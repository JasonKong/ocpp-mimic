/**
 * Smart Charging for a 2.0.1 station (functional block K): the profiles it
 * holds and the 2.0.1 rules for installing, clearing and reporting them. The
 * limits themselves come from the 1.6 composite schedule model
 * (`charging-profile.ts`), which 2.0.1 kept: a 2.0.1 profile is converted to
 * that model's shape to be evaluated. Pure: time comes in as milliseconds.
 *
 * - ChargingStationMaxProfile: evseId 0 only, not Relative; caps the station.
 * - TxDefaultProfile: on evseId 0 for every EVSE, or on one EVSE, where it
 *   takes the place of the evseId 0 profiles (K01.FR.14, .15).
 * - TxProfile: evseId > 0, for the running transaction named by
 *   transactionId (K01.FR.03, .09, .16, .33); removed when it ends.
 * - ChargingStationExternalConstraints comes only from an external system:
 *   refused (K01.FR.22).
 */
import type {
  ChargingProfile,
  ChargingSchedulePeriod as ChargingSchedulePeriod16,
} from '../ocpp16-messages.js';
import {
  clearProfiles,
  compositeSchedule,
  connectorLimit,
  stationLimit,
  type ChargingRateUnit,
  type Conversion,
  type InstalledProfile,
  type TransactionInfo,
} from '../charging-profile.js';
import type {
  ChargingProfileType,
  ChargingSchedulePeriodType,
  CompositeScheduleType,
  Ocpp21RequestOf,
} from '../ocpp21/messages.js';

type Bare<T> = Omit<T, 'customData'>;
export type ChargingProfile201 = Bare<ChargingProfileType>;

export interface InstalledProfile201 {
  /** 0 for the whole station. */
  evseId: number;
  profile: ChargingProfile201;
  /** When it was installed; a schedule without startSchedule starts here. */
  installedAt: number;
}

export interface SmartChargingLimits201 {
  /** SmartChargingCtrlr.ProfileStackLevel */
  maxStackLevel: number;
  /** SmartChargingCtrlr.PeriodsPerSchedule */
  maxPeriods: number;
  /** SmartChargingCtrlr.Entries:ChargingProfiles maxLimit */
  maxInstalled: number;
  /** SmartChargingCtrlr.RateUnit */
  units: readonly ChargingRateUnit[];
}

export interface InstallContext201 extends SmartChargingLimits201 {
  evseIds: readonly number[];
  /** The id of the transaction running on an EVSE, if any. */
  transactionOn(evseId: number): string | undefined;
  now: number;
  /**
   * 2.1: SmartChargingCtrlr.SupportedAdditionalPurposes and
   * SupportsDynamicProfiles. Undefined on 2.0.1, whose schemas allow none of it.
   */
  v21?: { purposes: readonly string[]; dynamic: boolean };
}

export type InstallResult201 =
  | { status: 'Accepted'; profiles: InstalledProfile201[] }
  | { status: 'Rejected'; reason: string; reasonCode: string };

/** Why 2.1 refuses a profile, with the reasonCode K01 names for it. */
export interface ProfileProblem21 {
  reason: string;
  reasonCode: string;
}

/**
 * The 2.1 checks (K01.FR.70, .120 to .126, K28.FR.01 to .03, the errata on
 * operation modes and phases): the new purposes and the Dynamic kind when the
 * station supports them, and the optional features ocpp-mimic does not
 * (useLocalTime, randomizedDelay, limitAtSoC, evseSleep), and nothing of V2X.
 */
export function profileProblem21(
  profile: ChargingProfile201,
  context: Pick<InstallContext201, 'v21'>,
): ProfileProblem21 | undefined {
  const problem = (reasonCode: string, reason: string) => ({ reasonCode, reason });
  const v21 = context.v21 ?? { purposes: [], dynamic: false };
  const purpose = profile.chargingProfilePurpose;
  if (
    (purpose === 'PriorityCharging' || purpose === 'LocalGeneration') &&
    !v21.purposes.includes(purpose)
  ) {
    return problem('UnsupportedPurpose', `chargingProfilePurpose ${purpose} is not supported`);
  }
  const dynamic = profile.chargingProfileKind === 'Dynamic';
  if (dynamic && !v21.dynamic)
    return problem('UnsupportedKind', 'Dynamic profiles are not supported');
  if (
    !dynamic &&
    (profile.dynUpdateInterval !== undefined || profile.dynUpdateTime !== undefined)
  ) {
    return problem(
      'InvalidProfile',
      'dynUpdateInterval and dynUpdateTime are for Dynamic profiles',
    );
  }
  const schedules = profile.chargingSchedule;
  if (dynamic) {
    const [only] = schedules;
    const [period] = only?.chargingSchedulePeriod ?? [];
    if (
      schedules.length !== 1 ||
      only?.chargingSchedulePeriod.length !== 1 ||
      period?.startPeriod !== 0
    ) {
      return problem(
        'InvalidSchedule',
        'a Dynamic profile has one schedule with one period from 0 (K28.FR.01 to .03)',
      );
    }
  }
  for (const schedule of schedules) {
    if (purpose === 'PriorityCharging' && schedule.duration !== undefined) {
      return problem('InvalidSchedule', 'a PriorityCharging schedule has no duration (K01.FR.70)');
    }
    if (schedule.useLocalTime === true)
      return problem('InvalidSchedule', 'useLocalTime is not supported');
    if ((schedule.randomizedDelay ?? 0) > 0) {
      return problem('InvalidSchedule', 'randomizedDelay is not supported');
    }
    if (schedule.limitAtSoC !== undefined)
      return problem('InvalidSchedule', 'limitAtSoC is not supported');
    for (const p of schedule.chargingSchedulePeriod) {
      if (p.evseSleep === true) return problem('InvalidSchedule', 'evseSleep is not supported');
      if (p.operationMode !== undefined && p.operationMode !== 'ChargingOnly') {
        return problem('InvalidOperationMode', `operationMode ${p.operationMode} is not supported`);
      }
      // 2.1 makes limit optional, but a ChargingOnly period needs one (Q, 2.2).
      if (p.limit === undefined) return problem('InvalidSchedule', 'every period needs a limit');
      if (p.limit_L2 !== undefined || p.limit_L3 !== undefined) {
        return problem('PhaseConflict', 'per-phase limits need an ISO 15118-20 AC EV');
      }
      if (p.setpoint !== undefined || p.dischargeLimit !== undefined) {
        return problem('InvalidSchedule', 'setpoints and discharge limits are V2X');
      }
    }
  }
  return undefined;
}

const time = (iso: string | undefined) => (iso === undefined ? undefined : Date.parse(iso));

/** Why a profile cannot be installed on `evseId` (K01), or undefined. */
export function profileProblem(
  profile: ChargingProfile201,
  evseId: number,
  context: InstallContext201,
): string | undefined {
  const purpose = profile.chargingProfilePurpose;
  if (evseId !== 0 && !context.evseIds.includes(evseId)) return `unknown EVSE ${evseId}`;
  if (purpose === 'ChargingStationExternalConstraints') {
    return 'ChargingStationExternalConstraints comes only from an external system';
  }
  if (purpose === 'ChargingStationMaxProfile') {
    if (evseId !== 0) return 'a ChargingStationMaxProfile can only be set on evseId 0';
    if (profile.chargingProfileKind === 'Relative') {
      return 'a ChargingStationMaxProfile cannot be Relative';
    }
  }
  if (purpose === 'TxProfile') {
    if (evseId === 0) return 'a TxProfile can only be set on an EVSE';
    const running = context.transactionOn(evseId);
    if (running === undefined) return `no transaction on EVSE ${evseId}`;
    if (profile.transactionId === undefined) return 'a TxProfile needs a transactionId';
    if (profile.transactionId !== running) {
      return `transaction ${profile.transactionId} is not running on EVSE ${evseId}`;
    }
  }
  if (profile.stackLevel < 0 || profile.stackLevel > context.maxStackLevel) {
    return `stackLevel ${profile.stackLevel} is above ProfileStackLevel ${context.maxStackLevel}`;
  }
  // More schedules are ISO 15118 (K01.FR.34).
  const schedule = profile.chargingSchedule[0];
  if (profile.chargingSchedule.length !== 1 || schedule === undefined) {
    return 'only one chargingSchedule is supported';
  }
  if (!context.units.includes(schedule.chargingRateUnit)) {
    return `chargingRateUnit ${schedule.chargingRateUnit} is not in RateUnit`;
  }
  const periods = schedule.chargingSchedulePeriod;
  if (periods.length > context.maxPeriods) {
    return `${periods.length} periods, more than PeriodsPerSchedule ${context.maxPeriods}`;
  }
  if (
    periods[0]?.startPeriod !== 0 ||
    periods.some((p, i) => i > 0 && p.startPeriod <= (periods[i - 1]?.startPeriod ?? 0))
  ) {
    return 'periods must start at 0 and increase (K01.FR.31, .35)';
  }
  if (profile.chargingProfileKind === 'Recurring' && profile.recurrencyKind === undefined) {
    return 'a Recurring profile needs a recurrencyKind';
  }
  return undefined;
}

/** Whether two profiles' validity periods overlap. */
function overlap(a: ChargingProfile201, b: ChargingProfile201): boolean {
  const aFrom = time(a.validFrom) ?? -Infinity;
  const aTo = time(a.validTo) ?? Infinity;
  const bFrom = time(b.validFrom) ?? -Infinity;
  const bTo = time(b.validTo) ?? Infinity;
  return aFrom < bTo && bFrom < aTo;
}

/** SetChargingProfile (K01), or the TxProfile a RequestStartTransaction brought (K05). */
export function installProfile201(
  profiles: readonly InstalledProfile201[],
  evseId: number,
  profile: ChargingProfile201,
  context: InstallContext201,
): InstallResult201 {
  const problem21 = profileProblem21(profile, context);
  if (problem21 !== undefined) return { status: 'Rejected', ...problem21 };
  const problem = profileProblem(profile, evseId, context);
  if (problem !== undefined)
    return { status: 'Rejected', reason: problem, reasonCode: 'InvalidProfile' };
  // The same id is replaced (K01.FR.05); another one with the same stackLevel and
  // purpose on the same EVSE (or transaction) and an overlapping validity conflicts
  // (K01.FR.06, .39).
  const kept = profiles.filter((p) => p.profile.id !== profile.id);
  const conflict = kept.find(
    (p) =>
      p.evseId === evseId &&
      p.profile.chargingProfilePurpose === profile.chargingProfilePurpose &&
      p.profile.stackLevel === profile.stackLevel &&
      (profile.chargingProfilePurpose === 'TxProfile'
        ? p.profile.transactionId === profile.transactionId
        : overlap(p.profile, profile)),
  );
  if (conflict !== undefined) {
    return {
      status: 'Rejected',
      reason: `profile ${conflict.profile.id} has the same stackLevel and purpose`,
      reasonCode: 'DuplicateProfile',
    };
  }
  if (kept.length + 1 > context.maxInstalled) {
    return {
      status: 'Rejected',
      reason: `more than ${context.maxInstalled} profiles`,
      reasonCode: 'InvalidProfile',
    };
  }
  // A Dynamic profile is up to date from now on unless it says when it was (K28.FR.05).
  const installed =
    profile.chargingProfileKind === 'Dynamic' && profile.dynUpdateTime === undefined
      ? { ...profile, dynUpdateTime: new Date(context.now).toISOString() }
      : profile;
  return {
    status: 'Accepted',
    profiles: [...kept, { evseId, profile: installed, installedAt: context.now }],
  };
}

/** ClearChargingProfile (K10): by id, or every profile matching all the criteria given. */
export function clearProfiles201(
  profiles: readonly InstalledProfile201[],
  request: Ocpp21RequestOf<'ClearChargingProfile'>,
): { profiles: InstalledProfile201[]; status: 'Accepted' | 'Unknown' } {
  const criteria = request.chargingProfileCriteria;
  const result = clearProfiles(profiles.map(toInternal), {
    ...(request.chargingProfileId !== undefined && { id: request.chargingProfileId }),
    ...(criteria?.evseId !== undefined && { connectorId: criteria.evseId }),
    ...(criteria?.chargingProfilePurpose !== undefined && {
      purpose: purposeOf(criteria.chargingProfilePurpose),
    }),
    ...(criteria?.stackLevel !== undefined && { stackLevel: criteria.stackLevel }),
  });
  const left = new Set(result.profiles.map((p) => p.profile.chargingProfileId));
  return {
    profiles: profiles.filter((p) => left.has(p.profile.id)),
    status: result.status,
  };
}

/** The profiles GetChargingProfiles asks for (K09.FR.04 to .06). */
export function selectProfiles201(
  profiles: readonly InstalledProfile201[],
  request: Ocpp21RequestOf<'GetChargingProfiles'>,
): InstalledProfile201[] {
  const criterion = request.chargingProfile;
  const ids = criterion.chargingProfileId;
  return profiles.filter(
    (p) =>
      (request.evseId === undefined || p.evseId === request.evseId) &&
      (ids === undefined || ids.includes(p.profile.id)) &&
      (criterion.stackLevel === undefined || p.profile.stackLevel === criterion.stackLevel) &&
      (criterion.chargingProfilePurpose === undefined ||
        p.profile.chargingProfilePurpose === criterion.chargingProfilePurpose) &&
      // Profiles set over OCPP come from the CSO.
      (criterion.chargingLimitSource === undefined ||
        criterion.chargingLimitSource.includes('CSO')),
  );
}

/** The TxProfiles of an EVSE go when its transaction ends. */
export function endTransactionProfiles201(
  profiles: readonly InstalledProfile201[],
  evseId: number,
): InstalledProfile201[] {
  return profiles.filter(
    (p) => !(p.evseId === evseId && p.profile.chargingProfilePurpose === 'TxProfile'),
  );
}

// ---- The 1.6 model ------------------------------------------------------------

function purposeOf(
  purpose: ChargingProfile201['chargingProfilePurpose'],
): ChargingProfile['chargingProfilePurpose'] {
  return purpose === 'ChargingStationMaxProfile' ? 'ChargePointMaxProfile' : (purpose as never);
}

/**
 * A 2.0.1 profile in the 1.6 model: the purpose renamed, its one schedule,
 * no transactionId (a TxProfile only exists while its transaction runs).
 */
export function toInternal(installed: InstalledProfile201): InstalledProfile {
  const { profile } = installed;
  const schedule = profile.chargingSchedule[0];
  // The schema asks for at least one schedule.
  if (schedule === undefined) throw new Error(`charging profile ${profile.id} has no schedule`);
  const periods = schedule.chargingSchedulePeriod.map((p): ChargingSchedulePeriod16 => ({
    startPeriod: p.startPeriod,
    // profileProblem() refuses periods without a limit.
    limit: p.limit ?? 0,
    ...(p.numberPhases !== undefined && { numberPhases: p.numberPhases }),
  }));
  return {
    connectorId: installed.evseId,
    installedAt: installed.installedAt,
    profile: {
      chargingProfileId: profile.id,
      stackLevel: profile.stackLevel,
      chargingProfilePurpose: purposeOf(profile.chargingProfilePurpose),
      // profileProblem() refuses the Dynamic kind.
      chargingProfileKind: profile.chargingProfileKind as 'Absolute' | 'Recurring' | 'Relative',
      ...(profile.recurrencyKind !== undefined && { recurrencyKind: profile.recurrencyKind }),
      ...(profile.validFrom !== undefined && { validFrom: profile.validFrom }),
      ...(profile.validTo !== undefined && { validTo: profile.validTo }),
      chargingSchedule: {
        chargingRateUnit: schedule.chargingRateUnit,
        chargingSchedulePeriod: periods as [
          ChargingSchedulePeriod16,
          ...ChargingSchedulePeriod16[],
        ],
        ...(schedule.duration !== undefined && { duration: schedule.duration }),
        ...(schedule.startSchedule !== undefined && { startSchedule: schedule.startSchedule }),
        ...(schedule.minChargingRate !== undefined && {
          minChargingRate: schedule.minChargingRate,
        }),
      },
    },
  };
}

// ---- 2.1: priority charging, local generation, Dynamic profiles -------------

/** Above every stack level a CSMS can send, so an active PriorityCharging profile prevails. */
const PRIORITY_STACK = 1_000_000;

/** When a Dynamic profile goes stale: its duration after the last update (K28.FR.13, errata). */
export function dynamicDeadline(profile: ChargingProfile201): number | undefined {
  const duration = profile.chargingSchedule[0]?.duration;
  const updated = time(profile.dynUpdateTime);
  return profile.chargingProfileKind !== 'Dynamic' ||
    duration === undefined ||
    updated === undefined
    ? undefined
    : updated + duration * 1000;
}

/**
 * The profiles in force, in the 1.6 model. An active PriorityCharging
 * profile (K21, K22) stands in for the EVSE's TxProfile and TxDefaultProfile:
 * it becomes a TxProfile above all others, so the ChargingStationMaxProfile
 * still applies (K01, 3.6). A LocalGeneration profile adds capacity instead
 * (see localGeneration201). A Dynamic profile is its one period, until it goes
 * stale (K28.FR.13 to .15).
 */
export function effectiveProfiles(
  profiles: readonly InstalledProfile201[],
  at: number,
  priorityEvses: ReadonlySet<number> = new Set(),
): InstalledProfile[] {
  return profiles.flatMap((installed): InstalledProfile[] => {
    const { profile } = installed;
    if (profile.chargingProfilePurpose === 'LocalGeneration') return [];
    if (profile.chargingProfilePurpose === 'PriorityCharging') {
      return [...priorityEvses]
        .filter((evseId) => installed.evseId === 0 || installed.evseId === evseId)
        .map((evseId) => {
          const internal = toInternal({ ...installed, evseId });
          internal.profile.chargingProfilePurpose = 'TxProfile';
          internal.profile.stackLevel = PRIORITY_STACK + profile.stackLevel;
          return internal;
        });
    }
    if (profile.chargingProfileKind === 'Dynamic') {
      const deadline = dynamicDeadline(profile);
      if (deadline !== undefined && at >= deadline) return [];
      const internal = toInternal(installed);
      internal.profile.chargingProfileKind = 'Absolute';
      // A Dynamic schedule's duration is how long an update holds, not how long it runs.
      delete internal.profile.chargingSchedule.duration;
      return [internal];
    }
    return [toInternal(installed)];
  });
}

/** The capacity LocalGeneration profiles add to an EVSE's limit (K08.FR.04, K04.FR.05). */
export function localGeneration201(
  profiles: readonly InstalledProfile201[],
  evseId: number,
  at: number,
) {
  const internal = profiles
    .filter((p) => p.profile.chargingProfilePurpose === 'LocalGeneration')
    .map((p) => {
      const converted = toInternal(p);
      converted.profile.chargingProfilePurpose = 'TxDefaultProfile';
      return converted;
    });
  return connectorLimit(internal, evseId, at, undefined);
}

/** A Dynamic profile with an update applied (K28.FR.06, .08): its one period, new dynUpdateTime. */
export function applyDynamicUpdate(
  installed: InstalledProfile201,
  update: Partial<Bare<ChargingSchedulePeriodType>>,
  at: number,
): InstalledProfile201 {
  const [schedule, ...others] = installed.profile.chargingSchedule;
  if (schedule === undefined) return installed;
  const [period] = schedule.chargingSchedulePeriod;
  const values = Object.fromEntries(
    Object.entries(update).filter(([key, value]) => key !== 'customData' && value !== undefined),
  );
  return {
    ...installed,
    profile: {
      ...installed.profile,
      dynUpdateTime: new Date(at).toISOString(),
      chargingSchedule: [
        { ...schedule, chargingSchedulePeriod: [{ ...period, startPeriod: 0, ...values }] },
        ...others,
      ],
    },
  };
}

/**
 * An EVSE's own limit (TxProfile, else TxDefaultProfile), the station's and
 * the local generation it may add, with their next changes.
 */
export function limits201(
  profiles: readonly InstalledProfile201[],
  evseId: number,
  at: number,
  transaction: TransactionInfo | undefined,
  priorityEvses?: ReadonlySet<number>,
) {
  const internal = effectiveProfiles(profiles, at, priorityEvses);
  const deadlines = profiles
    .map((p) => dynamicDeadline(p.profile))
    .filter((d): d is number => d !== undefined && d > at);
  return {
    own: connectorLimit(internal, evseId, at, transaction),
    station: stationLimit(internal, at),
    localGeneration: localGeneration201(profiles, evseId, at),
    ...(deadlines.length > 0 && { staleAt: Math.min(...deadlines) }),
  };
}

export interface CompositeRequest201 {
  /** 2.1: EVSEs whose PriorityCharging profile is active. */
  priorityEvses?: ReadonlySet<number>;
  evseId: number;
  from: number;
  durationS: number;
  unit: ChargingRateUnit;
  conversion: Conversion;
  ratingW: number;
  evseIds: readonly number[];
  transaction: (evseId: number) => TransactionInfo | undefined;
}

/** GetCompositeSchedule (K08): the 1.6 composite schedule in 2.0.1's shape. */
export function compositeSchedule201(
  profiles: readonly InstalledProfile201[],
  request: CompositeRequest201,
): Bare<CompositeScheduleType> {
  const schedule = compositeSchedule(
    effectiveProfiles(profiles, request.from, request.priorityEvses),
    {
      connectorId: request.evseId,
      from: request.from,
      durationS: request.durationS,
      unit: request.unit,
      conversion: request.conversion,
      ratingW: request.ratingW,
      connectorIds: request.evseIds,
      transaction: request.transaction,
    },
  );
  const periods = schedule.chargingSchedulePeriod.map((p): Bare<ChargingSchedulePeriodType> => ({
    startPeriod: p.startPeriod,
    // profileProblem() refuses periods without a limit.
    limit: p.limit ?? 0,
    ...(p.numberPhases !== undefined && { numberPhases: p.numberPhases }),
  }));
  return {
    evseId: request.evseId,
    duration: request.durationS,
    scheduleStart: new Date(request.from).toISOString(),
    chargingRateUnit: request.unit,
    chargingSchedulePeriod: periods as [
      Bare<ChargingSchedulePeriodType>,
      ...Bare<ChargingSchedulePeriodType>[],
    ],
  };
}
