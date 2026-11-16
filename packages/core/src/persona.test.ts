import { describe, expect, it } from 'vitest';
import {
  FEATURE_PROFILES,
  IMPLEMENTED_FEATURE_PROFILES,
  parseDuration,
  resolvePersonas,
} from './persona.js';

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
  it('validates a usage model', () => {
    const persona = {
      persona: 'with-usage',
      boot: { chargePointVendor: 'V', chargePointModel: 'M' },
      connectors: 1,
    };
    expect(
      resolveOne({ ...persona, usage: { sessionsPerHour: 2, stay: { min: '5m', max: '1h' } } })
        .errors,
    ).toEqual([]);
    expect(resolveOne({ ...persona, usage: { sessionsPerHour: 0 } }).errors).toEqual([
      'test.yaml: $.usage.sessionsPerHour: must be above 0',
    ]);
    expect(
      resolveOne({ ...persona, usage: { stay: { min: '5m', max: '1h' } } }).errors,
    ).toHaveLength(1);
  });

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

  it('reads firmware timings and outcomes', () => {
    const { personas } = resolveOne({
      ...BASE,
      firmware: { downloadTime: '2s', installTime: 3000, download: 'fail', signature: 'fail' },
    });
    expect(personas.get('base')?.options.firmware).toEqual({
      downloadMs: 2000,
      installMs: 3000,
      download: 'fail',
      signature: 'fail',
    });
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

  it('keeps named EV profiles and rejects unusable ones', () => {
    const ev = { capacityKWh: 40, initialSoc: 20, maxPowerW: 7400, phases: 1 };
    const ok = resolveOne({ ...BASE, evs: { compact: ev } });
    expect(ok.errors).toEqual([]);
    expect(ok.personas.get('base')?.definition.evs).toEqual({ compact: ev });
    expect(resolveOne({ ...BASE, evs: { broken: { ...ev, initialSoc: 150 } } }).errors).toEqual([
      'test.yaml: $.evs.broken: initialSoc must be between 0 and 100',
    ]);
    expect(resolveOne({ ...BASE, evs: { pwm: { ...ev, communication: 'basic' } } }).errors).toEqual(
      [],
    );
    expect(
      resolveOne({ ...BASE, evs: { broken: { ...ev, communication: 'wifi' } } }).errors[0],
    ).toMatch(/^test\.yaml: \$\.evs\.broken\.communication: /);
    expect(resolveOne({ ...BASE, evs: { broken: { capacityKWh: 40 } } }).errors[0]).toMatch(
      /^test\.yaml: \$\.evs\.broken\.initialSoc: /,
    );
  });

  it('implements every OCPP 1.6 feature profile, so advertising them all warns about nothing', () => {
    const { personas } = resolveOne({ ...BASE, features: [...FEATURE_PROFILES] });
    expect([...IMPLEMENTED_FEATURE_PROFILES].sort()).toEqual([...FEATURE_PROFILES].sort());
    expect(personas.get('base')?.warnings).toEqual([]);
  });

  it('reads a 2.1 persona with its feature groups and availability method, and keeps them from 2.0.1', () => {
    const v2 = {
      persona: 'v21',
      ocpp: '2.1',
      boot: { vendorName: 'VendorX', model: 'AC-21' },
      connectors: 2,
      features: ['Core', 'TariffAndCost'],
      connectorStatus: 'StatusNotification',
    };
    const { personas, errors } = resolveOne(v2);
    expect(errors).toEqual([]);
    expect(personas.get('v21')).toMatchObject({
      ocpp: '2.1',
      options: {
        ocpp: '2.1',
        connectorStatus: 'StatusNotification',
        features: ['Core', 'TariffAndCost'],
      },
    });
    // The 2.1 group is not built yet, so the persona says so.
    expect(personas.get('v21')?.warnings).toEqual([
      'test.yaml: certification profile TariffAndCost is supported in the persona but not implemented yet',
    ]);
    expect(resolveOne({ ...v2, ocpp: '2.0.1' }).errors).toEqual([
      'test.yaml: TariffAndCost, connectorStatus need ocpp "2.1"',
    ]);
    // Any other version is read as a 1.6 persona, which this is not.
    expect(resolveOne({ ...v2, ocpp: '2.2' }).errors).toContain(
      'test.yaml: $.boot.chargePointVendor: missing required property',
    );
  });
});
