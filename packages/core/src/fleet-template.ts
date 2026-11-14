/**
 * Fleet templates: the parts of creating stations in bulk that are pure
 * logic, shared by the engine's API and, later, load plans
 * (docs/design.md, "M4 scale").
 */

/** At most this many stations from one template. */
export const MAX_TEMPLATE_COUNT = 10_000;

const NAME = /^[A-Za-z0-9._-]{1,32}$/;

/** Problems with a tag or group name: 1 to 32 letters, digits, `.`, `_` or `-`. */
export function nameProblem(value: unknown, what: string): string | undefined {
  if (typeof value !== 'string' || !NAME.test(value)) {
    return `${what} must be 1 to 32 letters, digits, ".", "_" or "-"`;
  }
  return undefined;
}

/** Problems with a list of tags: at most 10 names, no repeats. */
export function tagsProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'tags must be a list of names';
  if (value.length > 10) return 'at most 10 tags';
  for (const tag of value) {
    const problem = nameProblem(tag, 'a tag');
    if (problem !== undefined) return problem;
  }
  if (new Set(value).size !== value.length) return 'tags must not repeat';
  return undefined;
}

/**
 * The ids an id pattern makes: one counter in braces, whose digits give the
 * first number and the width. `SIM-{0001}` × 3 → SIM-0001, SIM-0002,
 * SIM-0003; `SIM-{1001}` starts at SIM-1001. Numbers grow past the width
 * when they must (`{9}` × 2 → 9, 10).
 */
export function expandIdPattern(
  pattern: string,
  count: number,
): { ok: true; ids: string[] } | { ok: false; problem: string } {
  if (!Number.isInteger(count) || count < 1 || count > MAX_TEMPLATE_COUNT) {
    return { ok: false, problem: `count must be a whole number from 1 to ${MAX_TEMPLATE_COUNT}` };
  }
  const counters = [...pattern.matchAll(/\{(\d+)\}/g)];
  const counter = counters[0];
  if (
    counters.length !== 1 ||
    counter === undefined ||
    /[{}]/.test(pattern.replace(counter[0], ''))
  ) {
    return { ok: false, problem: 'the id needs exactly one counter in braces, such as SIM-{0001}' };
  }
  const digits = counter[1] ?? '';
  const first = Number(digits);
  const before = pattern.slice(0, counter.index);
  const after = pattern.slice(counter.index + counter[0].length);
  const ids = Array.from(
    { length: count },
    (_, i) => `${before}${String(first + i).padStart(digits.length, '0')}${after}`,
  );
  const bad = ids.find((id) => !/^[\x21-\x7e]{1,48}$/.test(id) || /[/?#%]/.test(id));
  if (bad !== undefined) {
    return {
      ok: false,
      problem: `${bad} is not a usable chargeBoxId (1 to 48 visible characters, no / ? # %)`,
    };
  }
  return { ok: true, ids };
}

/** How a group of stations starts: `rate` a second, each at a random point within `jitter` of its slot. */
export interface RampUp {
  rate: number;
  jitter: number;
}

export const DEFAULT_RAMP_UP: RampUp = { rate: 20, jitter: 0.5 };

/**
 * When each of `count` stations starts, in milliseconds from now. Station i
 * gets slot i (1 / rate seconds long) and starts `jitter` × a random share of
 * the slot into it. Without a ramp-up every station starts at once.
 */
export function rampUpDelays(count: number, ramp: RampUp | false, random: () => number): number[] {
  if (ramp === false) return Array.from({ length: count }, () => 0);
  const slot = 1000 / ramp.rate;
  return Array.from({ length: count }, (_, i) => Math.round(slot * (i + ramp.jitter * random())));
}

/** Problems with a ramp-up value: `false`, or `{ rate?, jitter? }`. */
export function parseRampUp(
  value: unknown,
): { ok: true; ramp: RampUp | false } | { ok: false; problem: string } {
  if (value === undefined) return { ok: true, ramp: DEFAULT_RAMP_UP };
  if (value === false) return { ok: true, ramp: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'rampUp must be false or { rate, jitter }' };
  }
  const {
    rate = DEFAULT_RAMP_UP.rate,
    jitter = DEFAULT_RAMP_UP.jitter,
    ...rest
  } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0)
    return { ok: false, problem: `rampUp has unknown fields: ${unknown.join(', ')}` };
  if (typeof rate !== 'number' || !(rate > 0) || rate > 10_000) {
    return { ok: false, problem: 'rampUp.rate must be a number of stations a second above 0' };
  }
  if (typeof jitter !== 'number' || !(jitter >= 0 && jitter <= 1)) {
    return { ok: false, problem: 'rampUp.jitter must be from 0 to 1' };
  }
  return { ok: true, ramp: { rate, jitter } };
}
