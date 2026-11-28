import type { SessionRecord } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../engine.js';
import { startBuiltinCsms, type BuiltinCsms } from './builtin-csms.js';
import {
  DEFAULT_TARIFF,
  methodOf,
  parseAccount,
  parsePaymentSettings,
  settle,
  testCard,
  type Account,
} from './payments.js';

const record = (patch: Partial<SessionRecord>) => patch as SessionRecord;
const account = (patch: Partial<Account>): Account => ({
  idToken: 'T',
  card: { brand: 'Visa', last4: '4242' },
  outcome: 'approve',
  billing: 'card',
  ...patch,
});

describe('payment rules', () => {
  it('tells how a session is paid from its token and how it started', () => {
    expect(methodOf(record({ source: 'local', idToken: { idToken: 'C' } }), undefined)).toBe(
      'card',
    );
    expect(methodOf(record({ source: 'remote', idToken: { idToken: 'A' } }), undefined)).toBe(
      'app',
    );
    expect(
      methodOf(
        record({ source: 'noAuth', idToken: { idToken: '', type: 'NoAuthorization' } }),
        undefined,
      ),
    ).toBe('free');
    expect(
      methodOf(record({ source: 'local', idToken: { idToken: 'M', type: 'EVCCID' } }), undefined),
    ).toBe('autocharge');
    expect(
      methodOf(
        record({ source: 'payment', idToken: { idToken: 'P', type: 'DirectPayment' } }),
        undefined,
      ),
    ).toBe('terminal');
    expect(
      methodOf(
        record({
          source: 'payment',
          remoteStartId: 3,
          idToken: { idToken: 'P', type: 'DirectPayment' },
        }),
        undefined,
      ),
    ).toBe('qr');
    // The account decides first: a free vend tag pays nothing, valet bills the site.
    expect(
      methodOf(
        record({ source: 'local', idToken: { idToken: 'HOME' } }),
        account({ billing: 'free' }),
      ),
    ).toBe('free');
    expect(
      methodOf(
        record({ source: 'remote', idToken: { idToken: 'VALET' } }),
        account({ billing: 'site' }),
      ),
    ).toBe('site');
  });

  it('captures the price within the hold, and by the policy beyond it', () => {
    const settings = { overHold: 'recharge' as const, minEnergyWh: 0 };
    expect(settle({ heldAmount: 50 }, 17.194, 5000, settings, 'approve')).toEqual({
      state: 'captured',
      captured: 17.19,
      events: [{ kind: 'capture', amount: 17.19 }],
    });
    // Over the hold: Invisible Urban cancels the hold and charges the whole price.
    expect(settle({ heldAmount: 50 }, 62.5, 5000, settings, 'approve')).toMatchObject({
      captured: 62.5,
      events: [
        { kind: 'cancel', amount: 50 },
        { kind: 'capture', amount: 62.5 },
      ],
    });
    // Stopped at the hold: the hold is what is charged.
    expect(
      settle({ heldAmount: 50 }, 50.4, 5000, { ...settings, overHold: 'stop' }, 'approve'),
    ).toMatchObject({
      captured: 50,
    });
    expect(
      settle({ heldAmount: 50 }, 3, 40, { ...settings, minEnergyWh: 100 }, 'approve'),
    ).toMatchObject({
      state: 'released',
    });
    expect(settle({ heldAmount: 50 }, 0, 5000, settings, 'approve')).toMatchObject({
      state: 'released',
    });
    expect(settle({ heldAmount: 50 }, 12, 5000, settings, 'fail-capture')).toMatchObject({
      state: 'failed',
      events: [{ kind: 'capture-failed', amount: 12 }],
    });
  });

  it('reads settings with the agreed defaults, and accounts with a test card', () => {
    expect(parsePaymentSettings({ stations: ['A'] })).toEqual({
      stations: ['A'],
      settings: {
        tariff: DEFAULT_TARIFF,
        holdAmount: 50,
        overHold: 'recharge',
        minEnergyWh: 0,
        idleGraceMinutes: 0,
      },
    });
    expect(parsePaymentSettings({ stations: [] })).toMatch(/stations/);
    expect(parsePaymentSettings({ stations: ['A'], overHold: 'later' })).toMatch(/overHold/);
    expect(parsePaymentSettings({ stations: ['A'], holdAmount: -1 })).toMatch(/holdAmount/);
    expect(parseAccount('APP-1', { outcome: 'decline' })).toEqual({
      idToken: 'APP-1',
      card: testCard('APP-1'),
      outcome: 'decline',
      billing: 'card',
    });
    expect(parseAccount('X', { card: { brand: 'Visa', last4: '42' } })).toMatch(/card/);
    expect(testCard('APP-1')).toEqual(testCard('APP-1'));
    expect(testCard('APP-1').last4).toMatch(/^\d{4}$/);
  });
});

describe('the built-in CSMS taking payments', () => {
  let engine: Engine | undefined;
  let csms: BuiltinCsms | undefined;
  afterEach(async () => {
    await engine?.stop();
    await csms?.stop();
    engine = undefined;
    csms = undefined;
  });

  async function until(check: () => Promise<boolean>, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  for (const ocpp of ['1.6', '2.0.1'] as const) {
    it(`holds, prices and captures ${ocpp} sessions as the reference price, by account and policy`, async () => {
      csms = await startBuiltinCsms();
      engine = createEngine({ port: 0 });
      const { url } = await engine.start();
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${url}${path}`, {
          method,
          ...(body !== undefined && {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps the assertions short
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      // The engine prices sessions with the same tariff, so the captures can be checked against it.
      await call('PUT', '/api/tariff', { tariff: DEFAULT_TARIFF });
      const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
      for (const id of ids) {
        expect(
          (
            await call('POST', '/api/stations', {
              id,
              persona: `generic-${ocpp}`,
              csmsUrl: csms.url,
              energyMultiplier: 600,
              // Meter values every second, so the prices move while the test watches.
              ...(ocpp === '1.6'
                ? { config: { MeterValueSampleInterval: '1' } }
                : { deviceModel: { SampledDataCtrlr: { TxUpdatedInterval: 1 } } }),
            })
          ).status,
        ).toBe(201);
      }
      for (const id of ids) {
        await until(async () => (await call('GET', `/api/stations/${id}`)).body.csms === 'builtin');
      }
      expect(
        (await call('PUT', '/api/sites/lot/payments', { stations: ['P1', 'P2', 'P3'] })).body,
      ).toMatchObject({
        settings: { holdAmount: 50, overHold: 'recharge' },
      });
      // A small hold that a short session outgrows, stopped at it, on its own site.
      await call('PUT', '/api/sites/tight/payments', {
        stations: ['P4'],
        holdAmount: 1,
        overHold: 'stop',
      });
      // A hold raised as the price nears it, and a card whose capture fails at the end.
      await call('PUT', '/api/sites/grow/payments', {
        stations: ['P5'],
        holdAmount: 1,
        overHold: 'increment',
      });
      await call('PUT', '/api/accounts/CARD-FAIL', { site: 'grow', outcome: 'fail-capture' });
      await call('PUT', '/api/accounts/CARD-DECLINE', { site: 'lot', outcome: 'decline' });
      await call('PUT', '/api/accounts/HOME', { site: 'lot', billing: 'free' });

      const start = async (id: string, idTag: string) => {
        await call('POST', `/api/stations/${id}/connectors/1/plug`, { ev: 'sedan-75kwh' });
        await call('POST', `/api/stations/${id}/connectors/1/id-tag`, { idTag });
      };
      await start('P1', 'CARD-OK');
      await start('P2', 'CARD-DECLINE');
      await start('P3', 'HOME');
      await start('P4', 'CARD-TIGHT');
      await start('P5', 'CARD-FAIL');
      const paymentOf = async (site: string, id: string) =>
        (await call('GET', `/api/sites/${site}/payments`)).body.payments.find(
          (p: { stationId: string }) => p.stationId === id,
        ) as Record<string, unknown> | undefined;
      await until(async () => (await paymentOf('lot', 'P1'))?.state === 'held');
      expect(await paymentOf('lot', 'P1')).toMatchObject({ method: 'card', heldAmount: 50 });
      // A declined card: no hold, and the CSMS stops the session.
      await until(async () => (await paymentOf('lot', 'P2'))?.state === 'declined');
      await until(
        async () =>
          (await call('GET', '/api/stations/P2')).body.connectors[0].transactionId === undefined,
      );
      await until(async () => (await paymentOf('lot', 'P3'))?.state === 'not-charged');
      // The tight session stops itself at its hold and is charged the hold.
      await until(async () => (await paymentOf('tight', 'P4'))?.state === 'captured');
      expect(await paymentOf('tight', 'P4')).toMatchObject({
        capturedAmount: 1,
        stoppedAtHold: true,
      });

      // Let P1 charge a while, then end it: the capture is the reference price to the cent.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await call('POST', '/api/stations/P1/connectors/1/id-tag', { idTag: 'CARD-OK' });
      await until(async () => (await paymentOf('lot', 'P1'))?.state === 'captured');
      const captured = (await paymentOf('lot', 'P1'))?.capturedAmount;
      const detail = (await call('GET', '/api/stations/P1/sessions/1')).body;
      expect(captured).toBeGreaterThan(0.5);
      expect(captured).toBe(detail.price.inclTax);

      await call('POST', '/api/stations/P5/connectors/1/id-tag', { idTag: 'CARD-FAIL' });
      await until(async () => (await paymentOf('grow', 'P5'))?.state === 'failed');
      const grown = (await paymentOf('grow', 'P5')) as {
        heldAmount: number;
        price: { inclTax: number };
      };
      expect(grown.heldAmount).toBeGreaterThan(grown.price.inclTax);
      const grow = (await call('GET', '/api/sites/grow/payments')).body;
      expect(grow.revenue).toBe(0);
      expect(grow.events.map((e: { kind: string }) => e.kind)).toEqual(
        expect.arrayContaining(['hold', 'increment', 'capture-failed']),
      );

      const lot = (await call('GET', '/api/sites/lot/payments')).body;
      expect(lot.revenue).toBe(captured);
      expect(lot.events.map((e: { kind: string }) => e.kind)).toEqual(
        expect.arrayContaining(['hold', 'decline', 'capture']),
      );
      // Load management on the same site id stands apart from its payments.
      expect(
        (await call('PUT', '/api/sites/lot', { stations: ['P1', 'P2', 'P3'], capacityW: 22_000 }))
          .status,
      ).toBe(200);
      expect((await call('DELETE', '/api/sites/lot')).status).toBe(200);
      expect((await call('GET', '/api/sites/lot/payments')).status).toBe(200);
      expect((await call('PUT', '/api/accounts/X', { outcome: 'decline' })).status).toBe(400);
      expect((await call('PUT', '/api/accounts/X', { site: 'nowhere' })).status).toBe(404);
      expect((await call('DELETE', '/api/sites/lot/payments')).status).toBe(200);
      expect((await call('GET', '/api/sites/lot/payments')).status).toBe(404);
    }, 30_000);
  }
});
