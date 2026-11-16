import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkTotpV1,
  parseWebPaymentUrl,
  paymentInfo,
  totpV1,
  webPaymentUrl,
  type HmacSha256,
} from './payment.js';

const hmac: HmacSha256 = (key, message) =>
  new Uint8Array(createHmac('sha256', key).update(message).digest());

// 2026-11-16T08:30:00Z; the expected codes come from an independent Python
// implementation of the spec's pseudocode (hmac, hashlib, struct '>Q').
const T0 = Date.parse('2026-11-16T08:30:00Z');
const SETTINGS = { sharedSecret: 's3cr3t-shared', validityS: 30, length: 8 };

describe('TOTP v1', () => {
  it('matches an independent implementation of the algorithm', () => {
    expect(totpV1(SETTINGS, T0, hmac)).toBe('oE1CORxM');
    expect(totpV1(SETTINGS, T0 + 29_999, hmac)).toBe('oE1CORxM');
    expect(totpV1(SETTINGS, T0 - 1, hmac)).toBe('gXzAOAUc');
    expect(totpV1(SETTINGS, T0 + 30_000, hmac)).toBe('i5invCOF');
    expect(totpV1({ sharedSecret: 'kiwi🥝secret', validityS: 60, length: 6 }, T0, hmac)).toBe(
      'iZVHiR',
    );
  });

  it('is accepted in the interval before and after, not two away', () => {
    expect(checkTotpV1('oE1CORxM', SETTINGS, T0 + 30_000, hmac)).toBe(true);
    expect(checkTotpV1('oE1CORxM', SETTINGS, T0 - 30_000, hmac)).toBe(true);
    expect(checkTotpV1('oE1CORxM', SETTINGS, T0 + 60_000, hmac)).toBe(false);
    expect(checkTotpV1('oE1CORxm', SETTINGS, T0, hmac)).toBe(false);
  });
});

describe('the payment URL', () => {
  const values = { chargingStationId: 'CS 1000', evseId: 1, totp: 'aHicux89', version: 'v1' };

  it('fills in the placeholders and adds the limits the station supports', () => {
    expect(
      webPaymentUrl('https://qr.example.com/{chargingstationid}/{evse}/{totp}/{version}', values, {
        maxEnergy: 20_000,
      }),
    ).toBe('https://qr.example.com/CS%201000/1/aHicux89/v1?maxenergy=20000');
    expect(
      webPaymentUrl(
        'https://qr.example.com/pay?cs={chargingstationid}&code={totp}',
        values,
        { maxCost: 12.34, maxTime: 3600 },
        ['maxcost'],
      ),
    ).toBe('https://qr.example.com/pay?cs=CS%201000&code=aHicux89&maxcost=12.34');
  });

  it('reads back what the station put in', () => {
    const template = 'https://qr.example.com/{chargingstationid}/{evse}/{totp}/{version}';
    const url = webPaymentUrl(template, values, { maxCost: 12.34, maxEnergy: 20_000 });
    expect(parseWebPaymentUrl(template, url)).toEqual({
      values: { chargingstationid: 'CS 1000', evse: '1', totp: 'aHicux89', version: 'v1' },
      limits: { maxCost: 12.34, maxEnergy: 20_000 },
    });
    expect(parseWebPaymentUrl(template, 'https://qr.example.com/CS1000/1/aHicux89')).toBe(
      undefined,
    );
  });
});

describe('payment details', () => {
  it('lists the configured details in their order, with test defaults', () => {
    expect(
      paymentInfo({ brand: 'Mastercard' }, ['CardLast4Digits', 'PaymentBrand', 'Unknown']),
    ).toEqual([
      { type: 'CardLast4Digits', additionalIdToken: '1111' },
      { type: 'PaymentBrand', additionalIdToken: 'Mastercard' },
    ]);
  });
});
