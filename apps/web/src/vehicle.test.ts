import { describe, expect, it } from 'vitest';
import type { SessionDetail } from './api.js';
import { vehicleRows } from './vehicle.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function detail(
  ocpp: '1.6' | '2.0.1',
  extra: Partial<SessionDetail['session']> = {},
  estimate: Partial<SessionDetail['estimate']> = {},
): SessionDetail {
  return {
    session: {
      stationId: 'CP-1',
      n: 1,
      ocpp,
      state: 'running',
      source: 'local',
      requestedAt: at(0),
      startedAt: at(0),
      meterStartWh: 0,
      timeline: [],
      samples: [
        {
          at: at(10),
          seq: 7,
          energyWh: 1800,
          powerW: 11_000,
          socPercent: 33,
          currentA: { L1: 16, L2: 16, L3: 16 },
        },
      ],
      truth: [
        { at: at(10), socPercent: 33.4, energyWh: 1800, powerW: 11_000, msUntilFull: 3_600_000 },
      ],
      states: [{ at: at(0), state: 'charging', seq: 4 }],
      costs: [],
      ...extra,
    },
    summary: {
      stationId: 'CP-1',
      n: 1,
      ocpp,
      state: 'running',
      source: 'local',
      requestedAt: at(0),
      energyWh: 1800,
    },
    estimate: { targetSoc: 100, targetFrom: 'default', taperSoc: 80, ...estimate },
    truth: { at: at(10), socPercent: 33.4, msToTarget: 3_600_000, etaAt: at(70) },
    durations: { charging: 600_000, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
  };
}
const EV = {
  soc: 33.4,
  profile: { capacityKWh: 60, initialSoc: 30, maxPowerW: 11_000, phases: 3, departureMinutes: 90 },
};
const byField = (rows: ReturnType<typeof vehicleRows>) =>
  Object.fromEntries(rows.map((r) => [r.field, r]));

describe('vehicle card rows', () => {
  it('shows what 1.6 reports, estimates the rest, and says what 1.6 cannot carry', () => {
    const rows = byField(
      vehicleRows(
        detail(
          '1.6',
          {},
          {
            capacityWh: 59_500,
            capacityFrom: 'readings',
            energyLeftWh: 40_000,
            msToTarget: 4_000_000,
          },
        ),
        '1.6',
        EV,
      ),
    );
    expect(rows.soc?.values).toEqual([{ text: '33 %', source: 'reported', seq: 7 }]);
    expect(rows.soc?.truth).toEqual({ text: '33.4 %', source: 'truth' });
    expect(rows.capacity?.values).toEqual([
      { text: '59.50 kWh from the readings', source: 'estimate' },
    ]);
    expect(rows.capacity?.truth?.text).toBe('60 kWh');
    expect(rows.energyNeeded?.values).toEqual([{ text: '40.00 kWh left', source: 'estimate' }]);
    expect(rows.targetSoc?.values).toEqual([{ text: '100 % assumed', source: 'estimate' }]);
    expect(rows.timeToTarget?.values[0]?.text).toBe('1 h 06 min');
    expect(rows.timeToTarget?.truth?.text).toBe('1 h 00 min');
    expect(rows.departure).toMatchObject({ values: [], missing: 'not in this version' });
    expect(rows.departure?.truth?.text).toBe('90 min after plugging in');
    expect(rows.evLimits?.missing).toBe('not in this version; only the actual current');
    expect(rows.drawing?.values).toEqual([{ text: 'charging', source: 'reported', seq: 4 }]);
    expect(rows.phases?.values).toEqual([
      { text: '3 from the per-phase currents', source: 'estimate' },
    ]);
    expect(rows.energy?.truth?.text).toBe('1.80 kWh');
    expect(rows.preconditioning?.missing).toBe('not in this version');
  });

  it('shows what an ISO 15118 EV tells over 2.0.1, and what an EV without it does not', () => {
    const iso = detail('2.0.1', {
      chargingNeeds: {
        requestedEnergyTransfer: 'DC',
        departureTime: at(90),
        dcChargingParameters: {
          evMaxCurrent: 125,
          evMaxVoltage: 400,
          evMaxPower: 50_000,
          evEnergyCapacity: 60_000,
          energyAmount: 42_000,
          stateOfCharge: 30,
          fullSoC: 90,
          bulkSoC: 75,
        },
      },
    });
    const rows = byField(vehicleRows(iso, '2.0.1', EV));
    expect(rows.capacity?.values).toEqual([{ text: '60.00 kWh', source: 'reported' }]);
    expect(rows.energyNeeded?.values[0]?.text).toBe('42.00 kWh at the start');
    expect(rows.targetSoc?.values[0]?.text).toBe('full 90 %, fast charging to 75 %');
    expect(rows.departure?.values[0]).toEqual({ text: '11:30', source: 'reported' });
    expect(rows.evLimits?.values[0]?.text).toBe('50.0 kW, 125 A, 400 V');

    const plain = byField(
      vehicleRows(
        detail('2.0.1', { samples: [{ at: at(1), seq: 2, energyWh: 100 }] }),
        '2.0.1',
        undefined,
      ),
    );
    expect(plain.soc).toMatchObject({ values: [], missing: 'not reported by this station or EV' });
    expect(plain.capacity?.missing).toBe('not reported by this station or EV');
    expect(plain.timeToTarget?.missing).toBe('not in this version');
    expect(plain.capacity?.truth).toBeUndefined();
  });

  it('names the vehicle when the token is its identity', () => {
    const rows = byField(
      vehicleRows(
        detail('2.0.1', { idToken: { idToken: '00:1A:2B:3C:4D:5E', type: 'MacAddress' } }),
        '2.0.1',
        EV,
      ),
    );
    expect(rows.identity?.values).toEqual([
      { text: 'MacAddress 00:1A:2B:3C:4D:5E', source: 'reported' },
    ]);
  });
});
