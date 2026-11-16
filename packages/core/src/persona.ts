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
import { durationSchema, parseDuration } from './duration.js';
import { UsageSchema, usageProblems } from './usage.js';
import { evProfileProblems, type EvProfile } from './ev.js';
import type { FirmwareSettings } from './firmware.js';
import { ChargePointErrorCodeSchema, OCPP16_MESSAGES } from './ocpp16-messages.js';
import {
  CERTIFICATION_PROFILES,
  FEATURES_21,
  type ChargePoint201Options,
} from './ocpp201/charge-point.js';
import { applyOverrides, type DeviceModelOverrides } from './ocpp201/device-model.js';
import { ChargingStationSchema, DataEnumSchema, MutabilityEnumSchema } from './ocpp201/messages.js';
import { standardVariables } from './ocpp201/standard-variables.js';
import type { OcppVersion } from './message-set.js';
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
} from './schema.js';

export { durationSchema, parseDuration } from './duration.js';

/** The feature profiles a charge point can advertise in SupportedFeatureProfiles. */
export const FEATURE_PROFILES = [
  'Core',
  'FirmwareManagement',
  'LocalAuthListManagement',
  'Reservation',
  'SmartCharging',
  'RemoteTrigger',
] as const;

/** 2.0.1 certification profiles implemented so far. */
export const IMPLEMENTED_201_PROFILES: readonly string[] = [
  'Core',
  'AdvancedSecurity',
  'LocalAuthListManagement',
  'SmartCharging',
  'Reservation',
  // 2.1's feature groups, as they are built (M7).
  'TariffAndCost',
];

/** Feature profiles this version of the charge point implements. */
export const IMPLEMENTED_FEATURE_PROFILES: readonly string[] = [
  'Core',
  'FirmwareManagement',
  'RemoteTrigger',
  'LocalAuthListManagement',
  'Reservation',
  'SmartCharging',
];

const timingFields = {
  startTransactionDelay: durationSchema,
  actionDelay: durationSchema,
  resetDowntime: object({}, { soft: durationSchema, hard: durationSchema }),
  bootRetry: durationSchema,
};

/** Fields every persona can have, whatever its OCPP version. */
const commonFields = {
  extends: string(),
  description: string(),
  power: object({}, { offeredW: number(), evW: number() }),
  firmware: object(
    {},
    {
      downloadTime: durationSchema,
      installTime: durationSchema,
      uploadTime: durationSchema,
      download: oneOf(['succeed', 'fail']),
      install: oneOf(['succeed', 'fail']),
      upload: oneOf(['succeed', 'fail']),
      signature: oneOf(['succeed', 'fail']),
      transfer: oneOf(['simulated', 'real']),
    },
  ),
  evs: record(
    object(
      { capacityKWh: number(), initialSoc: number(), maxPowerW: number(), phases: integer() },
      {
        taperSoc: number(),
        targetSoc: number(),
        communication: oneOf(['basic', 'dc', 'iso15118']),
        departureMinutes: number(),
      },
    ),
  ),
  usage: UsageSchema,
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
};

/** An OCPP 1.6 persona (`ocpp` absent or "1.6"). */
export const PersonaSchema = object(
  {
    persona: string({ maxLength: 64 }),
    boot: OCPP16_MESSAGES.BootNotification.request,
    connectors: integer({ minimum: 1 }),
  },
  {
    ...commonFields,
    ocpp: oneOf(['1.6']),
    features: array(oneOf(FEATURE_PROFILES)),
    config: record(union(string(), number(), boolean())),
    timing: object(
      {},
      {
        ...timingFields,
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
      },
    ),
  },
);

const scalar = union(string(), number(), boolean());

/** A persona's or station's `deviceModel`: component → variable → value or definition. */
export const DeviceModelOverridesSchema = record(
  record(
    union(
      scalar,
      object(
        {},
        {
          actual: scalar,
          target: scalar,
          minSet: scalar,
          maxSet: scalar,
          mutability: MutabilityEnumSchema,
          persistent: boolean(),
          dataType: DataEnumSchema,
          unit: string(),
          valuesList: string(),
          minLimit: number(),
          maxLimit: number(),
        },
      ),
    ),
  ),
);

/**
 * An OCPP 2.0.1 or 2.1 persona: `ocpp: "2.0.1"` or `"2.1"`, BootNotification's
 * chargingStation block as `boot`. 2.1 adds feature groups and a choice of how
 * connector availability is reported.
 */
export const Persona201Schema = object(
  {
    persona: string({ maxLength: 64 }),
    ocpp: oneOf(['2.0.1', '2.1']),
    boot: ChargingStationSchema,
    connectors: integer({ minimum: 1 }),
  },
  {
    ...commonFields,
    features: array(oneOf([...CERTIFICATION_PROFILES, ...FEATURES_21])),
    connectorStatus: oneOf(['NotifyEvent', 'StatusNotification']),
    deviceModel: DeviceModelOverridesSchema,
    timing: object(
      {},
      {
        ...timingFields,
        commandDelays: object(
          {},
          {
            ChangeAvailability: durationSchema,
            RequestStartTransaction: durationSchema,
            RequestStopTransaction: durationSchema,
            Reset: durationSchema,
            UnlockConnector: durationSchema,
            TriggerMessage: durationSchema,
            CustomerInformation: durationSchema,
          },
        ),
      },
    ),
  },
);

export type Persona201Definition = Infer<typeof Persona201Schema>;

export type PersonaDefinition = Infer<typeof PersonaSchema>;

/** The parts of the charge point options a persona decides. */
export type PersonaChargePointOptions = Pick<
  ChargePointOptions,
  'boot' | 'connectors' | 'config' | 'timing' | 'firmware'
> & {
  offeredPowerW?: number;
  evPowerW?: number;
};

/** The parts of a 2.0.1 station's options a persona decides. */
export type Persona201Options = Pick<
  ChargePoint201Options,
  'boot' | 'connectors' | 'timing' | 'offeredPowerW' | 'evPowerW' | 'ocpp' | 'connectorStatus'
> & {
  features: readonly string[];
  deviceModel?: DeviceModelOverrides;
  firmware?: Partial<FirmwareSettings>;
};

interface ResolvedPersonaBase {
  id: string;
  /** Where the persona came from, e.g. its file path. */
  source: string;
  /** Non-fatal problems, such as advertising a feature profile not implemented yet. */
  warnings: string[];
}

/** A persona with its options; `ocpp` tells the two versions apart. */
export type ResolvedPersona =
  | (ResolvedPersonaBase & {
      ocpp: '1.6';
      definition: PersonaDefinition;
      options: PersonaChargePointOptions;
    })
  | (ResolvedPersonaBase & {
      ocpp: '2.0.1' | '2.1';
      definition: Persona201Definition;
      options: Persona201Options;
    });

/** The OCPP version a persona document declares; 1.6 when it says nothing. */
export function personaVersion(data: { ocpp?: unknown }): OcppVersion {
  return data.ocpp === '2.0.1' || data.ocpp === '2.1' ? data.ocpp : '1.6';
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

function timingFrom(
  definition: PersonaDefinition | Persona201Definition,
): Partial<ChargePointTiming> {
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

function firmwareFrom(
  firmware: NonNullable<PersonaDefinition['firmware']>,
): Partial<FirmwareSettings> {
  const downloadMs = toMs(firmware.downloadTime);
  const installMs = toMs(firmware.installTime);
  const uploadMs = toMs(firmware.uploadTime);
  return {
    ...(downloadMs !== undefined && { downloadMs }),
    ...(installMs !== undefined && { installMs }),
    ...(uploadMs !== undefined && { uploadMs }),
    ...(firmware.download !== undefined && { download: firmware.download }),
    ...(firmware.install !== undefined && { install: firmware.install }),
    ...(firmware.upload !== undefined && { upload: firmware.upload }),
    ...(firmware.signature !== undefined && { signature: firmware.signature }),
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
    ...(definition.firmware !== undefined && { firmware: firmwareFrom(definition.firmware) }),
  };
}

/** Station options for a validated 2.0.1 persona. */
export function persona201ToOptions(definition: Persona201Definition): Persona201Options {
  return {
    boot: definition.boot,
    connectors: definition.connectors,
    timing: timingFrom(definition),
    features: definition.features ?? ['Core'],
    ocpp: definition.ocpp,
    ...(definition.connectorStatus !== undefined && {
      connectorStatus: definition.connectorStatus,
    }),
    ...(definition.deviceModel !== undefined && { deviceModel: definition.deviceModel }),
    ...(definition.power?.offeredW !== undefined && { offeredPowerW: definition.power.offeredW }),
    ...(definition.power?.evW !== undefined && { evPowerW: definition.power.evW }),
    ...(definition.firmware !== undefined && { firmware: firmwareFrom(definition.firmware) }),
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
    const ocpp = personaVersion(data);
    const validated =
      ocpp === '1.6' ? validate(PersonaSchema, data) : validate(Persona201Schema, data);
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
    const usageIssues =
      definition.usage === undefined ? [] : usageProblems(definition.usage, '$.usage');
    if (usageIssues.length > 0) {
      errors.push(...usageIssues.map((issue) => `${source}: ${issue.path}: ${issue.message}`));
      continue;
    }
    if (ocpp !== '1.6') {
      const definition201 = definition as Persona201Definition;
      // 2.1's feature groups and availability choice mean nothing to a 2.0.1 station.
      const only21 = [
        ...(definition201.features ?? []).filter((f) =>
          (FEATURES_21 as readonly string[]).includes(f),
        ),
        ...(definition201.connectorStatus !== undefined ? ['connectorStatus'] : []),
      ];
      if (ocpp === '2.0.1' && only21.length > 0) {
        errors.push(`${source}: ${only21.join(', ')} need ocpp "2.1"`);
        continue;
      }
      // Overrides are checked against the standard variables now, not when a station starts.
      const overrides = applyOverrides(
        standardVariables({
          connectors: definition201.connectors,
          features: definition201.features ?? ['Core'],
          offeredW: definition201.power?.offeredW ?? 7360,
          ocpp: definition201.ocpp,
        }),
        definition201.deviceModel,
      );
      if (!overrides.ok) {
        errors.push(...overrides.problems.map((problem) => `${source}: $.deviceModel.${problem}`));
        continue;
      }
      const warnings = (definition201.features ?? [])
        .filter((feature) => !IMPLEMENTED_201_PROFILES.includes(feature))
        .map(
          (feature) =>
            `${source}: certification profile ${feature} is supported in the persona but not implemented yet`,
        );
      personas.set(id, {
        id,
        source,
        ocpp,
        definition: definition201,
        options: persona201ToOptions(definition201),
        warnings,
      });
      continue;
    }
    const definition16 = definition as PersonaDefinition;
    let options: PersonaChargePointOptions;
    try {
      options = personaToOptions(definition16);
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const warnings = (definition16.features ?? [])
      .filter((feature) => !IMPLEMENTED_FEATURE_PROFILES.includes(feature))
      .map(
        (feature) => `${source}: feature profile ${feature} is advertised but not implemented yet`,
      );
    personas.set(id, { id, source, ocpp, definition: definition16, options, warnings });
  }

  return { personas, errors };
}
