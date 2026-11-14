import { describe, expect, it } from 'vitest';
import {
  createMeter,
  meterAt,
  nextAlignedSample,
  nextPeriodicSample,
  registerWh,
  sampleMeter,
  withPower,
} from './meter.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const HOUR = 3_600_000;

describe('meter', () => {
  it('integrates power over time into the energy register', () => {
    let meter = createMeter({ now: T0, energyWh: 1000 });
    meter = withPower(meter, T0, 7000);
    expect(registerWh(meterAt(meter, T0 + HOUR / 2))).toBe(4500);
    meter = withPower(meter, T0 + HOUR / 2, 0);
    expect(registerWh(meterAt(meter, T0 + HOUR))).toBe(4500);
  });

  it('never delivers more than it offers, nor negative power', () => {
    const meter = createMeter({ now: T0, offeredW: 3680 });
    expect(withPower(meter, T0, 11_000).powerW).toBe(3680);
    expect(withPower(meter, T0, -5).powerW).toBe(0);
  });

  it('only counts up, even if asked about an earlier time', () => {
    const meter = withPower(createMeter({ now: T0 }), T0, 3600);
    const later = meterAt(meter, T0 + HOUR);
    expect(meterAt(later, T0).energyWh).toBe(later.energyWh);
  });

  it('samples the supported measurands, skipping the others', () => {
    const meter = withPower(createMeter({ now: T0, energyWh: 1520.4, offeredW: 7360 }), T0, 6900);
    expect(
      sampleMeter(
        meter,
        T0,
        ['Energy.Active.Import.Register', 'Power.Active.Import', 'Current.Import', 'SoC'],
        'Sample.Periodic',
      ),
    ).toEqual({
      timestamp: '2026-11-14T10:00:00.000Z',
      sampledValue: [
        {
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          location: 'Outlet',
          value: '1520',
          unit: 'Wh',
        },
        {
          context: 'Sample.Periodic',
          measurand: 'Power.Active.Import',
          location: 'Outlet',
          value: '6900',
          unit: 'W',
        },
        {
          context: 'Sample.Periodic',
          measurand: 'Current.Import',
          location: 'Outlet',
          value: '30',
          unit: 'A',
        },
      ],
    });
    expect(sampleMeter(meter, T0, ['SoC'], 'Sample.Periodic')).toBeUndefined();
    expect(sampleMeter(meter, T0, [], 'Sample.Periodic')).toBeUndefined();
  });
});

describe('sampling schedule', () => {
  it('samples periodically from the transaction start', () => {
    expect(nextPeriodicSample(T0, 60, T0)).toBe(T0 + 60_000);
    expect(nextPeriodicSample(T0, 60, T0 + 59_999)).toBe(T0 + 60_000);
    expect(nextPeriodicSample(T0, 60, T0 + 60_000)).toBe(T0 + 120_000);
    expect(nextPeriodicSample(T0, 0, T0)).toBeUndefined();
  });

  it('aligns clock samples to intervals counted from midnight UTC', () => {
    const at = Date.parse('2026-11-14T10:07:30Z');
    expect(new Date(nextAlignedSample(900, at) ?? 0).toISOString()).toBe(
      '2026-11-14T10:15:00.000Z',
    );
    expect(
      new Date(nextAlignedSample(3600, Date.parse('2026-11-14T23:30:00Z')) ?? 0).toISOString(),
    ).toBe('2026-11-15T00:00:00.000Z');
    expect(nextAlignedSample(0, at)).toBeUndefined();
  });
});
