import {
  ManualClock,
  OCPP201_MESSAGE_SET,
  createRpc,
  sequentialIds,
  type CsmsHandlers,
  type Ocpp201RpcTypes,
  type Rpc,
} from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CallErrorReply, startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';

let csms: BuiltinCsms | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await csms?.stop();
  csms = undefined;
});

function open(url: string, protocols: string[] = ['ocpp1.6']): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', (code) => reject(new Error(`closed with ${code}`)));
  });
}

/** A bare-bones charge point: a socket plus core's RPC layer. */
async function connectChargePoint(id: string, handlers: CsmsHandlers = {}): Promise<Rpc> {
  if (csms === undefined) throw new Error('start the CSMS first');
  const socket = await open(`${csms.url}/${id}`);
  const rpc = createRpc({
    clock: new ManualClock(),
    ids: sequentialIds(`${id}-`),
    send: (text) => socket.send(text),
    handlers,
  });
  socket.on('message', (data) => rpc.receive(data.toString()));
  return rpc;
}

describe('built-in CSMS', () => {
  it('accepts a BootNotification from a charge point and records it', async () => {
    csms = await startBuiltinCsms();
    const rpc = await connectChargePoint('CP-1');
    const connection = await csms.waitForConnection('CP-1');

    const outcome = await rpc.call('BootNotification', {
      chargePointVendor: 'VendorX',
      chargePointModel: 'AC-7',
    });

    expect(outcome).toMatchObject({ ok: true, payload: { status: 'Accepted', interval: 60 } });
    expect(connection.protocol).toBe('ocpp1.6');
    const boot = await connection.waitForCall('BootNotification');
    expect(boot.payload).toEqual({ chargePointVendor: 'VendorX', chargePointModel: 'AC-7' });
  });

  it('hands out increasing transaction ids by default', async () => {
    csms = await startBuiltinCsms();
    const rpc = await connectChargePoint('CP-1');
    const start = {
      connectorId: 1,
      idTag: 'TAG',
      meterStart: 0,
      timestamp: '2026-11-14T10:00:00Z',
    };
    const first = await rpc.call('StartTransaction', start);
    const second = await rpc.call('StartTransaction', start);
    expect([first, second].map((o) => (o.ok ? o.payload.transactionId : undefined))).toEqual([
      1, 2,
    ]);
  });

  it('uses custom handlers, including CALLERROR replies', async () => {
    csms = await startBuiltinCsms({
      handlers: {
        BootNotification: () => ({
          status: 'Rejected',
          currentTime: new Date().toISOString(),
          interval: 10,
        }),
        Heartbeat: () => new CallErrorReply('InternalError', 'down for maintenance'),
      },
    });
    const rpc = await connectChargePoint('CP-1');
    expect(
      await rpc.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' }),
    ).toMatchObject({ ok: true, payload: { status: 'Rejected' } });
    expect(await rpc.call('Heartbeat', {})).toMatchObject({
      ok: false,
      failure: {
        kind: 'CallError',
        errorCode: 'InternalError',
        errorDescription: 'down for maintenance',
      },
    });
  });

  it('sends CALLs to the charge point and returns the answer', async () => {
    csms = await startBuiltinCsms();
    await connectChargePoint('CP-1', {
      Reset: ({ type }) => ({ status: type === 'Soft' ? 'Accepted' : 'Rejected' }),
    });
    const connection = await csms.waitForConnection('CP-1');

    expect(await connection.call('Reset', { type: 'Soft' })).toEqual({
      type: 3,
      id: 'csms-1',
      payload: { status: 'Accepted' },
    });
    expect(await connection.call('UpdateFirmware', {})).toMatchObject({
      type: 4,
      errorCode: 'NotSupported',
    });
  });

  it('answers with replies set per station, for a number of calls or all of them', async () => {
    csms = await startBuiltinCsms();
    const rpc = await connectChargePoint('CP-1');
    const other = await connectChargePoint('CP-2');
    await csms.waitForConnection('CP-2');

    csms.setReply('CP-1', 'Authorize', { payload: { idTagInfo: { status: 'Invalid' } } }, 1);
    expect(await rpc.call('Authorize', { idTag: 'A' })).toMatchObject({
      ok: true,
      payload: { idTagInfo: { status: 'Invalid' } },
    });
    expect(await rpc.call('Authorize', { idTag: 'A' })).toMatchObject({
      ok: true,
      payload: { idTagInfo: { status: 'Accepted' } },
    });

    csms.setReply('CP-1', 'Heartbeat', { error: 'InternalError', description: 'down' });
    for (let i = 0; i < 2; i++) {
      expect(await rpc.call('Heartbeat', {})).toMatchObject({
        ok: false,
        failure: { kind: 'CallError', errorCode: 'InternalError', errorDescription: 'down' },
      });
    }
    expect(await other.call('Heartbeat', {})).toMatchObject({ ok: true });

    csms.setReply('CP-1', 'DataTransfer', { ignore: true });
    const silent = await Promise.race([
      rpc.call('DataTransfer', { vendorId: 'X' }).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 300)),
    ]);
    expect(silent).toBe('silent');

    csms.clearReplies();
    expect(await other.call('Heartbeat', {})).toMatchObject({ ok: true });
  });

  it('refuses connections without a subprotocol it speaks or outside /ocpp/<id>', async () => {
    csms = await startBuiltinCsms();
    await expect(open(`${csms.url}/CP-1`, ['ocpp2.1'])).rejects.toThrow();
    await expect(open(csms.url.replace('/ocpp', '/other/CP-1'))).rejects.toThrow();
    expect(csms.stats()).toMatchObject({ refused: 2, opened: 0 });
  });

  it('answers with the configured heartbeat interval and refuses unknown idTags', async () => {
    csms = await startBuiltinCsms({ heartbeatInterval: 300, unknownIdTagPrefix: 'UNKNOWN-' });
    const rpc = await connectChargePoint('CP-1');
    const boot = await rpc.call('BootNotification', {
      chargePointVendor: 'V',
      chargePointModel: 'M',
    });
    expect(boot).toMatchObject({ ok: true, payload: { interval: 300 } });
    const authorize = (idTag: string) => rpc.call('Authorize', { idTag });
    expect(await authorize('LOAD-0001')).toMatchObject({
      payload: { idTagInfo: { status: 'Accepted' } },
    });
    expect(await authorize('UNKNOWN-7')).toMatchObject({
      payload: { idTagInfo: { status: 'Invalid' } },
    });
    const start = await rpc.call('StartTransaction', {
      connectorId: 1,
      idTag: 'UNKNOWN-7',
      meterStart: 0,
      timestamp: '2026-11-15T10:00:00Z',
    });
    expect(start).toMatchObject({ payload: { idTagInfo: { status: 'Invalid' } } });
  });

  it('delays its answers by a random time in the configured range', async () => {
    csms = await startBuiltinCsms({ responseDelay: { minMs: 80, maxMs: 120 } });
    const rpc = await connectChargePoint('CP-1');
    const started = performance.now();
    await rpc.call('Heartbeat', {});
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
  });

  it('keeps no frames without keepFrames, but still takes answers to its own calls', async () => {
    csms = await startBuiltinCsms({ keepFrames: false });
    const rpc = await connectChargePoint('CP-1', {
      GetConfiguration: () => ({ configurationKey: [] }),
    });
    const connection = await csms.waitForConnection('CP-1');
    for (let i = 0; i < 5; i++) await rpc.call('Heartbeat', {});
    expect(connection.received).toHaveLength(0);

    const answer = await connection.call('GetConfiguration', {});
    expect(answer).toMatchObject({ type: 3, payload: { configurationKey: [] } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection.received).toHaveLength(0);
  });

  it('counts connections, calls by action and answers', async () => {
    csms = await startBuiltinCsms({
      handlers: { DataTransfer: () => new CallErrorReply('NotSupported') },
    });
    const rpc = await connectChargePoint('CP-1');
    await rpc.call('Heartbeat', {});
    await rpc.call('Heartbeat', {});
    await rpc.call('DataTransfer', { vendorId: 'X' });
    await connectChargePoint('CP-2');
    await csms.waitForConnection('CP-2');
    expect(csms.stats()).toEqual({
      connected: 2,
      opened: 2,
      closed: 0,
      refused: 0,
      callsReceived: { Heartbeat: 2, DataTransfer: 1 },
      results: 2,
      errors: 1,
    });
    sockets[0]?.close();
    await (
      await csms.waitForConnection('CP-1')
    ).closed;
    expect(csms.stats()).toMatchObject({ connected: 1, closed: 1 });
  });
});

describe('built-in CSMS with OCPP 2.0.1 stations', () => {
  async function connect201(id: string): Promise<Rpc<Ocpp201RpcTypes>> {
    if (csms === undefined) throw new Error('start the CSMS first');
    const socket = await open(`${csms.url}/${id}`, ['ocpp2.0.1']);
    const rpc = createRpc<Ocpp201RpcTypes>({
      clock: new ManualClock(),
      ids: sequentialIds(`${id}-`),
      send: (text) => socket.send(text),
      messages: OCPP201_MESSAGE_SET,
    });
    socket.on('message', (data) => rpc.receive(data.toString()));
    return rpc;
  }

  const at = '2026-11-15T10:00:00Z';
  const token = (idToken: string) => ({ idToken, type: 'ISO14443' as const });
  const component = { name: 'Connector', evse: { id: 1, connectorId: 1 } };
  const variable = { name: 'Problem' };
  /** A valid request for every station-initiated action in M5's scope. */
  const requests: { [A in Ocpp201RpcTypes['out']]?: Ocpp201RpcTypes['requests'][A] } = {
    Authorize: { idToken: token('TAG-1') },
    BootNotification: { reason: 'PowerUp', chargingStation: { model: 'M', vendorName: 'V' } },
    DataTransfer: { vendorId: 'acme', data: { any: ['thing'] } },
    FirmwareStatusNotification: { status: 'Downloading', requestId: 1 },
    Heartbeat: {},
    LogStatusNotification: { status: 'Uploading', requestId: 2 },
    MeterValues: {
      evseId: 0,
      meterValue: [{ timestamp: at, sampledValue: [{ value: 1, context: 'Sample.Clock' }] }],
    },
    NotifyCustomerInformation: { data: 'none', seqNo: 0, generatedAt: at, requestId: 3 },
    NotifyEvent: {
      generatedAt: at,
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: at,
          trigger: 'Alerting',
          actualValue: 'true',
          eventNotificationType: 'HardWiredNotification',
          component,
          variable,
        },
      ],
    },
    NotifyReport: {
      requestId: 4,
      generatedAt: at,
      seqNo: 0,
      reportData: [{ component, variable, variableAttribute: [{ value: 'false' }] }],
    },
    ReportChargingProfiles: {
      requestId: 5,
      chargingLimitSource: 'CSO',
      evseId: 1,
      chargingProfile: [
        {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 3680 }],
            },
          ],
        },
      ],
    },
    ReservationStatusUpdate: { reservationId: 6, reservationUpdateStatus: 'Expired' },
    SecurityEventNotification: { type: 'StartupOfTheDevice', timestamp: at },
    SignCertificate: { csr: 'not a CSR' },
    StatusNotification: { timestamp: at, connectorStatus: 'Available', evseId: 1, connectorId: 1 },
    TransactionEvent: {
      eventType: 'Started',
      timestamp: at,
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-1' },
      idToken: token('TAG-1'),
    },
  };

  it('speaks 2.0.1 to a station offering ocpp2.0.1 and answers every in-scope request', async () => {
    csms = await startBuiltinCsms();
    const rpc = await connect201('CP-201');
    const connection = await csms.waitForConnection('CP-201');
    expect(connection).toMatchObject({ protocol: 'ocpp2.0.1', ocpp: '2.0.1' });
    for (const [action, payload] of Object.entries(requests)) {
      const outcome = await rpc.call(action as Ocpp201RpcTypes['out'], payload as never);
      // The RPC layer validates the answer against the 2.0.1 definitions.
      expect(outcome.ok, `${action}: ${JSON.stringify(outcome)}`).toBe(true);
    }
    expect(Object.keys(requests)).toHaveLength(16);
  });

  it('answers Invalid for unknown tokens, and tells unsupported from unknown actions', async () => {
    csms = await startBuiltinCsms({ unknownIdTagPrefix: 'UNKNOWN-' });
    const rpc = await connect201('CP-201');
    expect(await rpc.call('Authorize', { idToken: token('UNKNOWN-1') })).toMatchObject({
      ok: true,
      payload: { idTokenInfo: { status: 'Invalid' } },
    });
    expect(
      await rpc.call('TransactionEvent', {
        ...requests.TransactionEvent!,
        idToken: token('UNKNOWN-2'),
      }),
    ).toMatchObject({ ok: true, payload: { idTokenInfo: { status: 'Invalid' } } });
    const display = await rpc.call('NotifyDisplayMessages', { requestId: 1 });
    expect(display).toMatchObject({
      ok: false,
      failure: { kind: 'CallError', errorCode: 'NotSupported' },
    });
  });

  it('picks the version the station offers and refuses others', async () => {
    csms = await startBuiltinCsms();
    const v16 = await open(`${csms.url}/CP-16`, ['ocpp1.6']);
    const v201 = await open(`${csms.url}/CP-201`, ['ocpp2.0.1', 'ocpp1.6']);
    expect([v16.protocol, v201.protocol]).toEqual(['ocpp1.6', 'ocpp2.0.1']);
    await expect(open(`${csms.url}/CP-X`, ['ocpp2.1'])).rejects.toThrow();
    expect((await csms.waitForConnection('CP-16')).ocpp).toBe('1.6');
  });

  it('sends CertificateSigned with the certificate type the request named', async () => {
    const authority = { certificate: 'CA', key: 'KEY' };
    csms = await startBuiltinCsms({
      certificateAuthority: authority,
      handlers: {
        // The test checks the follow-up CALL only; signing itself is tested with the 1.6 flow.
        SignCertificate: (payload, connection) => {
          void connection
            .call('CertificateSigned', {
              certificateChain: 'CHAIN',
              ...(payload.certificateType !== undefined && {
                certificateType: payload.certificateType,
              }),
            })
            .catch(() => {});
          return { status: 'Accepted' };
        },
      },
    });
    const received: unknown[] = [];
    const socket = await open(`${csms.url}/CP-201`, ['ocpp2.0.1']);
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    socket.send(
      JSON.stringify([
        2,
        'a',
        'SignCertificate',
        { csr: 'x', certificateType: 'ChargingStationCertificate' },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toContainEqual([
      2,
      expect.any(String),
      'CertificateSigned',
      { certificateChain: 'CHAIN', certificateType: 'ChargingStationCertificate' },
    ]);
  });
});
