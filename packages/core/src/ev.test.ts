import { describe, expect, it } from 'vitest';
import {
  acceptedPowerW,
  advanceEv,
  createEv,
  evPowerW,
  evProfileProblems,
  msUntilFull,
  msUntilSoc,
  reportsSoc,
  speaksIso15118,
  TAPER_FLOOR,
  type EvProfile,
} from './ev.js';
import { createMeter, sampleMeter, withPower } from './meter.js';

const HOUR = 3_600_000;
/** 10 kWh battery at 20 %, 7.4 kW single-phase charger, taper from 80 %. */
const SMALL: EvProfile = { capacityKWh: 10, initialSoc: 20, maxPowerW: 7400, phases: 1 };
/** Fall of the accepted power per percent above 80 %: (7400 − 740) / 20. */
const SLOPE = (7400 - 7400 * TAPER_FLOOR) / 20;

describe('EV model', () => {
  it('accepts full power up to the taper point, then less, and nothing when full', () => {
    expect(acceptedPowerW(SMALL, 50)).toBe(7400);
    expect(acceptedPowerW(SMALL, 80)).toBe(7400);
    expect(acceptedPowerW(SMALL, 90)).toBeCloseTo(7400 - 10 * SLOPE, 6);
    expect(acceptedPowerW(SMALL, 99.999)).toBeCloseTo(740, 0);
    expect(acceptedPowerW(SMALL, 100)).toBe(0);
  });

  it('draws the smaller of the offered and the accepted power', () => {
    const ev = createEv({ ...SMALL, initialSoc: 90 });
    expect(evPowerW(ev, 22_000)).toBeCloseTo(7400 - 10 * SLOPE, 6);
    expect(evPowerW(ev, 3680)).toBe(3680);
    expect(evPowerW(ev, 0)).toBe(0);
  });

  it('charges at constant power to the taper point', () => {
    const ev = createEv(SMALL);
    // 6 kWh from 20 % to 80 % at 7360 W.
    const toTaper = (6000 / 7360) * HOUR;
    const result = advanceEv(ev, 7360, toTaper);
    expect(result.ev.soc).toBeCloseTo(80, 6);
    expect(result.energyWh).toBeCloseTo(6000, 6);
    expect(result.powerW).toBe(7360);
  });

  it('tapers above 80 % and stops at 100 %, at the moment msUntilFull predicts', () => {
    const ev = createEv(SMALL);
    // Constant 7360 W until the EV accepts less (80.12 %), then P = 7360·e^(−3.33 t) down to 740 W.
    const switchSoc = 80 + (7400 - 7360) / SLOPE;
    const lambda = (100 * SLOPE) / 10_000;
    const expected =
      (((switchSoc - 20) * 10_000) / 100 / 7360) * HOUR + (Math.log(7360 / 740) / lambda) * HOUR;
    const full = msUntilFull(ev, 7360) ?? NaN;
    expect(full).toBeGreaterThanOrEqual(expected);
    expect(full - expected).toBeLessThan(1);

    const almost = advanceEv(ev, 7360, full - 60_000);
    expect(almost.ev.soc).toBeLessThan(100);
    expect(almost.ev.soc).toBeGreaterThan(99);
    expect(almost.powerW).toBeGreaterThan(740);
    expect(almost.powerW).toBeLessThan(800);

    const done = advanceEv(ev, 7360, full);
    expect(done.ev.soc).toBe(100);
    expect(done.powerW).toBe(0);
    expect(done.energyWh).toBeCloseTo(8000, 6);
    // Nothing more goes in once full.
    expect(advanceEv(done.ev, 7360, HOUR)).toMatchObject({ energyWh: 0, powerW: 0 });
  });

  it('gives the same result for one long advance as for many short ones', () => {
    let ev = createEv(SMALL);
    let energy = 0;
    let lastSoc = ev.soc;
    for (let minute = 0; minute < 120; minute++) {
      const step = advanceEv(ev, 7360, 60_000);
      expect(step.energyWh).toBeGreaterThanOrEqual(0);
      expect(step.ev.soc).toBeGreaterThanOrEqual(lastSoc);
      energy += step.energyWh;
      lastSoc = step.ev.soc;
      ev = step.ev;
    }
    const once = advanceEv(createEv(SMALL), 7360, 2 * HOUR);
    expect(ev.soc).toBeCloseTo(once.ev.soc, 9);
    expect(energy).toBeCloseTo(once.energyWh, 6);
  });

  it('stays at the charge point limit longer when the charge point offers less', () => {
    const ev = createEv(SMALL);
    // 16 A: 3680 W until the EV accepts less, at 80 + (7400 − 3680) / slope ≈ 91.2 %.
    const switchSoc = 80 + (7400 - 3680) / SLOPE;
    const toSwitch = (((switchSoc - 20) * 10_000) / 100 / 3680) * HOUR;
    const atSwitch = advanceEv(ev, 3680, toSwitch);
    expect(atSwitch.ev.soc).toBeCloseTo(switchSoc, 6);
    expect(atSwitch.powerW).toBeCloseTo(3680, 6);
    expect(advanceEv(ev, 3680, toSwitch + 600_000).powerW).toBeLessThan(3680);
  });

  it('does nothing without offered power, and is done at once when already full', () => {
    const ev = createEv(SMALL);
    expect(msUntilFull(ev, 0)).toBeUndefined();
    expect(advanceEv(ev, 0, HOUR)).toMatchObject({ energyWh: 0, powerW: 0, ev: { soc: 20 } });
    const full = createEv({ ...SMALL, initialSoc: 100 });
    expect(msUntilFull(full, 7360)).toBe(0);
    expect(evPowerW(full, 7360)).toBe(0);
  });

  it('stops at a lower target without a taper when taperSoc equals targetSoc', () => {
    const ev = createEv({ ...SMALL, taperSoc: 90, targetSoc: 90 });
    const full = msUntilFull(ev, 7400) ?? NaN;
    expect(full).toBeCloseTo((7000 / 7400) * HOUR, -1);
    const done = advanceEv(ev, 7400, full);
    expect(done.ev.soc).toBe(90);
    expect(done.powerW).toBe(0);
  });

  it('rejects unusable profiles', () => {
    expect(evProfileProblems(SMALL)).toEqual([]);
    expect(
      evProfileProblems({ capacityKWh: 0, initialSoc: 120, maxPowerW: -1, phases: 2 as 1 }),
    ).toEqual([
      'capacityKWh must be greater than 0',
      'maxPowerW must be greater than 0',
      'phases must be 1 or 3',
      'initialSoc must be between 0 and 100',
    ]);
    expect(evProfileProblems({ ...SMALL, taperSoc: 95, targetSoc: 90 })).toEqual([
      'taperSoc must be between 0 and targetSoc',
    ]);
    expect(() => createEv({ ...SMALL, capacityKWh: 0 })).toThrow(RangeError);
    expect(evProfileProblems({ ...SMALL, communication: 'wifi' as 'dc' })).toEqual([
      'communication must be one of basic, dc, iso15118, iso15118-20',
    ]);
  });

  it('tells whether the station learns the SoC from the EV communication', () => {
    expect(reportsSoc(SMALL)).toBe(true);
    expect(reportsSoc({ ...SMALL, communication: 'basic' })).toBe(false);
    expect(reportsSoc({ ...SMALL, communication: 'dc' })).toBe(true);
    expect(reportsSoc({ ...SMALL, communication: 'iso15118' })).toBe(true);
  });

  it('reports currents per phase for a three-phase EV', () => {
    const meter = withPower(createMeter({ now: 0, offeredW: 11_040, voltageV: 230 }), 0, 11_040);
    const three = sampleMeter(meter, 0, ['Current.Import', 'Current.Offered'], 'Sample.Periodic', {
      phases: 3,
    });
    expect(three?.sampledValue.map((v) => `${v.measurand} ${v.phase} ${v.value}`)).toEqual([
      'Current.Import L1 16',
      'Current.Import L2 16',
      'Current.Import L3 16',
      'Current.Offered L1 16',
      'Current.Offered L2 16',
      'Current.Offered L3 16',
    ]);
    const one = sampleMeter(meter, 0, ['Current.Import'], 'Sample.Periodic', { phases: 1 });
    expect(one?.sampledValue).toEqual([
      {
        context: 'Sample.Periodic',
        measurand: 'Current.Import',
        location: 'Outlet',
        unit: 'A',
        value: '48',
      },
    ]);
  });

  it('adds SoC to meter samples when the EV state of charge is known', () => {
    const meter = createMeter({ now: 0 });
    expect(sampleMeter(meter, 0, ['SoC'], 'Sample.Periodic', { socPercent: 45.7 })).toEqual({
      timestamp: new Date(0).toISOString(),
      sampledValue: [
        {
          context: 'Sample.Periodic',
          measurand: 'SoC',
          location: 'EV',
          value: '45',
          unit: 'Percent',
        },
      ],
    });
    expect(sampleMeter(meter, 0, ['SoC'], 'Sample.Periodic')).toBeUndefined();
  });
});

describe('ISO 15118-20 EVs', () => {
  it('reach any SoC at the moment msUntilSoc predicts, before and in the taper', () => {
    const ev = createEv(SMALL);
    // 20 % to 50 % of 10 kWh at 7400 W: 3 kWh, 0.4054 h.
    expect(msUntilSoc(ev, 7400, 50)).toBe(Math.ceil((3000 / 7400) * HOUR));
    expect(msUntilSoc(ev, 7400, 100)).toBe(msUntilFull(ev, 7400));
    for (const goal of [50, 85, 95]) {
      const ms = msUntilSoc(ev, 7400, goal) ?? NaN;
      expect(advanceEv(ev, 7400, ms).ev.soc).toBeCloseTo(goal, 3);
    }
    // Under a 3 kW limit the EV takes 3 kW until its taper falls below it.
    const limited = msUntilSoc(ev, 3000, 90) ?? NaN;
    expect(advanceEv(ev, 3000, limited).ev.soc).toBeCloseTo(90, 3);
    expect(msUntilSoc(ev, 7400, 10)).toBe(0);
    expect(msUntilSoc(ev, 0, 50)).toBeUndefined();
  });

  it('speak ISO 15118 and check their control mode and minimum SoC', () => {
    expect(speaksIso15118({ ...SMALL, communication: 'iso15118-20' })).toBe(true);
    expect(speaksIso15118({ ...SMALL, communication: 'dc' })).toBe(false);
    expect(reportsSoc({ ...SMALL, communication: 'iso15118-20' })).toBe(true);
    expect(
      evProfileProblems({
        ...SMALL,
        targetSoc: 80,
        minimumSoc: 90,
        controlMode: 'Sometimes' as 'DynamicControl',
      }),
    ).toEqual([
      'controlMode must be one of ScheduledControl, DynamicControl',
      'minimumSoc must be between 0 and targetSoc',
    ]);
  });
});
