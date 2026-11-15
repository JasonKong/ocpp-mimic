import { describe, expect, it } from 'vitest';
import { OCPP201_MESSAGE_SET } from '../message-set.js';
import { chargingNeeds } from './charging-needs.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');

describe('ISO 15118 charging needs', () => {
  it('reports AC parameters for an AC connector, from the EV model', () => {
    const needs = chargingNeeds({
      profile: {
        capacityKWh: 60,
        initialSoc: 30,
        maxPowerW: 11_000,
        phases: 3,
        departureMinutes: 120,
      },
      soc: 30.4,
      connectorType: 'cType2',
      pluggedAt: T0,
    });
    expect(needs).toEqual({
      requestedEnergyTransfer: 'AC_three_phase',
      departureTime: '2026-11-15T12:00:00.000Z',
      acChargingParameters: {
        energyAmount: 41_760,
        evMinCurrent: 6,
        evMaxCurrent: 16,
        evMaxVoltage: 400,
      },
    });
    const single = chargingNeeds({
      profile: { capacityKWh: 10, initialSoc: 20, maxPowerW: 7400, phases: 1, targetSoc: 80 },
      soc: 20,
      pluggedAt: T0,
    });
    expect(single).toEqual({
      requestedEnergyTransfer: 'AC_single_phase',
      acChargingParameters: {
        energyAmount: 6000,
        evMinCurrent: 6,
        evMaxCurrent: 33,
        evMaxVoltage: 230,
      },
    });
  });

  it('reports DC parameters with capacity, SoC, full and bulk SoC for a DC connector', () => {
    const needs = chargingNeeds({
      profile: {
        capacityKWh: 77,
        initialSoc: 10,
        maxPowerW: 150_000,
        phases: 3,
        targetSoc: 90,
        taperSoc: 75,
      },
      soc: 12.9,
      connectorType: 'cCCS2',
      pluggedAt: T0,
    });
    expect(needs).toEqual({
      requestedEnergyTransfer: 'DC',
      dcChargingParameters: {
        evMaxCurrent: 375,
        evMaxVoltage: 400,
        energyAmount: 59_367,
        evMaxPower: 150_000,
        stateOfCharge: 12,
        evEnergyCapacity: 77_000,
        fullSoC: 90,
        bulkSoC: 75,
      },
    });
    // A full EV needs nothing more.
    expect(
      chargingNeeds({
        profile: { capacityKWh: 10, initialSoc: 100, maxPowerW: 50_000, phases: 3 },
        soc: 100,
        connectorType: 'cCCS1',
        pluggedAt: T0,
      }).dcChargingParameters?.energyAmount,
    ).toBe(0);
  });

  it('builds messages that pass the OCA 2.0.1 schema', () => {
    for (const connectorType of ['cType2', 'cCCS2']) {
      const payload = {
        evseId: 1,
        chargingNeeds: chargingNeeds({
          profile: {
            capacityKWh: 60,
            initialSoc: 30,
            maxPowerW: 11_000,
            phases: 3,
            departureMinutes: 30,
          },
          soc: 30,
          connectorType,
          pluggedAt: T0,
        }),
      };
      expect(OCPP201_MESSAGE_SET.validateRequest('NotifyEVChargingNeeds', payload).ok).toBe(true);
    }
  });
});
