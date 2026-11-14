import {
  ManualClock,
  createRpc,
  sequentialIds,
  type CsmsHandlers,
  type Rpc,
} from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CallErrorReply, startMiniCsms, type MiniCsms } from './mini-csms.js';

let csms: MiniCsms | undefined;
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

describe('mini CSMS', () => {
  it('accepts a BootNotification from a charge point and records it', async () => {
    csms = await startMiniCsms();
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
    csms = await startMiniCsms();
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
    csms = await startMiniCsms({
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
    csms = await startMiniCsms();
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

  it('refuses connections without the ocpp1.6 subprotocol or outside /ocpp/<id>', async () => {
    csms = await startMiniCsms();
    await expect(open(`${csms.url}/CP-1`, ['ocpp2.0.1'])).rejects.toThrow();
    await expect(open(csms.url.replace('/ocpp', '/other/CP-1'))).rejects.toThrow();
  });
});
