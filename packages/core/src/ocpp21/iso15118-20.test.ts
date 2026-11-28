import { describe, expect, it } from 'vitest';
import { createEv, type EvProfile } from '../ev.js';
import { chargingNeeds21, vehicleReadings, vehicleSampledValues } from './iso15118-20.js';

const T0 = Date.parse('2026-11-16T08:00:00Z');
/** 60 kWh at 30 %, 11 kW three-phase, target 80 %, minimum 40 %, leaving after 90 minutes. */
const AC: EvProfile = {
  capacityKWh: 60,
  initialSoc: 30,
  maxPowerW: 11_000,
  phases: 3,
  taperSoc: 70,
  targetSoc: 80,
  minimumSoc: 40,
  communication: 'iso15118-20',
  departureMinutes: 90,
};

describe('ISO 15118-20 charging needs', () => {
  it('leave after departureMinutes of simulated time under an energy multiplier', () => {
    // 90 simulated minutes at energy x30 are 3 minutes on the wall clock.
    expect(
      chargingNeeds21({ profile: AC, soc: 30, pluggedAt: T0, energyMultiplier: 30 }).departureTime,
    ).toBe('2026-11-16T08:03:00.000Z');
  });

  it('give v2xChargingParameters for charging, the control mode and the energy requests (K18.FR.06)', () => {
    // Hand-checked: 50 % of 60 kWh to the target, 10 % to the minimum; 6 A x 230 V x 3 = 4140 W.
    expect(chargingNeeds21({ profile: AC, soc: 30, pluggedAt: T0 })).toEqual({
      requestedEnergyTransfer: 'AC_three_phase',
      availableEnergyTransfer: ['AC_three_phase'],
      controlMode: 'ScheduledControl',
      mobilityNeedsMode: 'EVCC',
      departureTime: '2026-11-16T09:30:00.000Z',
      v2xChargingParameters: {
        minChargePower: 4140,
        maxChargePower: 11_000,
        evTargetEnergyRequest: 30_000,
        evMaxEnergyRequest: 30_000,
        evMinEnergyRequest: 6000,
        targetSoC: 80,
      },
    });
    const dc = chargingNeeds21({
      profile: { ...AC, maxPowerW: 150_000, controlMode: 'DynamicControl', minimumSoc: 20 },
      soc: 30,
      connectorType: 'cCCS2',
      pluggedAt: T0,
    });
    expect(dc).toMatchObject({
      requestedEnergyTransfer: 'DC',
      controlMode: 'DynamicControl',
      v2xChargingParameters: {
        maxChargeCurrent: 375,
        maxVoltage: 400,
        // Above the minimum already: a negative request.
        evMinEnergyRequest: -6000,
      },
    });
  });
});

describe('ISO 15118-20 vehicle readings', () => {
  it('report SoCs, remaining times, capacity and energy requests (R-EV-4)', () => {
    const ev = createEv(AC);
    const readings = vehicleReadings(ev, 11_000);
    // 30 % to 40 % = 6 kWh at 11 kW: 1963.6 s, so 1964.
    expect(readings).toMatchObject({
      'Display.PresentSOC': 30,
      'Display.MinimumSOC': 40,
      'Display.TargetSOC': 80,
      'Display.MaximumSOC': 80,
      'Display.RemainingTimeToMinimumSOC': 1964,
      'Display.ChargingComplete': 0,
      'Display.BatteryEnergyCapacity': 60_000,
      'EnergyRequest.Target': 30_000,
      'EnergyRequest.Minimum': 6000,
      'EnergyRequest.Bulk': 24_000,
    });
    expect(readings['Display.RemainingTimeToTargetSOC']).toBeGreaterThan((30_000 / 11_000) * 3600);
    // Nothing offered: no remaining times.
    expect(vehicleReadings(ev, 0)).not.toHaveProperty('Display.RemainingTimeToTargetSOC');
    expect(
      vehicleSampledValues(
        readings,
        ['Energy.Active.Import.Register', 'Display.ChargingComplete', 'Display.PresentSOC'],
        'Sample.Periodic',
      ),
    ).toEqual([
      {
        value: 0,
        measurand: 'Display.ChargingComplete',
        location: 'EV',
        context: 'Sample.Periodic',
      },
      {
        value: 30,
        measurand: 'Display.PresentSOC',
        location: 'EV',
        context: 'Sample.Periodic',
        unitOfMeasure: { unit: 'Percent' },
      },
    ]);
  });
});
