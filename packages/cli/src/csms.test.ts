import { ManualClock, createRpc, sequentialIds } from '@ocpp-mimic/core';
import { join } from 'node:path';
import { TEST_PKI_DIR, testPki } from '@ocpp-mimic/engine';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CsmsCommand } from './command.js';
import { startCsmsCommand, statusLine, summary, type RunningCsms } from './csms.js';

let running: RunningCsms | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await running?.stop();
  running = undefined;
});

function command(extra: Partial<CsmsCommand> = {}): CsmsCommand {
  return {
    kind: 'csms',
    port: 0,
    host: '127.0.0.1',
    heartbeatInterval: 60,
    unknownPrefix: 'UNKNOWN-',
    statusMs: 0,
    ...extra,
  };
}

function connect(url: string, options: WebSocket.ClientOptions = {}) {
  return new Promise<ReturnType<typeof createRpc>>((resolve, reject) => {
    const socket = new WebSocket(url, ['ocpp1.6'], options);
    sockets.push(socket);
    const rpc = createRpc({
      clock: new ManualClock(),
      ids: sequentialIds('cp-'),
      send: (text) => socket.send(text),
      handlers: {},
    });
    socket.on('message', (data) => rpc.receive(data.toString()));
    socket.once('open', () => resolve(rpc));
    socket.once('error', reject);
  });
}

describe('ocpp-mimic csms', () => {
  it('answers stations with the configured interval and unknown prefix', async () => {
    running = await startCsmsCommand(command({ heartbeatInterval: 120 }));
    const rpc = await connect(`${running.url}/LOAD-0001`);
    const boot = await rpc.call('BootNotification', {
      chargePointVendor: 'V',
      chargePointModel: 'M',
    });
    expect(boot).toMatchObject({ ok: true, payload: { interval: 120 } });
    const unknown = await rpc.call('Authorize', { idTag: 'UNKNOWN-1' });
    expect(unknown).toMatchObject({ ok: true, payload: { idTagInfo: { status: 'Invalid' } } });
    expect(running.stats()).toMatchObject({
      connected: 1,
      callsReceived: { BootNotification: 1, Authorize: 1 },
    });
  });

  it('requires the shared password when one is set', async () => {
    running = await startCsmsCommand(command({ password: 'a-shared-password' }));
    await expect(connect(`${running.url}/LOAD-0001`)).rejects.toThrow(/401/);
    const auth = Buffer.from('LOAD-0001:a-shared-password').toString('base64');
    await connect(`${running.url}/LOAD-0001`, { headers: { Authorization: `Basic ${auth}` } });
    expect(running.stats()).toMatchObject({ connected: 1, refused: 1 });
  });

  it('serves wss:// with the given certificate files', async () => {
    running = await startCsmsCommand(
      command({
        tls: {
          cert: join(TEST_PKI_DIR, 'server.crt'),
          key: join(TEST_PKI_DIR, 'server.key'),
          clientCertificates: 'none',
        },
      }),
    );
    expect(running.url).toMatch(/^wss:\/\//);
    const rpc = await connect(`${running.url}/LOAD-0001`, { ca: testPki('ca.crt') });
    expect(await rpc.call('Heartbeat', {})).toMatchObject({ ok: true });
  });

  it('prints status lines on its interval and a summary when stopped', async () => {
    const lines: string[] = [];
    running = await startCsmsCommand(command({ statusMs: 50 }), (line) => lines.push(line));
    const rpc = await connect(`${running.url}/LOAD-0001`);
    await rpc.call('Heartbeat', {});
    await rpc.call('Heartbeat', {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(lines.at(-1)).toBe(
      '1 connected (1 opened, 0 closed, 0 refused); 2 requests, 2 answered, 0 with CALLERROR',
    );
    const text = await running.stop();
    running = undefined;
    expect(text).toMatch(/^Ran 0m 0s\. 1 connected/);
    expect(text).toContain('  Heartbeat  2');
  });
});

describe('csms summary', () => {
  it('lists requests by action, most frequent first', () => {
    const stats = {
      connected: 0,
      opened: 1000,
      closed: 1000,
      refused: 0,
      callsReceived: { StatusNotification: 2000, BootNotification: 1000, Heartbeat: 60000 },
      results: 63000,
      errors: 0,
    };
    expect(statusLine(stats)).toBe(
      '0 connected (1000 opened, 1000 closed, 0 refused); 63000 requests, 63000 answered, 0 with CALLERROR',
    );
    expect(summary(stats, 3_725_000).split('\n')).toEqual([
      'Ran 62m 5s. 0 connected (1000 opened, 1000 closed, 0 refused); 63000 requests, 63000 answered, 0 with CALLERROR',
      '  Heartbeat           60000',
      '  StatusNotification  2000',
      '  BootNotification    1000',
    ]);
  });
});
