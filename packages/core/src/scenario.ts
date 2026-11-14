/**
 * Scenario model v1 (see "Scenario format v1" in docs/design.md): validation
 * of a parsed YAML document into a typed scenario, the variable check, and
 * step labels for reports. Reading the YAML stays with the caller, as for
 * personas.
 */
import { isJsonPath, operatorProblems } from './match.js';
import { ChargePointErrorCodeSchema, type ChargePointErrorCode } from './ocpp16-messages.js';
import { OCPP16_CHARGE_POINT_INITIATED, OCPP16_CSMS_INITIATED, RPC_ERROR_CODES } from './ocpp16.js';
import { durationSchema, parseDuration } from './persona.js';
import {
  boolean,
  integer,
  number,
  object,
  oneOf,
  record,
  string,
  union,
  type Schema,
  type ValidationIssue,
} from './schema.js';
import { parseInjection, type InjectionRequest } from './injections.js';
import { templateRefs, VARIABLE_NAME } from './template.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const DEFAULT_WITHIN_MS = 10_000;
export const DEFAULT_SCENARIO_TIMEOUT_MS = 300_000;

export interface ScenarioStation {
  id: string;
  persona: string;
  password?: string;
  config?: Record<string, string>;
  behaviour?: { refuseRemoteStart?: boolean; cableLock?: boolean };
  energyMultiplier?: number;
  /** Security Profile and certificate files (paths relative to the scenario file). */
  security?: {
    profile?: number;
    ca?: string;
    cert?: string;
    key?: string;
    manufacturerRoot?: string;
  };
  /** Setup waits until BootNotification is Accepted. Default true. */
  waitForBoot: boolean;
}

/** How the built-in CSMS accepts connections. */
export interface CsmsOptions {
  /**
   * Serve wss:// with the test PKI's server certificate. `clientCertificates`
   * asks stations for certificates signed by the test CA: `required` refuses
   * the TLS handshake without one (Security Profile 3).
   */
  tls?: { clientCertificates: 'none' | 'optional' | 'required' };
  /** Basic Auth passwords by station id; a listed station must send its password. */
  passwords?: Record<string, string>;
}

export type CardResult = 'authorized' | 'rejected' | 'stopping' | 'busy';
export type MessageDirection = 'sent' | 'received';
export type SearchFrom = 'last' | 'step' | 'start';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Variable name → JSON path into the step's result. */
export type SaveMap = Record<string, string>;

interface StepBase {
  /** Shown in reports instead of the generated label. */
  name?: string;
  /** The station the step acts on; default the first station. */
  station?: string;
}
interface ActionBase extends StepBase {
  /** The engine must refuse the action with a message containing this text. */
  expectError?: string;
}

export type ScenarioStep =
  | (ActionBase & { kind: 'plugIn'; connector: number; ev?: string })
  | (ActionBase & {
      kind: 'unplug' | 'evSuspend' | 'evResume' | 'clearFault';
      connector: number;
    })
  | (ActionBase & { kind: 'presentCard'; connector: number; idTag: string; result?: CardResult })
  | (ActionBase & {
      kind: 'fault';
      connector: number;
      errorCode: Exclude<ChargePointErrorCode, 'NoError'>;
      info?: string;
      vendorErrorCode?: string;
    })
  | (ActionBase & { kind: 'offline'; mode: 'clean' | 'half-open' })
  | (ActionBase & { kind: 'online' | 'stopStation' | 'startStation' })
  | (ActionBase & {
      kind: 'setBehaviour';
      behaviour: { refuseRemoteStart?: boolean; cableLock?: boolean };
    })
  | (StepBase & { kind: 'wait'; durationMs: number })
  | (StepBase & { kind: 'charge'; connector: number; durationMs: number })
  | (StepBase & {
      kind: 'expect';
      direction: MessageDirection;
      action: string;
      payload?: JsonValue;
      answer?: JsonValue;
      withinMs: number;
      from: SearchFrom;
      save?: SaveMap;
    })
  | (StepBase & {
      kind: 'expectNo';
      direction: MessageDirection;
      action: string;
      payload?: JsonValue;
      withinMs: number;
    })
  | (StepBase & {
      kind: 'expectConnector';
      connector: number;
      match: Record<string, JsonValue>;
      withinMs: number;
      save?: SaveMap;
    })
  | (StepBase & {
      kind: 'expectStation';
      match: Record<string, JsonValue>;
      withinMs: number;
      save?: SaveMap;
    })
  | (StepBase & {
      kind: 'csmsCall';
      action: string;
      payload: JsonValue;
      answer?: JsonValue;
      error?: string;
      /** Passes only when no answer arrives for this long (a CSMS-side timeout). */
      noAnswerMs?: number;
      save?: SaveMap;
    })
  | (StepBase & {
      kind: 'csmsReply';
      action: string;
      reply: { payload: JsonValue } | { error: string } | { ignore: true };
      times?: number;
    })
  | (StepBase & {
      kind: 'inject';
      station?: string;
      /** The fault; a reconnectStorm hits every station. */
      request: InjectionRequest;
    })
  | (StepBase & { kind: 'clearInjections'; station?: string })
  | (StepBase & {
      kind: 'http';
      method: HttpMethod;
      url: string;
      headers?: Record<string, string>;
      /** HTTP Basic credentials, sent as an Authorization header. */
      basicAuth?: { user: string; password: string };
      json?: JsonValue;
      expect?: { status?: number; json?: JsonValue };
      save?: SaveMap;
    });

export type StepKind = ScenarioStep['kind'];

export interface Scenario {
  name: string;
  description?: string;
  /** `builtin` or the WebSocket URL of a CSMS. */
  csms: string;
  stations: ScenarioStation[];
  vars: Record<string, string | number | boolean>;
  /** Limit for the whole scenario; the runner's default when absent. */
  timeoutMs?: number;
  checkSchemas: boolean;
  /** Settings of the built-in CSMS. */
  csmsOptions?: CsmsOptions;
  steps: ScenarioStep[];
}

export type ScenarioResult = { ok: true; scenario: Scenario } | { ok: false; errors: string[] };

// ---- Schemas ----------------------------------------------------------------

const anyJson: Schema<JsonValue> = { check() {} };
const connector = integer({ minimum: 0 });
const nonEmpty: Schema<string> = {
  check(value, path, issues) {
    string().check(value, path, issues);
    if (value === '') {
      issues.push({ path, errorCode: 'PropertyConstraintViolation', message: 'must not be empty' });
    }
  },
};
const positive: Schema<number> = {
  check(value, path, issues) {
    number().check(value, path, issues);
    if (typeof value === 'number' && !(value > 0)) {
      issues.push({ path, errorCode: 'PropertyConstraintViolation', message: 'must be above 0' });
    }
  },
};
const variableName = (path: string, name: string, issues: ValidationIssue[]) => {
  if (!VARIABLE_NAME.test(name) || name === 'env') {
    issues.push({
      path,
      errorCode: 'PropertyConstraintViolation',
      message: `${JSON.stringify(name)} is not a valid variable name`,
    });
  }
};
const saveSchema: Schema<SaveMap> = {
  check(value, path, issues) {
    record(string()).check(value, path, issues);
    if (typeof value !== 'object' || value === null) return;
    for (const [name, target] of Object.entries(value)) {
      variableName(`${path}.${name}`, name, issues);
      if (typeof target === 'string' && !isJsonPath(target)) {
        issues.push({
          path: `${path}.${name}`,
          errorCode: 'PropertyConstraintViolation',
          message: `${JSON.stringify(target)} is not a path like $.answer.transactionId`,
        });
      }
    }
  },
};
const behaviourSchema = object({}, { refuseRemoteStart: boolean(), cableLock: boolean() });
const action = { expectError: string(), station: nonEmpty };
const fromSchema = oneOf(['last', 'step', 'start']);
const directions = {
  sent: oneOf(OCPP16_CHARGE_POINT_INITIATED),
  received: oneOf(OCPP16_CSMS_INITIATED),
};

const stationSchema = object(
  { id: nonEmpty, persona: nonEmpty },
  {
    password: string(),
    config: record(union(string(), number(), boolean())),
    behaviour: behaviourSchema,
    energyMultiplier: positive,
    waitForBoot: boolean(),
    security: object(
      {},
      {
        profile: integer({ minimum: 0, maximum: 3 }),
        ca: nonEmpty,
        cert: nonEmpty,
        key: nonEmpty,
        manufacturerRoot: nonEmpty,
      },
    ),
  },
);

const csmsOptionsSchema = object(
  {},
  {
    tls: union(
      boolean(),
      object({}, { clientCertificates: oneOf(['none', 'optional', 'required']) }),
    ),
    passwords: record(string()),
  },
);

const topSchema = object(
  { name: nonEmpty, steps: { check: () => {} } as Schema<unknown> },
  {
    description: string(),
    csms: nonEmpty,
    station: { check: () => {} } as Schema<unknown>,
    stations: { check: () => {} } as Schema<unknown>,
    vars: record(union(string(), number(), boolean())),
    timeout: durationSchema,
    checkSchemas: boolean(),
    csmsOptions: csmsOptionsSchema,
  },
);

/** Argument schemas for steps whose arguments are a plain object. */
const ARGUMENTS = {
  plugIn: object({}, { connector, ev: nonEmpty, ...action }),
  unplug: object({}, { connector, ...action }),
  evSuspend: object({}, { connector, ...action }),
  evResume: object({}, { connector, ...action }),
  clearFault: object({}, { connector, ...action }),
  presentCard: object(
    { idTag: nonEmpty },
    { connector, result: oneOf(['authorized', 'rejected', 'stopping', 'busy']), ...action },
  ),
  fault: object(
    { errorCode: ChargePointErrorCodeSchema },
    { connector, info: string(), vendorErrorCode: string(), ...action },
  ),
  offline: object({ mode: oneOf(['clean', 'half-open']) }, action),
  online: object({}, action),
  stopStation: object({}, action),
  startStation: object({}, action),
  setBehaviour: object({}, { refuseRemoteStart: boolean(), cableLock: boolean(), ...action }),
  charge: object({ duration: durationSchema }, { connector, station: nonEmpty }),
  expect: object(
    {},
    {
      sent: directions.sent,
      received: directions.received,
      payload: anyJson,
      answer: anyJson,
      within: durationSchema,
      from: fromSchema,
      save: saveSchema,
      station: nonEmpty,
    },
  ),
  expectNo: object(
    {},
    {
      sent: directions.sent,
      received: directions.received,
      payload: anyJson,
      within: durationSchema,
      station: nonEmpty,
    },
  ),
  csmsCall: object(
    { action: oneOf(OCPP16_CSMS_INITIATED) },
    {
      payload: record(anyJson),
      answer: anyJson,
      error: oneOf(RPC_ERROR_CODES),
      noAnswer: durationSchema,
      save: saveSchema,
      station: nonEmpty,
    },
  ),
  csmsReply: object(
    { action: oneOf(OCPP16_CHARGE_POINT_INITIATED) },
    {
      payload: record(anyJson),
      error: oneOf(RPC_ERROR_CODES),
      ignore: boolean(),
      times: integer({ minimum: 1 }),
      station: nonEmpty,
    },
  ),
  http: object(
    { url: nonEmpty },
    {
      method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      headers: record(string()),
      basicAuth: object({ user: nonEmpty, password: string() }),
      json: anyJson,
      expect: object({}, { status: integer({ minimum: 100 }), json: anyJson }),
      save: saveSchema,
    },
  ),
  clearInjections: object({}, { station: nonEmpty }),
} as const;

/** Snapshot steps: these keys configure the step, every other key is a field to match. */
const SNAPSHOT_SETTINGS = {
  expectConnector: { connector: true, within: true, save: true, station: true },
  expectStation: { within: true, save: true, station: true },
} as const;
const SNAPSHOT_KEYS = {
  expectConnector: object(
    {},
    { connector, within: durationSchema, save: saveSchema, station: nonEmpty },
  ),
  expectStation: object({}, { within: durationSchema, save: saveSchema, station: nonEmpty }),
} as const;

export const STEP_KINDS: readonly StepKind[] = [
  ...(Object.keys(ARGUMENTS) as StepKind[]),
  'wait',
  'inject',
  ...(Object.keys(SNAPSHOT_KEYS) as StepKind[]),
];

const CSMS_STEPS = new Set<StepKind>(['csmsCall', 'csmsReply']);
const NO_STATION_STEPS = new Set<StepKind>(['wait', 'http']);

// ---- Validation -------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function format(issue: ValidationIssue): string {
  return `${issue.path}: ${issue.message}`;
}

function durationMs(value: unknown, fallback: number): number {
  return value === undefined ? fallback : (parseDuration(value as number | string) ?? fallback);
}

/** Copies the optional fields that are present, so absent ones stay absent. */
function pick<T extends Record<string, unknown>, K extends string>(
  source: T,
  keys: readonly K[],
): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function parseStep(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): ScenarioStep | undefined {
  if (!isObject(raw)) {
    issues.push({ path, errorCode: 'TypeConstraintViolation', message: 'a step must be a map' });
    return undefined;
  }
  const { name, ...rest } = raw;
  const keys = Object.keys(rest);
  const [kind] = keys;
  if (keys.length !== 1 || kind === undefined) {
    issues.push({
      path,
      errorCode: 'FormationViolation',
      message:
        keys.length === 0
          ? 'a step needs a step key'
          : `a step has exactly one step key besides name, found ${keys.join(', ')}`,
    });
    return undefined;
  }
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    issues.push({
      path: `${path}.${kind}`,
      errorCode: 'FormationViolation',
      message: `unknown step (known: ${STEP_KINDS.join(', ')})`,
    });
    return undefined;
  }
  if (name !== undefined) string().check(name, `${path}.name`, issues);
  const at = `${path}.${kind}`;
  const value = rest[kind];
  const before = issues.length;
  const named = typeof name === 'string' ? { name } : {};

  if (kind === 'wait') {
    durationSchema.check(value, at, issues);
    if (issues.length > before) return undefined;
    return { kind, ...named, durationMs: durationMs(value, 0) };
  }
  if (kind === 'inject') {
    const parsed = parseInjection(value, at);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      return undefined;
    }
    const station = isObject(value) ? value.station : undefined;
    if (station !== undefined) nonEmpty.check(station, `${at}.station`, issues);
    if (issues.length > before) return undefined;
    return {
      kind,
      ...named,
      ...(typeof station === 'string' && { station }),
      request: parsed.request,
    };
  }

  // No-argument steps may be written `online:` (null) as well as `online: {}`.
  const args: Record<string, unknown> = value === null ? {} : (value as Record<string, unknown>);
  if (kind === 'expectConnector' || kind === 'expectStation') {
    if (!isObject(args)) {
      issues.push({ path: at, errorCode: 'TypeConstraintViolation', message: 'expected a map' });
      return undefined;
    }
    const config = Object.keys(SNAPSHOT_KEYS[kind] === undefined ? {} : SNAPSHOT_SETTINGS[kind]);
    const settings = Object.fromEntries(
      Object.entries(args).filter(([key]) => config.includes(key)),
    );
    const match = Object.fromEntries(Object.entries(args).filter(([key]) => !config.includes(key)));
    SNAPSHOT_KEYS[kind].check(settings, at, issues);
    if (Object.keys(match).length === 0) {
      issues.push({
        path: at,
        errorCode: 'OccurenceConstraintViolation',
        message: 'nothing to match',
      });
    }
    for (const problem of operatorProblems(match, at)) {
      issues.push({ ...problem, errorCode: 'PropertyConstraintViolation' });
    }
    if (issues.length > before) return undefined;
    const common = {
      ...named,
      ...pick(settings, ['station', 'save'] as const),
      match: match as Record<string, JsonValue>,
      withinMs: durationMs(settings.within, DEFAULT_WITHIN_MS),
    } as StepBase & { match: Record<string, JsonValue>; withinMs: number; save?: SaveMap };
    return kind === 'expectConnector'
      ? { kind, ...common, connector: (settings.connector as number | undefined) ?? 1 }
      : { kind, ...common };
  }

  const argsKind = kind as keyof typeof ARGUMENTS;
  ARGUMENTS[argsKind].check(args, at, issues);
  if (issues.length > before || !isObject(args)) return undefined;
  const base = { ...named, ...pick(args, ['station', 'expectError'] as const) } as ActionBase;
  const connectorId = (args.connector as number | undefined) ?? 1;

  switch (argsKind) {
    case 'plugIn':
      return {
        kind: argsKind,
        ...base,
        connector: connectorId,
        ...pick(args, ['ev'] as const),
      } as ScenarioStep;
    case 'unplug':
    case 'evSuspend':
    case 'evResume':
    case 'clearFault':
      return { kind: argsKind, ...base, connector: connectorId };
    case 'presentCard':
      return {
        kind: argsKind,
        ...base,
        connector: connectorId,
        idTag: args.idTag as string,
        ...pick(args, ['result'] as const),
      } as ScenarioStep;
    case 'fault':
      if (args.errorCode === 'NoError') {
        issues.push({
          path: `${at}.errorCode`,
          errorCode: 'PropertyConstraintViolation',
          message: 'NoError is not a fault; use clearFault',
        });
        return undefined;
      }
      return {
        kind: argsKind,
        ...base,
        connector: connectorId,
        errorCode: args.errorCode,
        ...pick(args, ['info', 'vendorErrorCode'] as const),
      } as ScenarioStep;
    case 'offline':
      return { kind: argsKind, ...base, mode: args.mode as 'clean' | 'half-open' };
    case 'online':
    case 'stopStation':
    case 'startStation':
      return { kind: argsKind, ...base };
    case 'clearInjections':
      return { kind: argsKind, ...named, ...pick(args, ['station'] as const) } as ScenarioStep;
    case 'setBehaviour': {
      const behaviour = pick(args, ['refuseRemoteStart', 'cableLock'] as const);
      if (Object.keys(behaviour).length === 0) {
        issues.push({
          path: at,
          errorCode: 'OccurenceConstraintViolation',
          message: 'nothing to set',
        });
        return undefined;
      }
      return { kind: argsKind, ...base, behaviour } as ScenarioStep;
    }
    case 'charge':
      return {
        kind: argsKind,
        ...named,
        ...pick(args, ['station'] as const),
        connector: connectorId,
        durationMs: durationMs(args.duration, 0),
      } as ScenarioStep;
    case 'expect':
    case 'expectNo': {
      const both = args.sent !== undefined && args.received !== undefined;
      if (both || (args.sent === undefined && args.received === undefined)) {
        issues.push({
          path: at,
          errorCode: 'OccurenceConstraintViolation',
          message: both ? 'give either sent or received, not both' : 'needs sent or received',
        });
        return undefined;
      }
      for (const field of ['payload', 'answer'] as const) {
        for (const problem of operatorProblems(args[field], `${at}.${field}`)) {
          issues.push({ ...problem, errorCode: 'PropertyConstraintViolation' });
        }
      }
      if (issues.length > before) return undefined;
      const direction: MessageDirection = args.sent !== undefined ? 'sent' : 'received';
      const common = {
        ...named,
        ...pick(args, ['station', 'payload'] as const),
        direction,
        action: (args.sent ?? args.received) as string,
        withinMs: durationMs(args.within, DEFAULT_WITHIN_MS),
      };
      return kind === 'expect'
        ? ({
            kind: argsKind,
            ...common,
            ...pick(args, ['answer', 'save'] as const),
            from: (args.from as SearchFrom | undefined) ?? 'last',
          } as ScenarioStep)
        : ({ kind, ...common } as ScenarioStep);
    }
    case 'csmsCall':
      if ([args.answer, args.error, args.noAnswer].filter((v) => v !== undefined).length > 1) {
        issues.push({
          path: at,
          errorCode: 'OccurenceConstraintViolation',
          message: 'give one of answer, error and noAnswer',
        });
        return undefined;
      }
      for (const problem of operatorProblems(args.answer, `${at}.answer`)) {
        issues.push({ ...problem, errorCode: 'PropertyConstraintViolation' });
      }
      if (issues.length > before) return undefined;
      return {
        kind: argsKind,
        ...named,
        ...pick(args, ['station', 'answer', 'error', 'save'] as const),
        ...(args.noAnswer !== undefined && { noAnswerMs: durationMs(args.noAnswer, 0) }),
        action: args.action as string,
        payload: (args.payload as JsonValue | undefined) ?? {},
      } as ScenarioStep;
    case 'csmsReply': {
      const given = (['payload', 'error', 'ignore'] as const).filter(
        (key) => args[key] !== undefined,
      );
      if (given.length !== 1 || args.ignore === false) {
        issues.push({
          path: at,
          errorCode: 'OccurenceConstraintViolation',
          message: 'give exactly one of payload, error or ignore: true',
        });
        return undefined;
      }
      const reply =
        args.payload !== undefined
          ? { payload: args.payload as JsonValue }
          : args.error !== undefined
            ? { error: args.error as string }
            : { ignore: true as const };
      return {
        kind: argsKind,
        ...named,
        ...pick(args, ['station', 'times'] as const),
        action: args.action as string,
        reply,
      } as ScenarioStep;
    }
    case 'http': {
      const expectation = args.expect as { json?: unknown } | undefined;
      for (const problem of operatorProblems(expectation?.json, `${at}.expect.json`)) {
        issues.push({ ...problem, errorCode: 'PropertyConstraintViolation' });
      }
      if (issues.length > before) return undefined;
      return {
        kind: argsKind,
        ...named,
        method: (args.method as HttpMethod | undefined) ?? 'GET',
        url: args.url as string,
        ...pick(args, ['headers', 'basicAuth', 'json', 'expect', 'save'] as const),
      } as ScenarioStep;
    }
  }
}

/**
 * Validates one parsed YAML document. `label` (for example `fault.yaml#1`)
 * prefixes every error.
 */
export function parseScenario(document: unknown, label?: string): ScenarioResult {
  const issues: ValidationIssue[] = [];
  const prefix = (text: string) => (label === undefined ? text : `${label}: ${text}`);
  if (!isObject(document)) {
    return { ok: false, errors: [prefix('a scenario must be a map')] };
  }
  topSchema.check(document, '$', issues);
  for (const name of Object.keys(isObject(document.vars) ? document.vars : {})) {
    variableName(`$.vars.${name}`, name, issues);
  }

  const csms = typeof document.csms === 'string' ? document.csms : 'builtin';
  if (csms !== 'builtin' && !/^wss?:\/\/\S+$/.test(csms)) {
    issues.push({
      path: '$.csms',
      errorCode: 'PropertyConstraintViolation',
      message: 'must be builtin or a ws:// or wss:// URL',
    });
  }

  // Stations: `station` (one) or `stations` (a list), not both.
  let rawStations: unknown[] = [];
  if (document.station !== undefined && document.stations !== undefined) {
    issues.push({
      path: '$',
      errorCode: 'OccurenceConstraintViolation',
      message: 'give station or stations, not both',
    });
  } else if (document.station !== undefined) {
    rawStations = [document.station];
  } else if (Array.isArray(document.stations) && document.stations.length > 0) {
    rawStations = document.stations;
  } else {
    issues.push({
      path: '$',
      errorCode: 'OccurenceConstraintViolation',
      message: 'needs station or a non-empty stations list',
    });
  }
  const stationPath = (index: number) =>
    document.station !== undefined ? '$.station' : `$.stations[${index}]`;
  const stations: ScenarioStation[] = [];
  rawStations.forEach((raw, index) => {
    const before = issues.length;
    stationSchema.check(raw, stationPath(index), issues);
    if (issues.length > before || !isObject(raw)) return;
    if (stations.some((s) => s.id === raw.id)) {
      issues.push({
        path: `${stationPath(index)}.id`,
        errorCode: 'PropertyConstraintViolation',
        message: `duplicate station id ${String(raw.id)}`,
      });
      return;
    }
    stations.push({
      id: raw.id as string,
      persona: raw.persona as string,
      ...(pick(raw, [
        'password',
        'behaviour',
        'energyMultiplier',
        'security',
      ] as const) as Partial<ScenarioStation>),
      ...(isObject(raw.config) && {
        config: Object.fromEntries(Object.entries(raw.config).map(([k, v]) => [k, String(v)])),
      }),
      waitForBoot: raw.waitForBoot !== false,
    });
  });

  // Steps.
  const steps: ScenarioStep[] = [];
  if (!Array.isArray(document.steps) || document.steps.length === 0) {
    issues.push({
      path: '$.steps',
      errorCode: 'OccurenceConstraintViolation',
      message: 'needs at least one step',
    });
  } else {
    document.steps.forEach((raw, index) => {
      const path = `$.steps[${index}]`;
      const step = parseStep(raw, path, issues);
      if (step === undefined) return;
      const at = `${path}.${step.kind}`;
      if (step.station !== undefined) {
        if (NO_STATION_STEPS.has(step.kind)) {
          issues.push({
            path: `${at}.station`,
            errorCode: 'FormationViolation',
            message: 'this step takes no station',
          });
        } else if (stations.length > 0 && !stations.some((s) => s.id === step.station)) {
          issues.push({
            path: `${at}.station`,
            errorCode: 'PropertyConstraintViolation',
            message: `no station ${step.station} in this scenario`,
          });
        }
      }
      if (CSMS_STEPS.has(step.kind) && csms !== 'builtin') {
        issues.push({
          path: at,
          errorCode: 'FormationViolation',
          message: 'needs the built-in CSMS (csms: builtin)',
        });
      }
      const { invalid } = templateRefs(raw);
      for (const bad of invalid) {
        issues.push({
          path: at,
          errorCode: 'FormationViolation',
          message: `invalid template ${bad}`,
        });
      }
      steps.push(step);
    });
  }

  const rawOptions = isObject(document.csmsOptions) ? document.csmsOptions : undefined;
  if (rawOptions !== undefined && csms !== 'builtin') {
    issues.push({
      path: '$.csmsOptions',
      errorCode: 'FormationViolation',
      message: 'needs the built-in CSMS (csms: builtin)',
    });
  }
  const tlsOption = rawOptions?.tls;
  const csmsOptions: CsmsOptions | undefined =
    rawOptions === undefined
      ? undefined
      : {
          ...(tlsOption === true && { tls: { clientCertificates: 'none' as const } }),
          ...(isObject(tlsOption) && {
            tls: {
              clientCertificates:
                (tlsOption.clientCertificates as 'none' | 'optional' | 'required' | undefined) ??
                'none',
            },
          }),
          ...(isObject(rawOptions.passwords) && {
            passwords: rawOptions.passwords as Record<string, string>,
          }),
        };

  if (issues.length > 0) return { ok: false, errors: issues.map((i) => prefix(format(i))) };
  return {
    ok: true,
    scenario: {
      name: document.name as string,
      ...(typeof document.description === 'string' && { description: document.description }),
      csms,
      stations,
      vars: (document.vars as Scenario['vars'] | undefined) ?? {},
      ...(document.timeout !== undefined && {
        timeoutMs: durationMs(document.timeout, DEFAULT_SCENARIO_TIMEOUT_MS),
      }),
      checkSchemas: document.checkSchemas !== false,
      ...(csmsOptions !== undefined && { csmsOptions }),
      steps,
    },
  };
}

/**
 * Template names a scenario uses before they are defined. `provided` are the
 * names given from outside (`--var`); `vars` and earlier `save` steps count
 * too. Environment variables are checked when the step runs.
 */
export function variableProblems(scenario: Scenario, provided: readonly string[] = []): string[] {
  const known = new Set([...Object.keys(scenario.vars), ...provided]);
  const problems: string[] = [];
  scenario.steps.forEach((step, index) => {
    const { kind: _kind, name: _name, ...args } = step;
    for (const ref of templateRefs(args).refs) {
      if (!ref.env && !known.has(ref.name)) {
        problems.push(`$.steps[${index}].${step.kind}: unknown variable ${ref.name}`);
      }
    }
    if ('save' in step && step.save !== undefined) {
      for (const name of Object.keys(step.save)) known.add(name);
    }
  });
  return [...new Set(problems)];
}

// ---- Labels -----------------------------------------------------------------

/** `65000` → `1m5s`, `500` → `500ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const units: [number, string][] = [
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ];
  let rest = Math.round(ms / 1000) * 1000;
  let out = '';
  for (const [size, unit] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) out += `${count}${unit}`;
    rest -= count * size;
  }
  return out;
}

const fields = (match: Record<string, JsonValue>) =>
  Object.entries(match)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');

/** A short description of a step for reports; its `name` when it has one. */
export function stepLabel(step: ScenarioStep): string {
  if (step.name !== undefined) return step.name;
  const at = step.station !== undefined ? `${step.station} ` : '';
  switch (step.kind) {
    case 'plugIn':
      return `${at}plugIn connector ${step.connector}${step.ev !== undefined ? ` with ${step.ev}` : ''}`;
    case 'unplug':
    case 'evSuspend':
    case 'evResume':
    case 'clearFault':
      return `${at}${step.kind} connector ${step.connector}`;
    case 'presentCard':
      return `${at}presentCard ${step.idTag} at connector ${step.connector}`;
    case 'fault':
      return `${at}fault ${step.errorCode} on connector ${step.connector}`;
    case 'offline':
      return `${at}offline (${step.mode})`;
    case 'online':
    case 'stopStation':
    case 'startStation':
      return `${at}${step.kind}`;
    case 'setBehaviour':
      return `${at}setBehaviour ${fields(step.behaviour)}`;
    case 'wait':
      return `wait ${formatDuration(step.durationMs)}`;
    case 'charge':
      return `${at}charge connector ${step.connector} for ${formatDuration(step.durationMs)}`;
    case 'expect':
      return `${at}expect ${step.direction} ${step.action}`;
    case 'expectNo':
      return `${at}expectNo ${step.direction} ${step.action} for ${formatDuration(step.withinMs)}`;
    case 'expectConnector':
      return `${at}expectConnector ${step.connector} ${fields(step.match)}`;
    case 'expectStation':
      return `${at}expectStation ${fields(step.match)}`;
    case 'csmsCall':
      return `${at}csmsCall ${step.action}`;
    case 'csmsReply':
      return `${at}csmsReply ${step.action}`;
    case 'http':
      return `http ${step.method} ${step.url}`;
    case 'inject': {
      const { type, ...parameters } = step.request.injection;
      const details = fields(parameters as Record<string, JsonValue>);
      const duration =
        step.request.forMs === undefined ? '' : ` for ${formatDuration(step.request.forMs)}`;
      return `${type === 'reconnectStorm' ? '' : at}inject ${type}${details === '' ? '' : ` ${details}`}${duration}`;
    }
    case 'clearInjections':
      return `${at}clearInjections`;
  }
}
