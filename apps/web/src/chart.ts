/**
 * The energy chart's maths, kept out of the component so tests can check it:
 * linear scales, round ticks, SVG paths, and the series a session yields.
 */
import type { ReportedSample, SessionRecord, TrueSample } from './api.js';

export interface Scale {
  (value: number): number;
  domain: [number, number];
}

/** Maps [d0, d1] onto [r0, r1]; a flat domain maps to the middle of the range. */
export function scaleLinear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const scale = ((value: number) =>
    d1 === d0 ? (r0 + r1) / 2 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0)) as Scale;
  scale.domain = domain;
  return scale;
}

/** A round step for about `count` ticks over `span`: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, count: number): number {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
}

/** The smallest round number at or above `value`, on the steps `ticks` uses. */
export function niceMax(value: number, count = 4): number {
  if (!(value > 0)) return 1;
  const step = niceStep(value, count);
  return Math.ceil(value / step - 1e-9) * step;
}

/** About `count` round tick values covering [min, max] (steps of 1, 2 or 5 times a power of ten). */
export function ticks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Tick times for a span: every 1, 2, 5, 10, 15 or 30 minutes, or whole hours. */
export function timeTicks(start: number, end: number, count = 5): number[] {
  if (!(end > start)) return [start];
  const minute = 60_000;
  const raw = (end - start) / count;
  const step =
    [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].map((m) => m * minute).find((s) => s >= raw) ??
    Math.ceil(raw / (60 * minute)) * 60 * minute;
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push(t);
  return out;
}

export interface Point {
  t: number;
  v: number;
}

/** An SVG path through the points, in order; empty without any. */
export function linePath(points: readonly Point[], x: Scale, y: Scale): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(' ');
}

export interface SessionSeries {
  /** Reported power, kW. */
  power: Point[];
  /** Power the station offered (Power.Offered), kW. */
  offered: Point[];
  /** Reported SoC, percent. */
  soc: Point[];
  truePower: Point[];
  trueSoc: Point[];
  start: number;
  end: number;
  /** The top of the power axis, kW. */
  maxKw: number;
}

const at = (iso: string) => Date.parse(iso);
const points = <S>(
  list: readonly S[],
  time: (s: S) => string,
  value: (s: S) => number | undefined,
) =>
  list.flatMap((s) => {
    const v = value(s);
    const t = at(time(s));
    return v === undefined || !Number.isFinite(t) ? [] : [{ t, v }];
  });

/** The series of a session's chart, from its reported and true samples. */
export function sessionSeries(
  session: Pick<SessionRecord, 'samples' | 'truth' | 'startedAt' | 'requestedAt' | 'endedAt'>,
  now: number,
): SessionSeries {
  const samples: readonly ReportedSample[] = session.samples;
  const truth: readonly TrueSample[] = session.truth;
  const power = points(
    samples,
    (s) => s.at,
    (s) => (s.powerW === undefined ? undefined : s.powerW / 1000),
  );
  const offered = points(
    samples,
    (s) => s.at,
    (s) => (s.offeredW === undefined ? undefined : s.offeredW / 1000),
  );
  const soc = points(
    samples,
    (s) => s.at,
    (s) => s.socPercent,
  );
  const truePower = points(
    truth,
    (s) => s.at,
    (s) => s.powerW / 1000,
  );
  const trueSoc = points(
    truth,
    (s) => s.at,
    (s) => s.socPercent,
  );
  const times = [...power, ...offered, ...soc, ...truePower, ...trueSoc].map((p) => p.t);
  const start = Math.min(at(session.startedAt ?? session.requestedAt), ...times);
  const end = Math.max(session.endedAt === undefined ? now : at(session.endedAt), ...times);
  const top = Math.max(1, ...[...power, ...offered, ...truePower].map((p) => p.v));
  return { power, offered, soc, truePower, trueSoc, start, end, maxKw: niceMax(top * 1.05) };
}
