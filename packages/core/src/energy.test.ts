import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { createEnergy } from './energy.js';
import { createStationTimers } from './station-timers.js';

function setup(multiplier = 1, stationW?: number) {
  const clock = new ManualClock();
  const full: number[] = [];
  const energy = createEnergy({
    clock,
    timers: createStationTimers(clock),
    connectorIds: [1, 2],
    offeredW: 11_000,
    evPowerW: 7_000,
    ...(stationW !== undefined && { stationW }),
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

  describe('a shared supply', () => {
    const big = { capacityKWh: 75, initialSoc: 20, maxPowerW: 11_000, phases: 3 as const };
    // At 95 % this EV takes 3,575 W: its curve tapers from 11 kW at 80 % to 1.1 kW at 100 %.
    const nearlyFull = { capacityKWh: 40, initialSoc: 95, maxPowerW: 11_000, phases: 3 as const };
    const power = (energy: ReturnType<typeof setup>['energy'], id: number) =>
      Math.round(energy.meter(id).powerW);

    it('gives two charging connectors half each, and one all it can take alone', () => {
      const { energy } = setup(1, 12_000);
      energy.plugEv(1, { profile: big });
      energy.plugEv(2, { profile: big });
      energy.update(1, true, undefined);
      expect(power(energy, 1)).toBe(11_000);
      energy.update(2, true, undefined);
      expect([power(energy, 1), power(energy, 2)]).toEqual([6_000, 6_000]);
      expect(energy.meter(2).offeredW).toBe(6_000);
      // The other car is full and suspended: this one gets a whole connector again.
      energy.update(1, false, undefined);
      expect([power(energy, 1), power(energy, 2)]).toEqual([0, 11_000]);
    });

    it('passes on what a tapering car does not take, and more as it tapers', () => {
      const { clock, energy } = setup(1, 12_000);
      energy.plugEv(1, { profile: nearlyFull });
      energy.plugEv(2, { profile: big });
      energy.update(1, true, undefined);
      energy.update(2, true, undefined);
      // Its share would be 6 kW; it takes 3,575 W and the rest goes to the other car.
      expect(power(energy, 1)).toBe(3_575);
      expect(power(energy, 2)).toBe(12_000 - 3_575);
      expect(power(energy, 1) + power(energy, 2)).toBe(12_000);
      // A simulated minute later the shares are worked out again: it takes less, the other more.
      clock.advance(60_000);
      expect(power(energy, 1)).toBeLessThan(3_575);
      expect(power(energy, 2)).toBeGreaterThan(12_000 - 3_575);
      expect(power(energy, 1) + power(energy, 2)).toBeLessThanOrEqual(12_000);
    });

    it('shares a station-wide limit the same way, and lifts it', () => {
      const { energy } = setup();
      energy.plugEv(1, { profile: nearlyFull });
      energy.plugEv(2, { profile: big });
      energy.update(1, true, undefined);
      energy.update(2, true, undefined);
      expect([power(energy, 1), power(energy, 2)]).toEqual([3_575, 11_000]);
      energy.setStationLimit(10_000);
      expect([power(energy, 1), power(energy, 2)]).toEqual([3_575, 10_000 - 3_575]);
      // A connector's own limit still caps it under the station's.
      energy.update(2, true, 2_000);
      expect([power(energy, 1), power(energy, 2)]).toEqual([3_575, 2_000]);
      energy.setStationLimit(undefined);
      energy.update(2, true, undefined);
      expect([power(energy, 1), power(energy, 2)]).toEqual([3_575, 11_000]);
    });
  });
});
