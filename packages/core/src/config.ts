/**
 * Configuration keys: the values GetConfiguration reports and
 * ChangeConfiguration changes. Values are strings on the wire; typed reads go
 * through configInt / configBool / configList.
 */
import { MEASURANDS } from './ocpp16.js';
import type { RequestOf, ResponseOf } from './ocpp16-messages.js';

export type ConfigValueType = 'boolean' | 'integer' | 'string' | 'list';

export interface ConfigKeyDefinition {
  type: ConfigValueType;
  readonly: boolean;
  /** Default value, as it appears on the wire. */
  value: string;
  /** For integers: the smallest allowed value. */
  minimum?: number;
  /** For lists: the allowed items. Any item is allowed when absent. */
  allowedItems?: readonly string[];
  /** Changing the key is answered with RebootRequired; the new value is stored anyway. */
  rebootRequired?: boolean;
}

export interface ConfigState {
  readonly definitions: Readonly<Record<string, ConfigKeyDefinition>>;
  readonly values: Readonly<Record<string, string>>;
}

const MEASURAND_LIST: ConfigKeyDefinition = {
  type: 'list',
  readonly: false,
  value: 'Energy.Active.Import.Register',
  allowedItems: MEASURANDS,
};

/**
 * The OCPP 1.6 configuration keys supported, with their defaults: the Core
 * profile's and those of each feature profile that is implemented.
 * NumberOfConnectors is filled in by createConfig.
 */
export const STANDARD_CONFIG_KEYS: Readonly<Record<string, ConfigKeyDefinition>> = {
  AllowOfflineTxForUnknownId: { type: 'boolean', readonly: false, value: 'false' },
  AuthorizationCacheEnabled: { type: 'boolean', readonly: false, value: 'true' },
  AuthorizeRemoteTxRequests: { type: 'boolean', readonly: false, value: 'false' },
  ClockAlignedDataInterval: { type: 'integer', readonly: false, value: '0', minimum: 0 },
  ConnectionTimeOut: { type: 'integer', readonly: false, value: '60', minimum: 0 },
  ConnectorPhaseRotation: { type: 'list', readonly: false, value: '0.Unknown' },
  GetConfigurationMaxKeys: { type: 'integer', readonly: true, value: '50' },
  HeartbeatInterval: { type: 'integer', readonly: false, value: '300', minimum: 0 },
  LocalAuthListEnabled: { type: 'boolean', readonly: false, value: 'true' },
  LocalAuthListMaxLength: { type: 'integer', readonly: true, value: '100', minimum: 0 },
  LocalAuthorizeOffline: { type: 'boolean', readonly: false, value: 'true' },
  LocalPreAuthorize: { type: 'boolean', readonly: false, value: 'false' },
  MeterValuesAlignedData: MEASURAND_LIST,
  MeterValuesSampledData: MEASURAND_LIST,
  MeterValueSampleInterval: { type: 'integer', readonly: false, value: '60', minimum: 0 },
  NumberOfConnectors: { type: 'integer', readonly: true, value: '1' },
  ResetRetries: { type: 'integer', readonly: false, value: '1', minimum: 0 },
  SendLocalListMaxLength: { type: 'integer', readonly: true, value: '100', minimum: 0 },
  StopTransactionOnEVSideDisconnect: { type: 'boolean', readonly: false, value: 'true' },
  StopTransactionOnInvalidId: { type: 'boolean', readonly: false, value: 'true' },
  StopTxnAlignedData: { ...MEASURAND_LIST, value: '' },
  StopTxnSampledData: MEASURAND_LIST,
  SupportedFeatureProfiles: {
    type: 'list',
    readonly: true,
    value: 'Core,RemoteTrigger,LocalAuthListManagement',
  },
  TransactionMessageAttempts: { type: 'integer', readonly: false, value: '3', minimum: 0 },
  TransactionMessageRetryInterval: { type: 'integer', readonly: false, value: '60', minimum: 0 },
  UnlockConnectorOnEVSideDisconnect: { type: 'boolean', readonly: false, value: 'true' },
  WebSocketPingInterval: { type: 'integer', readonly: false, value: '30', minimum: 0 },
};

export interface CreateConfigOptions {
  numberOfConnectors: number;
  /** Extra or replaced key definitions, for example from a persona. */
  definitions?: Readonly<Record<string, ConfigKeyDefinition>>;
  /** Values that override the defaults; each must be valid for its key. */
  values?: Readonly<Record<string, string>>;
}

export function createConfig(options: CreateConfigOptions): ConfigState {
  const definitions: Record<string, ConfigKeyDefinition> = {
    ...STANDARD_CONFIG_KEYS,
    NumberOfConnectors: {
      type: 'integer',
      readonly: true,
      value: String(options.numberOfConnectors),
    },
    ...options.definitions,
  };
  const values = Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [key, definition.value]),
  );
  for (const [key, value] of Object.entries(options.values ?? {})) {
    const definition = definitions[key];
    if (definition === undefined) throw new Error(`unknown configuration key ${key}`);
    const normalized = normalizeValue(definition, value);
    if (normalized === undefined)
      throw new Error(`invalid value for ${key}: ${JSON.stringify(value)}`);
    values[key] = normalized;
  }
  return { definitions, values };
}

/** The wire form of `value` for `definition`, or undefined if it is not valid. */
function normalizeValue(definition: ConfigKeyDefinition, value: string): string | undefined {
  switch (definition.type) {
    case 'boolean': {
      const lower = value.trim().toLowerCase();
      return lower === 'true' || lower === 'false' ? lower : undefined;
    }
    case 'integer': {
      if (!/^-?\d+$/.test(value.trim())) return undefined;
      const number = Number(value);
      if (!Number.isSafeInteger(number)) return undefined;
      if (definition.minimum !== undefined && number < definition.minimum) return undefined;
      return String(number);
    }
    case 'list': {
      const items = splitList(value);
      if (definition.allowedItems !== undefined) {
        const allowed = new Set(definition.allowedItems);
        if (!items.every((item) => allowed.has(item))) return undefined;
      }
      return items.join(',');
    }
    case 'string':
      return value;
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function configValue(config: ConfigState, key: string): string | undefined {
  return config.values[key];
}

export function configInt(config: ConfigState, key: string): number {
  const value = Number(config.values[key]);
  if (!Number.isInteger(value)) throw new Error(`configuration key ${key} is not an integer`);
  return value;
}

export function configBool(config: ConfigState, key: string): boolean {
  return config.values[key] === 'true';
}

export function configList(config: ConfigState, key: string): string[] {
  return splitList(config.values[key] ?? '');
}

type GetConfigurationResponse = ResponseOf<'GetConfiguration'>;
type ChangeConfigurationStatus = ResponseOf<'ChangeConfiguration'>['status'];

/**
 * Answers GetConfiguration: the requested keys, or every key when the list is
 * empty or missing (OCPP 1.6 treats both the same way).
 */
export function getConfiguration(
  config: ConfigState,
  request: RequestOf<'GetConfiguration'>,
): GetConfigurationResponse {
  const requested =
    request.key !== undefined && request.key.length > 0
      ? request.key
      : Object.keys(config.definitions);
  const configurationKey: NonNullable<GetConfigurationResponse['configurationKey']> = [];
  const unknownKey: string[] = [];
  for (const key of requested) {
    const definition = config.definitions[key];
    const value = config.values[key];
    if (definition === undefined || value === undefined) {
      unknownKey.push(key);
    } else {
      configurationKey.push({ key, readonly: definition.readonly, value });
    }
  }
  return {
    ...(configurationKey.length > 0 && { configurationKey }),
    ...(unknownKey.length > 0 && { unknownKey }),
  };
}

/**
 * Answers ChangeConfiguration. An unknown key is NotSupported; a read-only key
 * or an invalid value is Rejected; otherwise the value is stored and the
 * answer is Accepted, or RebootRequired for keys that need a reboot.
 */
export function changeConfiguration(
  config: ConfigState,
  request: RequestOf<'ChangeConfiguration'>,
): { config: ConfigState; status: ChangeConfigurationStatus } {
  const definition = config.definitions[request.key];
  if (definition === undefined) return { config, status: 'NotSupported' };
  if (definition.readonly) return { config, status: 'Rejected' };
  const normalized = normalizeValue(definition, request.value);
  if (normalized === undefined) return { config, status: 'Rejected' };
  return {
    config: { ...config, values: { ...config.values, [request.key]: normalized } },
    status: definition.rebootRequired === true ? 'RebootRequired' : 'Accepted',
  };
}
