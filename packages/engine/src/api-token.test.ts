import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createTokenCheck,
  EVENTS_PROTOCOL,
  exposedWithoutTokenWarning,
  isLoopbackHost,
  tokenProtocol,
} from './api-token.js';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';
import { createEngine, type Engine } from './engine.js';

const TOKEN = 'test-token-ä';
const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('API token check', () => {
  it('lets everything through without a token', () => {
    expect(createTokenCheck(undefined)(request({}))).toBe(true);
    expect(createTokenCheck('')(request({}))).toBe(true);
  });

  it('takes the token as a bearer header or as an events subprotocol', () => {
    const check = createTokenCheck(TOKEN);
    expect(check(request({}))).toBe(false);
    expect(check(request({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
    expect(check(request({ authorization: `bearer ${TOKEN}` }))).toBe(true);
    expect(check(request({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(check(request({ authorization: `Basic ${TOKEN}` }))).toBe(false);
    expect(
      check(request({ 'sec-websocket-protocol': `${EVENTS_PROTOCOL}, ${tokenProtocol(TOKEN)}` })),
    ).toBe(true);
    expect(check(request({ 'sec-websocket-protocol': tokenProtocol('wrong') }))).toBe(false);
  });

  it('knows loopback addresses and warns about others without a token', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.test']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
    expect(exposedWithoutTokenWarning('The engine', '127.0.0.1', undefined)).toBeUndefined();
    expect(exposedWithoutTokenWarning('The engine', '0.0.0.0', TOKEN)).toBeUndefined();
    expect(exposedWithoutTokenWarning('The engine', '0.0.0.0', undefined)).toMatch(
      /^The engine listens on 0.0.0.0 without an API token/,
    );
  });
});

describe('engine and CSMS with an API token', () => {
  let engine: Engine | undefined;
  let csms: BuiltinCsms | undefined;

  afterEach(async () => {
    await engine?.stop();
    await csms?.stop();
    engine = undefined;
    csms = undefined;
  });

  it('requires the token on the API, /metrics and events, but not on health', async () => {
    engine = createEngine({ port: 0, apiToken: TOKEN });
    const { url } = await engine.start();
    const auth = { authorization: `Bearer ${TOKEN}` };

    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    const refused = await fetch(`${url}/api/stations`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await refused.json()).toEqual({
      error: 'an API token is required: Authorization: Bearer <token>',
    });
    expect((await fetch(`${url}/api/stations`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${url}/metrics`)).status).toBe(401);
    expect((await fetch(`${url}/metrics`, { headers: auth })).status).toBe(200);

    const events = url.replace(/^http/, 'ws') + '/api/events';
    const rejected = await new Promise<number>((resolve) => {
      const ws = new WebSocket(events);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(rejected).toBe(401);
    const accepted = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(events, [EVENTS_PROTOCOL, tokenProtocol(TOKEN)]);
      ws.on('open', () => {
        resolve(ws.protocol);
        ws.close();
      });
      ws.on('error', reject);
    });
    // The server picks its own protocol and never echoes the token.
    expect(accepted).toBe(EVENTS_PROTOCOL);
  });

  it('warns when it listens beyond loopback without a token', async () => {
    const warnings: string[] = [];
    engine = createEngine({ port: 0, host: '0.0.0.0', onWarning: (m) => warnings.push(m) });
    await engine.start();
    expect(warnings).toEqual([expect.stringMatching(/listens on 0\.0\.0\.0 without an API token/)]);
  });

  it('protects the CSMS control API, and the engine passes its token on remote starts', async () => {
    csms = await startBuiltinCsms({ port: 0, apiToken: 'csms-token' });
    const control = csms.url.replace(/^ws/, 'http').replace(/\/ocpp$/, '');

    expect((await fetch(`${control}/api/health`)).status).toBe(200);
    const refused = await fetch(`${control}/api/stations/SIM-1/remote-start`, {
      method: 'POST',
      body: JSON.stringify({ idToken: { idToken: 'TAG' } }),
    });
    expect(refused.status).toBe(401);

    engine = createEngine({ port: 0, csmsApiToken: 'csms-token' });
    const { url } = await engine.start();
    const created = await fetch(`${url}/api/stations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url }),
    });
    expect(created.status).toBe(201);
    await csms.waitForConnection('SIM-1', 5000);
    const until = Date.now() + 5000;
    let answer: Response | undefined;
    for (;;) {
      answer = await fetch(`${url}/api/stations/SIM-1/remote-start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: { idToken: 'TAG-1' } }),
      });
      // The engine learns that the CSMS is the built-in one once the station is connected.
      if (answer.status !== 409 || Date.now() > until) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ action: 'RemoteStartTransaction' });
  });
});
