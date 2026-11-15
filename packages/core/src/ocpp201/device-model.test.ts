import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  componentKey,
  createDeviceModel,
  parseComponentKey,
  parseVariableKey,
  valueProblem,
  variableKey,
  type VariableDefinition,
} from './device-model.js';
import { standardVariables } from './standard-variables.js';

const standard = standardVariables({ connectors: 2, features: ['Core'], offeredW: 11_000 });
const model = (
  overrides?: Parameters<typeof applyOverrides>[1],
  saved?: Record<string, string>,
) => {
  const applied = applyOverrides(standard, overrides);
  if (!applied.ok) throw new Error(applied.problems.join('; '));
  return createDeviceModel({
    definitions: applied.definitions,
    ...(saved !== undefined && { saved }),
    read: (key) => (key === 'EVSE@1/AvailabilityState' ? 'Occupied' : undefined),
  });
};
const comm = { name: 'OCPPCommCtrlr' };

describe('device model keys and values', () => {
  it('write and read component and variable keys', () => {
    const component = { name: 'Connector', instance: 'A', evse: { id: 1, connectorId: 2 } };
    expect(componentKey(component)).toBe('Connector:A@1.2');
    expect(parseComponentKey('Connector:A@1.2')).toEqual(component);
    expect(parseComponentKey('EVSE@3')).toEqual({ name: 'EVSE', evse: { id: 3 } });
    expect(parseVariableKey('MessageAttempts:TransactionEvent')).toEqual({
      name: 'MessageAttempts',
      instance: 'TransactionEvent',
    });
    expect(variableKey({ name: 'Power' })).toBe('Power');
    expect(parseComponentKey('bad key!')).toBeUndefined();
  });

  it('check values against the data type and limits', () => {
    const def = (extra: Partial<VariableDefinition>): VariableDefinition => ({
      component: comm,
      variable: { name: 'X' },
      dataType: 'integer',
      attributes: {},
      ...extra,
    });
    expect(valueProblem(def({ minLimit: 0, maxLimit: 10 }), '5')).toBeUndefined();
    expect(valueProblem(def({ minLimit: 0, maxLimit: 10 }), '11')).toBe('out of range 0 to 10');
    expect(valueProblem(def({}), '1.5')).toBe('not an integer');
    expect(valueProblem(def({ dataType: 'boolean' }), 'yes')).toBe('not true or false');
    expect(valueProblem(def({ dataType: 'OptionList', valuesList: 'a,b' }), 'b')).toBeUndefined();
    expect(valueProblem(def({ dataType: 'MemberList', valuesList: 'a,b' }), 'a,c')).toBe(
      'c not in a, b',
    );
    expect(valueProblem(def({ dataType: 'MemberList', valuesList: 'a,b' }), 'a,a')).toBe(
      'repeats an item',
    );
    expect(valueProblem(def({ dataType: 'string', maxLimit: 3 }), 'abcd')).toBe(
      'longer than 3 characters',
    );
    expect(valueProblem(def({ dataType: 'dateTime' }), 'today')).toBe('not a date-time');
  });

  it('apply persona overrides: standard values, vendor variables, and problems', () => {
    const applied = applyOverrides(standard, {
      OCPPCommCtrlr: { HeartbeatInterval: 120, 'MessageAttempts:TransactionEvent': 5 },
      VendorCtrlr: {
        Mode: {
          actual: 'eco',
          dataType: 'OptionList',
          valuesList: 'eco,boost',
          mutability: 'ReadWrite',
        },
      },
    });
    expect(applied.ok).toBe(true);
    const dm = createDeviceModel({ definitions: applied.ok ? applied.definitions : [] });
    expect(dm.get('OCPPCommCtrlr', 'HeartbeatInterval')).toBe('120');
    expect(dm.get('OCPPCommCtrlr', 'MessageAttempts:TransactionEvent')).toBe('5');
    expect(dm.get('VendorCtrlr', 'Mode')).toBe('eco');
    expect(
      applyOverrides(standard, {
        OCPPCommCtrlr: { HeartbeatInterval: 'often', NoSuchVariable: 1 },
        VendorCtrlr: { Mode: { actual: 'x' } },
      }),
    ).toEqual({
      ok: false,
      problems: [
        'OCPPCommCtrlr.HeartbeatInterval: not an integer',
        'OCPPCommCtrlr.NoSuchVariable: not a standard variable; define it with dataType and a value',
        'VendorCtrlr.Mode: a new variable needs a dataType',
      ],
    });
  });
});

describe('GetVariables and SetVariables', () => {
  it('answer per item with the specification statuses', () => {
    const dm = model();
    const results = dm.getVariables([
      { component: comm, variable: { name: 'HeartbeatInterval' } },
      { component: { name: 'NoSuchCtrlr' }, variable: { name: 'X' } },
      { component: comm, variable: { name: 'NoSuchVariable' } },
      { component: comm, variable: { name: 'HeartbeatInterval' }, attributeType: 'Target' },
      { component: { name: 'SecurityCtrlr' }, variable: { name: 'BasicAuthPassword' } },
      { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'AvailabilityState' } },
      { component: comm, variable: { name: 'MessageAttempts', instance: 'TransactionEvent' } },
      // MessageAttempts exists only with an instance (B06.FR.15).
      { component: comm, variable: { name: 'MessageAttempts' } },
    ]);
    expect(results.map((r) => [r.attributeStatus, r.attributeValue])).toEqual([
      ['Accepted', '300'],
      ['UnknownComponent', undefined],
      ['UnknownVariable', undefined],
      ['NotSupportedAttributeType', undefined],
      ['Rejected', undefined],
      ['Accepted', 'Occupied'],
      ['Accepted', '3'],
      ['UnknownVariable', undefined],
    ]);
    expect(results[0]).toMatchObject({ attributeType: 'Actual', component: comm });
  });

  it('set writable values, refuse read-only and invalid ones, and report what changed', () => {
    const dm = model();
    const { results, changed } = dm.setVariables([
      { component: comm, variable: { name: 'HeartbeatInterval' }, attributeValue: '30' },
      { component: comm, variable: { name: 'FileTransferProtocols' }, attributeValue: 'FTP' },
      { component: comm, variable: { name: 'WebSocketPingInterval' }, attributeValue: '-1' },
      {
        component: { name: 'SecurityCtrlr' },
        variable: { name: 'BasicAuthPassword' },
        attributeValue: 'secret-password',
      },
      { component: comm, variable: { name: 'QueueAllMessages' }, attributeValue: 'false' },
      {
        component: { name: 'ClockCtrlr' },
        variable: { name: 'DateTime' },
        attributeValue: '2026-11-15T10:00:00Z',
      },
    ]);
    expect(results.map((r) => r.attributeStatus)).toEqual([
      'Accepted',
      'Rejected',
      'Rejected',
      'Accepted',
      'Accepted',
      'Rejected',
    ]);
    expect(results[2]?.attributeStatusInfo).toEqual({
      reasonCode: 'InvalidValue',
      additionalInfo: 'out of range 0 to ∞',
    });
    // An unchanged value is not a change.
    expect(changed).toEqual(['OCPPCommCtrlr/HeartbeatInterval', 'SecurityCtrlr/BasicAuthPassword']);
    expect(dm.get('OCPPCommCtrlr', 'HeartbeatInterval')).toBe('30');
  });

  it('keep persistent values across a restart, ignoring saved values that no longer fit', () => {
    const first = model();
    first.setVariables([
      { component: comm, variable: { name: 'HeartbeatInterval' }, attributeValue: '45' },
    ]);
    const saved = first.persistentValues();
    expect(saved['OCPPCommCtrlr/HeartbeatInterval/Actual']).toBe('45');
    expect(Object.keys(saved).some((key) => key.includes('AvailabilityState'))).toBe(false);
    const second = model(undefined, {
      ...saved,
      'OCPPCommCtrlr/WebSocketPingInterval/Actual': 'never',
      'DeviceDataCtrlr/ItemsPerMessage:GetReport/Actual': '1',
    });
    expect(second.get('OCPPCommCtrlr', 'HeartbeatInterval')).toBe('45');
    expect(second.get('OCPPCommCtrlr', 'WebSocketPingInterval')).toBe('30');
    // Constants are not restored.
    expect(second.get('DeviceDataCtrlr', 'ItemsPerMessage:GetReport')).toBe('20');
  });
});

describe('reports', () => {
  it('build the base reports', () => {
    const dm = model();
    const full = dm.baseReport('FullInventory') ?? [];
    expect(full).toHaveLength(standard.length);
    const password = full.find((r) => r.variable.name === 'BasicAuthPassword');
    expect(password?.variableAttribute).toEqual([
      { type: 'Actual', mutability: 'WriteOnly', persistent: true, constant: false },
    ]);
    const heartbeat = full.find((r) => r.variable.name === 'HeartbeatInterval');
    expect(heartbeat).toMatchObject({
      variableAttribute: [{ type: 'Actual', value: '300', mutability: 'ReadWrite' }],
      variableCharacteristics: { dataType: 'integer', unit: 's', supportsMonitoring: false },
    });
    const configuration = dm.baseReport('ConfigurationInventory') ?? [];
    expect(
      configuration.every((r) => r.variableAttribute.some((a) => a.mutability !== 'ReadOnly')),
    ).toBe(true);
    expect(configuration.length).toBeLessThan(full.length);
    const summary = dm.baseReport('SummaryInventory') ?? [];
    expect(summary.map((r) => componentKey(r.component))).toEqual([
      'ChargingStation',
      'EVSE@1',
      'Connector@1.1',
      'EVSE@2',
      'Connector@2.1',
    ]);
  });

  it('select a custom report by component variables and criteria', () => {
    const dm = model();
    const byComponent = dm.customReport(undefined, [{ component: { name: 'EVSE' } }]);
    expect(new Set(byComponent.map((r) => componentKey(r.component)))).toEqual(
      new Set(['EVSE@1', 'EVSE@2']),
    );
    const oneVariable = dm.customReport(undefined, [
      { component: { name: 'EVSE', evse: { id: 2 } }, variable: { name: 'Power' } },
    ]);
    expect(oneVariable.map((r) => `${componentKey(r.component)}/${r.variable.name}`)).toEqual([
      'EVSE@2/Power',
    ]);
    expect(dm.customReport(['Problem'], undefined)).toEqual([]);
    expect(
      dm.customReport(['Enabled'], [{ component: { name: 'AuthCtrlr' } }]).length,
    ).toBeGreaterThan(0);
  });
});
