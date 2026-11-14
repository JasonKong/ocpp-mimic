import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseScenario, type Scenario } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runScenario, type RunOptions } from './runner.js';

let server: Server | undefined;
const requests: { method: string; url: string; auth?: string; body: string }[] = [];

afterEach(async () => {
  requests.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A tiny app backend: POST /charges creates a charge, GET /charges/<id> reads it. */
async function startApp(): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        ...(req.headers.authorization !== undefined && { auth: req.headers.authorization }),
        body,
      });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && req.url === '/charges') {
        json(201, {
          id: 'c-1',
          ok: true,
          station: (JSON.parse(body) as { station: string }).station,
        });
      } else if (req.method === 'GET' && req.url === '/charges/c-1') {
        json(200, { id: 'c-1', state: 'charging', token: req.headers.authorization });
      } else if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('plain text');
      } else {
        json(500, { error: 'boom' });
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

function scenario(steps: string): Scenario {
  const result = parseScenario(
    parse(`name: http\nstation: { id: SIM-HTTP, persona: generic-1.6 }\nsteps:\n${steps}`),
  );
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scenario;
}

const options = (api: string): RunOptions => ({
  vars: { APP_API: api },
  env: { APP_TOKEN: 's3cret-token' },
});

describe('http step', () => {
  it(
    'sends templated requests, checks the response and saves values',
    { timeout: 20_000 },
    async () => {
      const api = await startApp();
      const result = await runScenario(
        scenario(`
  - http:
      method: POST
      url: "{{APP_API}}/charges"
      headers: { Authorization: "Bearer {{env.APP_TOKEN}}" }
      json: { station: SIM-HTTP, connector: 1 }
      expect: { status: 201, json: { ok: true, station: SIM-HTTP } }
      save: { charge: $.json.id }
  - http:
      url: "{{APP_API}}/charges/{{charge}}"
      expect: { json: { state: charging } }
  - http: { url: "{{APP_API}}/text" }
`),
        'http#1',
        options(api),
      );
      expect(result.status).toBe('passed');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/charges',
          auth: 'Bearer s3cret-token',
          body: '{"station":"SIM-HTTP","connector":1}',
        },
        { method: 'GET', url: '/charges/c-1', body: '' },
        { method: 'GET', url: '/text', body: '' },
      ]);
    },
  );

  it(
    'fails on unexpected statuses and bodies, masking secrets in the report',
    { timeout: 20_000 },
    async () => {
      const api = await startApp();
      const wrongStatus = await runScenario(
        scenario(`
  - http: { url: "{{APP_API}}/broken" }
`),
        'a#1',
        options(api),
      );
      expect(wrongStatus.steps[0]).toMatchObject({
        status: 'failed',
        message: `GET ${api}/broken answered 500, expected a 2xx status`,
        details: ['body: {"error":"boom"}'],
      });

      const wrongBody = await runScenario(
        scenario(`
  - http:
      url: "{{APP_API}}/charges/c-1"
      headers: { Authorization: "{{env.APP_TOKEN}}" }
      expect: { json: { state: done, token: nope } }
`),
        'b#1',
        options(api),
      );
      expect(wrongBody.steps[0]).toMatchObject({
        status: 'failed',
        message: 'the response did not match',
        details: [
          '$.json.state: expected "done", found "charging"',
          '$.json.token: expected "nope", found "***"',
        ],
      });

      const notJson = await runScenario(
        scenario(`
  - http: { url: "{{APP_API}}/text", expect: { json: { a: 1 } } }
`),
        'c#1',
        options(api),
      );
      expect(notJson.steps[0]?.message).toBe('the response is not JSON');

      const unreachable = await runScenario(
        scenario(`
  - http: { url: "http://127.0.0.1:9/nothing" }
`),
        'd#1',
        options(api),
      );
      expect(unreachable.steps[0]?.message).toMatch(
        /^GET http:\/\/127\.0\.0\.1:9\/nothing failed: /,
      );

      const missingEnv = await runScenario(
        scenario(`
  - http: { url: "{{APP_API}}/text", headers: { X-Key: "{{env.NOT_SET}}" } }
`),
        'e#1',
        options(api),
      );
      expect(missingEnv.steps[0]?.message).toBe('environment variable NOT_SET is not set');
    },
  );
});
