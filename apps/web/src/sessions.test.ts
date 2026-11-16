import { describe, expect, it } from 'vitest';
import type { SessionDetail } from './api.js';
import {
  energyFigures,
  failureText,
  formatDuration,
  formatRoute,
  limitsText,
  parseRoute,
  sessionDuration,
  stateTone,
  stepDelay,
  stepLabel,
} from './sessions.js';

describe('session formatting', () => {
  it('reads and writes session links', () => {
    expect(parseRoute('#/stations/CP%2F1')).toEqual({ stationId: 'CP/1', sessions: false });
    expect(parseRoute('#/stations/CP-1/sessions')).toEqual({ stationId: 'CP-1', sessions: true });
    expect(parseRoute('#/stations/CP-1/sessions/12')).toEqual({
      stationId: 'CP-1',
      sessions: true,
      n: 12,
    });
    expect(parseRoute('#/elsewhere')).toBeUndefined();
    expect(formatRoute({ stationId: 'CP/1', sessions: true, n: 3 })).toBe(
      '#/stations/CP%2F1/sessions/3',
    );
    expect(formatRoute({ stationId: 'CP-1', sessions: false, n: 3 })).toBe('#/stations/CP-1');
  });

  it('formats durations and steps', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(102 * 60_000)).toBe('1 h 42 min');
    expect(formatDuration(-1)).toBe('—');
    expect(
      sessionDuration({ startedAt: '2026-11-15T10:00:00Z' }, Date.parse('2026-11-15T10:30:00Z')),
    ).toBe(1_800_000);
    expect(sessionDuration({}, 0)).toBeUndefined();
    const step = {
      seq: 1,
      at: 'x',
      action: 'RemoteStartTransaction',
      direction: 'csms-to-cp' as const,
      messageType: 2 as const,
    };
    expect(stepLabel(step)).toBe('CSMS → CP RemoteStartTransaction');
    expect(stepLabel({ ...step, direction: 'cp-to-csms', messageType: 3 })).toBe(
      'CP → CSMS RemoteStartTransaction answer',
    );
    expect(stepDelay({ ...step, sincePreviousMs: 80 })).toBe('+80 ms');
    expect(stepDelay({ ...step, sincePreviousMs: 1234 })).toBe('+1.2 s');
    expect(stepDelay(step)).toBe('');
  });

  it('says why a session did not start, and colours states', () => {
    expect(failureText({ reason: 'Rejected' })).toBe('The station rejected the remote start');
    expect(failureText({ reason: 'NotAuthorized', detail: 'Blocked' })).toBe(
      'Not authorized (Blocked)',
    );
    expect(failureText(undefined)).toBeUndefined();
    expect(
      ['running', 'starting', 'finished', 'not-started'].map((s) => stateTone(s as 'running')),
    ).toEqual(['good', 'pending', 'muted', 'bad']);
  });
});

describe('energy figures', () => {
  const T0 = Date.parse('2026-11-15T10:00:00Z');
  const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
  const detail = (extra: Partial<SessionDetail['session']> = {}): SessionDetail => ({
    session: {
      stationId: 'CP-1',
      n: 1,
      ocpp: '2.0.1',
      state: 'running',
      source: 'local',
      requestedAt: at(0),
      startedAt: at(0),
      timeline: [],
      samples: [
        {
          at: at(1),
          seq: 1,
          powerW: 7000,
          socPercent: 30,
          currentA: { L1: 16, L2: 15.8 },
          voltageV: { L1: 231 },
        },
        { at: at(2), seq: 2, powerW: 7400, socPercent: 31 },
      ],
      truth: [{ at: at(2), socPercent: 31.6, energyWh: 300, powerW: 7390 }],
      states: [],
      costs: [],
      ...extra,
    },
    summary: {
      stationId: 'CP-1',
      n: 1,
      ocpp: '2.0.1',
      state: 'running',
      source: 'local',
      requestedAt: at(0),
      energyWh: 300,
    },
    estimate: {
      targetSoc: 100,
      targetFrom: 'default',
      taperSoc: 80,
      socPercent: 31,
      at: at(2),
      etaAt: at(62),
      msToTarget: 3_600_000,
    },
    truth: { at: at(2), socPercent: 31.6, msToTarget: 3_300_000, etaAt: at(57) },
    gap: { gapMs: 300_000, off: false },
    durations: { charging: 100_000, suspendedEV: 20_000, suspendedEVSE: 10_000, idle: 5_000 },
    price: { tariffId: 'reference', currency: 'NZD', items: [], exclTax: 0, tax: 0, inclTax: 0 },
  });

  it('takes the latest reported values, the truth, the ETAs and the phases', () => {
    const f = energyFigures(detail(), T0 + 2 * 60_000);
    expect(f).toMatchObject({
      energyWh: 300,
      powerW: 7400,
      socPercent: 31,
      truePowerW: 7390,
      trueSocPercent: 31.6,
      chargingMs: 100_000,
      suspendedMs: 30_000,
      idleMs: 5_000,
      etaAt: at(62),
      leftMs: 3_600_000,
      trueEtaAt: at(57),
      trueLeftMs: 3_300_000,
      off: false,
      peakPowerW: 7400,
      startSocPercent: 30,
      endSocPercent: 31,
    });
    expect(f.phases).toEqual([
      { phase: 'L1', currentA: 16, voltageV: 231 },
      { phase: 'L2', currentA: 15.8 },
    ]);
    expect(f.reason).toBeUndefined();
  });

  it('turns simulated times into wall-clock time under an energy multiplier', () => {
    const fast = { ...detail(), energyMultiplier: 60 };
    const f = energyFigures(fast, T0 + 2 * 60_000);
    // 60 simulated minutes to go at ×60 is one real minute.
    expect(f).toMatchObject({
      multiplier: 60,
      etaAt: at(3),
      leftMs: 60_000,
      trueLeftMs: 55_000,
      gapMs: 5_000,
    });
    expect(energyFigures(detail(), T0).multiplier).toBe(1);
  });

  it('says why there is no estimate', () => {
    const d = detail({ samples: [{ at: at(1), seq: 1, energyWh: 100 }], truth: [] });
    d.estimate = { targetSoc: 100, targetFrom: 'default', taperSoc: 80, reason: 'no SoC reported' };
    delete d.truth;
    delete d.gap;
    const f = energyFigures(d, T0);
    expect(f.reason).toBe('no SoC reported');
    expect(f.socPercent).toBeUndefined();
    expect(f.phases).toBeUndefined();
    expect(f.trueEtaAt).toBeUndefined();
  });
});

describe('transaction limits', () => {
  it('reads as cost, energy, time and SoC', () => {
    expect(limitsText({ maxCost: 12.5, maxEnergy: 20_000, maxTime: 5400, maxSoC: 80 }, 'NZD')).toBe(
      '12.50 NZD, 20.0 kWh, 1 h 30 min, 80 % SoC',
    );
    expect(limitsText({ maxEnergy: 500 })).toBe('0.5 kWh');
  });
});
