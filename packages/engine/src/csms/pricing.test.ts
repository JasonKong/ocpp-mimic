import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReferenceTariff } from '@ocpp-mimic/core';
import { createEngine, type Engine } from '../engine.js';
import { startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';

const TARIFF: ReferenceTariff = {
  tariffId: 'test',
  currency: 'NZD',
  fixedFee: { prices: [{ priceFixed: 1 }] },
  energy: { prices: [{ priceKwh: 0.4 }], taxRates: [{ type: 'GST', tax: 15 }] },
  chargingTime: { prices: [{ priceMinute: 0.05 }] },
};

let engine: Engine | undefined;
let csms: BuiltinCsms | undefined;
let dir: string | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  await csms?.stop();
  csms = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describe('pricing sessions', () => {
  it('keeps the reference tariff over the API, checked and stored', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-tariff-'));
    const storePath = join(dir, 'state.db');
    engine = createEngine({ port: 0, storePath });
    let { url } = await engine.start();
    const call = async (method: string, body?: unknown) => {
      const res = await fetch(`${url}/api/tariff`, {
        method,
        ...(body !== undefined && {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await call('GET')).body.tariff).toMatchObject({ tariffId: 'reference' });
    const bad = await call('PUT', { tariff: { tariffId: 'x', currency: 'dollars' } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('currency must be an ISO 4217 code');
    expect((await call('PUT', { tariff: TARIFF })).body.tariff).toEqual(TARIFF);
    await engine.stop();
    engine = createEngine({ port: 0, storePath });
    ({ url } = await engine.start());
    expect((await call('GET')).body.tariff).toEqual(TARIFF);
  });

  it('has the built-in CSMS price 2.0.1 sessions, and its final cost matches the reference price', async () => {
    csms = await startBuiltinCsms({ tariff: TARIFF, costUpdatedEveryMs: 300 });
    engine = createEngine({ port: 0, backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 } });
    const { url } = await engine.start();
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const get = async (path: string) =>
      (await (await fetch(`${url}${path}`)).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely typed JSON
    await fetch(`${url}/api/tariff`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tariff: TARIFF }),
    });
    await post('/api/stations', {
      id: 'PRICED',
      persona: 'generic-2.0.1',
      csmsUrl: csms.url,
      energyMultiplier: 600,
      deviceModel: { SampledDataCtrlr: { TxUpdatedInterval: 1 } },
    });
    await until(async () => (await get('/api/stations/PRICED')).registration === 'Accepted');
    await post('/api/stations/PRICED/connectors/1/id-tag', { idTag: 'AA000001', type: 'ISO14443' });
    await post('/api/stations/PRICED/connectors/1/plug', { ev: 'compact-40kwh' });
    // Running costs come back with the TransactionEvents and with CostUpdated.
    await until(async () => {
      const costs = (await get('/api/stations/PRICED/sessions/1')).session?.costs ?? [];
      return costs.some((c: { from: string }) => c.from === 'CostUpdated') && costs.length >= 3;
    });
    await post('/api/stations/PRICED/connectors/1/id-tag', { idTag: 'AA000001', type: 'ISO14443' });
    await until(
      async () => (await get('/api/stations/PRICED/sessions/1')).session?.state === 'finished',
    );
    const detail = await get('/api/stations/PRICED/sessions/1');
    const final = detail.session.costs.at(-1);
    expect(final.from).toBe('TransactionEventResponse');
    expect(detail.price.items.map((i: { part: string }) => i.part)).toEqual([
      'fixedFee',
      'energy',
      'chargingTime',
    ]);
    expect(detail.price.inclTax).toBeGreaterThan(1);
    expect(final.totalCost).toBe(detail.price.inclTax);
  });
});
