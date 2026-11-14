/**
 * The usage model: drivers who arrive at a station's free connectors, plug
 * in an EV, present a card, stay a while and leave (docs/design.md, "M4
 * scale"). It drives a charge point through the same inputs as the API, on
 * the injected clock and a seeded random generator, so a station repeats its
 * sessions when the CSMS answers the same way.
 */
import type { Clock, TimerHandle } from './clock.js';
import { durationSchema, parseDuration } from './duration.js';
import {
  number,
  object,
  record,
  string,
  validate,
  type Infer,
  type ValidationIssue,
} from './schema.js';

const share = number();

const usageFields = {
  stay: object({ min: durationSchema, max: durationSchema }),
  evs: record(number()),
  idTags: object(
    {},
    {
      prefix: string({ maxLength: 12 }),
      count: number(),
      unknownShare: share,
      unknownPrefix: string({ maxLength: 12 }),
    },
  ),
  cardFirst: share,
  stopBy: object({}, { card: number(), unplug: number() }),
  steps: object({ min: durationSchema, max: durationSchema }),
};

/** A persona's `usage`: a complete model. */
export const UsageSchema = object({ sessionsPerHour: number() }, usageFields);
/** A station's `usage` object: changes to its persona's model. */
export const UsageOverrideSchema = object({}, { sessionsPerHour: number(), ...usageFields });

export type UsageDefinition = Infer<typeof UsageSchema>;
export type UsageOverride = Infer<typeof UsageOverrideSchema>;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The model a station can run: its persona's `usage` with the station's
 * changes on top (objects merge key by key; `evs` is replaced). `station`
 * true or absent takes the persona's as it is. Undefined when there is
 * none; problems when the result is not a valid model.
 */
export function resolveUsage(
  persona: UsageDefinition | undefined,
  station: boolean | UsageOverride | undefined,
  path = '$.usage',
): { model?: UsageModel; problems: string[] } {
  const changes = isPlain(station) ? station : {};
  if (persona === undefined && !isPlain(station)) {
    return { problems: station === true ? ['the persona has no usage model to turn on'] : [] };
  }
  const merged: Record<string, unknown> = { ...persona };
  for (const [key, value] of Object.entries(changes)) {
    const base = merged[key];
    merged[key] = key !== 'evs' && isPlain(base) && isPlain(value) ? { ...base, ...value } : value;
  }
  const validated = validate(UsageSchema, merged);
  if (!validated.ok)
    return { problems: validated.issues.map((i) => `${path}${i.path.slice(1)}: ${i.message}`) };
  const problems = usageProblems(validated.value, path).map((i) => `${i.path}: ${i.message}`);
  return problems.length > 0 ? { problems } : { model: usageModel(validated.value), problems: [] };
}

/** A usage model with defaults filled in and durations in milliseconds. */
export interface UsageModel {
  sessionsPerHour: number;
  stayMs: { min: number; max: number };
  /** EV profile name → weight; empty plugs in without an EV. */
  evs: Record<string, number>;
  idTags: { prefix: string; count: number; unknownShare: number; unknownPrefix: string };
  cardFirst: number;
  /** Share of drivers who end with the card; the rest unplug. */
  stopByCard: number;
  /** A driver's wait between card and plug, before giving up, and before unplugging. */
  stepMs: { min: number; max: number };
}

/** Checks ranges the schema cannot; `path` prefixes the problems. */
export function usageProblems(definition: UsageDefinition, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const problem = (at: string, message: string) =>
    issues.push({ path: `${path}.${at}`, errorCode: 'PropertyConstraintViolation', message });
  if (!(definition.sessionsPerHour > 0)) problem('sessionsPerHour', 'must be above 0');
  const inShare = (value: number | undefined, at: string) => {
    if (value !== undefined && !(value >= 0 && value <= 1)) problem(at, 'must be from 0 to 1');
  };
  inShare(definition.idTags?.unknownShare, 'idTags.unknownShare');
  inShare(definition.cardFirst, 'cardFirst');
  const count = definition.idTags?.count;
  if (count !== undefined && !(Number.isInteger(count) && count >= 1)) {
    problem('idTags.count', 'must be a whole number from 1');
  }
  for (const key of ['stay', 'steps'] as const) {
    const range = definition[key];
    if (range === undefined) continue;
    const min = parseDuration(range.min) ?? 0;
    const max = parseDuration(range.max) ?? 0;
    if (!(min > 0) || max < min) problem(key, 'needs 0 < min <= max');
  }
  for (const [name, weight] of Object.entries(definition.evs ?? {})) {
    if (!(weight >= 0)) problem(`evs.${name}`, 'a weight must be 0 or more');
  }
  const { card = 0.7, unplug = 0.3 } = definition.stopBy ?? {};
  if (!(card >= 0 && unplug >= 0 && card + unplug > 0)) {
    problem('stopBy', 'needs card and unplug weights of 0 or more, not both 0');
  }
  return issues;
}

export function usageModel(definition: UsageDefinition): UsageModel {
  const { card = 0.7, unplug = 0.3 } = definition.stopBy ?? {};
  return {
    sessionsPerHour: definition.sessionsPerHour,
    stayMs: {
      min: parseDuration(definition.stay?.min ?? '20m') ?? 1_200_000,
      max: parseDuration(definition.stay?.max ?? '2h') ?? 7_200_000,
    },
    evs: { ...definition.evs },
    idTags: {
      prefix: definition.idTags?.prefix ?? 'LOAD-',
      count: definition.idTags?.count ?? 500,
      unknownShare: definition.idTags?.unknownShare ?? 0,
      unknownPrefix: definition.idTags?.unknownPrefix ?? 'UNKNOWN-',
    },
    cardFirst: definition.cardFirst ?? 0.3,
    stopByCard: card / (card + unplug),
    stepMs: {
      min: parseDuration(definition.steps?.min ?? '5s') ?? 5_000,
      max: parseDuration(definition.steps?.max ?? '30s') ?? 30_000,
    },
  };
}

/** A small seeded generator (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A station's seed from the run's seed and its id (FNV-1a), so stations do not share sessions. */
export function stationSeed(runSeed: number, stationId: string): number {
  let hash = 0x811c9dc5 ^ (runSeed >>> 0);
  for (let i = 0; i < stationId.length; i++) {
    hash ^= stationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** What the driver can do and see at a station: the API's inputs. */
export interface UsageActions {
  connectorIds(): number[];
  /** Free for a new driver: Available (not reserved, unavailable or faulted, no cable). */
  isFree(connectorId: number): boolean;
  plugIn(connectorId: number, ev: string | undefined): void;
  unplug(connectorId: number): void;
  /** Resolves with whether the card started (or stopped) a transaction. */
  presentIdTag(connectorId: number, idTag: string): Promise<'authorized' | 'stopping' | 'other'>;
  /** Whether a cable is plugged in, for a restart mid-session. */
  isPluggedIn(connectorId: number): boolean;
  /** Whether a transaction runs on the connector, so a card would stop it. */
  hasTransaction(connectorId: number): boolean;
}

export type UsageEvent =
  | { type: 'arrived'; connectorId: number; idTag: string; ev?: string }
  | { type: 'turned-away'; connectorId: number }
  | { type: 'refused'; connectorId: number; idTag: string }
  | { type: 'left'; connectorId: number; by: 'card' | 'unplug' };

export interface UsageDriver {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface UsageDriverOptions {
  clock: Clock;
  random: () => number;
  model: UsageModel;
  actions: UsageActions;
  onEvent?: (event: UsageEvent) => void;
}

export function createUsageDriver(options: UsageDriverOptions): UsageDriver {
  const { clock, random, model, actions } = options;
  const timers = new Map<number, TimerHandle>();
  let running = false;
  const between = (range: { min: number; max: number }) =>
    range.min + random() * (range.max - range.min);
  const emit = (event: UsageEvent) => options.onEvent?.(event);

  function later(connectorId: number, delayMs: number, fn: () => void): void {
    const existing = timers.get(connectorId);
    if (existing !== undefined) clock.clearTimer(existing);
    timers.set(
      connectorId,
      clock.setTimer(Math.max(0, delayMs), () => {
        timers.delete(connectorId);
        if (running) fn();
      }),
    );
  }

  /** The next arrival at a connector: exponential gaps for Poisson arrivals. */
  function scheduleArrival(connectorId: number): void {
    const meanMs = 3_600_000 / model.sessionsPerHour;
    later(connectorId, -Math.log(1 - random()) * meanMs, () => arrive(connectorId));
  }

  function pickEv(): string | undefined {
    const entries = Object.entries(model.evs).filter(([, weight]) => weight > 0);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total === 0) return undefined;
    let point = random() * total;
    for (const [name, weight] of entries) {
      point -= weight;
      if (point < 0) return name;
    }
    return entries.at(-1)?.[0];
  }

  function pickIdTag(): string {
    const { prefix, count, unknownShare, unknownPrefix } = model.idTags;
    const unknown = random() < unknownShare;
    const n = 1 + Math.floor(random() * count);
    return `${unknown ? unknownPrefix : prefix}${String(n).padStart(4, '0')}`;
  }

  function arrive(connectorId: number): void {
    if (!actions.isFree(connectorId)) {
      emit({ type: 'turned-away', connectorId });
      scheduleArrival(connectorId);
      return;
    }
    const ev = pickEv();
    const idTag = pickIdTag();
    const cardFirst = random() < model.cardFirst;
    const stayMs = between(model.stayMs);
    const byCard = random() < model.stopByCard;
    emit({ type: 'arrived', connectorId, idTag, ...(ev !== undefined && { ev }) });
    const stay = () => later(connectorId, stayMs, () => end(connectorId, idTag, byCard));
    const authorize = (then: () => void) => {
      void actions.presentIdTag(connectorId, idTag).then((result) => {
        if (!running) return;
        if (result !== 'authorized') {
          emit({ type: 'refused', connectorId, idTag });
          // The driver gives up and takes the cable out (or never puts it in).
          later(connectorId, between(model.stepMs), () => leave(connectorId));
          return;
        }
        then();
      });
    };
    if (cardFirst) {
      // The cable follows the card; the transaction starts once it is in.
      authorize(() =>
        later(connectorId, between(model.stepMs), () => {
          actions.plugIn(connectorId, ev);
          stay();
        }),
      );
    } else {
      actions.plugIn(connectorId, ev);
      later(connectorId, between(model.stepMs), () => authorize(stay));
    }
  }

  function end(connectorId: number, idTag: string, byCard: boolean): void {
    emit({ type: 'left', connectorId, by: byCard ? 'card' : 'unplug' });
    // Without a transaction (ended by the CSMS or a power cut), a card would start a new one.
    if (!byCard || !actions.hasTransaction(connectorId)) {
      leave(connectorId);
      return;
    }
    void actions.presentIdTag(connectorId, idTag).then(() => {
      if (running) later(connectorId, between(model.stepMs), () => leave(connectorId));
    });
  }

  function leave(connectorId: number): void {
    if (actions.isPluggedIn(connectorId)) actions.unplug(connectorId);
    scheduleArrival(connectorId);
  }

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      for (const connectorId of actions.connectorIds()) {
        // After a restart, the driver of a plugged-in cable picks a new stay.
        if (actions.isPluggedIn(connectorId)) {
          later(connectorId, between(model.stayMs), () => leave(connectorId));
        } else {
          scheduleArrival(connectorId);
        }
      }
    },
    stop() {
      running = false;
      for (const timer of timers.values()) clock.clearTimer(timer);
      timers.clear();
    },
  };
}
