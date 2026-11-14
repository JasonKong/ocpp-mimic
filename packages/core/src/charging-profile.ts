/**
 * Smart Charging: the charging profiles installed in a charge point and the
 * limits they impose, per OCPP 1.6 section 3.13 (purposes, stacking,
 * combining purposes) and the SetChargingProfile / ClearChargingProfile /
 * GetCompositeSchedule rules. Pure: time comes in as milliseconds.
 *
 * - ChargePointMaxProfile: connectorId 0 only; caps all connectors together.
 * - TxDefaultProfile: on connectorId 0 for every connector, or on one
 *   connector, where it takes the place of the connectorId 0 profiles.
 * - TxProfile: connectorId > 0, only during a transaction; it overrules the
 *   TxDefaultProfile and is deleted when the transaction ends.
 * Within a purpose the profile with the highest stackLevel that is valid and
 * has a schedule period at that moment prevails.
 */
import type {
  ChargingProfile,
  ChargingSchedule,
  ChargingSchedulePeriod,
} from './ocpp16-messages.js';

export type ChargingProfilePurpose = ChargingProfile['chargingProfilePurpose'];
export type ChargingRateUnit = ChargingSchedule['chargingRateUnit'];

export interface InstalledProfile {
  connectorId: number;
  profile: ChargingProfile;
  /** When the profile was installed; an Absolute schedule without startSchedule starts here. */
  installedAt: number;
}

export interface ProfileLimits {
  /** ChargeProfileMaxStackLevel */
  maxStackLevel: number;
  /** ChargingScheduleMaxPeriods */
  maxPeriods: number;
  /** MaxChargingProfilesInstalled */
  maxInstalled: number;
  /** ChargingScheduleAllowedChargingRateUnit, as A / W */
  allowedUnits: readonly ChargingRateUnit[];
}

export interface InstallContext extends ProfileLimits {
  connectorIds: readonly number[];
  /** The transaction running on a connector, if any. */
  transactionId: (connectorId: number) => number | undefined;
  now: number;
}

export type InstallResult = {
  profiles: InstalledProfile[];
  status: 'Accepted' | 'Rejected';
  /** Why a profile was rejected, for the log. */
  reason?: string;
};

/** A running transaction, for TxProfiles and Relative schedules. */
export interface TransactionInfo {
  /** Undefined until the CSMS has answered StartTransaction. */
  id?: number;
  startedAt: number;
}

/** The limit a profile imposes at a moment. */
export interface ActiveLimit {
  limit: number;
  unit: ChargingRateUnit;
  /** numberPhases of the period; the specification's default is 3. */
  numberPhases: number;
  chargingProfileId: number;
  purpose: ChargingProfilePurpose;
}

/** Voltage and the phases actually used (by the EV), for converting between A and W. */
export interface Conversion {
  voltageV: number;
  phases: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const PURPOSES: readonly ChargingProfilePurpose[] = [
  'ChargePointMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
];

const time = (iso: string | undefined) => (iso === undefined ? undefined : Date.parse(iso));

/** Installs a profile (SetChargingProfile, or one inside RemoteStartTransaction). */
export function installProfile(
  profiles: readonly InstalledProfile[],
  connectorId: number,
  profile: ChargingProfile,
  context: InstallContext,
): InstallResult {
  const reject = (reason: string): InstallResult => ({
    profiles: [...profiles],
    status: 'Rejected',
    reason,
  });
  const purpose = profile.chargingProfilePurpose;
  if (connectorId !== 0 && !context.connectorIds.includes(connectorId)) {
    return reject(`unknown connector ${connectorId}`);
  }
  if (purpose === 'ChargePointMaxProfile' && connectorId !== 0) {
    return reject('a ChargePointMaxProfile can only be set on connectorId 0');
  }
  if (purpose === 'TxProfile') {
    if (connectorId === 0) return reject('a TxProfile can only be set on a connector > 0');
    const running = context.transactionId(connectorId);
    if (running === undefined) return reject(`no transaction on connector ${connectorId}`);
    if (profile.transactionId !== undefined && profile.transactionId !== running) {
      return reject(
        `transaction ${profile.transactionId} is not running on connector ${connectorId}`,
      );
    }
  }
  if (profile.stackLevel < 0 || profile.stackLevel > context.maxStackLevel) {
    return reject(
      `stackLevel ${profile.stackLevel} is above ChargeProfileMaxStackLevel ${context.maxStackLevel}`,
    );
  }
  const schedule = profile.chargingSchedule;
  if (!context.allowedUnits.includes(schedule.chargingRateUnit)) {
    return reject(`chargingRateUnit ${schedule.chargingRateUnit} is not allowed`);
  }
  const periods = schedule.chargingSchedulePeriod;
  if (periods.length > context.maxPeriods) {
    return reject(
      `${periods.length} periods, more than ChargingScheduleMaxPeriods ${context.maxPeriods}`,
    );
  }
  if (
    periods[0]?.startPeriod !== 0 ||
    periods.some((p, i) => i > 0 && p.startPeriod <= (periods[i - 1]?.startPeriod ?? 0))
  ) {
    return reject('periods must start at 0 and increase');
  }
  if (profile.chargingProfileKind === 'Recurring' && profile.recurrencyKind === undefined) {
    return reject('a Recurring profile needs a recurrencyKind');
  }

  // Same id anywhere, or the same purpose and stackLevel on this connector: replaced.
  const kept = profiles.filter(
    (p) =>
      p.profile.chargingProfileId !== profile.chargingProfileId &&
      !(
        p.connectorId === connectorId &&
        p.profile.chargingProfilePurpose === purpose &&
        p.profile.stackLevel === profile.stackLevel
      ),
  );
  if (kept.length + 1 > context.maxInstalled) {
    return reject(`more than MaxChargingProfilesInstalled ${context.maxInstalled} profiles`);
  }
  const running = purpose === 'TxProfile' ? context.transactionId(connectorId) : undefined;
  const stored: ChargingProfile =
    running !== undefined && profile.transactionId === undefined
      ? { ...profile, transactionId: running }
      : profile;
  return {
    profiles: [...kept, { connectorId, profile: stored, installedAt: context.now }],
    status: 'Accepted',
  };
}

export interface ClearCriteria {
  id?: number;
  connectorId?: number;
  purpose?: ChargingProfilePurpose;
  stackLevel?: number;
}

/**
 * ClearChargingProfile: by id (other criteria ignored), or every profile
 * matching all the criteria given. Unknown when nothing was removed.
 */
export function clearProfiles(
  profiles: readonly InstalledProfile[],
  criteria: ClearCriteria,
): { profiles: InstalledProfile[]; status: 'Accepted' | 'Unknown' } {
  const matches = (p: InstalledProfile) =>
    criteria.id !== undefined
      ? p.profile.chargingProfileId === criteria.id
      : (criteria.connectorId === undefined || p.connectorId === criteria.connectorId) &&
        (criteria.purpose === undefined || p.profile.chargingProfilePurpose === criteria.purpose) &&
        (criteria.stackLevel === undefined || p.profile.stackLevel === criteria.stackLevel);
  const kept = profiles.filter((p) => !matches(p));
  return { profiles: kept, status: kept.length < profiles.length ? 'Accepted' : 'Unknown' };
}

/** The TxProfiles of a connector are deleted when its transaction ends. */
export function endTransactionProfiles(
  profiles: readonly InstalledProfile[],
  connectorId: number,
): InstalledProfile[] {
  return profiles.filter(
    (p) => !(p.connectorId === connectorId && p.profile.chargingProfilePurpose === 'TxProfile'),
  );
}

interface Evaluation {
  period?: ChargingSchedulePeriod;
  /** The next moment the result can change, if any. */
  next?: number;
}

/** Where a profile's schedule stands at `at`: the period in force and the next change. */
function evaluate(
  installed: InstalledProfile,
  at: number,
  transaction: TransactionInfo | undefined,
): Evaluation {
  const { profile } = installed;
  const schedule = profile.chargingSchedule;
  const validFrom = time(profile.validFrom);
  const validTo = time(profile.validTo);
  if (validFrom !== undefined && at < validFrom) return { next: validFrom };
  if (validTo !== undefined && at >= validTo) return {};
  /** The earliest of the given moments and validTo, as an Evaluation's `next`. */
  const nextOf = (...moments: (number | undefined)[]): { next?: number } => {
    const known = [...moments, validTo].filter((t): t is number => t !== undefined);
    return known.length === 0 ? {} : { next: Math.min(...known) };
  };

  let start: number;
  let cycleEnd: number | undefined;
  switch (profile.chargingProfileKind) {
    case 'Relative':
      if (transaction === undefined) return {};
      start = transaction.startedAt;
      break;
    case 'Recurring': {
      const anchor = time(schedule.startSchedule) ?? installed.installedAt;
      const cycle = profile.recurrencyKind === 'Weekly' ? WEEK_MS : DAY_MS;
      if (at < anchor) return nextOf(anchor);
      start = anchor + Math.floor((at - anchor) / cycle) * cycle;
      cycleEnd = start + cycle;
      break;
    }
    default: {
      start = time(schedule.startSchedule) ?? installed.installedAt;
      if (at < start) return nextOf(start);
    }
  }
  const elapsedS = (at - start) / 1000;
  const durationEnd =
    schedule.duration === undefined ? undefined : start + schedule.duration * 1000;
  if (durationEnd !== undefined && at >= durationEnd) return nextOf(cycleEnd);
  const periods = schedule.chargingSchedulePeriod;
  let index = 0;
  while (index + 1 < periods.length && (periods[index + 1]?.startPeriod ?? Infinity) <= elapsedS)
    index++;
  const following = periods[index + 1];
  return {
    ...(periods[index] !== undefined && { period: periods[index] }),
    ...nextOf(
      following === undefined ? undefined : start + following.startPeriod * 1000,
      durationEnd,
      cycleEnd,
    ),
  };
}

/** The prevailing profile of one purpose among `candidates` at `at`, with the next change. */
function prevailing(
  candidates: readonly InstalledProfile[],
  at: number,
  transaction: TransactionInfo | undefined,
): { limit?: ActiveLimit; next?: number } {
  let next: number | undefined;
  const sorted = [...candidates].sort((a, b) => b.profile.stackLevel - a.profile.stackLevel);
  for (const installed of sorted) {
    const evaluation = evaluate(installed, at, transaction);
    if (evaluation.next !== undefined)
      next = next === undefined ? evaluation.next : Math.min(next, evaluation.next);
    if (evaluation.period !== undefined) {
      return {
        limit: {
          limit: evaluation.period.limit,
          unit: installed.profile.chargingSchedule.chargingRateUnit,
          numberPhases: evaluation.period.numberPhases ?? 3,
          chargingProfileId: installed.profile.chargingProfileId,
          purpose: installed.profile.chargingProfilePurpose,
        },
        ...(next !== undefined && { next }),
      };
    }
  }
  return next === undefined ? {} : { next };
}

/** The transaction-level profiles that apply to a connector: TxProfile over TxDefaultProfile. */
function connectorCandidates(
  profiles: readonly InstalledProfile[],
  connectorId: number,
  transaction: TransactionInfo | undefined,
): { tx: InstalledProfile[]; txDefault: InstalledProfile[] } {
  const tx =
    transaction === undefined
      ? []
      : profiles.filter(
          (p) =>
            p.connectorId === connectorId &&
            p.profile.chargingProfilePurpose === 'TxProfile' &&
            (p.profile.transactionId === undefined ||
              transaction.id === undefined ||
              p.profile.transactionId === transaction.id),
        );
  const own = profiles.filter(
    (p) => p.connectorId === connectorId && p.profile.chargingProfilePurpose === 'TxDefaultProfile',
  );
  const txDefault =
    own.length > 0
      ? own
      : profiles.filter(
          (p) => p.connectorId === 0 && p.profile.chargingProfilePurpose === 'TxDefaultProfile',
        );
  return { tx, txDefault };
}

/** The connector's own limit (TxProfile, else TxDefaultProfile) at `at`, and when it next changes. */
export function connectorLimit(
  profiles: readonly InstalledProfile[],
  connectorId: number,
  at: number,
  transaction?: TransactionInfo,
): { limit?: ActiveLimit; next?: number } {
  const { tx, txDefault } = connectorCandidates(profiles, connectorId, transaction);
  const fromTx = prevailing(tx, at, transaction);
  if (fromTx.limit !== undefined) return fromTx;
  const fromDefault = prevailing(txDefault, at, transaction);
  const next = [fromTx.next, fromDefault.next].filter((t): t is number => t !== undefined);
  return {
    ...(fromDefault.limit !== undefined && { limit: fromDefault.limit }),
    ...(next.length > 0 && { next: Math.min(...next) }),
  };
}

/** The ChargePointMaxProfile limit (all connectors together) at `at`, and when it next changes. */
export function stationLimit(
  profiles: readonly InstalledProfile[],
  at: number,
): { limit?: ActiveLimit; next?: number } {
  return prevailing(
    profiles.filter((p) => p.profile.chargingProfilePurpose === 'ChargePointMaxProfile'),
    at,
    undefined,
  );
}

/** A limit in watts: amperes × voltage × the phases in use (at most the period's numberPhases). */
export function toWatts(limit: ActiveLimit, conversion: Conversion): number {
  if (limit.unit === 'W') return limit.limit;
  return limit.limit * conversion.voltageV * Math.min(limit.numberPhases, conversion.phases);
}

function fromWatts(watts: number, unit: ChargingRateUnit, conversion: Conversion): number {
  if (unit === 'W') return Math.round(watts * 10) / 10;
  return Math.round((watts / (conversion.voltageV * conversion.phases)) * 10) / 10;
}

export interface CompositeRequest {
  /** 0 for the whole charge point. */
  connectorId: number;
  from: number;
  durationS: number;
  unit: ChargingRateUnit;
  conversion: Conversion;
  /** What the connector (or the station, for 0) can deliver without any profile, in W. */
  ratingW: number;
  /** The connectors of the station, for connectorId 0. */
  connectorIds: readonly number[];
  transaction?: (connectorId: number) => TransactionInfo | undefined;
}

/**
 * GetCompositeSchedule: from `from` for `durationS` seconds, the minimum of
 * the ChargePointMaxProfile and the connector's TxProfile / TxDefaultProfile
 * (for connectorId 0, the sum over the connectors capped by the
 * ChargePointMaxProfile), in `unit`, with equal neighbouring periods merged.
 */
export function compositeSchedule(
  profiles: readonly InstalledProfile[],
  request: CompositeRequest,
): ChargingSchedule {
  const end = request.from + request.durationS * 1000;
  const wattsAt = (at: number): { watts: number; next?: number } => {
    const station = stationLimit(profiles, at);
    const nexts: number[] = station.next === undefined ? [] : [station.next];
    const stationW =
      station.limit === undefined ? Infinity : toWatts(station.limit, request.conversion);
    const connectorW = (connectorId: number) => {
      const own = connectorLimit(profiles, connectorId, at, request.transaction?.(connectorId));
      if (own.next !== undefined) nexts.push(own.next);
      return Math.min(
        request.ratingW,
        own.limit === undefined ? Infinity : toWatts(own.limit, request.conversion),
      );
    };
    const watts =
      request.connectorId === 0
        ? Math.min(
            stationW,
            request.connectorIds.reduce((sum, id) => sum + connectorW(id), 0),
          )
        : Math.min(stationW, connectorW(request.connectorId));
    const future = nexts.filter((t) => t > at);
    return { watts, ...(future.length > 0 && { next: Math.min(...future) }) };
  };

  const periods: ChargingSchedulePeriod[] = [];
  let at = request.from;
  for (let guard = 0; at < end && guard < 1000; guard++) {
    const { watts, next } = wattsAt(at);
    const limit = fromWatts(
      Number.isFinite(watts) ? watts : request.ratingW,
      request.unit,
      request.conversion,
    );
    if (periods.at(-1)?.limit !== limit) {
      periods.push({ startPeriod: Math.round((at - request.from) / 1000), limit });
    }
    if (next === undefined) break;
    at = next;
  }
  return {
    duration: request.durationS,
    startSchedule: new Date(request.from).toISOString(),
    chargingRateUnit: request.unit,
    chargingSchedulePeriod:
      periods.length > 0
        ? (periods as [ChargingSchedulePeriod, ...ChargingSchedulePeriod[]])
        : [{ startPeriod: 0, limit: fromWatts(request.ratingW, request.unit, request.conversion) }],
  };
}

/** The purposes in precedence order, for display. */
export const CHARGING_PROFILE_PURPOSES = PURPOSES;
