/** Durations in personas, scenarios and plans: milliseconds or `500ms`, `6s`, `3m`, `1h`. */
import type { Schema } from './schema.js';

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Milliseconds for a duration: a number (ms) or a string such as `200ms`, `6s`, `3m`, `1h`. */
export function parseDuration(value: number | string): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  const match = DURATION.exec(value.trim());
  if (match === null) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export const durationSchema: Schema<number | string> = {
  check(value, path, issues) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      issues.push({ path, errorCode: 'TypeConstraintViolation', message: 'expected a duration' });
    } else if (parseDuration(value) === undefined) {
      issues.push({
        path,
        errorCode: 'PropertyConstraintViolation',
        message: `not a duration (use milliseconds or e.g. "500ms", "6s", "3m"): ${JSON.stringify(value)}`,
      });
    }
  },
};
