/**
 * Personas: declarative descriptions of how a vendor or firmware behaves
 * within what OCPP allows (BootNotification fields, connectors, power,
 * feature profiles, configuration defaults, timing, fault catalogue).
 *
 * This module validates parsed persona documents, resolves `extends`, and
 * turns a persona into charge point options. Reading files is the engine's
 * job.
 */
import {
  DEFAULT_TIMING,
  type ChargePointOptions,
  type ChargePointTiming,
  type DelayedCommand,
} from './charge-point.js';
import { createConfig } from './config.js';
import { evProfileProblems, type EvProfile } from './ev.js';
import { ChargePointErrorCodeSchema, OCPP16_MESSAGES } from './ocpp16-messages.js';
import {
  array,
  boolean,
  integer,
  number,
  object,
  oneOf,
  record,
  string,
  union,
  validate,
  type Infer,
  type Schema,
} from './schema.js';

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Milliseconds for a duration: a number (ms) or a string such as `200ms`, `6s`, `3m`, `1h`. */
export function parseDuration(value: number | string): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  const match = DURATION.exec(value.trim());
  if (match === null) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export const durationSchema: Schema<number | string> = {
  check(value, path, issues) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      issues.push({ path, errorCode: 'TypeConstraintViolation', message: 'expected a duration' });
    } else if (parseDuration(value) === undefined) {
      issues.push({
        path,
        errorCode: 'PropertyConstraintViolation',
        message: `not a duration (use milliseconds or e.g. "500ms", "6s", "3m"): ${JSON.stringify(value)}`,
      });
    }
  },
};

/** The feature profiles a charge point can advertise in SupportedFeatureProfiles. */
export const FEATURE_PROFILES = [
  'Core',
  'FirmwareManagement',
  'LocalAuthListManagement',
  'Reservation',
  'SmartCharging',
  'RemoteTrigger',
] as const;

/** Feature profiles this version of the charge point implements. */
export const IMPLEMENTED_FEATURE_PROFILES: readonly string[] = [
  'Core',
  'RemoteTrigger',
  'LocalAuthListManagement',
  'Reservation',
  'SmartCharging',
];

export const PersonaSchema = object(
  {
    persona: string({ maxLength: 64 }),
    boot: OCPP16_MESSAGES.BootNotification.request,
    connectors: integer({ minimum: 1 }),
  },
  {
    extends: string(),
    description: string(),
    power: object({}, { offeredW: number(), evW: number() }),
    features: array(oneOf(FEATURE_PROFILES)),
    config: record(union(string(), number(), boolean())),
    timing: object(
      {},
      {
        startTransactionDelay: durationSchema,
        actionDelay: durationSchema,
        commandDelays: object(
          {},
          {
            ChangeAvailability: durationSchema,
            RemoteStartTransaction: durationSchema,
            RemoteStopTransaction: durationSchema,
            Reset: durationSchema,
            UnlockConnector: durationSchema,
            TriggerMessage: durationSchema,
          },
        ),
        resetDowntime: object({}, { soft: durationSchema, hard: durationSchema }),
        bootRetry: durationSchema,
      },
    ),
    evs: record(
      object(
        { capacityKWh: number(), initialSoc: number(), maxPowerW: number(), phases: integer() },
        { taperSoc: number(), targetSoc: number() },
      ),
    ),
    faults: array(
      object(
        { errorCode: ChargePointErrorCodeSchema },
        {
          name: string(),
          info: string({ maxLength: 50 }),
          vendorErrorCode: string({ maxLength: 50 }),
        },
      ),
    ),
  },
);

export type PersonaDefinition = Infer<typeof PersonaSchema>;

/** The parts of the charge point options a persona decides. */
export type PersonaChargePointOptions = Pick<
  ChargePointOptions,
  'boot' | 'connectors' | 'config' | 'timing'
> & {
  offeredPowerW?: number;
  evPowerW?: number;
};

export interface ResolvedPersona {
  id: string;
  /** Where the persona came from, e.g. its file path. */
  source: string;
  definition: PersonaDefinition;
  options: PersonaChargePointOptions;
  /** Non-fatal problems, such as advertising a feature profile not implemented yet. */
  warnings: string[];
}

export interface PersonaSource {
  source: string;
  data: unknown;
}

export interface ResolvePersonasResult {
  personas: Map<string, ResolvedPersona>;
  errors: string[];
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars from `child` replace the parent's. */
function deepMerge(parent: PlainObject, child: PlainObject): PlainObject {
  const merged: PlainObject = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    const base = merged[key];
    merged[key] = isPlainObject(base) && isPlainObject(value) ? deepMerge(base, value) : value;
  }
  return merged;
}

function toMs(value: number | string | undefined): number | undefined {
  return value === undefined ? undefined : parseDuration(value);
}

function timingFrom(definition: PersonaDefinition): Partial<ChargePointTiming> {
  const t = definition.timing;
  if (t === undefined) return {};
  const commandDelays: Partial<Record<DelayedCommand, number>> = {};
  for (const [command, value] of Object.entries(t.commandDelays ?? {})) {
    const ms = toMs(value);
    if (ms !== undefined) commandDelays[command as DelayedCommand] = ms;
  }
  const startTransactionDelayMs = toMs(t.startTransactionDelay);
  const actionDelayMs = toMs(t.actionDelay);
  const bootRetryMs = toMs(t.bootRetry);
  return {
    ...(startTransactionDelayMs !== undefined && { startTransactionDelayMs }),
    ...(actionDelayMs !== undefined && { actionDelayMs }),
    ...(Object.keys(commandDelays).length > 0 && { actionDelaysMs: commandDelays }),
    ...(t.resetDowntime !== undefined && {
      resetDowntimeMs: {
        Soft: toMs(t.resetDowntime.soft) ?? DEFAULT_TIMING.resetDowntimeMs.Soft,
        Hard: toMs(t.resetDowntime.hard) ?? DEFAULT_TIMING.resetDowntimeMs.Hard,
      },
    }),
    ...(bootRetryMs !== undefined && { bootRetryMs }),
  };
}

/** Charge point options for a validated persona; throws if its configuration values are invalid. */
export function personaToOptions(definition: PersonaDefinition): PersonaChargePointOptions {
  const values: Record<string, string> = Object.fromEntries(
    Object.entries(definition.config ?? {}).map(([key, value]) => [key, String(value)]),
  );
  if (definition.features !== undefined)
    values.SupportedFeatureProfiles = definition.features.join(',');
  // Fail early, with the persona's numbers, rather than when a charge point is created.
  createConfig({ numberOfConnectors: definition.connectors, values });
  return {
    boot: definition.boot,
    connectors: definition.connectors,
    config: { values },
    timing: timingFrom(definition),
    ...(definition.power?.offeredW !== undefined && { offeredPowerW: definition.power.offeredW }),
    ...(definition.power?.evW !== undefined && { evPowerW: definition.power.evW }),
  };
}

/**
 * Validates persona documents and resolves `extends`. Every problem is
 * reported with the document's source; a persona with an error is left out.
 */
export function resolvePersonas(sources: readonly PersonaSource[]): ResolvePersonasResult {
  const errors: string[] = [];
  const raw = new Map<string, { source: string; data: PlainObject }>();

  for (const { source, data } of sources) {
    if (!isPlainObject(data) || typeof data.persona !== 'string' || data.persona.length === 0) {
      errors.push(`${source}: a persona needs a "persona" id`);
      continue;
    }
    const existing = raw.get(data.persona);
    if (existing !== undefined) {
      errors.push(`${source}: persona "${data.persona}" is already defined in ${existing.source}`);
      continue;
    }
    raw.set(data.persona, { source, data });
  }

  const merged = new Map<string, PlainObject | undefined>();
  function mergedOf(id: string, chain: string[]): PlainObject | undefined {
    if (merged.has(id)) return merged.get(id);
    const entry = raw.get(id);
    if (entry === undefined) return undefined;
    const { extends: parentId, ...own } = entry.data;
    let result: PlainObject | undefined = own;
    if (parentId !== undefined) {
      if (typeof parentId !== 'string') {
        errors.push(`${entry.source}: "extends" must be a persona id`);
        result = undefined;
      } else if (chain.includes(parentId)) {
        errors.push(`${entry.source}: circular extends: ${[...chain, parentId].join(' → ')}`);
        result = undefined;
      } else if (!raw.has(parentId)) {
        errors.push(`${entry.source}: extends unknown persona "${parentId}"`);
        result = undefined;
      } else {
        const parent = mergedOf(parentId, [...chain, parentId]);
        result = parent === undefined ? undefined : deepMerge(parent, own);
      }
    }
    merged.set(id, result);
    return result;
  }

  const personas = new Map<string, ResolvedPersona>();
  for (const [id, { source }] of raw) {
    const data = mergedOf(id, [id]);
    if (data === undefined) continue;
    const validated = validate(PersonaSchema, data);
    if (!validated.ok) {
      for (const issue of validated.issues)
        errors.push(`${source}: ${issue.path}: ${issue.message}`);
      continue;
    }
    const definition = validated.value;
    const evProblems = Object.entries(definition.evs ?? {}).flatMap(([name, ev]) =>
      evProfileProblems(ev as EvProfile).map((problem) => `${source}: $.evs.${name}: ${problem}`),
    );
    if (evProblems.length > 0) {
      errors.push(...evProblems);
      continue;
    }
    let options: PersonaChargePointOptions;
    try {
      options = personaToOptions(definition);
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const warnings = (definition.features ?? [])
      .filter((feature) => !IMPLEMENTED_FEATURE_PROFILES.includes(feature))
      .map(
        (feature) => `${source}: feature profile ${feature} is advertised but not implemented yet`,
      );
    personas.set(id, { id, source, definition, options, warnings });
  }

  return { personas, errors };
}
