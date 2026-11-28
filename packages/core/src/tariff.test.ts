import { describe, expect, it } from 'vitest';
import { createSessionTracker, type SessionFrame, type SessionRecord } from './session.js';
import {
  deliveredWh,
  priceSession,
  tariffProblems,
  taxOn,
  type ReferenceTariff,
} from './tariff.js';

const TARIFF: ReferenceTariff = {
  tariffId: 'reference',
  currency: 'NZD',
  fixedFee: { prices: [{ priceFixed: 1 }] },
  energy: { prices: [{ priceKwh: 0.35 }], taxRates: [{ type: 'GST', tax: 15 }] },
  chargingTime: { prices: [{ priceMinute: 0.02 }] },
  idleTime: { prices: [{ priceMinute: 0.5 }] },
};

/**
 * A 1.6 session from frames: a remote start at 10:00, charging 12.4 kWh
 * until 11:00, SuspendedEV (full) until 11:20, stopped at 11:20.
 */
function session16(): SessionRecord {
  const tracker = createSessionTracker({ stationId: 'CP-1', ocpp: '1.6' });
  let seq = 0;
  let last: SessionRecord | undefined;
  const feed = (frame: Omit<SessionFrame, 'seq'>) => {
    for (const touch of tracker.frame({ ...frame, seq: ++seq })) last = touch.session;
  };
  const call = (
    at: string,
    action: string,
    payload: object,
    id: string,
    direction: SessionFrame['direction'] = 'cp-to-csms',
  ) => feed({ at, direction, messageType: 2, uniqueId: id, action, payload });
  const answer = (
    at: string,
    action: string,
    payload: object,
    id: string,
    direction: SessionFrame['direction'] = 'csms-to-cp',
  ) => feed({ at, direction, messageType: 3, uniqueId: id, action, payload });
  call(
    '2026-11-15T10:00:00Z',
    'RemoteStartTransaction',
    { idTag: 'APP', connectorId: 1 },
    'r',
    'csms-to-cp',
  );
  answer(
    '2026-11-15T10:00:00Z',
    'RemoteStartTransaction',
    { status: 'Accepted' },
    'r',
    'cp-to-csms',
  );
  call(
    '2026-11-15T10:00:00Z',
    'StartTransaction',
    { connectorId: 1, idTag: 'APP', meterStart: 1000, timestamp: '2026-11-15T10:00:00Z' },
    's',
  );
  answer(
    '2026-11-15T10:00:01Z',
    'StartTransaction',
    { transactionId: 7, idTagInfo: { status: 'Accepted' } },
    's',
  );
  call(
    '2026-11-15T10:00:01Z',
    'StatusNotification',
    { connectorId: 1, status: 'Charging', errorCode: 'NoError', timestamp: '2026-11-15T10:00:00Z' },
    'c',
  );
  call(
    '2026-11-15T10:30:00Z',
    'MeterValues',
    {
      connectorId: 1,
      transactionId: 7,
      meterValue: [{ timestamp: '2026-11-15T10:30:00Z', sampledValue: [{ value: '7200' }] }],
    },
    'm',
  );
  call(
    '2026-11-15T11:00:00Z',
    'StatusNotification',
    {
      connectorId: 1,
      status: 'SuspendedEV',
      errorCode: 'NoError',
      timestamp: '2026-11-15T11:00:00Z',
    },
    'e',
  );
  call(
    '2026-11-15T11:20:00Z',
    'StopTransaction',
    {
      transactionId: 7,
      meterStop: 13_400,
      timestamp: '2026-11-15T11:20:00Z',
      reason: 'EVDisconnected',
    },
    'x',
  );
  answer('2026-11-15T11:20:01Z', 'StopTransaction', {}, 'x');
  return last as SessionRecord;
}

describe('reference tariff', () => {
  it('accepts a 2.1 TariffType without conditions and says what is wrong otherwise', () => {
    expect(tariffProblems(TARIFF)).toEqual([]);
    expect(
      tariffProblems({ ...TARIFF, minCost: { exclTax: 2 }, maxCost: { inclTax: 80 } }),
    ).toEqual([]);
    expect(tariffProblems('free')).toEqual(['a tariff must be an object']);
    expect(
      tariffProblems({
        tariffId: '',
        currency: 'dollars',
        energy: { prices: [{ priceKwh: -1 }, { priceKwh: 2 }] },
        idleTime: { prices: [{ priceMinute: 1, conditions: { paymentBrand: 'Visa' } }] },
        chargingTime: { prices: [{ priceMinute: 1 }], taxRates: [{ tax: 15 }] },
        reservationTime: { prices: [] },
        surcharge: 1,
        minCost: { exclTax: 10 },
        maxCost: { exclTax: 5 },
      }),
    ).toEqual([
      'tariffId must be a string of 1 to 60 characters',
      'currency must be an ISO 4217 code such as NZD',
      'reservationTime is not supported yet',
      'unknown field surcharge',
      'energy.prices: priceKwh must be a number of at least 0',
      'chargingTime.taxRates: each needs a type, a tax of at least 0 and an optional stack',
      "idleTime.prices: condition paymentBrand is not one of idleTime's",
      'minCost must not be above maxCost',
    ]);
  });

  it('takes every 2.1 condition, on every part, and checks their values', () => {
    const offPeak = {
      ...TARIFF,
      energy: {
        prices: [
          { priceKwh: 0.2, conditions: { startTimeOfDay: '21:00', endTimeOfDay: '07:00' } },
          { priceKwh: 0.35 },
        ],
      },
    };
    expect(tariffProblems(offPeak)).toEqual([]);
    expect(
      tariffProblems({
        ...TARIFF,
        energy: {
          prices: [
            {
              priceKwh: 0.2,
              conditions: { startTimeOfDay: '9pm', minPower: -1, dayOfWeek: ['Funday'] },
            },
            { priceKwh: 0.3, conditions: { dayOfWeek: ['Monday'], evseKind: 'Wireless' } },
          ],
        },
      }),
    ).toEqual([
      'energy.prices: startTimeOfDay must be HH:MM',
      'energy.prices: dayOfWeek must list days such as Monday',
      'energy.prices: minPower must be a number of at least 0',
      'energy.prices: evseKind must be AC or DC',
    ]);
    // Charging and idle time by duration, a fixed fee by payment brand, a last price with conditions.
    expect(
      tariffProblems({
        ...TARIFF,
        fixedFee: {
          prices: [{ priceFixed: 0, conditions: { paymentBrand: 'Visa' } }, { priceFixed: 1 }],
        },
        chargingTime: { prices: [{ priceMinute: 0.05, conditions: { minChargingTime: 3600 } }] },
        idleTime: {
          prices: [
            { priceMinute: 0, conditions: { maxIdleTime: 600 } },
            { priceMinute: 0.5, conditions: { minIdleTime: 600, maxPower: 100 } },
          ],
        },
        minCost: { exclTax: 2, taxRates: [{ type: 'GST', tax: 15 }] },
      }),
    ).toEqual([]);
  });

  it('prices energy by the time of each stretch between readings, in the station time zone', () => {
    // 2026-11-16 08:00Z is 21:00 in Auckland: 3 kWh before, 2 kWh after.
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 16, h, m)).toISOString();
    const record: SessionRecord = {
      stationId: 'CP-1',
      n: 1,
      ocpp: '2.1',
      state: 'finished',
      source: 'local',
      requestedAt: at(7),
      startedAt: at(7),
      endedAt: at(9),
      meterStartWh: 0,
      meterStartSeq: 1,
      meterStopWh: 5000,
      meterStopSeq: 9,
      timeline: [],
      samples: [
        { at: at(7, 30), seq: 4, energyWh: 1500 },
        { at: at(8), seq: 6, energyWh: 3000 },
        { at: at(8, 30), seq: 8, energyWh: 4000 },
      ],
      truth: [],
      states: [],
      costs: [],
    };
    const tou: ReferenceTariff = {
      tariffId: 'TOU',
      currency: 'NZD',
      energy: {
        prices: [
          { priceKwh: 0.2, conditions: { startTimeOfDay: '21:00', endTimeOfDay: '07:00' } },
          { priceKwh: 0.4 },
        ],
      },
    };
    const price = priceSession(record, tou, at(9), { timeZone: 'Pacific/Auckland' });
    expect(
      price.items.map((i) => [i.quantity, i.unitPrice, i.exclTax, i.conditions?.startTimeOfDay]),
    ).toEqual([
      [2, 0.2, 0.4, '21:00'],
      [3, 0.4, 1.2, undefined],
    ]);
    // In UTC (the default) it is all daytime.
    expect(priceSession(record, tou, at(9)).items.map((i) => [i.quantity, i.unitPrice])).toEqual([
      [5, 0.4],
    ]);
  });

  it('stacks taxes: a higher stack also taxes the taxes below it', () => {
    expect(taxOn(10, [{ type: 'GST', tax: 15 }])).toBe(1.5);
    expect(
      taxOn(10, [
        { type: 'A', tax: 10 },
        { type: 'B', tax: 5 },
      ]),
    ).toBe(1.5);
    expect(
      taxOn(10, [
        { type: 'A', tax: 10 },
        { type: 'B', tax: 10, stack: 1 },
      ]),
    ).toBe(2.1);
    expect(taxOn(10)).toBe(0);
  });

  it('prices a finished session from its reported values, item by item with their frames', () => {
    const record = session16();
    expect(record).toMatchObject({ state: 'finished', meterStartWh: 1000, meterStopWh: 13_400 });
    expect(deliveredWh(record)).toEqual({
      wh: 12_400,
      frames: [record.meterStartSeq, record.meterStopSeq],
    });
    const price = priceSession(record, TARIFF, '2026-11-15T12:00:00Z');
    expect(
      price.items.map(({ part, quantity, exclTax, tax, inclTax }) => ({
        part,
        quantity,
        exclTax,
        tax,
        inclTax,
      })),
    ).toEqual([
      { part: 'fixedFee', quantity: 1, exclTax: 1, tax: 0, inclTax: 1 },
      { part: 'energy', quantity: 12.4, exclTax: 4.34, tax: 0.65, inclTax: 4.99 },
      { part: 'chargingTime', quantity: 60, exclTax: 1.2, tax: 0, inclTax: 1.2 },
      { part: 'idleTime', quantity: 20, exclTax: 10, tax: 0, inclTax: 10 },
    ]);
    expect(price).toMatchObject({ currency: 'NZD', exclTax: 16.54, tax: 0.65, inclTax: 17.19 });
    expect(price.adjusted).toBeUndefined();
    // Every item points to the frames it used.
    expect(price.items.find((i) => i.part === 'fixedFee')?.frames).toEqual([3]);
    // Energy names every reading it came from: the start, the meter values, the stop.
    expect(price.items.find((i) => i.part === 'energy')?.frames).toEqual([3, 6, 8]);
    expect(price.items.find((i) => i.part === 'chargingTime')?.frames).toEqual([5]);
    expect(price.items.find((i) => i.part === 'idleTime')?.frames).toEqual([7]);
    // A grace period leaves the first idle minutes unpriced; a longer one, all of them.
    const graced = priceSession(record, TARIFF, '2026-11-15T12:00:00Z', { idleGraceMinutes: 15 });
    expect(graced.items.find((i) => i.part === 'idleTime')).toMatchObject({
      quantity: 5,
      exclTax: 2.5,
    });
    expect(graced.inclTax).toBe(9.69);
    const free = priceSession(record, TARIFF, '2026-11-15T12:00:00Z', { idleGraceMinutes: 30 });
    expect(free.items.find((i) => i.part === 'idleTime')).toMatchObject({
      quantity: 0,
      exclTax: 0,
    });
  });

  it('prices a running session up to now from its first and latest readings', () => {
    const record = session16();
    const running: SessionRecord = {
      ...record,
      state: 'running',
      samples: [
        { at: '2026-11-15T10:10:00Z', seq: 1, energyWh: 2000 },
        { at: '2026-11-15T10:40:00Z', seq: 2, energyWh: 5000 },
      ],
      states: record.states.slice(0, 1),
    };
    delete running.endedAt;
    delete running.meterStartWh;
    delete running.meterStopWh;
    const price = priceSession(running, TARIFF, '2026-11-15T10:45:00Z');
    expect(price.items.find((i) => i.part === 'energy')).toMatchObject({
      quantity: 3,
      frames: [1, 2],
    });
    expect(price.items.find((i) => i.part === 'chargingTime')?.quantity).toBe(45);
    expect(price.items.find((i) => i.part === 'idleTime')?.quantity).toBe(0);
  });

  it('applies minCost and maxCost to the total before tax', () => {
    const record = session16();
    const low = priceSession(
      record,
      { ...TARIFF, minCost: { exclTax: 30 } },
      '2026-11-15T12:00:00Z',
    );
    // As on a 2.1 station: minCost replaces the total at the end, taxed by its own rates (I12.FR.38).
    expect(low).toMatchObject({ exclTax: 30, tax: 0, inclTax: 30, adjusted: 'minCost' });
    const taxedMin = priceSession(
      record,
      { ...TARIFF, minCost: { exclTax: 30, taxRates: [{ type: 'GST', tax: 15 }] } },
      '2026-11-15T12:00:00Z',
    );
    expect(taxedMin).toMatchObject({ exclTax: 30, tax: 4.5, inclTax: 34.5 });
    // A running session is not raised to minCost yet.
    const running: SessionRecord = { ...record, state: 'running' };
    delete running.endedAt;
    expect(
      priceSession(running, { ...TARIFF, minCost: { exclTax: 30 } }, '2026-11-15T10:30:00Z')
        .adjusted,
    ).toBeUndefined();
    // maxCost stops the price where it is reached: here in the idle time, after all the energy
    // and its tax (I12.FR.39, .40).
    const high = priceSession(
      record,
      { ...TARIFF, maxCost: { exclTax: 10 } },
      '2026-11-15T12:00:00Z',
    );
    expect(high).toMatchObject({ exclTax: 10, tax: 0.65, inclTax: 10.65, adjusted: 'maxCost' });
  });

  it('charges nothing for a session that never started', () => {
    const notStarted: SessionRecord = { ...session16(), state: 'not-started' };
    expect(
      priceSession(notStarted, { ...TARIFF, minCost: { exclTax: 2 } }, '2026-11-15T12:00:00Z'),
    ).toMatchObject({
      items: [],
      exclTax: 0,
      tax: 0,
      inclTax: 0,
    });
    // A tariff with only some parts prices only those.
    const energyOnly: ReferenceTariff = {
      tariffId: 'e',
      currency: 'NZD',
      energy: { prices: [{ priceKwh: 0.5 }] },
    };
    expect(
      priceSession(session16(), energyOnly, '2026-11-15T12:00:00Z').items.map((i) => i.part),
    ).toEqual(['energy']);
  });
});
