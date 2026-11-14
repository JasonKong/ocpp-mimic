import {
  ManualClock,
  createRpc,
  sequentialIds,
  type CsmsHandlers,
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

  it('refuses connections without the ocpp1.6 subprotocol or outside /ocpp/<id>', async () => {
    csms = await startBuiltinCsms();
    await expect(open(`${csms.url}/CP-1`, ['ocpp2.0.1'])).rejects.toThrow();
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
