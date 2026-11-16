import { describe, expect, it } from 'vitest';
import {
  checkTariff,
  conditionsHold,
  createCostMeter,
  localTime,
  type Tariff21,
  type TariffPlace,
  type TariffSituation,
} from './tariff-cost.js';

const T0 = Date.parse('2026-11-16T08:30:00Z'); // 21:30 in Auckland (NZDT, UTC+13)
const UTC: TariffPlace = { timeZone: 'UTC', evseKind: 'AC' };
const NZ: TariffPlace = { timeZone: 'Pacific/Auckland', evseKind: 'AC' };
const GST = [{ type: 'GST', tax: 15 }];
const MIN = 60_000;

const at = (
  ms: number,
  energyWh: number,
  charging: boolean,
  extra: Partial<TariffSituation> = {},
): TariffSituation => ({
  at: T0 + ms,
  energyWh,
  powerW: charging ? 7200 : 0,
  currentA: charging ? 31.3 : 0,
  durationS: ms / 1000,
  chargingS: 0,
  idleS: 0,
  charging,
  ...extra,
});

describe('local time', () => {
  it('knows the date, weekday and minute in a time zone', () => {
    expect(localTime(T0, 'Pacific/Auckland')).toMatchObject({
      date: '2026-11-16',
      weekday: 'Monday',
      minute: 21 * 60 + 30,
    });
    expect(localTime(T0, 'UTC')).toMatchObject({ date: '2026-11-16', minute: 8 * 60 + 30 });
  });
});

describe('tariff conditions', () => {
  const s = at(0, 0, true);
  it('treat a window that ends before it starts as one across midnight, 00:00 as the end of the day', () => {
    expect(conditionsHold({ startTimeOfDay: '21:00', endTimeOfDay: '07:00' }, s, NZ)).toBe(true);
    expect(conditionsHold({ startTimeOfDay: '07:00', endTimeOfDay: '21:00' }, s, NZ)).toBe(false);
    expect(conditionsHold({ startTimeOfDay: '21:00', endTimeOfDay: '00:00' }, s, NZ)).toBe(true);
    expect(conditionsHold({ dayOfWeek: ['Monday'] }, s, NZ)).toBe(true);
    expect(conditionsHold({ dayOfWeek: ['Sunday'] }, s, NZ)).toBe(false);
  });

  it('take dates from as inclusive and to as exclusive, and minimums inclusive and maximums exclusive', () => {
    expect(conditionsHold({ validFromDate: '2026-11-16', validToDate: '2026-11-17' }, s, NZ)).toBe(
      true,
    );
    expect(conditionsHold({ validToDate: '2026-11-16' }, s, NZ)).toBe(false);
    expect(conditionsHold({ minEnergy: 0, maxEnergy: 1 }, s, NZ)).toBe(true);
    expect(conditionsHold({ minPower: 7200 }, s, NZ)).toBe(true);
    expect(conditionsHold({ maxPower: 7200 }, s, NZ)).toBe(false);
    expect(conditionsHold({ evseKind: 'DC' }, s, NZ)).toBe(false);
  });
});

describe('checking a tariff', () => {
  const limits = { maxElements: 2, conditionsSupported: true };
  it('names what the station cannot take', () => {
    const base: Tariff21 = { tariffId: 'T', currency: 'NZD' };
    expect(checkTariff({ ...base, energy: { prices: [{ priceKwh: 0.3 }] } }, limits)).toEqual({
      status: 'Accepted',
    });
    expect(
      checkTariff(
        { ...base, energy: { prices: [{ priceKwh: 1 }, { priceKwh: 2 }, { priceKwh: 3 }] } },
        limits,
      ),
    ).toMatchObject({ status: 'TooManyElements' });
    expect(
      checkTariff(
        {
          ...base,
          idleTime: { prices: [{ priceMinute: 1, conditions: { dayOfWeek: ['Monday'] } }] },
        },
        { ...limits, conditionsSupported: false },
      ),
    ).toMatchObject({ status: 'ConditionNotSupported' });
    expect(
      checkTariff(
        { ...base, energy: { prices: [{ priceKwh: 1, conditions: { startTimeOfDay: '7:00' } }] } },
        limits,
      ),
    ).toMatchObject({ status: 'Rejected' });
    expect(checkTariff({ ...base, currency: 'nzd' }, limits)).toMatchObject({ status: 'Rejected' });
  });
});

describe('the cost of a transaction', () => {
  it('prices the fixed fee, energy, charging time and idle time, with tax', () => {
    // Hand-checked: fixed 1.00 + 15% = 1.15; 3.6 kWh x 0.30 = 1.08 + 15% = 1.242 -> 1.24;
    // 30 min x 0.05 = 1.50; 10 min idle x 0.50 = 5.00. Totals 8.58 and 8.89.
    const tariff: Tariff21 = {
      tariffId: 'T-1',
      currency: 'NZD',
      fixedFee: { prices: [{ priceFixed: 1 }], taxRates: GST },
      energy: { prices: [{ priceKwh: 0.3 }], taxRates: GST },
      chargingTime: { prices: [{ priceMinute: 0.05 }] },
      idleTime: { prices: [{ priceMinute: 0.5 }] },
    };
    const meter = createCostMeter({ tariff, place: UTC, start: at(0, 0, true) });
    meter.advance(at(30 * MIN, 3600, false));
    meter.advance(at(40 * MIN, 3600, false));
    const details = meter.details(true);
    expect(details.totalCost).toEqual({
      currency: 'NZD',
      typeOfCost: 'NormalCost',
      fixed: { exclTax: 1, inclTax: 1.15, taxRates: GST },
      energy: { exclTax: 1.08, inclTax: 1.24, taxRates: GST },
      chargingTime: { exclTax: 1.5, inclTax: 1.5 },
      idleTime: { exclTax: 5, inclTax: 5 },
      total: { exclTax: 8.58, inclTax: 8.89 },
    });
    expect(details.totalUsage).toEqual({ energy: 3600, chargingTime: 1800, idleTime: 600 });
    expect(details.chargingPeriods).toEqual([
      {
        tariffId: 'T-1',
        startPeriod: new Date(T0).toISOString(),
        dimensions: [
          { type: 'Energy', volume: 3600 },
          { type: 'ChargingTime', volume: 1800 },
          { type: 'IdleTIme', volume: 600 },
        ],
      },
    ]);
    // Running costs carry no charging periods (I12.FR.02, errata 2025-09).
    expect(meter.details(false).chargingPeriods).toBeUndefined();
    expect(meter.totalInclTax()).toBeCloseTo(8.892, 6);
  });

  it('starts a charging period when the price changes at 22:00 local time', () => {
    // Hand-checked: 21:30 to 22:00 3.6 kWh x 0.45 = 1.62; 22:00 to 22:30 3.6 kWh x 0.25 = 0.90.
    const tariff: Tariff21 = {
      tariffId: 'TOU',
      currency: 'NZD',
      energy: {
        prices: [
          { priceKwh: 0.45, conditions: { startTimeOfDay: '07:00', endTimeOfDay: '22:00' } },
          { priceKwh: 0.25 },
        ],
      },
    };
    const meter = createCostMeter({ tariff, place: NZ, start: at(0, 0, true) });
    expect(meter.nextChange()).toBe(Date.parse('2026-11-16T09:00:00Z'));
    meter.advance(at(30 * MIN, 3600, true));
    meter.advance(at(60 * MIN, 7200, true));
    const details = meter.details(true);
    expect(details.totalCost.energy).toEqual({ exclTax: 2.52, inclTax: 2.52 });
    expect(details.chargingPeriods?.map((p) => [p.startPeriod, p.dimensions?.[0]?.volume])).toEqual(
      [
        ['2026-11-16T08:30:00.000Z', 3600],
        ['2026-11-16T09:00:00.000Z', 3600],
      ],
    );
  });

  it('caps the total at maxCost exactly and keeps counting the usage (I12.FR.39, .40)', () => {
    const tariff: Tariff21 = {
      tariffId: 'CAP',
      currency: 'NZD',
      energy: { prices: [{ priceKwh: 0.5 }] },
      maxCost: { exclTax: 2 },
    };
    const meter = createCostMeter({ tariff, place: UTC, start: at(0, 0, true) });
    meter.advance(at(60 * MIN, 10_000, true));
    expect(meter.details(true)).toMatchObject({
      totalCost: {
        typeOfCost: 'MaxCost',
        energy: { exclTax: 2 },
        total: { exclTax: 2, inclTax: 2 },
      },
      totalUsage: { energy: 10_000 },
    });
  });

  it('replaces a lower total with minCost at the end only (I12.FR.38)', () => {
    const tariff: Tariff21 = {
      tariffId: 'MIN',
      currency: 'NZD',
      energy: { prices: [{ priceKwh: 0.3 }] },
      minCost: { exclTax: 2, inclTax: 2.3 },
    };
    const meter = createCostMeter({ tariff, place: UTC, start: at(0, 0, true) });
    meter.advance(at(10 * MIN, 1000, true));
    expect(meter.details(false).totalCost).toMatchObject({
      typeOfCost: 'NormalCost',
      total: { exclTax: 0.3 },
    });
    expect(meter.details(true).totalCost).toEqual({
      currency: 'NZD',
      typeOfCost: 'MinCost',
      fixed: { exclTax: 2, inclTax: 2.3 },
      total: { exclTax: 2, inclTax: 2.3 },
    });
    expect(meter.totalInclTax(true)).toBe(2.3);
  });

  it('stacks taxes: same stack on the same base, a higher stack on the taxed amount (I12.FR.13)', () => {
    // 2.50 with 6% + 4% = 2.75; then 10% of 2.75 = 3.025 -> 3.03.
    const tariff: Tariff21 = {
      tariffId: 'TAX',
      currency: 'EUR',
      fixedFee: {
        prices: [{ priceFixed: 2.5 }],
        taxRates: [
          { type: 'A', tax: 6 },
          { type: 'B', tax: 4 },
          { type: 'C', tax: 10, stack: 1 },
        ],
      },
    };
    const meter = createCostMeter({ tariff, place: UTC, start: at(0, 0, true) });
    expect(meter.details(true).totalCost.total).toEqual({ exclTax: 2.5, inclTax: 3.03 });
  });

  it('changes the tariff from now on, without the new fixed fee (I11.FR.08)', () => {
    const first: Tariff21 = {
      tariffId: 'A',
      currency: 'NZD',
      fixedFee: { prices: [{ priceFixed: 1 }] },
      energy: { prices: [{ priceKwh: 0.3 }] },
    };
    const meter = createCostMeter({ tariff: first, place: UTC, start: at(0, 0, true) });
    meter.advance(at(10 * MIN, 1000, true));
    meter.changeTariff({
      ...first,
      tariffId: 'B',
      fixedFee: { prices: [{ priceFixed: 5 }] },
      energy: { prices: [{ priceKwh: 0.6 }] },
    });
    meter.advance(at(20 * MIN, 2000, true));
    const details = meter.details(true);
    // 1.00 + 1 kWh x 0.30 + 1 kWh x 0.60.
    expect(details.totalCost.total).toEqual({ exclTax: 1.9, inclTax: 1.9 });
    expect(details.chargingPeriods?.map((p) => p.tariffId)).toEqual(['A', 'B']);
  });

  it('chooses a fixed fee by the payment brand at the start (C18)', () => {
    const tariff: Tariff21 = {
      tariffId: 'ADHOC',
      currency: 'NZD',
      fixedFee: {
        prices: [{ priceFixed: 0.5, conditions: { paymentBrand: 'Visa' } }, { priceFixed: 0 }],
      },
    };
    const visa = createCostMeter({
      tariff,
      place: { ...UTC, payment: { brand: 'Visa' } },
      start: at(0, 0, true),
    });
    const card = createCostMeter({ tariff, place: UTC, start: at(0, 0, true) });
    expect(visa.details(true).totalCost.total.exclTax).toBe(0.5);
    expect(card.details(true).totalCost.total.exclTax).toBe(0);
  });
});
