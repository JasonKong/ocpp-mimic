/**
 * Ad hoc payment helpers (OCPP 2.1 block C): the card details a payment
 * terminal puts in a DirectPayment idToken (C18), and the dynamic QR code of
 * a web payment, its time-based one-time password (TOTP v1) and URL (C25).
 * core has no crypto: the caller passes HMAC-SHA256 (the engine's comes from
 * node:crypto).
 */
import type { AdditionalInfoType } from './messages.js';

/** HMAC-SHA256 of `message` under `key`, the key taken as UTF-8. */
export type HmacSha256 = (key: string, message: Uint8Array) => Uint8Array;

/** The TOTP v1 alphabet. */
export const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The TOTP versions a station computes (WebPaymentsCtrlr.TOTPVersion). */
export const TOTP_VERSIONS = ['v1'] as const;

/** WebPaymentsCtrlr's SharedSecret, ValidityTime (s) and Length. */
export interface TotpSettings {
  sharedSecret: string;
  validityS: number;
  length: number;
}

/** The time interval a moment falls in: floor(unix seconds / ValidityTime). */
export function totpInterval(atMs: number, validityS: number): number {
  return Math.floor(atMs / 1000 / validityS);
}

/**
 * TOTP v1 (C25, "Time-based One-Time password algorithm"): HMAC-SHA256 of
 * the interval as 8 bytes big-endian, then Length base62 characters from the
 * hash bytes, starting at the offset in the low nibble of the last byte.
 */
export function totpV1(settings: TotpSettings, atMs: number, hmac: HmacSha256): string {
  return codeOf(settings, totpInterval(atMs, settings.validityS), hmac);
}

function codeOf(settings: TotpSettings, interval: number, hmac: HmacSha256): string {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(interval / 2 ** 32));
  view.setUint32(4, interval >>> 0);
  const hash = hmac(settings.sharedSecret, message);
  const offset = (hash[hash.length - 1] ?? 0) & 0x0f;
  let code = '';
  for (let i = 0; i < settings.length; i++) {
    code += BASE62[(hash[(offset + i) % hash.length] ?? 0) % BASE62.length];
  }
  return code;
}

/**
 * The CSMS's check of a TOTP from a payment URL: it matches the code of the
 * present interval, or of the one before or after it (clock differences and
 * delays).
 */
export function checkTotpV1(
  code: string,
  settings: TotpSettings,
  atMs: number,
  hmac: HmacSha256,
): boolean {
  const interval = totpInterval(atMs, settings.validityS);
  return [interval, interval - 1, interval + 1].some(
    (candidate) => codeOf(settings, candidate, hmac) === code,
  );
}

/** Limits an EV driver asks for before scanning the code (C25.FR.03 to .06). */
export interface WebPaymentLimits {
  /** Wh. */
  maxEnergy?: number;
  /** Seconds. */
  maxTime?: number;
  /** In the station's currency. */
  maxCost?: number;
}

/** The URL parameters for the limits (WebPaymentsCtrlr.URLParameters valuesList). */
export const WEB_PAYMENT_PARAMETERS = ['maxtime', 'maxenergy', 'maxcost'] as const;
export type WebPaymentParameter = (typeof WEB_PAYMENT_PARAMETERS)[number];

const PARAMETER_OF: Record<keyof WebPaymentLimits, WebPaymentParameter> = {
  maxEnergy: 'maxenergy',
  maxTime: 'maxtime',
  maxCost: 'maxcost',
};

export interface WebPaymentUrlValues {
  /** SecurityCtrlr.Identity (C25.FR.51). */
  chargingStationId: string;
  evseId: number;
  totp: string;
  version: string;
  /** WebPaymentsCtrlr.RoamingEvseId, when the template names it (C25.FR.53). */
  roamingEvseId?: string;
}

/**
 * The payment URL of the dynamic QR code: the template's placeholders filled
 * in (C25.FR.51 to .53) and the driver's limits as query parameters (C25.FR.56
 * to .58), those the station supports.
 */
export function webPaymentUrl(
  template: string,
  values: WebPaymentUrlValues,
  limits: WebPaymentLimits = {},
  supported: readonly string[] = WEB_PAYMENT_PARAMETERS,
): string {
  const fill: Record<string, string | undefined> = {
    chargingstationid: values.chargingStationId,
    evse: String(values.evseId),
    totp: values.totp,
    version: values.version,
    roamingevseid: values.roamingEvseId,
  };
  const url = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = fill[name.toLowerCase()];
    return value === undefined ? whole : encodeURIComponent(value);
  });
  const query = (Object.keys(PARAMETER_OF) as (keyof WebPaymentLimits)[])
    .filter((key) => limits[key] !== undefined && supported.includes(PARAMETER_OF[key]))
    .map((key) => `${PARAMETER_OF[key]}=${String(limits[key])}`);
  if (query.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query.join('&')}`;
}

/** What a payment page reads back from a payment URL. */
export interface ParsedWebPaymentUrl {
  /** The placeholders' values, by lower-case name. */
  values: Record<string, string>;
  limits: WebPaymentLimits;
}

/** Reads a payment URL made from `template`, or undefined when it does not fit (C25.FR.09). */
export function parseWebPaymentUrl(template: string, url: string): ParsedWebPaymentUrl | undefined {
  const [path = '', queryText = ''] = url.split('?', 2);
  const templatePath = template.split('?', 1)[0] ?? '';
  const names: string[] = [];
  const pattern = templatePath
    .split(/(\{\w+\})/)
    .map((part) => {
      const placeholder = /^\{(\w+)\}$/.exec(part);
      if (placeholder?.[1] === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(placeholder[1].toLowerCase());
      return '([^/?#]+)';
    })
    .join('');
  const match = new RegExp(`^${pattern}$`).exec(path);
  if (match === null) return undefined;
  const values: Record<string, string> = {};
  names.forEach((name, i) => {
    values[name] = decodeURIComponent(match[i + 1] ?? '');
  });
  const limits: WebPaymentLimits = {};
  for (const pair of queryText.split('&')) {
    const [key = '', raw = ''] = pair.split('=', 2);
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) continue;
    if (key === 'maxenergy') limits.maxEnergy = value;
    if (key === 'maxtime') limits.maxTime = value;
    if (key === 'maxcost') limits.maxCost = value;
  }
  return { values, limits };
}

/** A payment card as a simulated terminal reads it. Every field has a test default. */
export interface PaymentCard {
  /** Appendix "PaymentBrand", e.g. Visa, Mastercard. Default Visa. */
  brand?: string;
  /** Appendix "PaymentRecognition", e.g. CC, Debit, ApplePay. Default CC. */
  recognition?: string;
  /** Contactless, Contact or Magstripe. Default Contactless. */
  readingMethod?: string;
  /** First 6 digits. Default 411111 (a well-known test card). */
  cardBin?: string;
  /** Last 4 digits. Default 1111. */
  last4?: string;
  /** YYYY/MM. Default 2030/12. */
  expiry?: string;
}

/** A card with the test defaults filled in. */
export function withCardDefaults(card: PaymentCard): Required<PaymentCard> {
  return {
    brand: card.brand ?? 'Visa',
    recognition: card.recognition ?? 'CC',
    readingMethod: card.readingMethod ?? 'Contactless',
    cardBin: card.cardBin ?? '411111',
    last4: card.last4 ?? '1111',
    expiry: card.expiry ?? '2030/12',
  };
}

/** The details the simulated terminal can read (PaymentCtrlr.PaymentDetails valuesList). */
export const PAYMENT_DETAILS = [
  'PaymentBrand',
  'PaymentRecognition',
  'ReadingMethod',
  'CardBin',
  'CardLast4Digits',
  'CardExpiryDate',
] as const;

/**
 * The idToken's additionalInfo for a card: the details PaymentDetails names,
 * in the order it names them (C18.FR.04, .06).
 */
export function paymentInfo(card: PaymentCard, details: readonly string[]): AdditionalInfoType[] {
  const full = withCardDefaults(card);
  const value: Record<string, string> = {
    PaymentBrand: full.brand,
    PaymentRecognition: full.recognition,
    ReadingMethod: full.readingMethod,
    CardBin: full.cardBin,
    CardLast4Digits: full.last4,
    CardExpiryDate: full.expiry,
  };
  return details
    .filter((type) => value[type] !== undefined)
    .map((type) => ({ type, additionalIdToken: value[type] ?? '' }));
}
