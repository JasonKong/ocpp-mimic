import { describe, expect, it } from 'vitest';
import {
  clearProfiles,
  compositeSchedule,
  connectorLimit,
  endTransactionProfiles,
  installProfile,
  stationLimit,
  toWatts,
  type InstallContext,
  type InstalledProfile,
} from './charging-profile.js';
import type { ChargingProfile } from './ocpp16-messages.js';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-14T10:00:00Z');
const H = 3_600_000;

const context = (transactions: Record<number, number> = {}): InstallContext => ({
  maxStackLevel: 10,
  maxPeriods: 24,
  maxInstalled: 20,
  allowedUnits: ['A', 'W'],
  connectorIds: [1, 2],
  transactionId: (c) => transactions[c],
  now: NOW,
});

function profile(
  overrides: Partial<ChargingProfile> & Pick<ChargingProfile, 'chargingProfileId'>,
): ChargingProfile {
  return {
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: {
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
    },
    ...overrides,
  };
}

/** Installs profiles in order, expecting each to be accepted. */
function install(entries: [number, ChargingProfile][], ctx = context()): InstalledProfile[] {
  let profiles: InstalledProfile[] = [];
  for (const [connectorId, p] of entries) {
    const result = installProfile(profiles, connectorId, p, ctx);
    expect(result.status, result.reason).toBe('Accepted');
    profiles = result.profiles;
  }
  return profiles;
}

/** The daily default profile from OCPP 1.6 section 3.13.7: 6 kW from 08:00 to 20:00, else 11 kW. */
const SPEC_DAILY = profile({
  chargingProfileId: 100,
  chargingProfileKind: 'Recurring',
  recurrencyKind: 'Daily',
  chargingSchedule: {
    duration: 86400,
    startSchedule: '2013-01-01T00:00:00Z',
    chargingRateUnit: 'W',
    chargingSchedulePeriod: [
      { startPeriod: 0, limit: 11000, numberPhases: 3 },
      { startPeriod: 28800, limit: 6000, numberPhases: 3 },
      { startPeriod: 72000, limit: 11000, numberPhases: 3 },
    ],
  },
});

describe('installing charging profiles', () => {
  it('checks purposes, connectors and transactions', () => {
    const reject = (connectorId: number, p: ChargingProfile, ctx = context()) =>
      installProfile([], connectorId, p, ctx);
    expect(
      reject(1, profile({ chargingProfileId: 1, chargingProfilePurpose: 'ChargePointMaxProfile' })),
    ).toMatchObject({
      status: 'Rejected',
      reason: 'a ChargePointMaxProfile can only be set on connectorId 0',
    });
    expect(
      reject(0, profile({ chargingProfileId: 1, chargingProfilePurpose: 'TxProfile' })).status,
    ).toBe('Rejected');
    expect(
      reject(1, profile({ chargingProfileId: 1, chargingProfilePurpose: 'TxProfile' })),
    ).toMatchObject({
      reason: 'no transaction on connector 1',
    });
    expect(
      reject(
        1,
        profile({ chargingProfileId: 1, chargingProfilePurpose: 'TxProfile', transactionId: 8 }),
        context({ 1: 7 }),
      ),
    ).toMatchObject({ reason: 'transaction 8 is not running on connector 1' });
    expect(reject(9, profile({ chargingProfileId: 1 }))).toMatchObject({
      reason: 'unknown connector 9',
    });
  });

  it('checks the configured limits and the schedule', () => {
    const reject = (p: ChargingProfile, ctx: Partial<InstallContext> = {}) =>
      installProfile([], 1, p, { ...context(), ...ctx }).reason;
    expect(reject(profile({ chargingProfileId: 1, stackLevel: 11 }))).toMatch(
      /ChargeProfileMaxStackLevel/,
    );
    expect(reject(profile({ chargingProfileId: 1 }), { allowedUnits: ['A'] })).toMatch(
      /chargingRateUnit W/,
    );
    expect(reject(profile({ chargingProfileId: 1 }), { maxPeriods: 0 })).toMatch(
      /ChargingScheduleMaxPeriods/,
    );
    expect(
      reject(
        profile({
          chargingProfileId: 1,
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 60, limit: 1 }],
          },
        }),
      ),
    ).toBe('periods must start at 0 and increase');
    expect(reject(profile({ chargingProfileId: 1, chargingProfileKind: 'Recurring' }))).toMatch(
      /recurrencyKind/,
    );
    const full = install([[1, profile({ chargingProfileId: 1 })]]);
    expect(
      installProfile(full, 1, profile({ chargingProfileId: 2, stackLevel: 1 }), {
        ...context(),
        maxInstalled: 1,
      }).reason,
    ).toMatch(/MaxChargingProfilesInstalled/);
  });

  it('replaces a profile with the same id, or the same purpose and stackLevel on the connector', () => {
    let profiles = install([
      [1, profile({ chargingProfileId: 1 })],
      [2, profile({ chargingProfileId: 2 })],
    ]);
    profiles = installProfile(profiles, 1, profile({ chargingProfileId: 3 }), context()).profiles;
    expect(profiles.map((p) => p.profile.chargingProfileId).sort()).toEqual([2, 3]);
    profiles = installProfile(
      profiles,
      1,
      profile({ chargingProfileId: 2, stackLevel: 4 }),
      context(),
    ).profiles;
    expect(profiles.map((p) => [p.connectorId, p.profile.chargingProfileId])).toEqual([
      [1, 3],
      [1, 2],
    ]);
  });

  it('stores the running transaction on a TxProfile sent without one', () => {
    const [stored] = install(
      [[1, profile({ chargingProfileId: 1, chargingProfilePurpose: 'TxProfile' })]],
      context({ 1: 42 }),
    );
    expect(stored?.profile.transactionId).toBe(42);
  });
});

describe('clearing charging profiles', () => {
  const profiles = install(
    [
      [0, profile({ chargingProfileId: 1, chargingProfilePurpose: 'ChargePointMaxProfile' })],
      [1, profile({ chargingProfileId: 2 })],
      [1, profile({ chargingProfileId: 3, stackLevel: 2 })],
      [1, profile({ chargingProfileId: 4, chargingProfilePurpose: 'TxProfile' })],
    ],
    context({ 1: 7 }),
  );
  const ids = (list: InstalledProfile[]) => list.map((p) => p.profile.chargingProfileId);

  it('clears by id, ignoring the other criteria', () => {
    expect(ids(clearProfiles(profiles, { id: 2, connectorId: 0 }).profiles)).toEqual([1, 3, 4]);
  });

  it('clears everything matching all the criteria given, and says Unknown when nothing matched', () => {
    expect(
      ids(clearProfiles(profiles, { connectorId: 1, purpose: 'TxDefaultProfile' }).profiles),
    ).toEqual([1, 4]);
    expect(ids(clearProfiles(profiles, { stackLevel: 2 }).profiles)).toEqual([1, 2, 4]);
    expect(ids(clearProfiles(profiles, {}).profiles)).toEqual([]);
    expect(clearProfiles(profiles, { id: 99 })).toMatchObject({ status: 'Unknown' });
  });

  it("deletes a connector's TxProfiles when its transaction ends", () => {
    expect(ids(endTransactionProfiles(profiles, 1))).toEqual([1, 2, 3]);
  });
});

describe('limits in force', () => {
  it('follows the daily example from the specification', () => {
    const profiles = install([[0, SPEC_DAILY]]);
    const limit = (iso: string) => connectorLimit(profiles, 1, at(iso));
    expect(limit('2026-11-14T07:59:00Z')).toMatchObject({
      limit: { limit: 11000 },
      next: at('2026-11-14T08:00:00Z'),
    });
    expect(limit('2026-11-14T10:00:00Z')).toMatchObject({
      limit: { limit: 6000, unit: 'W', numberPhases: 3 },
      next: at('2026-11-14T20:00:00Z'),
    });
    expect(limit('2026-11-14T20:00:00Z')).toMatchObject({
      limit: { limit: 11000 },
      next: at('2026-11-15T00:00:00Z'),
    });
    expect(limit('2026-11-15T09:00:00Z').limit?.limit).toBe(6000);
  });

  it('takes the highest stack level, falling back when its schedule or validity ends', () => {
    const profiles = install([
      [0, profile({ chargingProfileId: 1, stackLevel: 0 })],
      [
        0,
        profile({
          chargingProfileId: 2,
          stackLevel: 1,
          chargingSchedule: {
            duration: 3600,
            startSchedule: '2026-11-14T10:00:00Z',
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 2000 }],
          },
        }),
      ],
      [
        0,
        profile({
          chargingProfileId: 3,
          stackLevel: 2,
          validFrom: '2026-11-14T12:00:00Z',
          validTo: '2026-11-14T13:00:00Z',
        }),
      ],
    ]);
    const limit = (ms: number) => connectorLimit(profiles, 1, ms);
    expect(limit(NOW)).toMatchObject({
      limit: { limit: 2000, chargingProfileId: 2 },
      next: NOW + H,
    });
    expect(limit(NOW + H).limit).toMatchObject({ limit: 5000, chargingProfileId: 1 });
    expect(limit(NOW + 2.5 * H).limit?.chargingProfileId).toBe(3);
    expect(limit(NOW + 3 * H).limit?.chargingProfileId).toBe(1);
  });

  it('lets a TxProfile overrule TxDefaultProfiles, and a connector profile replace connector 0 for that connector', () => {
    const profiles = install(
      [
        [0, profile({ chargingProfileId: 1 })],
        [
          2,
          profile({
            chargingProfileId: 2,
            chargingSchedule: {
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 4000 }],
            },
          }),
        ],
        [
          1,
          profile({
            chargingProfileId: 3,
            chargingProfilePurpose: 'TxProfile',
            chargingProfileKind: 'Relative',
            chargingSchedule: {
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 10 },
                { startPeriod: 600, limit: 6 },
              ],
            },
          }),
        ],
      ],
      context({ 1: 7 }),
    );
    const tx = { id: 7, startedAt: NOW };
    expect(connectorLimit(profiles, 1, NOW + 60_000, tx)).toMatchObject({
      limit: { limit: 10, unit: 'A', purpose: 'TxProfile' },
      next: NOW + 600_000,
    });
    expect(connectorLimit(profiles, 1, NOW + 700_000, tx).limit?.limit).toBe(6);
    // Without the transaction (a different id), the default applies.
    expect(
      connectorLimit(profiles, 1, NOW, { id: 8, startedAt: NOW }).limit?.chargingProfileId,
    ).toBe(1);
    expect(connectorLimit(profiles, 2, NOW).limit?.limit).toBe(4000);
    expect(connectorLimit(profiles, 2, NOW).limit?.chargingProfileId).toBe(2);
  });

  it('starts Relative schedules with the transaction, and caps the station with the ChargePointMaxProfile', () => {
    const profiles = install([
      [
        0,
        profile({
          chargingProfileId: 1,
          chargingProfileKind: 'Relative',
          chargingSchedule: {
            duration: 600,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }],
          },
        }),
      ],
      [0, profile({ chargingProfileId: 2, chargingProfilePurpose: 'ChargePointMaxProfile' })],
    ]);
    expect(connectorLimit(profiles, 1, NOW).limit).toBeUndefined();
    expect(connectorLimit(profiles, 1, NOW + 60_000, { startedAt: NOW }).limit?.limit).toBe(3000);
    expect(connectorLimit(profiles, 1, NOW + 700_000, { startedAt: NOW }).limit).toBeUndefined();
    expect(stationLimit(profiles, NOW).limit).toMatchObject({
      limit: 5000,
      purpose: 'ChargePointMaxProfile',
    });
  });

  it('converts amperes to watts with the phases in use', () => {
    const limit = {
      limit: 16,
      unit: 'A' as const,
      numberPhases: 3,
      chargingProfileId: 1,
      purpose: 'TxProfile' as const,
    };
    expect(toWatts(limit, { voltageV: 230, phases: 3 })).toBe(11040);
    expect(toWatts(limit, { voltageV: 230, phases: 1 })).toBe(3680);
    expect(toWatts({ ...limit, numberPhases: 1 }, { voltageV: 230, phases: 3 })).toBe(3680);
    expect(toWatts({ ...limit, unit: 'W', limit: 7000 }, { voltageV: 230, phases: 3 })).toBe(7000);
  });
});

describe('composite schedules', () => {
  const conversion = { voltageV: 230, phases: 3 };

  it('takes the minimum of the station and connector limits per interval, merging equal ones', () => {
    const profiles = install([
      [0, SPEC_DAILY],
      [
        0,
        profile({
          chargingProfileId: 2,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          chargingSchedule: {
            startSchedule: '2026-11-14T00:00:00Z',
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 8000 },
              { startPeriod: 18 * 3600, limit: 20000 },
            ],
          },
        }),
      ],
    ]);
    const schedule = compositeSchedule(profiles, {
      connectorId: 1,
      from: at('2026-11-14T06:00:00Z'),
      durationS: 24 * 3600,
      unit: 'W',
      conversion,
      ratingW: 22000,
      connectorIds: [1, 2],
    });
    expect(schedule).toEqual({
      duration: 86400,
      startSchedule: '2026-11-14T06:00:00.000Z',
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 8000 }, // station 8 kW below the default 11 kW
        { startPeriod: 2 * 3600, limit: 6000 }, // 08:00 default 6 kW
        { startPeriod: 14 * 3600, limit: 11000 }, // 20:00 default 11 kW, station now 20 kW
      ],
    });
  });

  it('reports amperes, the station total for connectorId 0, and the rating without profiles', () => {
    const profiles = install([
      [
        0,
        profile({
          chargingProfileId: 1,
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 6900 }],
          },
        }),
      ],
    ]);
    const base = { from: NOW, durationS: 3600, conversion, ratingW: 11040, connectorIds: [1, 2] };
    expect(
      compositeSchedule(profiles, { ...base, connectorId: 1, unit: 'A' }).chargingSchedulePeriod,
    ).toEqual([{ startPeriod: 0, limit: 10 }]);
    expect(
      compositeSchedule(profiles, { ...base, connectorId: 0, unit: 'W' }).chargingSchedulePeriod,
    ).toEqual([{ startPeriod: 0, limit: 13800 }]);
    expect(
      compositeSchedule([], { ...base, connectorId: 1, unit: 'W' }).chargingSchedulePeriod,
    ).toEqual([{ startPeriod: 0, limit: 11040 }]);
  });
});
