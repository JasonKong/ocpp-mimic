import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { createEnergy } from './energy.js';
import { createStationTimers } from './station-timers.js';

function setup(multiplier = 1) {
  const clock = new ManualClock();
  const full: number[] = [];
  const energy = createEnergy({
    clock,
    timers: createStationTimers(clock),
    connectorIds: [1, 2],
    offeredW: 11_000,
    evPowerW: 7_000,
    multiplier,
    registers: { '2': 500 },
    onFull: (connectorId) => full.push(connectorId),
    log: () => {},
  });
  return { clock, energy, full };
}

describe('energy', () => {
  it('draws the fixed power without an EV, capped by the limit, and integrates energy', () => {
    const { clock, energy } = setup();
    energy.update(1, true, undefined);
    expect(energy.meter(1)).toMatchObject({ powerW: 7_000, offeredW: 11_000 });
    energy.update(1, true, 3_680);
    expect(energy.meter(1)).toMatchObject({ powerW: 3_680, offeredW: 3_680 });
    clock.advance(3_600_000);
    expect(energy.sync(1).energyWh).toBeCloseTo(3_680);
    energy.update(1, false, undefined);
    expect(energy.meter(1).powerW).toBe(0);
    expect(energy.registers()).toMatchObject({ '2': 500 });
  });

  it('follows an EV until it is full, then calls back', () => {
    const { clock, energy, full } = setup(60);
    energy.plugEv(1, {
      name: 'small',
      profile: { capacityKWh: 10, initialSoc: 90, maxPowerW: 7_400, phases: 1 },
    });
    expect(energy.extras(1)).toEqual({ socPercent: 90, phases: 1 });
    // An EV with the PWM signal only never tells its SoC.
    energy.plugEv(2, {
      profile: {
        capacityKWh: 10,
        initialSoc: 50,
        maxPowerW: 7_400,
        phases: 3,
        communication: 'basic',
      },
    });
    expect(energy.extras(2)).toEqual({ phases: 3 });
    expect(energy.conversion(1)).toEqual({ voltageV: 230, phases: 1 });
    energy.update(1, true, undefined);
    expect(energy.meter(1).powerW).toBeGreaterThan(0);
    clock.advance(3_600_000);
    expect(full).toEqual([1]);
    expect(energy.canResume(1)).toBe(false);
    expect(energy.ev(1)?.name).toBe('small');
    expect(energy.removeEv(1)).toBe(true);
    expect(energy.removeEv(1)).toBe(false);
  });

  it('sets the register and the multiplier', () => {
    const { clock, energy } = setup();
    expect(energy.setRegister(2, 100)).toBe(500);
    energy.update(2, true, undefined);
    energy.setMultiplier(10);
    expect(energy.multiplier).toBe(10);
    clock.advance(360_000);
    expect(energy.sync(2).energyWh).toBeCloseTo(100 + 7_000);
  });
});
