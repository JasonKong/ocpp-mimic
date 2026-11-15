import { describe, expect, it } from 'vitest';
import { linePath, niceMax, scaleLinear, sessionSeries, ticks, timeTicks } from './chart.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');

describe('energy chart maths', () => {
  it('scales linearly, and puts a flat domain in the middle', () => {
    const s = scaleLinear([0, 10], [100, 0]);
    expect([s(0), s(5), s(10)]).toEqual([100, 50, 0]);
    expect(scaleLinear([3, 3], [0, 10])(3)).toBe(5);
  });

  it('picks round ticks and time ticks', () => {
    expect(ticks(0, 22, 4)).toEqual([0, 10, 20]);
    expect(ticks(0, 7.4, 4)).toEqual([0, 2, 4, 6]);
    expect(ticks(0, 150, 4)).toEqual([0, 50, 100, 150]);
    expect(ticks(5, 5)).toEqual([5]);
    expect([niceMax(7.77), niceMax(11.55), niceMax(52.5), niceMax(157.5), niceMax(0)]).toEqual([
      8, 15, 60, 200, 1,
    ]);
    expect(timeTicks(T0, T0 + 30 * 60_000, 5).map((t) => (t - T0) / 60_000)).toEqual([
      0, 10, 20, 30,
    ]);
    expect(timeTicks(T0, T0 + 5 * 3_600_000, 5).map((t) => (t - T0) / 3_600_000)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('draws paths through points', () => {
    const x = scaleLinear([0, 10], [0, 100]);
    const y = scaleLinear([0, 1], [50, 0]);
    expect(
      linePath(
        [
          { t: 0, v: 0 },
          { t: 10, v: 1 },
        ],
        x,
        y,
      ),
    ).toBe('M0.0,50.0 L100.0,0.0');
    expect(linePath([], x, y)).toBe('');
  });

  it('builds the series of a session from reported and true samples', () => {
    const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
    const series = sessionSeries(
      {
        requestedAt: at(0),
        startedAt: at(0),
        samples: [
          { at: at(1), seq: 1, powerW: 7200, offeredW: 7400, socPercent: 30 },
          { at: at(2), seq: 2, powerW: 7100, socPercent: 31 },
          { at: at(3), seq: 3, energyWh: 300 },
        ],
        truth: [{ at: at(2), socPercent: 31.4, energyWh: 240, powerW: 7150 }],
      },
      T0 + 10 * 60_000,
    );
    expect(series.power).toEqual([
      { t: T0 + 60_000, v: 7.2 },
      { t: T0 + 120_000, v: 7.1 },
    ]);
    expect(series.offered).toEqual([{ t: T0 + 60_000, v: 7.4 }]);
    expect(series.soc.map((p) => p.v)).toEqual([30, 31]);
    expect(series.trueSoc).toEqual([{ t: T0 + 120_000, v: 31.4 }]);
    expect(series.start).toBe(T0);
    expect(series.end).toBe(T0 + 10 * 60_000);
    expect(series.maxKw).toBe(8);
  });
});
