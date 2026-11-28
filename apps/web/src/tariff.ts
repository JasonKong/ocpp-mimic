/**
 * The tariff editor's form: the reference tariff as a few fields (one price
 * per part, one tax rate for every part, and an optional off-peak energy
 * price for a time of day), and back.
 */
import type { ReferenceTariff, TaxRate } from './api.js';

export interface TariffForm {
  currency: string;
  /** Prices as typed; empty leaves the part out. */
  fixedFee: string;
  priceKwh: string;
  /** An energy price for a time of day (2.1 conditions), HH:MM to HH:MM local time. */
  offPeakKwh: string;
  offPeakFrom: string;
  offPeakTo: string;
  chargingMinute: string;
  idleMinute: string;
  /** One tax rate (percent) for every part; empty for none. */
  taxName: string;
  taxPercent: string;
  minCost: string;
  maxCost: string;
}

const str = (value: number | undefined) => (value === undefined ? '' : String(value));

/**
 * Whether the form can show a tariff without losing anything: one price per part (energy may
 * have an off-peak price for a time of day first), one tax rate for every part, and minCost and
 * maxCost before tax. A tariff with other 2.1 conditions is set with PUT /api/tariff.
 */
export function fitsForm(tariff: ReferenceTariff): boolean {
  const single = (part?: { prices: { conditions?: object }[] }) =>
    part === undefined || (part.prices.length === 1 && part.prices[0]?.conditions === undefined);
  const energy = tariff.energy?.prices ?? [];
  const offPeak = energy.length === 2 ? energy[0]?.conditions : undefined;
  const energyFits =
    energy.length <= 1
      ? energy[0]?.conditions === undefined
      : energy.length === 2 &&
        energy[1]?.conditions === undefined &&
        offPeak !== undefined &&
        Object.keys(offPeak).every((k) => k === 'startTimeOfDay' || k === 'endTimeOfDay');
  const rates = [tariff.fixedFee, tariff.energy, tariff.chargingTime, tariff.idleTime]
    .map((p) => p?.taxRates ?? [])
    .filter((r) => r.length > 0);
  const oneRate =
    rates.every((r) => r.length === 1) && new Set(rates.map((r) => JSON.stringify(r[0]))).size <= 1;
  const cost = (c?: { inclTax?: number; taxRates?: unknown }) =>
    c === undefined || (c.inclTax === undefined && c.taxRates === undefined);
  return (
    single(tariff.fixedFee) &&
    single(tariff.chargingTime) &&
    single(tariff.idleTime) &&
    energyFits &&
    oneRate &&
    cost(tariff.minCost) &&
    cost(tariff.maxCost)
  );
}

export function tariffToForm(tariff: ReferenceTariff): TariffForm {
  const prices = tariff.energy?.prices ?? [];
  const timed = prices.length > 1 ? prices[0] : undefined;
  const rate =
    tariff.energy?.taxRates?.[0] ??
    tariff.fixedFee?.taxRates?.[0] ??
    tariff.chargingTime?.taxRates?.[0] ??
    tariff.idleTime?.taxRates?.[0];
  return {
    currency: tariff.currency,
    fixedFee: str(tariff.fixedFee?.prices[0]?.priceFixed),
    priceKwh: str(prices.at(-1)?.priceKwh),
    offPeakKwh: str(timed?.priceKwh),
    offPeakFrom: timed?.conditions?.startTimeOfDay ?? '',
    offPeakTo: timed?.conditions?.endTimeOfDay ?? '',
    chargingMinute: str(tariff.chargingTime?.prices[0]?.priceMinute),
    idleMinute: str(tariff.idleTime?.prices[0]?.priceMinute),
    taxName: rate?.type ?? 'Tax',
    taxPercent: str(rate?.tax),
    minCost: str(tariff.minCost?.exclTax),
    maxCost: str(tariff.maxCost?.exclTax),
  };
}

/** The tariff a form describes, or the first problem with it. */
export function formToTariff(form: TariffForm): { tariff: ReferenceTariff } | { problem: string } {
  const number = (label: string, text: string): number | undefined | string => {
    if (text.trim() === '') return undefined;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : `${label} must be a number of at least 0`;
  };
  const fields = {
    fixedFee: number('The session fee', form.fixedFee),
    priceKwh: number('The price per kWh', form.priceKwh),
    offPeakKwh: number('The off-peak price per kWh', form.offPeakKwh),
    chargingMinute: number('The price per charging minute', form.chargingMinute),
    idleMinute: number('The idle fee', form.idleMinute),
    taxPercent: number('The tax', form.taxPercent),
    minCost: number('The minimum', form.minCost),
    maxCost: number('The maximum', form.maxCost),
  };
  for (const value of Object.values(fields))
    if (typeof value === 'string') return { problem: value };
  const v = fields as Record<keyof typeof fields, number | undefined>;
  if (!/^[A-Z]{3}$/.test(form.currency))
    return { problem: 'The currency is an ISO 4217 code such as NZD' };
  const taxRates: TaxRate[] | undefined =
    v.taxPercent === undefined
      ? undefined
      : [{ type: form.taxName.trim() || 'Tax', tax: v.taxPercent }];
  const withTax = taxRates === undefined ? {} : { taxRates };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (v.offPeakKwh !== undefined) {
    if (v.priceKwh === undefined)
      return { problem: 'An off-peak price needs the price per kWh too' };
    if (!time.test(form.offPeakFrom) || !time.test(form.offPeakTo)) {
      return { problem: 'The off-peak hours are HH:MM to HH:MM' };
    }
  }
  const energyPrices =
    v.priceKwh === undefined
      ? undefined
      : [
          ...(v.offPeakKwh === undefined
            ? []
            : [
                {
                  priceKwh: v.offPeakKwh,
                  conditions: { startTimeOfDay: form.offPeakFrom, endTimeOfDay: form.offPeakTo },
                },
              ]),
          { priceKwh: v.priceKwh },
        ];
  return {
    tariff: {
      tariffId: 'reference',
      currency: form.currency,
      ...(v.fixedFee !== undefined && {
        fixedFee: { prices: [{ priceFixed: v.fixedFee }], ...withTax },
      }),
      ...(energyPrices !== undefined && { energy: { prices: energyPrices, ...withTax } }),
      ...(v.chargingMinute !== undefined && {
        chargingTime: { prices: [{ priceMinute: v.chargingMinute }], ...withTax },
      }),
      ...(v.idleMinute !== undefined && {
        idleTime: { prices: [{ priceMinute: v.idleMinute }], ...withTax },
      }),
      ...(v.minCost !== undefined && { minCost: { exclTax: v.minCost } }),
      ...(v.maxCost !== undefined && { maxCost: { exclTax: v.maxCost } }),
    },
  };
}

/** Money with two decimals and its currency. */
export const formatMoney = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;
