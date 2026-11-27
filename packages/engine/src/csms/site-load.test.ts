import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../engine.js';
import { startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';
import {
  allocate,
  parseSite,
  siteLimitRequest,
  worthSending,
  type SessionLoad,
} from './site-load.js';

const session = (evseId: number, patch: Partial<SessionLoad> = {}): SessionLoad => ({
  stationId: 'S',
  evseId,
  transactionId: evseId,
  startedAt: evseId,
  evSuspended: false,
  ...patch,
});

describe('sharing a site between sessions', () => {
  it('gives equal shares to sessions that want more', () => {
    expect([...allocate(12_000, [session(1), session(2), session(3)]).values()]).toEqual([
      4000, 4000, 4000,
    ]);
  });

  it('passes on what a session clearly does not take, and keeps a minimum for a full car', () => {
    // It draws 1,500 W of a 4,000 W limit: it needs 1,950 W, and the others share the rest.
    const tapering = session(1, { measuredW: 1500, limitW: 4000 });
    expect(allocate(12_000, [tapering, session(2), session(3)])).toEqual(
      new Map([
        ['S 1', 1950],
        ['S 2', 5025],
        ['S 3', 5025],
      ]),
    );
    // Close to its limit, it still wants more.
    expect(allocate(12_000, [session(1, { measuredW: 3900, limitW: 4000 }), session(2)])).toEqual(
      new Map([
        ['S 1', 6000],
        ['S 2', 6000],
      ]),
    );
    const full = session(1, { evSuspended: true });
    expect(allocate(10_000, [full, session(2)])).toEqual(
      new Map([
        ['S 1', 1380],
        ['S 2', 8620],
      ]),
    );
  });

  it('lets the latest sessions wait at 0 when the minimum does not fit them all', () => {
    expect(allocate(3000, [session(3), session(1), session(2)])).toEqual(
      new Map([
        ['S 3', 0],
        ['S 1', 1500],
        ['S 2', 1500],
      ]),
    );
    expect(allocate(1000, [session(1)])).toEqual(new Map([['S 1', 0]]));
  });

  it('admits cars that take power before a full one, which waits at 0 when room runs out', () => {
    // Room for two minimums: the full car started first, but the two charging cars go ahead.
    const full = session(1, { evSuspended: true });
    expect(allocate(3000, [full, session(2), session(3)])).toEqual(
      new Map([
        ['S 2', 1500],
        ['S 3', 1500],
        ['S 1', 0],
      ]),
    );
  });

  it('sends a new limit only when it moves enough, and always to or from 0', () => {
    expect(worthSending(undefined, 4000)).toBe(true);
    expect(worthSending(4000, 4100)).toBe(false);
    expect(worthSending(4000, 4400)).toBe(true);
    expect(worthSending(1380, 0)).toBe(true);
    expect(worthSending(0, 1380)).toBe(true);
  });

  it('writes the limit as a TxProfile in W for each version, and checks a site', () => {
    expect(siteLimitRequest('1.6', session(2, { transactionId: 7 }), 4000)).toEqual({
      connectorId: 2,
      csChargingProfiles: {
        chargingProfileId: 9002,
        transactionId: 7,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 4000 }],
        },
      },
    });
    expect(siteLimitRequest('2.0.1', session(1, { transactionId: 'tx-1' }), 0)).toMatchObject({
      evseId: 1,
      chargingProfile: {
        id: 9001,
        transactionId: 'tx-1',
        chargingSchedule: [{ id: 9001, chargingRateUnit: 'W' }],
      },
    });
    expect(parseSite({ capacityW: 22_000, stations: ['A', 'B'] })).toEqual({
      capacityW: 22_000,
      stations: ['A', 'B'],
    });
    expect(parseSite({ capacityW: -1, stations: ['A'] })).toMatch(/capacityW/);
    expect(parseSite({ capacityW: 1000, stations: [] })).toMatch(/stations/);
  });
});

describe('the built-in CSMS managing a site', () => {
  let engine: Engine | undefined;
  let csms: BuiltinCsms | undefined;
  afterEach(async () => {
    await engine?.stop();
    await csms?.stop();
    engine = undefined;
    csms = undefined;
  });

  async function until(check: () => Promise<boolean>, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  for (const ocpp of ['1.6', '2.0.1'] as const) {
    it(`shares a site's capacity between ${ocpp} sessions and follows the cars`, async () => {
      csms = await startBuiltinCsms();
      engine = createEngine({ port: 0 });
      const { url } = await engine.start();
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${url}${path}`, {
          method,
          ...(body !== undefined && {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps the assertions short
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      // The CSMS needs the power each session draws, so the stations report it every second.
      const settings =
        ocpp === '1.6'
          ? {
              config: {
                MeterValueSampleInterval: '1',
                MeterValuesSampledData: 'Energy.Active.Import.Register,Power.Active.Import',
              },
            }
          : {
              deviceModel: {
                SampledDataCtrlr: {
                  TxUpdatedInterval: 1,
                  TxUpdatedMeasurands: 'Energy.Active.Import.Register,Power.Active.Import',
                },
              },
            };
      for (const id of ['L1', 'L2']) {
        const created = await call('POST', '/api/stations', {
          id,
          persona: `generic-${ocpp}`,
          csmsUrl: csms.url,
          ...settings,
        });
        expect(created.status).toBe(201);
      }
      for (const id of ['L1', 'L2']) {
        await until(async () => (await call('GET', `/api/stations/${id}`)).body.csms === 'builtin');
      }
      expect((await call('GET', '/api/sites/yard')).status).toBe(404);
      expect(
        await call('PUT', '/api/sites/yard', { capacityW: 8000, stations: ['L1', 'L2'] }),
      ).toMatchObject({ status: 200, body: { id: 'yard', capacityW: 8000, minimumW: 1380 } });

      const limitOf = async (id: string) =>
        (await call('GET', `/api/stations/${id}`)).body.connectors[0] as {
          limitW?: number;
          status: string;
          chargingState?: string;
          powerW: number;
        };
      const start = async (id: string) => {
        await call('POST', `/api/stations/${id}/connectors/1/plug`, { ev: 'sedan-75kwh' });
        await call('POST', `/api/stations/${id}/connectors/1/id-tag`, { idTag: `TAG-${id}` });
      };
      await start('L1');
      await until(async () => (await limitOf('L1')).limitW === 8000);
      await start('L2');
      await until(async () => (await limitOf('L1')).limitW === 4000);
      await until(async () => (await limitOf('L2')).limitW === 4000);
      expect((await limitOf('L2')).powerW).toBe(4000);

      // The first car stops taking power (as when full): it keeps the minimum, the other gets the rest.
      await call('POST', '/api/stations/L1/connectors/1/ev-suspend');
      await until(async () => (await limitOf('L2')).limitW === 8000 - 1380);
      expect((await limitOf('L1')).limitW).toBe(1380);

      // Room for one minimum only: the charging car gets it all, the suspended one waits at 0,
      // in SuspendedEVSE.
      await call('PUT', '/api/sites/yard', { capacityW: 2000, stations: ['L1', 'L2'] });
      await until(async () => (await limitOf('L1')).limitW === 0);
      await until(async () => (await limitOf('L2')).limitW === 2000);
      const waiting = await limitOf('L1');
      // 1.6 reports the EVSE's suspension first; 2.x keeps the EV's own (SuspendedEV).
      expect(ocpp === '1.6' ? waiting.status : waiting.chargingState).toBe(
        ocpp === '1.6' ? 'SuspendedEVSE' : 'SuspendedEV',
      );
      expect(waiting.powerW).toBe(0);

      const site = await call('GET', '/api/sites/yard');
      expect(site.body).toMatchObject({ capacityW: 2000, allocatedW: 2000 });
      expect(site.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stationId: 'L1', limitW: 0, state: 'waiting' }),
          expect.objectContaining({ stationId: 'L2', limitW: 2000, state: 'charging' }),
        ]),
      );
      expect(site.body.sent[0]).toMatchObject({ status: 'Accepted' });

      // Removing the site clears its limits.
      expect((await call('DELETE', '/api/sites/yard')).status).toBe(200);
      await until(async () => (await limitOf('L1')).limitW === undefined);
      await until(async () => (await limitOf('L2')).limitW === undefined);
      expect((await call('GET', '/api/sites/yard')).status).toBe(404);
    });
  }
});
