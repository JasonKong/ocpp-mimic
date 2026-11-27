import { afterEach, describe, expect, it } from 'vitest';
import { demoBanner, startDemo, type RunningDemo } from './demo.js';

let demo: RunningDemo | undefined;
afterEach(async () => {
  await demo?.stop();
  demo = undefined;
});

async function until(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ocpp-mimic demo', () => {
  it('runs the CSMS and the engine together, and valet works through them', async () => {
    demo = await startDemo({ port: 0, csmsPort: 0 });
    expect(demo.demoUrl).toBe(`${demo.engineUrl}/#/demo`);
    expect(demo.csmsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ocpp$/);
    const engineUrl = demo.engineUrl;
    const post = (path: string, body: unknown) =>
      fetch(`${engineUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect(
      (
        await post('/api/stations', {
          id: 'D-1',
          persona: 'generic-dual-1.6',
          csmsUrl: demo.csmsUrl,
        })
      ).status,
    ).toBe(201);
    expect(
      (await post('/api/stations/D-1/auto-start', { idToken: { idToken: 'VALET' } })).status,
    ).toBe(200);
    await post('/api/stations/D-1/connectors/2/plug', {});
    await until(async () => {
      const station = (await (await fetch(`${engineUrl}/api/stations/D-1`)).json()) as {
        csms?: string;
        connectors: { connectorId: number; transactionId?: number }[];
      };
      return (
        station.csms === 'builtin' &&
        station.connectors.find((c) => c.connectorId === 2)?.transactionId !== undefined
      );
    });
  });

  it('says where the page is, and the CSMS address when it is not the page default', () => {
    const running: RunningDemo = {
      csmsUrl: 'ws://127.0.0.1:9100/ocpp',
      engineUrl: 'http://127.0.0.1:7300',
      demoUrl: 'http://127.0.0.1:7300/#/demo',
      stop: async () => {},
    };
    expect(demoBanner(running, 'ws://127.0.0.1:9100/ocpp')).toBe(
      [
        'ocpp-mimic demo',
        '  Demo page:  http://127.0.0.1:7300/#/demo',
        '  CSMS:       ws://127.0.0.1:9100/ocpp',
        'Ctrl-C stops both.',
      ].join('\n'),
    );
    expect(
      demoBanner({ ...running, csmsUrl: 'ws://127.0.0.1:9300/ocpp' }, 'ws://127.0.0.1:9100/ocpp'),
    ).toContain("Set the page's CSMS field to ws://127.0.0.1:9300/ocpp.");
  });
});
