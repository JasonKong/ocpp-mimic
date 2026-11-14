/**
 * Fault injections: what the engine's Fault Injector can do to a station's
 * connection and messages, as validated data shared by the API and the
 * scenario steps. The engine carries them out; core only defines them.
 */
import { RPC_ERROR_CODES, type RpcErrorCode } from './ocpp16.js';
import { durationSchema, parseDuration } from './persona.js';
import {
  integer,
  number,
  object,
  oneOf,
  string,
  type Schema,
  type ValidationIssue,
} from './schema.js';

export type FrameDirection = 'sent' | 'received';

/** One fault. `sent` frames go from the station to the CSMS, `received` ones the other way. */
export type Injection =
  // Network
  | { type: 'latency'; ms: number; direction: FrameDirection | 'both' }
  | {
      type: 'drop';
      direction: FrameDirection;
      /** Frames to drop; every matching one while active when absent. */
      count?: number;
      /** Chance of dropping each matching frame, 0 to 1 (default 1). */
      probability?: number;
      /** Only CALLs of this action. */
      action?: string;
    }
  | { type: 'flap'; downMs: number; upMs: number; times: number }
  | { type: 'reconnectStorm' }
  // Protocol
  | { type: 'malformedJson'; count: number }
  | { type: 'duplicateId'; count: number }
  | { type: 'unknownId'; count: number }
  | { type: 'outOfOrder' }
  | { type: 'noAnswer'; action?: string; count?: number }
  | { type: 'callError'; errorCode: RpcErrorCode; action?: string; count?: number }
  | { type: 'schemaViolation'; action?: string; count: number }
  // Device
  | { type: 'meterRollback'; wh: number; connector: number }
  | { type: 'meterReset'; connector: number }
  /** Every timestamp the station sends is shifted by `ms` (negative: behind). */
  | { type: 'clockDrift'; ms: number }
  | { type: 'badTimestamp'; count: number }
  // Power
  | { type: 'powerLoss'; offMs: number; onMs: number; times: number };

export type InjectionType = Injection['type'];

/** An injection plus how long it stays active (until cleared, or used up, when absent). */
export interface InjectionRequest {
  injection: Injection;
  forMs?: number;
}

const count = integer({ minimum: 1 });
const probability: Schema<number> = {
  check(value, path, issues) {
    number().check(value, path, issues);
    if (typeof value === 'number' && (value < 0 || value > 1)) {
      issues.push({
        path,
        errorCode: 'PropertyConstraintViolation',
        message: 'not between 0 and 1',
      });
    }
  },
};
const action = string({ maxLength: 50 });

/** The parameters each type takes, besides `type` and `for`. */
const PARAMETERS = {
  latency: object({ ms: durationSchema }, { direction: oneOf(['sent', 'received', 'both']) }),
  drop: object({ direction: oneOf(['sent', 'received']) }, { count, probability, action }),
  flap: object({ down: durationSchema, up: durationSchema }, { times: count }),
  reconnectStorm: object({}),
  malformedJson: object({}, { count }),
  duplicateId: object({}, { count }),
  unknownId: object({}, { count }),
  outOfOrder: object({}),
  noAnswer: object({}, { action, count }),
  callError: object({}, { errorCode: oneOf(RPC_ERROR_CODES), action, count }),
  schemaViolation: object({}, { action, count }),
  meterRollback: object({ wh: integer({ minimum: 1 }) }, { connector: integer({ minimum: 1 }) }),
  meterReset: object({}, { connector: integer({ minimum: 1 }) }),
  clockDrift: object({ ms: integer() }),
  badTimestamp: object({}, { count }),
  powerLoss: object({ off: durationSchema }, { on: durationSchema, times: count }),
} as const satisfies Record<InjectionType, Schema<unknown>>;

export const INJECTION_TYPES = Object.keys(PARAMETERS) as InjectionType[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ms = (value: unknown) => parseDuration(value as number | string) ?? 0;

/**
 * Validates `{ type, ...parameters, for? }` (with `station` allowed and
 * ignored, for scenario steps) and turns it into an InjectionRequest.
 */
export function parseInjection(
  value: unknown,
  path = '$',
): { ok: true; request: InjectionRequest } | { ok: false; issues: ValidationIssue[] } {
  const issue = (at: string, message: string): ValidationIssue => ({
    path: at,
    errorCode: 'PropertyConstraintViolation',
    message,
  });
  if (!isObject(value)) {
    return {
      ok: false,
      issues: [{ path, errorCode: 'TypeConstraintViolation', message: 'expected a map' }],
    };
  }
  const { type, for: duration, station: _station, ...parameters } = value;
  if (typeof type !== 'string' || !(type in PARAMETERS)) {
    return {
      ok: false,
      issues: [issue(`${path}.type`, `must be one of ${INJECTION_TYPES.join(', ')}`)],
    };
  }
  const issues: ValidationIssue[] = [];
  PARAMETERS[type as InjectionType].check(parameters, path, issues);
  if (duration !== undefined) durationSchema.check(duration, `${path}.for`, issues);
  if (issues.length > 0) return { ok: false, issues };

  const p = parameters as Record<string, unknown>;
  const optional = <K extends string>(key: K) =>
    (p[key] === undefined ? {} : { [key]: p[key] }) as Partial<Record<K, never>>;
  let injection: Injection;
  switch (type as InjectionType) {
    case 'latency':
      injection = {
        type: 'latency',
        ms: ms(p.ms),
        direction: (p.direction as FrameDirection | 'both' | undefined) ?? 'both',
      };
      break;
    case 'drop':
      injection = {
        type: 'drop',
        direction: p.direction as FrameDirection,
        ...optional('count'),
        ...optional('probability'),
        ...optional('action'),
      };
      break;
    case 'flap':
      injection = {
        type: 'flap',
        downMs: ms(p.down),
        upMs: ms(p.up),
        times: (p.times as number | undefined) ?? 1,
      };
      break;
    case 'callError':
      injection = {
        type: 'callError',
        errorCode: (p.errorCode as RpcErrorCode | undefined) ?? 'InternalError',
        ...optional('action'),
        ...optional('count'),
      };
      break;
    case 'noAnswer':
      injection = { type: 'noAnswer', ...optional('action'), ...optional('count') };
      break;
    case 'schemaViolation':
      injection = {
        type: 'schemaViolation',
        count: (p.count as number | undefined) ?? 1,
        ...optional('action'),
      };
      break;
    case 'meterRollback':
      injection = {
        type: 'meterRollback',
        wh: p.wh as number,
        connector: (p.connector as number | undefined) ?? 1,
      };
      break;
    case 'meterReset':
      injection = { type: 'meterReset', connector: (p.connector as number | undefined) ?? 1 };
      break;
    case 'clockDrift':
      injection = { type: 'clockDrift', ms: p.ms as number };
      break;
    case 'powerLoss':
      injection = {
        type: 'powerLoss',
        offMs: ms(p.off),
        onMs: p.on === undefined ? 5000 : ms(p.on),
        times: (p.times as number | undefined) ?? 1,
      };
      break;
    case 'badTimestamp':
    case 'malformedJson':
    case 'duplicateId':
    case 'unknownId':
      injection = { type, count: (p.count as number | undefined) ?? 1 } as Injection;
      break;
    case 'reconnectStorm':
    case 'outOfOrder':
      injection = { type } as Injection;
      break;
  }
  return {
    ok: true,
    request: { injection, ...(duration !== undefined && { forMs: ms(duration) }) },
  };
}
