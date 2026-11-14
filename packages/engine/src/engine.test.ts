import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from './engine.js';

describe('engine HTTP API', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it('reports health with the supported OCPP subprotocols', async () => {
    engine = createEngine({ port: 0 });
    const { url } = await engine.start();

    const res = await fetch(`${url}/api/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', ocpp: ['ocpp1.6'] });
  });

  it('answers 404 for unknown routes', async () => {
    engine = createEngine({ port: 0 });
    const { url } = await engine.start();

    const res = await fetch(`${url}/api/nope`);

    expect(res.status).toBe(404);
  });
});
