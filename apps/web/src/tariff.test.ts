import { describe, expect, it } from 'vitest';
import type { ReferenceTariff } from './api.js';
import { formatMoney, formToTariff, tariffToForm } from './tariff.js';

const TARIFF: ReferenceTariff = {
  tariffId: 'reference',
  currency: 'NZD',
  fixedFee: { prices: [{ priceFixed: 1 }], taxRates: [{ type: 'GST', tax: 15 }] },
  energy: { prices: [{ priceKwh: 0.35 }], taxRates: [{ type: 'GST', tax: 15 }] },
  idleTime: { prices: [{ priceMinute: 0.5 }], taxRates: [{ type: 'GST', tax: 15 }] },
  maxCost: { exclTax: 80 },
};

describe('the tariff form', () => {
  it('turns a tariff into fields and back', () => {
    const form = tariffToForm(TARIFF);
    expect(form).toEqual({
      currency: 'NZD',
      fixedFee: '1',
      priceKwh: '0.35',
      offPeakKwh: '',
      offPeakFrom: '',
      offPeakTo: '',
      chargingMinute: '',
      idleMinute: '0.5',
      taxName: 'GST',
      taxPercent: '15',
      minCost: '',
      maxCost: '80',
    });
    expect(formToTariff(form)).toEqual({ tariff: TARIFF });
  });

  it('leaves out empty parts and tax, and refuses bad numbers', () => {
    const form = { ...tariffToForm(TARIFF), taxPercent: '', fixedFee: '', maxCost: '' };
    expect(formToTariff(form)).toEqual({
      tariff: {
        tariffId: 'reference',
        currency: 'NZD',
        energy: { prices: [{ priceKwh: 0.35 }] },
        idleTime: { prices: [{ priceMinute: 0.5 }] },
      },
    });
    expect(formToTariff({ ...form, priceKwh: '-1' })).toEqual({
      problem: 'The price per kWh must be a number of at least 0',
    });
    expect(formToTariff({ ...form, currency: 'dollars' })).toEqual({
      problem: 'The currency is an ISO 4217 code such as NZD',
    });
    expect(formatMoney(4.5, 'NZD')).toBe('4.50 NZD');
  });

  it('turns an off-peak price into a time-of-day condition and back', () => {
    const form = {
      ...tariffToForm(TARIFF),
      offPeakKwh: '0.2',
      offPeakFrom: '21:00',
      offPeakTo: '07:00',
    };
    const result = formToTariff(form);
    expect(result).toMatchObject({
      tariff: {
        energy: {
          prices: [
            { priceKwh: 0.2, conditions: { startTimeOfDay: '21:00', endTimeOfDay: '07:00' } },
            { priceKwh: 0.35 },
          ],
        },
      },
    });
    if (!('tariff' in result)) throw new Error(result.problem);
    expect(tariffToForm(result.tariff)).toMatchObject({
      priceKwh: '0.35',
      offPeakKwh: '0.2',
      offPeakFrom: '21:00',
      offPeakTo: '07:00',
    });
    expect(formToTariff({ ...form, offPeakTo: '7am' })).toEqual({
      problem: 'The off-peak hours are HH:MM to HH:MM',
    });
    expect(formToTariff({ ...form, priceKwh: '' })).toEqual({
      problem: 'An off-peak price needs the price per kWh too',
    });
  });
});
