import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';
import {
  backoffDelay,
  createTransport,
  DEFAULT_BACKOFF,
  type Transport,
  type TransportEvent,
  type TransportOptions,
} from './transport.js';

let csms: BuiltinCsms | undefined;
const transports: Transport[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await csms?.stop();
  csms = undefined;
});

const FAST = { initialDelayMs: 20, maxDelayMs: 100, factor: 2, jitter: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport with recorded callbacks. */
function open(options: Partial<TransportOptions> & { url: string }) {
  const received: string[] = [];
  const events: TransportEvent[] = [];
  let opens = 0;
  let closes = 0;
  const transport = createTransport({
    chargeBoxId: 'CP-1',
    backoff: FAST,
    onText: (text) => received.push(text),
    onOpen: () => {
      opens += 1;
    },
    onClose: () => {
      closes += 1;
    },
    onEvent: (event) => events.push(event),
    ...options,
  });
  transports.push(transport);
  transport.start();
  return {
    transport,
    received,
    events,
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
  };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(5);
  }
}

describe('backoffDelay', () => {
  it('grows exponentially up to the maximum, with jitter around each delay', () => {
    const policy = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect([0, 1, 2, 3, 10].map((attempt) => backoffDelay(attempt, policy, Math.random))).toEqual([
      1000, 2000, 4000, 8000, 60_000,
    ]);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(800);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999_999)).toBe(1200);
  });
});

describe('transport', () => {
  it('connects to <url>/<chargeBoxId> with ocpp1.6 and carries text both ways', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const connection = await csms.waitForConnection('CP-1');
    await until(() => t.opens === 1);
    expect(connection.protocol).toBe('ocpp1.6');
    expect(t.transport.state).toBe('open');

    t.transport.send('[2,"a","Heartbeat",{}]');
    await connection.waitForCall('Heartbeat');
    await until(() => t.received.length === 1);
    expect(JSON.parse(t.received[0] ?? '')).toMatchObject([
      3,
      'a',
      { currentTime: expect.any(String) },
    ]);
  });

  it('sends Basic Auth with the chargeBoxId as user name', async () => {
    const expected = `Basic ${Buffer.from('CP-1:secret').toString('base64')}`;
    csms = await startBuiltinCsms({ authorize: (_id, header) => header === expected });
    const good = open({ url: csms.url, password: 'secret' });
    expect((await csms.waitForConnection('CP-1')).headers.authorization).toBe(expected);
    await until(() => good.opens === 1);

    const bad = open({ url: csms.url, chargeBoxId: 'CP-2', password: 'wrong' });
    await until(() => bad.events.some((e) => e.type === 'error'));
    expect(bad.opens).toBe(0);
  });

  it('reconnects with backoff when the CSMS drops the connection', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const first = await csms.waitForConnection('CP-1');
    first.close();
    const second = await csms.waitForConnection('CP-1', 2000, first);
    await until(() => t.opens === 2);
    expect(second).not.toBe(first);
    expect(t.closes).toBe(1);
    expect(t.events).toContainEqual({ type: 'reconnect-scheduled', delayMs: 20 });
  });

  it('keeps retrying while the CSMS is unreachable', async () => {
    const t = open({ url: 'ws://127.0.0.1:1/ocpp' });
    await until(() => t.events.filter((e) => e.type === 'reconnect-scheduled').length >= 3);
    const delays = t.events.flatMap((e) => (e.type === 'reconnect-scheduled' ? [e.delayMs] : []));
    expect(delays.slice(0, 3)).toEqual([20, 40, 80]);
    expect(t.opens).toBe(0);
  });

  it('drops a server that does not accept the ocpp1.6 subprotocol', async () => {
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: () => false,
    });
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const t = open({ url: `ws://127.0.0.1:${port}/ocpp` });
    await until(() => t.events.some((e) => e.type === 'error' && /subprotocol/.test(e.message)));
    expect(t.opens).toBe(0);
  });

  it('a clean outage closes the socket and stays offline until goOnline', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const first = await csms.waitForConnection('CP-1');
    await until(() => t.opens === 1);

    t.transport.goOffline('clean');
    await first.closed;
    expect(t.transport.state).toBe('offline');
    expect(t.closes).toBe(1);
    await sleep(100);
    expect(t.opens).toBe(1);

    t.transport.goOnline();
    await csms.waitForConnection('CP-1', 2000, first);
    await until(() => t.opens === 2);
  });

  it('a half-open outage keeps the socket but drops traffic and pongs', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const first = await csms.waitForConnection('CP-1');
    await until(() => t.opens === 1);
    expect(await first.ping()).toBe(true);

    t.transport.goOffline('half-open');
    expect(t.transport.state).toBe('half-open');
    expect(t.closes).toBe(1);
    expect(await first.ping(200)).toBe(false);
    t.transport.send('[2,"lost","Heartbeat",{}]');
    await sleep(50);
    expect(first.received).toEqual([]);

    t.transport.goOnline();
    await csms.waitForConnection('CP-1', 2000, first);
    await until(() => t.opens === 2);
  });

  it('sends WebSocket pings at the configured interval', async () => {
    csms = await startBuiltinCsms();
    open({ url: csms.url, pingIntervalMs: 30 });
    const connection = await csms.waitForConnection('CP-1');
    await until(() => connection.pings >= 2);
  });

  it('restarts after the downtime of a reset', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const first = await csms.waitForConnection('CP-1');
    await until(() => t.opens === 1);
    const started = Date.now();
    t.transport.restartAfter(150);
    await csms.waitForConnection('CP-1', 2000, first);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(t.events).toContainEqual({ type: 'reconnect-scheduled', delayMs: 150 });
  });

  it('reads the connection settings before every attempt and reports failed attempts', async () => {
    csms = await startBuiltinCsms({ passwords: { 'CP-1': 'right-password' } });
    let password = 'wrong-password';
    let failures = 0;
    const t = open({
      url: csms.url,
      connectionSettings: () => ({ password }),
      onConnectFailed: () => {
        failures += 1;
        // The callback may reconnect at once; that must replace the scheduled retry.
        if (failures === 1) {
          password = 'right-password';
          t.transport.restartAfter(0);
        }
      },
    });
    await until(() => t.opens === 1);
    expect(failures).toBe(1);
    const connection = await csms.waitForConnection('CP-1');
    expect(connection.headers.authorization).toBe(
      `Basic ${Buffer.from('CP-1:right-password').toString('base64')}`,
    );
    // No second socket from a leaked retry timer.
    await sleep(150);
    expect(t.opens).toBe(1);
    expect(t.events.filter((e) => e.type === 'connecting')).toHaveLength(2);
  });

  it('refuses to connect when the settings say why, and keeps retrying', async () => {
    let failures = 0;
    const t = open({
      url: 'ws://127.0.0.1:1/ocpp',
      connectionSettings: () => ({ error: 'Security Profile 2 needs a wss:// CSMS address' }),
      onConnectFailed: () => {
        failures += 1;
      },
    });
    await until(() => failures >= 2);
    expect(t.events).toContainEqual({
      type: 'error',
      message: 'Security Profile 2 needs a wss:// CSMS address',
    });
  });

  it('stop() closes the connection for good', async () => {
    csms = await startBuiltinCsms();
    const t = open({ url: csms.url });
    const connection = await csms.waitForConnection('CP-1');
    await until(() => t.opens === 1);
    await t.transport.stop();
    await connection.closed;
    await sleep(100);
    expect(t.transport.state).toBe('stopped');
    expect(t.opens).toBe(1);
  });
});
