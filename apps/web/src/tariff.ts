/**
 * The tariff editor's form: the reference tariff as a few fields (one price
 * per part, one tax rate for every part), and back.
 */
import type { ReferenceTariff, TaxRate } from './api.js';

export interface TariffForm {
  currency: string;
  /** Prices as typed; empty leaves the part out. */
  fixedFee: string;
  priceKwh: string;
  chargingMinute: string;
  idleMinute: string;
  /** One tax rate (percent) for every part; empty for none. */
  taxName: string;
  taxPercent: string;
  minCost: string;
  maxCost: string;
}

const str = (value: number | undefined) => (value === undefined ? '' : String(value));

export function tariffToForm(tariff: ReferenceTariff): TariffForm {
  const rate =
    tariff.energy?.taxRates?.[0] ??
    tariff.fixedFee?.taxRates?.[0] ??
    tariff.chargingTime?.taxRates?.[0] ??
    tariff.idleTime?.taxRates?.[0];
  return {
    currency: tariff.currency,
    fixedFee: str(tariff.fixedFee?.prices[0]?.priceFixed),
    priceKwh: str(tariff.energy?.prices[0]?.priceKwh),
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
  return {
    tariff: {
      tariffId: 'reference',
      currency: form.currency,
      ...(v.fixedFee !== undefined && {
        fixedFee: { prices: [{ priceFixed: v.fixedFee }], ...withTax },
      }),
      ...(v.priceKwh !== undefined && {
        energy: { prices: [{ priceKwh: v.priceKwh }], ...withTax },
      }),
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
