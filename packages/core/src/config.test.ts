import { describe, expect, it } from 'vitest';
import {
  changeConfiguration,
  configBool,
  configInt,
  configList,
  createConfig,
  getConfiguration,
} from './config.js';
import { validateResponse } from './ocpp16-messages.js';

const config = createConfig({ numberOfConnectors: 2 });

describe('configuration keys', () => {
  it('starts from the standard defaults, with NumberOfConnectors filled in', () => {
    expect(configInt(config, 'NumberOfConnectors')).toBe(2);
    expect(configInt(config, 'MeterValueSampleInterval')).toBe(60);
    expect(configBool(config, 'StopTransactionOnEVSideDisconnect')).toBe(true);
    expect(configList(config, 'MeterValuesSampledData')).toEqual(['Energy.Active.Import.Register']);
    expect(configList(config, 'StopTxnAlignedData')).toEqual([]);
  });

  it('applies overrides and extra definitions, rejecting invalid ones up front', () => {
    const custom = createConfig({
      numberOfConnectors: 1,
      definitions: { VendorMode: { type: 'string', readonly: false, value: 'eco' } },
      values: { HeartbeatInterval: '60', AuthorizeRemoteTxRequests: 'TRUE' },
    });
    expect(configInt(custom, 'HeartbeatInterval')).toBe(60);
    expect(configBool(custom, 'AuthorizeRemoteTxRequests')).toBe(true);
    expect(custom.values.VendorMode).toBe('eco');
    expect(() => createConfig({ numberOfConnectors: 1, values: { Nope: '1' } })).toThrow(/unknown/);
    expect(() =>
      createConfig({ numberOfConnectors: 1, values: { HeartbeatInterval: 'soon' } }),
    ).toThrow(/invalid value/);
  });
});

describe('GetConfiguration', () => {
  it('returns every key when none are requested, with read-only flags', () => {
    const response = getConfiguration(config, {});
    expect(validateResponse('GetConfiguration', response).ok).toBe(true);
    expect(response.unknownKey).toBeUndefined();
    expect(response.configurationKey).toContainEqual({
      key: 'NumberOfConnectors',
      readonly: true,
      value: '2',
    });
    expect(response.configurationKey).toContainEqual({
      key: 'HeartbeatInterval',
      readonly: false,
      value: '300',
    });
  });

  it('returns every key for an empty key list, as for a missing one', () => {
    expect(getConfiguration(config, { key: [] })).toEqual(getConfiguration(config, {}));
    expect(getConfiguration(config, { key: [] }).configurationKey?.length).toBe(
      Object.keys(config.definitions).length,
    );
  });

  it('returns requested keys and lists the unknown ones', () => {
    expect(getConfiguration(config, { key: ['HeartbeatInterval', 'Nope'] })).toEqual({
      configurationKey: [{ key: 'HeartbeatInterval', readonly: false, value: '300' }],
      unknownKey: ['Nope'],
    });
  });
});

describe('ChangeConfiguration', () => {
  it('stores a valid value and answers Accepted', () => {
    const result = changeConfiguration(config, { key: 'MeterValueSampleInterval', value: '10' });
    expect(result.status).toBe('Accepted');
    expect(configInt(result.config, 'MeterValueSampleInterval')).toBe(10);
    expect(configInt(config, 'MeterValueSampleInterval')).toBe(60);
  });

  it('normalizes booleans and lists', () => {
    const bool = changeConfiguration(config, { key: 'LocalPreAuthorize', value: 'True' });
    expect(bool.config.values.LocalPreAuthorize).toBe('true');
    const list = changeConfiguration(config, {
      key: 'MeterValuesSampledData',
      value: 'Energy.Active.Import.Register, Power.Active.Import',
    });
    expect(list.status).toBe('Accepted');
    expect(configList(list.config, 'MeterValuesSampledData')).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
    ]);
  });

  it('answers NotSupported for unknown keys and Rejected for read-only keys or bad values', () => {
    expect(changeConfiguration(config, { key: 'Nope', value: '1' }).status).toBe('NotSupported');
    expect(changeConfiguration(config, { key: 'NumberOfConnectors', value: '4' }).status).toBe(
      'Rejected',
    );
    for (const [key, value] of [
      ['HeartbeatInterval', '-5'],
      ['HeartbeatInterval', '1.5'],
      ['LocalPreAuthorize', 'yes'],
      ['MeterValuesSampledData', 'Energy.Active.Import.Register,Banana'],
    ] as const) {
      const result = changeConfiguration(config, { key, value });
      expect(result.status).toBe('Rejected');
      expect(result.config).toBe(config);
    }
  });

  it('answers RebootRequired for keys marked so, and stores the value', () => {
    const custom = createConfig({
      numberOfConnectors: 1,
      definitions: {
        NetworkProfile: { type: 'string', readonly: false, value: 'a', rebootRequired: true },
      },
    });
    const result = changeConfiguration(custom, { key: 'NetworkProfile', value: 'b' });
    expect(result.status).toBe('RebootRequired');
    expect(result.config.values.NetworkProfile).toBe('b');
  });
});
