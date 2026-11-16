import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createEngine, type Engine } from '../engine.js';
import { startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';
import { localControlOrigin } from './probe.js';

let engine: Engine | undefined;
let csms: BuiltinCsms | undefined;
const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await engine?.stop();
  engine = undefined;
  await csms?.stop();
  csms = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

async function request(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps the assertions short
    body: text === '' ? undefined : (JSON.parse(text) as Record<string, any>),
  };
}

const REFERENCE = {
  tariffId: 'REFERENCE',
  currency: 'NZD',
  energy: { prices: [{ priceKwh: 0.3 }], taxRates: [{ type: 'GST', tax: 15 }] },
};

/** The built-in CSMS and an engine with one 2.1 station (every 2.1 feature group) on it. */
async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'mimic-csms21-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'all.yaml'),
    [
      'persona: all-2.1',
      'extends: generic-2.1',
      'connectors: 2',
      'features: [Core, SmartCharging, TariffAndCost, Payment, WebPayments]',
    ].join('\n'),
  );
  csms = await startBuiltinCsms({ tariff: REFERENCE });
  engine = createEngine({
    port: 0,
    personaDirs: [dir],
    backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 },
  });
  const { url } = await engine.start();
  const api = (method: string, path: string, body?: unknown) => request(url, method, path, body);
  const control = localControlOrigin(csms.url) ?? '';
  /** A control API command for station CS-21. */
  const command = (name: string, body: unknown = {}) =>
    request(control, 'POST', `/api/stations/CS-21/${name}`, body);
  expect(
    (await api('POST', '/api/stations', { id: 'CS-21', persona: 'all-2.1', csmsUrl: csms.url }))
      .status,
  ).toBe(201);
  await until(
    async () => (await api('GET', '/api/stations/CS-21')).body?.registration === 'Accepted',
  );
  const connection = await csms.waitForConnection('CS-21');
  /** The station's CALLs of an action, as the CSMS received them. */
  const calls = (action: string) =>
    connection.received.filter(
      (f): f is Extract<typeof f, { type: 2 }> => f.type === 2 && f.action === action,
    );
  return { api, command, calls, connection };
}

describe('the built-in CSMS with a 2.1 station', () => {
  it('sends the reference tariff, a driver tariff and a transaction limit', async () => {
    const { api, command, calls } = await start();
    expect((await command('default-tariff')).body).toEqual({
      action: 'SetDefaultTariff',
      status: 'Accepted',
    });
    expect(
      (await command('call', { action: 'GetTariffs', payload: { evseId: 0 } })).body,
    ).toMatchObject({
      action: 'GetTariffs',
      status: 'Accepted',
      tariffAssignments: [{ tariffId: 'REFERENCE', tariffKind: 'DefaultTariff' }],
    });
    // The driver's own tariff comes with Authorize (I08), and a limit with the Started answer.
    expect(
      (
        await command('driver-tariff', {
          tariff: { tariffId: 'DRIVER', currency: 'NZD', energy: { prices: [{ priceKwh: 0.2 }] } },
        })
      ).status,
    ).toBe(200);
    expect(
      (await command('transaction-limit', { transactionLimit: { maxEnergy: 500 } })).body,
    ).toEqual({ queued: true });
    expect(
      (await api('POST', '/api/stations/CS-21/connectors/1/id-tag', { idTag: 'TAG-1' })).body
        ?.result,
    ).toBe('authorized');
    await api('POST', '/api/stations/CS-21/connectors/1/plug', {});
    await until(() =>
      calls('TransactionEvent').some((c) => c.payload.triggerReason === 'LimitSet'),
    );
    const started = calls('TransactionEvent').find((c) => c.payload.eventType === 'Started');
    expect(started?.payload.transactionInfo).toMatchObject({ tariffId: 'DRIVER' });
    const limitSet = calls('TransactionEvent').find((c) => c.payload.triggerReason === 'LimitSet');
    expect(limitSet?.payload.transactionInfo).toMatchObject({
      transactionLimit: { maxEnergy: 500 },
    });
    expect((await command('driver-tariff', { tariff: null })).body).toEqual({ driverTariff: null });
  });

  it('answers PullDynamicScheduleUpdate with the values it set, and sends any command', async () => {
    const { api, command, calls } = await start();
    const dynamic = {
      evseId: 1,
      chargingProfile: {
        id: 7,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Dynamic',
        dynUpdateInterval: 1,
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'W',
            duration: 3600,
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
          },
        ],
      },
    };
    expect(
      (await command('call', { action: 'SetChargingProfile', payload: dynamic })).body,
    ).toMatchObject({ status: 'Accepted' });
    expect(
      (
        await command('call', {
          action: 'UpdateDynamicSchedule',
          payload: { chargingProfileId: 7, scheduleUpdate: { limit: 4000 } },
        })
      ).body,
    ).toMatchObject({ status: 'Accepted' });
    // dynUpdateInterval 1 s: the station pulls, and the CSMS answers with 4000 W.
    await until(() => calls('PullDynamicScheduleUpdate').length > 0, 5000);
    await until(async () => {
      const log = await api('GET', '/api/stations/CS-21/messages?action=PullDynamicScheduleUpdate');
      const entries = (log.body?.entries ?? []) as { messageType?: number; payload?: unknown }[];
      return entries.some(
        (e) =>
          e.messageType === 3 &&
          JSON.stringify(e.payload) ===
            JSON.stringify({ status: 'Accepted', scheduleUpdate: { limit: 4000 } }),
      );
    });
    expect((await command('call', { action: 'Nope', payload: {} })).status).toBe(400);
    expect(
      (
        await command('call', {
          action: 'UsePriorityCharging',
          payload: { transactionId: 'x', activate: true },
        })
      ).body,
    ).toMatchObject({ action: 'UsePriorityCharging', status: 'Rejected' });
  });

  it('checks a payment URL like a payment page and tells the station the payment started (C25)', async () => {
    const { api, command } = await start();
    await command('call', {
      action: 'SetVariables',
      payload: {
        setVariableData: [
          {
            component: { name: 'WebPaymentsCtrlr' },
            variable: { name: 'SharedSecret' },
            attributeValue: 'csms-secret-1',
          },
        ],
      },
    });
    const qr = (await api('GET', '/api/stations/CS-21/connectors/2/payment-url?maxcost=15')).body;
    expect((await command('web-payment', { url: qr?.url })).body).toEqual({
      action: 'NotifyWebPaymentStarted',
      valid: true,
      evseId: 2,
      limits: { maxCost: 15 },
    });
    // The EVSE waits for the web payment's start.
    expect(
      (await api('POST', '/api/stations/CS-21/connectors/2/id-tag', { idTag: 'TAG-2' })).body
        ?.result,
    ).toBe('busy');
    const forged = String(qr?.url).replace(/\/([0-9A-Za-z]{8})\/v1/, '/AAAAAAAA/v1');
    expect((await command('web-payment', { url: forged })).body).toEqual({
      valid: false,
      reason: 'the code is not valid now',
    });
    expect(
      (await command('web-payment', { url: 'https://elsewhere.example.com/x' })).body,
    ).toMatchObject({ valid: false });
  });
});

describe('the built-in CSMS installing its tariff', () => {
  it('sends its reference tariff to a 2.1 station as its default tariff after the boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimic-csms21-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'priced.yaml'),
      ['persona: priced-2.1', 'extends: generic-2.1', 'features: [Core, TariffAndCost]'].join('\n'),
    );
    csms = await startBuiltinCsms({ tariff: REFERENCE, installTariff: true });
    engine = createEngine({
      port: 0,
      personaDirs: [dir],
      backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 },
    });
    const { url } = await engine.start();
    expect(
      (
        await request(url, 'POST', '/api/stations', {
          id: 'P-21',
          persona: 'priced-2.1',
          csmsUrl: csms.url,
        })
      ).status,
    ).toBe(201);
    const connection = await csms.waitForConnection('P-21');
    await until(async () => {
      const answer = await connection.call('GetTariffs', { evseId: 0 }).catch(() => undefined);
      return (
        answer?.type === 3 && JSON.stringify(answer.payload).includes('"tariffId":"REFERENCE"')
      );
    });
  });
});

describe('the built-in CSMS control API with other versions', () => {
  it('keeps 2.1 commands for 2.1 stations', async () => {
    csms = await startBuiltinCsms();
    const socket = new WebSocket(`${csms.url}/CP-201`, ['ocpp2.0.1']);
    sockets.push(socket);
    await new Promise((resolve) => socket.once('open', resolve));
    await csms.waitForConnection('CP-201');
    const control = localControlOrigin(csms.url) ?? '';
    expect((await request(control, 'POST', '/api/stations/CP-201/default-tariff', {})).status).toBe(
      404,
    );
    expect(
      (await request(control, 'POST', '/api/stations/CP-201/call', { action: 'SetDefaultTariff' }))
        .status,
    ).toBe(400);
    expect((await request(control, 'POST', '/api/stations/CP-201/unknown', {})).status).toBe(404);
  });
});
