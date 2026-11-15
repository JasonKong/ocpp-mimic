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
  Ocpp201RequestOf,
} from './messages.js';

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
}

export type InstallResult201 =
  { status: 'Accepted'; profiles: InstalledProfile201[] } | { status: 'Rejected'; reason: string };

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
  const problem = profileProblem(profile, evseId, context);
  if (problem !== undefined) return { status: 'Rejected', reason: problem };
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
    };
  }
  if (kept.length + 1 > context.maxInstalled) {
    return { status: 'Rejected', reason: `more than ${context.maxInstalled} profiles` };
  }
  return {
    status: 'Accepted',
    profiles: [...kept, { evseId, profile, installedAt: context.now }],
  };
}

/** ClearChargingProfile (K10): by id, or every profile matching all the criteria given. */
export function clearProfiles201(
  profiles: readonly InstalledProfile201[],
  request: Ocpp201RequestOf<'ClearChargingProfile'>,
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
  request: Ocpp201RequestOf<'GetChargingProfiles'>,
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
    limit: p.limit,
    ...(p.numberPhases !== undefined && { numberPhases: p.numberPhases }),
  }));
  return {
    connectorId: installed.evseId,
    installedAt: installed.installedAt,
    profile: {
      chargingProfileId: profile.id,
      stackLevel: profile.stackLevel,
      chargingProfilePurpose: purposeOf(profile.chargingProfilePurpose),
      chargingProfileKind: profile.chargingProfileKind,
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

/** An EVSE's own limit (TxProfile, else TxDefaultProfile) and the station's, with their next changes. */
export function limits201(
  profiles: readonly InstalledProfile201[],
  evseId: number,
  at: number,
  transaction: TransactionInfo | undefined,
) {
  const internal = profiles.map(toInternal);
  return {
    own: connectorLimit(internal, evseId, at, transaction),
    station: stationLimit(internal, at),
  };
}

export interface CompositeRequest201 {
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
  const schedule = compositeSchedule(profiles.map(toInternal), {
    connectorId: request.evseId,
    from: request.from,
    durationS: request.durationS,
    unit: request.unit,
    conversion: request.conversion,
    ratingW: request.ratingW,
    connectorIds: request.evseIds,
    transaction: request.transaction,
  });
  const periods = schedule.chargingSchedulePeriod.map((p): Bare<ChargingSchedulePeriodType> => ({
    startPeriod: p.startPeriod,
    limit: p.limit,
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
