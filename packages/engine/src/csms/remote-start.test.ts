import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../engine.js';
import { startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';
import { localControlOrigin, probeCsms } from './probe.js';

let engine: Engine | undefined;
const csmss: BuiltinCsms[] = [];
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  for (const csms of csmss.splice(0)) await csms.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describe('the built-in CSMS control API', () => {
  it('only asks CSMSs on this machine', () => {
    expect(localControlOrigin('ws://127.0.0.1:9100/ocpp')).toBe('http://127.0.0.1:9100');
    expect(localControlOrigin('wss://localhost:8443/ocpp')).toBe('https://localhost:8443');
    expect(localControlOrigin('ws://[::1]:9100/ocpp')).toBe('http://[::1]:9100');
    expect(localControlOrigin('wss://csms.example.com/ocpp')).toBeUndefined();
    expect(localControlOrigin('not a url')).toBeUndefined();
  });

  it('tells the built-in CSMS from others', async () => {
    const builtin = await startBuiltinCsms();
    const quiet = await startBuiltinCsms({ controlApi: false });
    csmss.push(builtin, quiet);
    expect(await probeCsms(builtin.url)).toBe('builtin');
    expect(await probeCsms(quiet.url)).toBe('external');
    expect(await probeCsms('ws://127.0.0.1:1/ocpp', 500)).toBe('external');
    expect(await probeCsms('wss://csms.example.com/ocpp')).toBe('external');
  });

  it('starts sessions remotely through the built-in CSMS, and refuses for any other CSMS', async () => {
    const builtin = await startBuiltinCsms();
    const quiet = await startBuiltinCsms({ controlApi: false });
    csmss.push(builtin, quiet);
    engine = createEngine({ port: 0, backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 } });
    const { url } = await engine.start();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${url}${path}`, {
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
    };
    for (const [id, persona, csmsUrl] of [
      ['R16', 'generic-1.6', builtin.url],
      ['R201', 'generic-2.0.1', builtin.url],
      ['EXT', 'generic-1.6', quiet.url],
    ] as const) {
      expect((await call('POST', '/api/stations', { id, persona, csmsUrl })).status).toBe(201);
    }
    await until(async () => (await call('GET', '/api/stations/R16')).body?.csms === 'builtin');
    await until(async () => (await call('GET', '/api/stations/R201')).body?.csms === 'builtin');
    await until(async () => (await call('GET', '/api/stations/EXT')).body?.csms === 'external');

    const r16 = await call('POST', '/api/stations/R16/remote-start', {
      idToken: { idToken: 'APP-USER' },
      evseId: 1,
    });
    expect(r16).toMatchObject({
      status: 200,
      body: { action: 'RemoteStartTransaction', status: 'Accepted' },
    });
    const r201 = await call('POST', '/api/stations/R201/remote-start', {
      idToken: { idToken: 'APP-USER-2' },
      evseId: 1,
    });
    expect(r201).toMatchObject({
      status: 200,
      body: {
        action: 'RequestStartTransaction',
        status: 'Accepted',
        remoteStartId: expect.any(Number),
      },
    });
    await call('POST', '/api/stations/R201/connectors/1/plug', {});
    await until(
      async () =>
        (await call('GET', '/api/stations/R201/sessions')).body?.sessions?.[0]?.state === 'running',
    );
    expect((await call('GET', '/api/stations/R201/sessions/1')).body?.session).toMatchObject({
      source: 'remote',
      idToken: { idToken: 'APP-USER-2', type: 'Central' },
      remoteStartId: r201.body?.remoteStartId,
    });

    const refused = await call('POST', '/api/stations/EXT/remote-start', {
      idToken: { idToken: 'X' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toContain('must come from that CSMS');
    expect((await call('POST', '/api/stations/R16/remote-start', { idToken: 'X' })).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', '/api/stations/R16/remote-start', {
          idToken: { idToken: 'X' },
          evseId: 0,
        })
      ).status,
    ).toBe(400);
  });
});
