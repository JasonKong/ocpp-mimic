/**
 * A simulated payment provider for the built-in CSMS (M10): what a CSMS that
 * charges drivers itself does with their money, which OCPP never carries. A site's payment settings say how its sessions are priced (the
 * reference tariff, an idle grace period) and paid: an amount held on the
 * driver's card when a session starts, the price captured when it ends, and
 * what happens when the price outgrows the hold. Drivers' cards are made up,
 * with a test outcome each; nothing reaches a real payment provider.
 */
import {
  createSessionTracker,
  priceSession,
  tariffProblems,
  type JsonObject,
  type OcppVersion,
  type ReferenceTariff,
  type SessionFrame,
  type SessionPrice,
  type SessionRecord,
  type SessionTracker,
} from '@ocpp-mimic/core';

/** When the price outgrows the hold: charge it all at the end, raise the hold, or stop there. */
export const OVER_HOLD_POLICIES = ['recharge', 'increment', 'stop'] as const;
export type OverHoldPolicy = (typeof OVER_HOLD_POLICIES)[number];

/** How a test card answers: approve, decline the hold, ask the driver to confirm, fail at capture. */
export const CARD_OUTCOMES = ['approve', 'decline', 'requires-action', 'fail-capture'] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

/** Who pays for a token's sessions: its card, nobody (free vend), or the site (valet). */
export const BILLING = ['card', 'free', 'site'] as const;
export type Billing = (typeof BILLING)[number];

export interface PaymentSettings {
  tariff: ReferenceTariff;
  /** Held on the card when a session starts, in the tariff's currency. */
  holdAmount: number;
  overHold: OverHoldPolicy;
  /** Below this, nothing is charged and the hold is released. */
  minEnergyWh: number;
  /** Idle minutes not charged, from the first idle minute. */
  idleGraceMinutes: number;
}

/** A made-up tariff in NZD: a connection fee, energy and idle time, with GST. */
export const DEFAULT_TARIFF: ReferenceTariff = {
  tariffId: 'DEMO-NZD',
  currency: 'NZD',
  fixedFee: { prices: [{ priceFixed: 0.5 }], taxRates: [{ type: 'GST', tax: 15 }] },
  energy: { prices: [{ priceKwh: 0.4 }], taxRates: [{ type: 'GST', tax: 15 }] },
  idleTime: { prices: [{ priceMinute: 0.2 }], taxRates: [{ type: 'GST', tax: 15 }] },
};

export const DEFAULT_SETTINGS: PaymentSettings = {
  tariff: DEFAULT_TARIFF,
  holdAmount: 50,
  overHold: 'recharge',
  minEnergyWh: 0,
  idleGraceMinutes: 0,
};

export interface Account {
  idToken: string;
  card: { brand: string; last4: string };
  outcome: CardOutcome;
  billing: Billing;
}

/** How a session is paid, as the CSMS can tell from its messages and the token's account. */
export type PaymentMethod = 'card' | 'autocharge' | 'app' | 'qr' | 'terminal' | 'free' | 'site';

export type PaymentState =
  | 'pending'
  | 'requires-action'
  | 'held'
  | 'captured'
  | 'released'
  | 'failed'
  | 'declined'
  | 'not-charged'
  | 'site-account'
  | 'settled-by-station';

export interface PaymentEvent {
  at: string;
  stationId: string;
  evseId?: number;
  kind:
    | 'hold'
    | 'increment'
    | 'capture'
    | 'cancel'
    | 'release'
    | 'decline'
    | 'requires-action'
    | 'capture-failed'
    | 'stop-at-hold'
    | 'settlement'
    | 'notice';
  amount?: number;
  detail?: string;
}

export interface Payment {
  stationId: string;
  /** The session's n on its station. */
  n: number;
  evseId?: number;
  transactionId?: number | string;
  idToken?: string;
  method: PaymentMethod;
  card?: { brand: string; last4: string };
  state: PaymentState;
  /** What is held on the card now. */
  heldAmount: number;
  /** The price so far (or final), tax included, with its items. */
  price?: Pick<SessionPrice, 'items' | 'exclTax' | 'tax' | 'inclTax' | 'currency'>;
  capturedAmount?: number;
  startedAt?: string;
  endedAt?: string;
  /** The session asked for no more power at the hold (policy `stop`). */
  stoppedAtHold?: true;
  /** The driver was told that idle fees start. */
  idleNoticed?: true;
}

const round = (amount: number) => Math.round(amount * 100) / 100;
const deliveredWh = (record: SessionRecord) => {
  const last = record.meterStopWh ?? record.samples.at(-1)?.energyWh;
  return last === undefined || record.meterStartWh === undefined
    ? 0
    : Math.max(0, last - record.meterStartWh);
};

/**
 * How a session is paid: by the token's account, else by how it started. The
 * station's valet token (the CSMS's auto start) is billed to the site.
 */
export function methodOf(
  record: SessionRecord,
  account: Account | undefined,
  valetToken?: string,
): PaymentMethod {
  const type = record.idToken?.type;
  if (type === 'NoAuthorization') return 'free';
  if (account?.billing === 'free') return 'free';
  if (account?.billing === 'site') return 'site';
  if (valetToken !== undefined && record.idToken?.idToken === valetToken) return 'site';
  if (type === 'DirectPayment') return record.remoteStartId === undefined ? 'terminal' : 'qr';
  if (record.source === 'payment') return record.remoteStartId === undefined ? 'terminal' : 'qr';
  if (record.source === 'remote') return 'app';
  if (type === 'MacAddress' || type === 'EVCCID') return 'autocharge';
  return 'card';
}

/**
 * What to do at the end of a session with its final price: how much to
 * capture and the events, by the over-hold policy. A failed capture leaves
 * a debt; below the minimum energy or at a price of 0 the hold is released.
 */
export function settle(
  payment: Pick<Payment, 'heldAmount'>,
  price: number,
  energyWh: number,
  settings: Pick<PaymentSettings, 'overHold' | 'minEnergyWh'>,
  outcome: CardOutcome,
): {
  state: PaymentState;
  captured?: number;
  events: { kind: PaymentEvent['kind']; amount?: number; detail?: string }[];
} {
  const amount = round(price);
  if (amount <= 0 || energyWh < settings.minEnergyWh) {
    return {
      state: 'released',
      events: [
        {
          kind: 'release',
          amount: payment.heldAmount,
          detail: amount <= 0 ? 'nothing to charge' : `under ${settings.minEnergyWh} Wh`,
        },
      ],
    };
  }
  if (outcome === 'fail-capture') {
    return {
      state: 'failed',
      events: [{ kind: 'capture-failed', amount, detail: 'the card refused the capture: a debt' }],
    };
  }
  if (amount <= payment.heldAmount) {
    return { state: 'captured', captured: amount, events: [{ kind: 'capture', amount }] };
  }
  if (settings.overHold === 'stop') {
    // The session stopped at the hold; what it took past it in the meantime is not charged.
    return {
      state: 'captured',
      captured: payment.heldAmount,
      events: [{ kind: 'capture', amount: payment.heldAmount, detail: 'capped at the hold' }],
    };
  }
  // Re-charge (and an increment that fell short): cancel the hold, charge the whole price.
  return {
    state: 'captured',
    captured: amount,
    events: [
      { kind: 'cancel', amount: payment.heldAmount, detail: 'the price outgrew the hold' },
      { kind: 'capture', amount, detail: 'charged in full' },
    ],
  };
}

/** Payment settings from a request body (with the defaults for what is missing), or a problem. */
export function parsePaymentSettings(
  body: Record<string, unknown>,
): { stations: string[]; settings: PaymentSettings } | string {
  const { stations, tariff, holdAmount, overHold, minEnergyWh, idleGraceMinutes } = body;
  if (
    !Array.isArray(stations) ||
    stations.length === 0 ||
    stations.some((s) => typeof s !== 'string' || s === '')
  ) {
    return '"stations" must be a list of station ids';
  }
  if (tariff !== undefined) {
    const problems = tariffProblems(tariff);
    if (problems.length > 0) return `"tariff": ${problems.join('; ')}`;
  }
  const amount = (value: unknown, name: string) =>
    value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      ? undefined
      : `"${name}" must be a number, 0 or more`;
  const problem =
    amount(holdAmount, 'holdAmount') ??
    amount(minEnergyWh, 'minEnergyWh') ??
    amount(idleGraceMinutes, 'idleGraceMinutes');
  if (problem !== undefined) return problem;
  if (overHold !== undefined && !(OVER_HOLD_POLICIES as readonly unknown[]).includes(overHold)) {
    return `"overHold" must be one of ${OVER_HOLD_POLICIES.join(', ')}`;
  }
  return {
    stations: stations as string[],
    settings: {
      tariff: (tariff as ReferenceTariff | undefined) ?? DEFAULT_SETTINGS.tariff,
      holdAmount: (holdAmount as number | undefined) ?? DEFAULT_SETTINGS.holdAmount,
      overHold: (overHold as OverHoldPolicy | undefined) ?? DEFAULT_SETTINGS.overHold,
      minEnergyWh: (minEnergyWh as number | undefined) ?? DEFAULT_SETTINGS.minEnergyWh,
      idleGraceMinutes:
        (idleGraceMinutes as number | undefined) ?? DEFAULT_SETTINGS.idleGraceMinutes,
    },
  };
}

/** An account from a request body, or a problem. */
export function parseAccount(idToken: string, body: Record<string, unknown>): Account | string {
  const card = body.card as Record<string, unknown> | undefined;
  if (
    card !== undefined &&
    (typeof card !== 'object' ||
      card === null ||
      typeof card.brand !== 'string' ||
      !/^\d{4}$/.test(String(card.last4)))
  ) {
    return '"card" must be { brand, last4 } with four digits';
  }
  if (body.outcome !== undefined && !(CARD_OUTCOMES as readonly unknown[]).includes(body.outcome)) {
    return `"outcome" must be one of ${CARD_OUTCOMES.join(', ')}`;
  }
  if (body.billing !== undefined && !(BILLING as readonly unknown[]).includes(body.billing)) {
    return `"billing" must be one of ${BILLING.join(', ')}`;
  }
  return {
    idToken,
    card:
      card === undefined
        ? testCard(idToken)
        : { brand: String(card.brand), last4: String(card.last4) },
    outcome: (body.outcome as CardOutcome | undefined) ?? 'approve',
    billing: (body.billing as Billing | undefined) ?? 'card',
  };
}

/** The test card of a token nobody set up: a Visa whose last four digits come from the token. */
export function testCard(idToken: string): { brand: string; last4: string } {
  let hash = 0;
  for (const char of idToken) hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  return { brand: 'Visa', last4: String(hash).padStart(4, '0') };
}

/** What `GET /api/sites/<id>/payments` answers with. */
export interface PaymentsState {
  id: string;
  stations: string[];
  settings: PaymentSettings;
  payments: Payment[];
  events: PaymentEvent[];
  /** Captured on the site's sessions so far. */
  revenue: number;
}

export interface PaymentStation {
  ocpp: OcppVersion;
  call(action: string, payload: JsonObject): Promise<{ ok: boolean; status?: string }>;
}

export interface PaymentsOptions {
  station(chargeBoxId: string): PaymentStation | undefined;
  /** The token the CSMS starts the station's sessions with on plug-in (valet), if any. */
  valetToken?: (chargeBoxId: string) => string | undefined;
  /** How long a hold waits for its session to start before it is released (default 2 min). */
  pendingHoldMs?: number;
  now?: () => number;
}

/** What the CSMS asks before letting a token start a session, and where it asks. */
export interface PaymentCheck {
  /**
   * `authorize`: an Authorize; `start`: a StartTransaction or a TransactionEvent with a token;
   * `remote`: before a remote start (the app); `web`: the QR code's payment page is paid.
   */
  via: 'authorize' | 'start' | 'remote' | 'web';
  idToken?: string;
  type?: string;
  evseId?: number;
  /** `web`: the card the driver pays with on the page, and its test outcome. */
  card?: { brand: string; last4: string };
  outcome?: CardOutcome;
}

/** Whether the token may start: a declined card may not; a card held for may. */
export interface PaymentAnswer {
  allowed: boolean;
  /** Held on the card for the session to come. */
  held?: number;
  reason?: string;
}

export interface Payments {
  setSite(id: string, stations: string[], settings: PaymentSettings): PaymentsState;
  deleteSite(id: string): boolean;
  site(id: string): PaymentsState | undefined;
  setAccount(account: Account): Account;
  account(idToken: string): Account | undefined;
  /**
   * Holds on the driver's card before a session starts (T131): an Authorize, a remote start or
   * the QR code's page. A station on no payments site, a free or site-billed token, and a token
   * already held for or charging are allowed without a new hold.
   */
  authorize(chargeBoxId: string, check: PaymentCheck): PaymentAnswer;
  /** The price so far of a transaction on a payments site, tax included, for its cost messages. */
  priceOf(chargeBoxId: string, transactionId: unknown): number | undefined;
  /** Sees a frame of a station's connection, in order. */
  frame(chargeBoxId: string, ocpp: OcppVersion, frame: SessionFrame): void;
}

export function createPayments(options: PaymentsOptions): Payments {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const sites = new Map<string, { stations: string[]; settings: PaymentSettings }>();
  const accounts = new Map<string, Account>();
  const trackers = new Map<string, { ocpp: OcppVersion; tracker: SessionTracker }>();
  /** `${stationId} ${n}` → its payment. */
  const payments = new Map<string, Payment>();
  const events = new Map<string, PaymentEvent[]>();
  /**
   * Holds made before their session started, until it does: `${stationId} ${idToken}`, or
   * `web ${stationId} ${evseId}` for a QR code's page.
   */
  const pending = new Map<
    string,
    {
      siteId: string;
      amount: number;
      card: { brand: string; last4: string };
      timer: NodeJS.Timeout;
    }
  >();

  const siteOf = (stationId: string) =>
    [...sites.entries()].find(([, site]) => site.stations.includes(stationId));

  function note(siteId: string, event: Omit<PaymentEvent, 'at'>): void {
    const list = events.get(siteId) ?? [];
    list.unshift({ at: iso(), ...event });
    events.set(siteId, list.slice(0, 200));
  }

  const cardText = (card: { brand: string; last4: string }) => `${card.brand} ****${card.last4}`;

  /** A hold before the session: declined, or held until the session takes it (or time runs out). */
  function holdAhead(
    siteId: string,
    settings: PaymentSettings,
    key: string,
    at: { stationId: string; evseId?: number },
    card: { brand: string; last4: string },
    outcome: CardOutcome,
  ): PaymentAnswer {
    if (outcome === 'decline') {
      note(siteId, { ...at, kind: 'decline', amount: settings.holdAmount, detail: cardText(card) });
      return { allowed: false, reason: `the card was declined (${cardText(card)})` };
    }
    if (outcome === 'requires-action') {
      note(siteId, {
        ...at,
        kind: 'requires-action',
        detail: 'the driver confirmed in the bank app',
      });
    }
    note(siteId, { ...at, kind: 'hold', amount: settings.holdAmount, detail: cardText(card) });
    const timer = setTimeout(() => {
      if (pending.get(key)?.timer !== timer) return;
      pending.delete(key);
      note(siteId, {
        ...at,
        kind: 'release',
        amount: settings.holdAmount,
        detail: 'no session started',
      });
    }, options.pendingHoldMs ?? 120_000);
    timer.unref();
    pending.set(key, { siteId, amount: settings.holdAmount, card, timer });
    return { allowed: true, held: settings.holdAmount };
  }

  /** The hold made for a session before it started, taken by its payment. */
  function takePending(record: SessionRecord, method: PaymentMethod) {
    let key: string | undefined;
    if (method === 'qr') {
      const exact = `web ${record.stationId} ${record.evseId ?? 0}`;
      key = pending.has(exact)
        ? exact
        : [...pending.keys()].find((k) => k.startsWith(`web ${record.stationId} `));
    } else if (record.idToken !== undefined) {
      key = `${record.stationId} ${record.idToken.idToken}`;
    }
    const hold = key === undefined ? undefined : pending.get(key);
    if (key === undefined || hold === undefined) return undefined;
    clearTimeout(hold.timer);
    pending.delete(key);
    return hold;
  }

  /** Sessions to stop once their transaction id is known (1.6: it comes in the CSMS's answer). */
  const stopWhenKnown = new Set<string>();

  /** Stops a session as the CSMS: its card was declined, or it reached the hold (policy `stop`). */
  function stopSession(payment: Payment): void {
    if (payment.transactionId === undefined) {
      stopWhenKnown.add(`${payment.stationId} ${payment.n}`);
      return;
    }
    const { transactionId } = payment;
    const station = options.station(payment.stationId);
    if (station === undefined) return;
    const action = station.ocpp === '1.6' ? 'RemoteStopTransaction' : 'RequestStopTransaction';
    const payload =
      station.ocpp === '1.6'
        ? { transactionId: Number(transactionId) }
        : { transactionId: String(transactionId) };
    // A station may still be taking in the answer that gave it the transaction id, so a refused
    // stop is tried again while the session runs, as a CSMS would.
    const attempt = (left: number) => {
      void station
        .call(action, payload)
        .then((answer) => {
          if (answer.status === 'Rejected' && left > 0 && payment.endedAt === undefined) {
            setTimeout(() => attempt(left - 1), 300);
          }
        })
        .catch(() => {});
    };
    setTimeout(() => attempt(5), 0);
  }

  function follow(siteId: string, settings: PaymentSettings, record: SessionRecord): void {
    const key = `${record.stationId} ${record.n}`;
    const token = record.idToken?.idToken;
    const account = token === undefined ? undefined : accounts.get(token);
    let payment = payments.get(key);
    let ahead: ReturnType<typeof takePending>;
    if (payment === undefined) {
      if (record.startedAt === undefined) return;
      const method = methodOf(record, account, options.valetToken?.(record.stationId));
      payment = {
        stationId: record.stationId,
        n: record.n,
        ...(record.evseId !== undefined && { evseId: record.evseId }),
        ...(record.transactionId !== undefined && { transactionId: record.transactionId }),
        ...(token !== undefined && { idToken: token }),
        method,
        state: 'pending',
        heldAmount: 0,
        startedAt: record.startedAt,
      };
      payments.set(key, payment);
      const at = {
        stationId: record.stationId,
        ...(record.evseId !== undefined && { evseId: record.evseId }),
      };
      if (method === 'free') {
        payment.state = 'not-charged';
      } else if (method === 'site') {
        payment.state = 'site-account';
      } else if (method === 'terminal') {
        // The station's terminal holds the money; its amount comes with the transaction's maxCost.
        payment.state = 'held';
      } else if ((ahead = takePending(record, method)) !== undefined) {
        payment.state = 'held';
        payment.heldAmount = ahead.amount;
        payment.card = ahead.card;
      } else {
        // Nobody asked before the start (a station that authorized the token itself): hold now.
        const card = account?.card ?? testCard(token ?? `${record.stationId}-${record.n}`);
        const outcome = account?.outcome ?? 'approve';
        payment.card = card;
        if (outcome === 'decline') {
          payment.state = 'declined';
          note(siteId, {
            ...at,
            kind: 'decline',
            amount: settings.holdAmount,
            detail: `${card.brand} ****${card.last4}`,
          });
          stopSession(payment);
        } else {
          if (outcome === 'requires-action') {
            note(siteId, {
              ...at,
              kind: 'requires-action',
              detail: 'the driver confirmed in the bank app',
            });
          }
          payment.state = 'held';
          payment.heldAmount = settings.holdAmount;
          note(siteId, {
            ...at,
            kind: 'hold',
            amount: settings.holdAmount,
            detail: `${card.brand} ****${card.last4}`,
          });
        }
      }
    }
    if (record.transactionId !== undefined) payment.transactionId = record.transactionId;
    if (payment.transactionId !== undefined && stopWhenKnown.delete(key)) stopSession(payment);
    const at = {
      stationId: payment.stationId,
      ...(payment.evseId !== undefined && { evseId: payment.evseId }),
    };
    const finished = record.state === 'finished' || record.state === 'not-started';
    const price = priceSession(record, settings.tariff, record.endedAt ?? iso(), {
      idleGraceMinutes: settings.idleGraceMinutes,
    });
    payment.price = {
      items: price.items,
      exclTax: price.exclTax,
      tax: price.tax,
      inclTax: price.inclTax,
      currency: price.currency,
    };
    if (payment.method === 'free' || payment.method === 'site') {
      if (finished) payment.endedAt = record.endedAt ?? iso();
      return;
    }
    // The driver hears when idle fees start (the CSMS's notice, as an app push).
    const idle = record.states.at(-1)?.state === 'suspendedEV';
    const idlePrice = settings.tariff.idleTime?.prices[0]?.priceMinute ?? 0;
    if (idle && idlePrice > 0 && payment.idleNoticed !== true && !finished) {
      payment.idleNoticed = true;
      note(siteId, {
        ...at,
        kind: 'notice',
        detail:
          settings.idleGraceMinutes > 0
            ? `full: idle fees start in ${settings.idleGraceMinutes} min`
            : 'full: idle fees start now',
      });
    }
    if (payment.state === 'held' && payment.method !== 'terminal' && !finished) {
      if (settings.overHold === 'increment') {
        const margin = Math.max(5, payment.heldAmount * 0.1);
        if (price.inclTax >= payment.heldAmount - margin) {
          payment.heldAmount = round(payment.heldAmount + settings.holdAmount);
          note(siteId, {
            ...at,
            kind: 'increment',
            amount: payment.heldAmount,
            detail: 'the price neared the hold',
          });
        }
      } else if (
        settings.overHold === 'stop' &&
        price.inclTax >= payment.heldAmount &&
        payment.stoppedAtHold !== true
      ) {
        payment.stoppedAtHold = true;
        note(siteId, { ...at, kind: 'stop-at-hold', amount: payment.heldAmount });
        stopSession(payment);
      }
    }
    const maxCost = record.limits?.maxCost;
    if (payment.method === 'terminal' && payment.heldAmount === 0 && maxCost !== undefined) {
      payment.heldAmount = maxCost;
      note(siteId, {
        ...at,
        kind: 'hold',
        amount: maxCost,
        detail: "by the station's payment terminal",
      });
    }
    if (
      payment.method === 'terminal' &&
      record.settlement !== undefined &&
      payment.state === 'held'
    ) {
      payment.state = 'settled-by-station';
      payment.capturedAmount = record.settlement.amount;
      note(siteId, {
        ...at,
        kind: 'settlement',
        amount: record.settlement.amount,
        detail: record.settlement.status,
      });
    }
    if (!finished || payment.endedAt !== undefined) return;
    payment.endedAt = record.endedAt ?? iso();
    if (payment.state !== 'held' || payment.method === 'terminal') return;
    const outcome =
      (payment.idToken !== undefined ? accounts.get(payment.idToken)?.outcome : undefined) ??
      'approve';
    const result = settle(payment, price.inclTax, deliveredWh(record), settings, outcome);
    payment.state = result.state;
    if (result.captured !== undefined) payment.capturedAmount = result.captured;
    for (const event of result.events) note(siteId, { ...at, ...event });
  }

  function stateOf(id: string): PaymentsState | undefined {
    const site = sites.get(id);
    if (site === undefined) return undefined;
    const list = [...payments.values()].filter((p) => site.stations.includes(p.stationId));
    return {
      id,
      stations: site.stations,
      settings: site.settings,
      payments: list,
      events: events.get(id) ?? [],
      revenue: round(list.reduce((sum, p) => sum + (p.capturedAmount ?? 0), 0)),
    };
  }

  return {
    setSite(id, stations, settings) {
      sites.set(id, { stations: [...stations], settings });
      return stateOf(id) as PaymentsState;
    },
    deleteSite(id) {
      const site = sites.get(id);
      if (site === undefined) return false;
      sites.delete(id);
      events.delete(id);
      for (const [key, hold] of pending) {
        if (hold.siteId !== id) continue;
        clearTimeout(hold.timer);
        pending.delete(key);
      }
      for (const [key, payment] of payments) {
        if (site.stations.includes(payment.stationId)) payments.delete(key);
      }
      // Their sessions are forgotten too, so a site set up again starts afresh.
      for (const stationId of site.stations) trackers.delete(stationId);
      for (const key of stopWhenKnown) {
        if (site.stations.includes(key.split(' ')[0] ?? '')) stopWhenKnown.delete(key);
      }
      return true;
    },
    site: stateOf,
    setAccount(account) {
      accounts.set(account.idToken, account);
      return account;
    },
    account: (idToken) => accounts.get(idToken),
    priceOf(chargeBoxId, transactionId) {
      if (transactionId === undefined || siteOf(chargeBoxId) === undefined) return undefined;
      const payment = [...payments.values()].find(
        (p) => p.stationId === chargeBoxId && String(p.transactionId) === String(transactionId),
      );
      return payment?.price?.inclTax;
    },
    authorize(chargeBoxId, check) {
      const site = siteOf(chargeBoxId);
      if (site === undefined) return { allowed: true };
      const [siteId, { settings }] = site;
      const at = {
        stationId: chargeBoxId,
        ...(check.evseId !== undefined && { evseId: check.evseId }),
      };
      if (check.via === 'web') {
        const key = `web ${chargeBoxId} ${check.evseId ?? 0}`;
        const waiting = pending.get(key);
        if (waiting !== undefined) return { allowed: true, held: waiting.amount };
        const card = check.card ?? testCard(key);
        return holdAhead(siteId, settings, key, at, card, check.outcome ?? 'approve');
      }
      const token = check.idToken;
      // Free vend, the station's own payment (terminal, QR code), free and site-billed tokens.
      if (token === undefined || token === '') return { allowed: true };
      if (check.type === 'NoAuthorization' || check.type === 'DirectPayment') {
        return { allowed: true };
      }
      const account = accounts.get(token);
      if (account?.billing === 'free' || account?.billing === 'site') return { allowed: true };
      if (options.valetToken?.(chargeBoxId) === token) return { allowed: true };
      // The token at its own session (to stop it, or the start after its Authorize).
      const running = [...payments.values()].find(
        (p) => p.stationId === chargeBoxId && p.idToken === token && p.endedAt === undefined,
      );
      if (running !== undefined) {
        return running.state === 'declined'
          ? { allowed: false, reason: 'the card was declined' }
          : { allowed: true };
      }
      const key = `${chargeBoxId} ${token}`;
      const waiting = pending.get(key);
      if (waiting !== undefined) return { allowed: true, held: waiting.amount };
      const card = account?.card ?? testCard(token);
      return holdAhead(siteId, settings, key, at, card, account?.outcome ?? 'approve');
    },
    frame(chargeBoxId, ocpp, frame) {
      const site = siteOf(chargeBoxId);
      if (site === undefined) return;
      // A station that comes back on another version is another station to follow.
      let tracker = trackers.get(chargeBoxId)?.tracker;
      if (tracker === undefined || trackers.get(chargeBoxId)?.ocpp !== ocpp) {
        tracker = createSessionTracker({ stationId: chargeBoxId, ocpp });
        trackers.set(chargeBoxId, { ocpp, tracker });
      }
      for (const touch of tracker.frame(frame)) {
        follow(site[0], site[1].settings, touch.session);
      }
    },
  };
}
