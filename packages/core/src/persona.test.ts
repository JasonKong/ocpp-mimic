import { describe, expect, it } from 'vitest';
import { parseDuration, resolvePersonas } from './persona.js';

const BASE = {
  persona: 'base',
  boot: { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' },
  connectors: 2,
  power: { offeredW: 11000 },
  features: ['Core', 'RemoteTrigger'],
  config: { HeartbeatInterval: 120, StopTransactionOnInvalidId: false },
  timing: {
    startTransactionDelay: '2s',
    commandDelays: { RemoteStopTransaction: 800 },
    resetDowntime: { soft: '30s', hard: '3m' },
  },
  faults: [{ name: 'Ground fault', errorCode: 'GroundFailure', info: 'GND_FAULT' }],
};

const resolveOne = (data: unknown) => resolvePersonas([{ source: 'test.yaml', data }]);

describe('parseDuration', () => {
  it('reads milliseconds and unit suffixes', () => {
    expect([200, '200ms', '6s', '1.5s', '3m', '1h'].map(parseDuration)).toEqual([
      200, 200, 6000, 1500, 180_000, 3_600_000,
    ]);
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration(-1)).toBeUndefined();
  });
});

describe('resolvePersonas', () => {
  it('turns a persona into charge point options', () => {
    const { personas, errors } = resolveOne(BASE);
    expect(errors).toEqual([]);
    expect(personas.get('base')?.options).toEqual({
      boot: { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' },
      connectors: 2,
      offeredPowerW: 11000,
      config: {
        values: {
          HeartbeatInterval: '120',
          StopTransactionOnInvalidId: 'false',
          SupportedFeatureProfiles: 'Core,RemoteTrigger',
        },
      },
      timing: {
        startTransactionDelayMs: 2000,
        actionDelaysMs: { RemoteStopTransaction: 800 },
        resetDowntimeMs: { Soft: 30_000, Hard: 180_000 },
      },
    });
    expect(personas.get('base')?.warnings).toEqual([]);
  });

  it('merges extends: objects key by key, arrays and scalars replaced', () => {
    const child = {
      persona: 'child',
      extends: 'base',
      boot: { firmwareVersion: '2.5.0' },
      features: ['Core'],
      config: { HeartbeatInterval: 60 },
    };
    const { personas, errors } = resolvePersonas([
      { source: 'child.yaml', data: child },
      { source: 'base.yaml', data: BASE },
    ]);
    expect(errors).toEqual([]);
    expect(personas.get('child')?.definition).toMatchObject({
      boot: { chargePointVendor: 'VendorX', chargePointModel: 'AC-7', firmwareVersion: '2.5.0' },
      connectors: 2,
      features: ['Core'],
      config: { HeartbeatInterval: 60, StopTransactionOnInvalidId: false },
    });
  });

  it('reports schema problems with the source and path', () => {
    const { personas, errors } = resolveOne({
      ...BASE,
      connectors: 0,
      timing: { actionDelay: 'soon' },
      colour: 'red',
    });
    expect(personas.size).toBe(0);
    expect(errors).toEqual([
      'test.yaml: $.connectors: less than 1',
      'test.yaml: $.timing.actionDelay: not a duration (use milliseconds or e.g. "500ms", "6s", "3m"): "soon"',
      'test.yaml: $.colour: unexpected property',
    ]);
  });

  it('reports invalid configuration values', () => {
    expect(resolveOne({ ...BASE, config: { HeartbeatInterval: 'often' } }).errors).toEqual([
      'test.yaml: invalid value for HeartbeatInterval: "often"',
    ]);
    expect(resolveOne({ ...BASE, config: { Nope: 1 } }).errors).toEqual([
      'test.yaml: unknown configuration key Nope',
    ]);
  });

  it('reports missing ids, duplicates, unknown parents and cycles', () => {
    const { errors } = resolvePersonas([
      { source: 'a.yaml', data: { boot: {} } },
      { source: 'b.yaml', data: BASE },
      { source: 'c.yaml', data: BASE },
      { source: 'd.yaml', data: { persona: 'orphan', extends: 'nobody' } },
      { source: 'e.yaml', data: { persona: 'x', extends: 'y' } },
      { source: 'f.yaml', data: { persona: 'y', extends: 'x' } },
    ]);
    expect(errors).toEqual([
      'a.yaml: a persona needs a "persona" id',
      'c.yaml: persona "base" is already defined in b.yaml',
      'd.yaml: extends unknown persona "nobody"',
      'f.yaml: circular extends: x → y → x',
    ]);
  });

  it('warns about feature profiles that are not implemented yet', () => {
    const { personas } = resolveOne({ ...BASE, features: ['Core', 'SmartCharging'] });
    expect(personas.get('base')?.warnings).toEqual([
      'test.yaml: feature profile SmartCharging is advertised but not implemented yet',
    ]);
  });
});
