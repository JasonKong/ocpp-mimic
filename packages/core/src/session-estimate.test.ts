import { describe, expect, it } from 'vitest';
import { advanceEv, createEv, evPowerW, msUntilFull, type EvProfile } from './ev.js';
import {
  capacityFromReadings,
  estimateGap,
  estimateSession,
  hoursToTarget,
  recentPowerW,
  refinedSoc,
  sessionTruth,
} from './session-estimate.js';
import type { ReportedSample, SessionRecord } from './session.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const base = (): SessionRecord => ({
  stationId: 'CP-1',
  n: 1,
  ocpp: '2.0.1',
  evseId: 1,
  state: 'running',
  source: 'local',
  requestedAt: iso(T0),
  startedAt: iso(T0),
  timeline: [],
  samples: [],
  truth: [],
  states: [],
  costs: [],
});

/**
 * A session as the station would report it: every `everyMs` a sample with
 * the energy register, the power and the SoC rounded down to an integer (as
 * meters report it), and a true sample from the EV model next to it.
 */
function simulate(
  profile: EvProfile,
  offeredW: number,
  durationMs: number,
  everyMs = 60_000,
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  const record = { ...base(), ...extra };
  let ev = createEv(profile);
  let energyWh = 0;
  let powerW = evPowerW(ev, offeredW);
  for (let t = 0; t <= durationMs; t += everyMs) {
    const at = iso(T0 + t);
    if (t > 0) {
      const step = advanceEv(ev, offeredW, everyMs);
      ev = step.ev;
      energyWh += step.energyWh;
      powerW = step.powerW;
    }
    record.samples.push({ at, seq: t / everyMs, energyWh, powerW, socPercent: Math.floor(ev.soc) });
    const ms = msUntilFull(ev, offeredW);
    record.truth.push({
      at,
      socPercent: ev.soc,
      energyWh,
      powerW,
      ...(ms !== undefined && { msUntilFull: ms }),
    });
  }
  return record;
}

/** The record as it stood at minute `minute`. */
const at = (record: SessionRecord, minute: number, everyMs = 60_000): SessionRecord => ({
  ...record,
  samples: record.samples.slice(0, Math.floor((minute * 60_000) / everyMs) + 1),
  truth: record.truth.slice(0, Math.floor((minute * 60_000) / everyMs) + 1),
});

const AC: EvProfile = { capacityKWh: 60, initialSoc: 20, maxPowerW: 11_000, phases: 3 };
const DC: EvProfile = { capacityKWh: 60, initialSoc: 10, maxPowerW: 50_000, phases: 3 };
const SMALL: EvProfile = { capacityKWh: 10, initialSoc: 20, maxPowerW: 7_400, phases: 1 };

describe('session estimates', () => {
  it('matches the EV model when it knows the capacity and the power', () => {
    for (const [profile, soc] of [
      [AC, 20],
      [AC, 90],
      [DC, 50],
    ] as const) {
      const ev = createEv({ ...profile, initialSoc: soc });
      const model = msUntilFull(ev, profile.maxPowerW) ?? 0;
      const power =
        soc > 80 ? profile.maxPowerW * (1 - (0.9 * (soc - 80)) / 20) : profile.maxPowerW;
      const ours = hoursToTarget(profile.capacityKWh * 1000, soc, power, 80, 100) * 3_600_000;
      expect(Math.abs(ours - model) / model).toBeLessThan(1e-6);
    }
  });

  it('works the capacity out once SoC has risen 5 points', () => {
    const record = simulate(AC, 22_000, 3 * 3_600_000);
    expect(capacityFromReadings(at(record, 10).samples)).toBeUndefined();
    // 11 kW into 60 kWh is 0.31 points a minute: 5 points take about 17 minutes.
    const capacity = capacityFromReadings(at(record, 30).samples);
    expect(capacity).toBeDefined();
    expect(Math.abs((capacity ?? 0) - 60_000) / 60_000).toBeLessThan(0.03);
  });

  it('averages the power over the last 5 minutes', () => {
    const samples: ReportedSample[] = [0, 1, 2, 3, 4, 5, 6].map((m) => ({
      at: iso(T0 + m * 60_000),
      seq: m,
      energyWh: m * 100,
      powerW: 1,
    }));
    expect(recentPowerW(samples)).toBe(1);
    expect(recentPowerW(samples.map(({ powerW: _p, ...s }) => s))).toBeCloseTo(6000);
    expect(recentPowerW([{ at: iso(T0), seq: 1, powerW: 3600 }])).toBe(3600);
  });

  it('adds the energy since SoC last went up to the reported integer', () => {
    const samples: ReportedSample[] = [
      { at: iso(T0), seq: 1, energyWh: 0, socPercent: 40 },
      { at: iso(T0 + 60_000), seq: 2, energyWh: 300, socPercent: 41 },
      { at: iso(T0 + 120_000), seq: 3, energyWh: 600, socPercent: 41 },
    ];
    // 300 Wh of a 60 kWh battery since 41 % was first reported.
    expect(refinedSoc(samples, 60_000)).toBeCloseTo(41.5);
    expect(refinedSoc(samples.slice(0, 1), 60_000)).toBe(40);
    expect(
      refinedSoc(
        [...samples, { at: iso(T0 + 180_000), seq: 4, energyWh: 2000, socPercent: 41 }],
        60_000,
      ),
    ).toBeCloseTo(41.99);
  });

  it('stays within 5 minutes or 10 % of the truth once SoC has risen 5 points', () => {
    for (const profile of [AC, DC, SMALL]) {
      const record = simulate(profile, profile.maxPowerW * 2, 6 * 3_600_000);
      const minutes = record.samples.length - 1;
      let checked = 0;
      for (let minute = 1; minute <= minutes; minute++) {
        const now = at(record, minute);
        const estimate = estimateSession(now);
        // The capacity comes from the readings where SoC went up: the first is one point in.
        const rose = (now.samples.at(-1)?.socPercent ?? 0) - profile.initialSoc;
        if (rose < 6 || estimate.reason === 'target reached') continue;
        const gap = estimateGap(estimate, sessionTruth(now));
        expect(gap, `${profile.maxPowerW} W at minute ${minute}`).toBeDefined();
        expect(gap?.off, `${profile.maxPowerW} W at minute ${minute}: ${gap?.gapMs} ms`).toBe(
          false,
        );
        checked++;
      }
      expect(checked).toBeGreaterThan(10);
    }
  });

  it('uses the charging needs of an ISO 15118 EV: capacity, target, taper and departure', () => {
    const profile: EvProfile = { ...DC, targetSoc: 90, taperSoc: 75 };
    // 10 % to 75 % at 50 kW takes 47 minutes, the taper to 90 % about 28 more.
    const departure = iso(T0 + 2 * 3_600_000);
    const record = simulate(profile, 100_000, 2 * 3_600_000, 60_000, {
      chargingNeeds: {
        requestedEnergyTransfer: 'DC',
        departureTime: departure,
        dcChargingParameters: {
          evMaxCurrent: 125,
          evMaxVoltage: 400,
          evEnergyCapacity: 60_000,
          fullSoC: 90,
          bulkSoC: 75,
        },
      },
    });
    const early = estimateSession(at(record, 2));
    expect(early).toMatchObject({
      capacityWh: 60_000,
      capacityFrom: 'chargingNeeds',
      targetSoc: 90,
      targetFrom: 'chargingNeeds',
      taperSoc: 75,
      departureTime: departure,
      reachesTargetBeforeDeparture: true,
    });
    const gap = estimateGap(early, sessionTruth(at(record, 2)));
    expect(gap?.off).toBe(false);
    const soon = {
      ...record,
      chargingNeeds: { ...record.chargingNeeds, departureTime: iso(T0 + 3_600_000) },
    };
    expect(estimateSession(at(soon, 2)).reachesTargetBeforeDeparture).toBe(false);
  });

  it('says why it cannot estimate', () => {
    const noSoc = { ...base(), samples: [{ at: iso(T0), seq: 1, energyWh: 0, powerW: 7000 }] };
    expect(estimateSession(noSoc).reason).toBe('no SoC reported');
    const early = simulate(AC, 11_000, 5 * 60_000);
    expect(estimateSession(early)).toMatchObject({
      reason: 'SoC has not risen enough',
      socPercent: 21,
    });
    const full = simulate(SMALL, 7400, 3 * 3_600_000);
    expect(estimateSession(full)).toMatchObject({ reason: 'target reached', msToTarget: 0 });
    const paused = simulate(AC, 11_000, 60 * 60_000);
    const stillAt = paused.samples.at(-1)!;
    for (let m = 1; m <= 6; m++) {
      paused.samples.push({
        ...stillAt,
        at: iso(Date.parse(stillAt.at) + m * 60_000),
        powerW: 0,
      });
    }
    expect(estimateSession(paused).reason).toBe('no power');
  });

  it('reads the truth from the latest true sample', () => {
    const record = simulate(AC, 11_000, 10 * 60_000);
    const truth = sessionTruth(record);
    expect(truth?.at).toBe(iso(T0 + 10 * 60_000));
    expect(Date.parse(truth?.etaAt ?? '')).toBe(
      Date.parse(truth?.at ?? '') + (truth?.msToTarget ?? 0),
    );
    expect(sessionTruth(base())).toBeUndefined();
    expect(estimateGap(estimateSession(base()), truth)).toBeUndefined();
  });
});
