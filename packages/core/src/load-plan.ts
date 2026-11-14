/**
 * Load plans for `ocpp-mimic load` (docs/design.md, "M4 scale"): groups of
 * stations made from templates, a ramp-up, timed fleet events and pass / fail
 * thresholds. This module validates a parsed plan; running it is the
 * engine's job.
 */
import { durationSchema, parseDuration } from './duration.js';
import {
  expandIdPattern,
  nameProblem,
  parseRampUp,
  tagsProblem,
  type RampUp,
} from './fleet-template.js';
import { parseInjection, type InjectionRequest } from './injections.js';
import {
  array,
  boolean,
  integer,
  number,
  object,
  record,
  string,
  union,
  type Schema,
  type ValidationIssue,
} from './schema.js';
import { UsageOverrideSchema, type UsageOverride } from './usage.js';

export interface LoadGroup {
  name: string;
  /** The stations' ids, from the group's id pattern and count. */
  ids: string[];
  persona: string;
  tags: string[];
  /** The usage model; groups charge on their own unless `usage: false`. */
  usage: boolean | UsageOverride;
  config?: Record<string, string>;
  password?: string;
  energyMultiplier?: number;
}

/** Which stations a fleet event hits; all of them when empty. */
export interface LoadSelection {
  share?: number;
  count?: number;
  group?: string;
  tag?: string;
}

export type LoadEvent = { atMs: number; stations: LoadSelection } & (
  { kind: 'reconnectStorm' } | { kind: 'inject'; request: InjectionRequest }
);

export interface LoadThresholds {
  bootAcceptedWithinMs?: number;
  recoverWithinMs?: number;
  unexpectedDisconnects?: number;
  lateWork?: { p99Ms?: number; maxMs?: number };
  csmsLatency?: { p95Ms?: number; p99Ms?: number };
  timeouts?: number;
  callErrors?: number;
  schemaViolations?: number;
  eventLoopDelay?: { p99Ms?: number; maxMs?: number };
  memory?: { rssBytes?: number; heapGrowth?: number };
  /** The share of the expected number of sessions that must run. */
  sessions?: { min: number };
}

export interface LoadPlan {
  name: string;
  /** `builtin`, or the CSMS's ws:// / wss:// URL (the chargeBoxId is appended). */
  csms: string;
  seed: number;
  durationMs: number;
  rampUp: RampUp | false;
  groups: LoadGroup[];
  events: LoadEvent[];
  thresholds: LoadThresholds;
}

const BYTES = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i;
const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;

/** Bytes for `512MB`, `2GB` (powers of 1024), or a plain number. */
export function parseBytes(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = BYTES.exec(value.trim());
  if (match === null) return undefined;
  return Number(match[1]) * UNIT_BYTES[(match[2] ?? 'B').toUpperCase() as keyof typeof UNIT_BYTES];
}

/** A share for `10%` or a number from 0 to 1. */
export function parseShare(value: unknown): number | undefined {
  if (typeof value === 'number') return value >= 0 && value <= 1 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(value.trim());
  const share = match === null ? undefined : Number(match[1]) / 100;
  return share !== undefined && share <= 1 ? share : undefined;
}

const custom = <T>(test: (value: unknown) => boolean, message: string): Schema<T> => ({
  check(value, path, issues) {
    if (!test(value)) issues.push({ path, errorCode: 'PropertyConstraintViolation', message });
  },
});
const bytes = custom<string | number>((v) => parseBytes(v) !== undefined, 'not a size such as 2GB');
const shareSchema = custom<string | number>(
  (v) => parseShare(v) !== undefined,
  'not a share such as 0.05 or 5%',
);
const count = integer({ minimum: 0 });

const groupSchema = object(
  { name: string(), count: integer({ minimum: 1 }), id: string(), persona: string() },
  {
    tags: array(string()),
    usage: union(boolean(), UsageOverrideSchema),
    config: record(union(string(), number(), boolean())),
    password: string(),
    energyMultiplier: number(),
  },
);

const selectionSchema = object(
  {},
  { share: shareSchema, count: integer({ minimum: 1 }), group: string(), tag: string() },
);

const thresholdsSchema = object(
  {},
  {
    bootAcceptedWithin: durationSchema,
    recoverWithin: durationSchema,
    unexpectedDisconnects: count,
    lateWork: object({}, { p99: durationSchema, max: durationSchema }),
    csmsLatency: object({}, { p95: durationSchema, p99: durationSchema }),
    timeouts: count,
    callErrors: count,
    schemaViolations: count,
    eventLoopDelay: object({}, { p99: durationSchema, max: durationSchema }),
    memory: object({}, { rss: bytes, heapGrowth: shareSchema }),
    sessions: object({ min: shareSchema }),
  },
);

const planSchema = object(
  {
    name: string(),
    csms: string(),
    duration: durationSchema,
    groups: array(groupSchema, { minItems: 1 }),
  },
  {
    seed: integer({ minimum: 0 }),
    rampUp: { check: () => {} } as Schema<unknown>,
    events: array({ check: () => {} } as Schema<unknown>),
    thresholds: thresholdsSchema,
  },
);

type Raw = Record<string, unknown>;
const ms = (value: unknown) => parseDuration(value as string | number) ?? 0;

export function parseLoadPlan(
  document: unknown,
): { ok: true; plan: LoadPlan } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const problem = (path: string, message: string) =>
    issues.push({ path, errorCode: 'PropertyConstraintViolation', message });
  planSchema.check(document, '$', issues);
  if (issues.length > 0) return { ok: false, issues };
  const raw = document as Raw;

  if (raw.csms !== 'builtin' && !/^wss?:\/\/\S+$/.test(String(raw.csms))) {
    problem('$.csms', 'must be builtin or a ws:// or wss:// URL');
  }
  const ramp = parseRampUp(raw.rampUp);
  if (!ramp.ok) problem('$.rampUp', ramp.problem);
  const durationMs = ms(raw.duration);
  if (!(durationMs > 0)) problem('$.duration', 'must be above 0');

  const groups: LoadGroup[] = [];
  const seen = new Set<string>();
  (raw.groups as Raw[]).forEach((group, index) => {
    const path = `$.groups[${index}]`;
    const nameIssue = nameProblem(group.name, 'the group name');
    if (nameIssue !== undefined) problem(`${path}.name`, nameIssue);
    if (groups.some((g) => g.name === group.name)) problem(`${path}.name`, 'is used twice');
    if (group.tags !== undefined) {
      const tagIssue = tagsProblem(group.tags);
      if (tagIssue !== undefined) problem(`${path}.tags`, tagIssue);
    }
    const expanded = expandIdPattern(String(group.id), Number(group.count));
    if (!expanded.ok) {
      problem(`${path}.id`, expanded.problem);
      return;
    }
    const repeated = expanded.ids.find((id) => seen.has(id));
    if (repeated !== undefined) problem(`${path}.id`, `${repeated} is also in another group`);
    expanded.ids.forEach((id) => seen.add(id));
    if (group.energyMultiplier !== undefined && !((group.energyMultiplier as number) > 0)) {
      problem(`${path}.energyMultiplier`, 'must be above 0');
    }
    groups.push({
      name: String(group.name),
      ids: expanded.ids,
      persona: String(group.persona),
      tags: (group.tags as string[] | undefined) ?? [],
      usage: (group.usage as boolean | UsageOverride | undefined) ?? true,
      ...(group.config !== undefined && {
        config: Object.fromEntries(
          Object.entries(group.config as Raw).map(([key, value]) => [key, String(value)]),
        ),
      }),
      ...(group.password !== undefined && { password: String(group.password) }),
      ...(group.energyMultiplier !== undefined && {
        energyMultiplier: group.energyMultiplier as number,
      }),
    });
  });

  const events: LoadEvent[] = [];
  ((raw.events as unknown[] | undefined) ?? []).forEach((event, index) => {
    const path = `$.events[${index}]`;
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      problem(path, 'expected a map');
      return;
    }
    const { at, stations = {}, ...action } = event as Raw;
    const before = issues.length;
    durationSchema.check(at, `${path}.at`, issues);
    selectionSchema.check(stations, `${path}.stations`, issues);
    const selection = stations as Raw;
    if (selection.share !== undefined && selection.count !== undefined) {
      problem(`${path}.stations`, 'give share or count, not both');
    }
    if (selection.group !== undefined && !groups.some((g) => g.name === selection.group)) {
      problem(`${path}.stations.group`, `no group ${String(selection.group)}`);
    }
    const kinds = Object.keys(action);
    if (kinds.length !== 1 || !['reconnectStorm', 'inject'].includes(kinds[0] ?? '')) {
      problem(path, 'needs at, optional stations, and one of reconnectStorm or inject');
      return;
    }
    const atMs = ms(at);
    if (atMs >= durationMs) problem(`${path}.at`, 'is not before the end of the run');
    const select: LoadSelection = {
      ...(selection.share !== undefined && { share: parseShare(selection.share) ?? 0 }),
      ...(selection.count !== undefined && { count: selection.count as number }),
      ...(selection.group !== undefined && { group: String(selection.group) }),
      ...(selection.tag !== undefined && { tag: String(selection.tag) }),
    };
    if (kinds[0] === 'reconnectStorm') {
      if (issues.length === before) events.push({ atMs, stations: select, kind: 'reconnectStorm' });
      return;
    }
    const parsed = parseInjection(action.inject, `${path}.inject`);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      return;
    }
    if (issues.length === before) {
      events.push({ atMs, stations: select, kind: 'inject', request: parsed.request });
    }
  });

  const t = (raw.thresholds ?? {}) as Raw;
  const sub = (key: string) => (t[key] ?? {}) as Raw;
  const msOf = (value: unknown) => (value === undefined ? undefined : ms(value));
  const thresholds: LoadThresholds = {};
  const set = <K extends keyof LoadThresholds>(key: K, value: LoadThresholds[K] | undefined) => {
    if (value !== undefined) thresholds[key] = value;
  };
  /** A nested threshold with only its given parts, or nothing. */
  const pair = <A extends string, B extends string>(
    a: A,
    av: number | undefined,
    b: B,
    bv: number | undefined,
  ) =>
    av === undefined && bv === undefined
      ? undefined
      : ({ ...(av !== undefined && { [a]: av }), ...(bv !== undefined && { [b]: bv }) } as Partial<
          Record<A | B, number>
        >);
  set('bootAcceptedWithinMs', msOf(t.bootAcceptedWithin));
  set('recoverWithinMs', msOf(t.recoverWithin));
  set('unexpectedDisconnects', t.unexpectedDisconnects as number | undefined);
  set('lateWork', pair('p99Ms', msOf(sub('lateWork').p99), 'maxMs', msOf(sub('lateWork').max)));
  set(
    'csmsLatency',
    pair('p95Ms', msOf(sub('csmsLatency').p95), 'p99Ms', msOf(sub('csmsLatency').p99)),
  );
  set('timeouts', t.timeouts as number | undefined);
  set('callErrors', t.callErrors as number | undefined);
  set('schemaViolations', t.schemaViolations as number | undefined);
  set(
    'eventLoopDelay',
    pair('p99Ms', msOf(sub('eventLoopDelay').p99), 'maxMs', msOf(sub('eventLoopDelay').max)),
  );
  set(
    'memory',
    pair(
      'rssBytes',
      parseBytes(sub('memory').rss),
      'heapGrowth',
      parseShare(sub('memory').heapGrowth),
    ),
  );
  if (t.sessions !== undefined) set('sessions', { min: parseShare(sub('sessions').min) ?? 0 });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: {
      name: String(raw.name),
      csms: String(raw.csms),
      seed: (raw.seed as number | undefined) ?? 1,
      durationMs,
      rampUp: ramp.ok ? ramp.ramp : false,
      groups,
      events: events.sort((a, b) => a.atMs - b.atMs),
      thresholds,
    },
  };
}

/** The ids an event's selection picks from the plan's stations, in a seeded order. */
export function selectStations(
  plan: LoadPlan,
  selection: LoadSelection,
  random: () => number,
): string[] {
  let ids = plan.groups
    .filter((group) => selection.group === undefined || group.name === selection.group)
    .filter((group) => selection.tag === undefined || group.tags.includes(selection.tag))
    .flatMap((group) => group.ids);
  if (selection.share === undefined && selection.count === undefined) return ids;
  ids = [...ids];
  // Fisher-Yates with the run's generator, so the same seed hits the same stations.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
  }
  const take = selection.count ?? Math.max(1, Math.round((selection.share ?? 0) * ids.length));
  return ids.slice(0, Math.min(take, ids.length));
}
