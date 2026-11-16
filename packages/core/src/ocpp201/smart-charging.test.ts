import { describe, expect, it } from 'vitest';
import { compositeSchedule, installProfile, type InstalledProfile } from '../charging-profile.js';
import type { ChargingProfile } from '../ocpp16-messages.js';
import {
  clearProfiles201,
  compositeSchedule201,
  endTransactionProfiles201,
  installProfile201,
  limits201,
  selectProfiles201,
  type ChargingProfile201,
  type InstallContext201,
  type InstalledProfile201,
} from './smart-charging.js';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-15T10:00:00Z');
const H = 3_600_000;

const context = (transactions: Record<number, string> = {}): InstallContext201 => ({
  maxStackLevel: 10,
  maxPeriods: 24,
  maxInstalled: 20,
  units: ['A', 'W'],
  evseIds: [1, 2],
  transactionOn: (evseId) => transactions[evseId],
  now: NOW,
});

function profile(
  overrides: Partial<ChargingProfile201> & Pick<ChargingProfile201, 'id'>,
  limit = 5000,
): ChargingProfile201 {
  return {
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: [
      {
        id: 1,
        startSchedule: new Date(NOW).toISOString(),
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit }],
      },
    ],
    ...overrides,
  };
}

function install(entries: [number, ChargingProfile201][], ctx = context()): InstalledProfile201[] {
  let profiles: InstalledProfile201[] = [];
  for (const [evseId, p] of entries) {
    const result = installProfile201(profiles, evseId, p, ctx);
    expect(result.status, result.status === 'Rejected' ? result.reason : '').toBe('Accepted');
    if (result.status === 'Accepted') profiles = result.profiles;
  }
  return profiles;
}

const rejected = (
  profiles: InstalledProfile201[],
  evseId: number,
  p: ChargingProfile201,
  ctx = context(),
) => {
  const result = installProfile201(profiles, evseId, p, ctx);
  return result.status === 'Rejected' ? result.reason : undefined;
};

describe('2.0.1 SetChargingProfile rules (K01)', () => {
  it('checks the EVSE, the purpose and the transaction', () => {
    expect(rejected([], 3, profile({ id: 1 }))).toBe('unknown EVSE 3');
    expect(
      rejected(
        [],
        0,
        profile({ id: 1, chargingProfilePurpose: 'ChargingStationExternalConstraints' }),
      ),
    ).toMatch(/external system/);
    expect(
      rejected([], 1, profile({ id: 1, chargingProfilePurpose: 'ChargingStationMaxProfile' })),
    ).toMatch(/evseId 0/);
    expect(
      rejected(
        [],
        0,
        profile({
          id: 1,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Relative',
        }),
      ),
    ).toMatch(/Relative/);
    const tx = profile({ id: 1, chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' });
    expect(rejected([], 0, tx)).toMatch(/on an EVSE/);
    expect(rejected([], 1, tx)).toBe('no transaction on EVSE 1');
    expect(rejected([], 1, tx, context({ 1: 'tx-9' }))).toMatch(/tx-1 is not running/);
    expect(
      rejected([], 1, { ...tx, transactionId: undefined } as never, context({ 1: 'tx-1' })),
    ).toMatch(/needs a transactionId/);
    expect(install([[1, tx]], context({ 1: 'tx-1' }))).toHaveLength(1);
  });

  it('checks the stack level, the schedules, the unit and the periods', () => {
    expect(rejected([], 1, profile({ id: 1, stackLevel: 11 }))).toMatch(/ProfileStackLevel 10/);
    const base = profile({ id: 1 });
    const [schedule] = base.chargingSchedule;
    if (schedule === undefined) throw new Error('no schedule');
    expect(
      rejected([], 1, { ...base, chargingSchedule: [schedule, { ...schedule, id: 2 }] }),
    ).toMatch(/only one chargingSchedule/);
    expect(
      rejected([], 1, { ...base, chargingSchedule: [schedule] }, { ...context(), units: ['A'] }),
    ).toMatch(/chargingRateUnit W/);
    expect(
      rejected([], 1, {
        ...base,
        chargingSchedule: [
          { ...schedule, chargingSchedulePeriod: [{ startPeriod: 10, limit: 1 }] },
        ],
      }),
    ).toMatch(/start at 0/);
  });

  it('replaces the same id and refuses a conflicting stack level', () => {
    const first = install([[1, profile({ id: 1 })]]);
    // Same id: replaced, also on another EVSE (K01.FR.05).
    const replaced = installProfile201(first, 2, profile({ id: 1 }, 3000), context());
    expect(replaced.status).toBe('Accepted');
    if (replaced.status === 'Accepted') expect(replaced.profiles.map((p) => p.evseId)).toEqual([2]);
    // Same stackLevel and purpose on the same EVSE with overlapping validity (K01.FR.06).
    expect(rejected(first, 1, profile({ id: 2 }))).toMatch(/profile 1 has the same stackLevel/);
    // Validity periods apart: fine.
    const later = install([
      [1, profile({ id: 1, validTo: new Date(NOW + H).toISOString() })],
      [1, profile({ id: 2, validFrom: new Date(NOW + H).toISOString() })],
    ]);
    expect(later).toHaveLength(2);
  });
});

describe('2.0.1 ClearChargingProfile, GetChargingProfiles and TxProfiles', () => {
  const profiles = install(
    [
      [0, profile({ id: 1, chargingProfilePurpose: 'ChargingStationMaxProfile' }, 20_000)],
      [0, profile({ id: 2, stackLevel: 1 })],
      [1, profile({ id: 3 })],
      [2, profile({ id: 4, stackLevel: 2 })],
      [1, profile({ id: 5, chargingProfilePurpose: 'TxProfile', transactionId: 'tx-1' })],
    ],
    context({ 1: 'tx-1' }),
  );

  it('clears by id or by criteria, Unknown when nothing matches (K10)', () => {
    expect(clearProfiles201(profiles, { chargingProfileId: 4 }).profiles).toHaveLength(4);
    expect(clearProfiles201(profiles, { chargingProfileId: 99 }).status).toBe('Unknown');
    const byCriteria = clearProfiles201(profiles, {
      chargingProfileCriteria: { evseId: 0, chargingProfilePurpose: 'ChargingStationMaxProfile' },
    });
    expect(byCriteria.profiles.map((p) => p.profile.id)).toEqual([2, 3, 4, 5]);
    expect(clearProfiles201(profiles, { chargingProfileCriteria: { stackLevel: 7 } }).status).toBe(
      'Unknown',
    );
  });

  it('selects by EVSE and criteria (K09.FR.04 to .06)', () => {
    const ids = (request: Parameters<typeof selectProfiles201>[1]) =>
      selectProfiles201(profiles, request).map((p) => p.profile.id);
    expect(ids({ requestId: 1, chargingProfile: {} })).toEqual([1, 2, 3, 4, 5]);
    expect(ids({ requestId: 1, evseId: 0, chargingProfile: {} })).toEqual([1, 2]);
    expect(
      ids({ requestId: 1, evseId: 1, chargingProfile: { chargingProfilePurpose: 'TxProfile' } }),
    ).toEqual([5]);
    expect(ids({ requestId: 1, chargingProfile: { chargingProfileId: [2, 4] } })).toEqual([2, 4]);
    expect(ids({ requestId: 1, chargingProfile: { stackLevel: 1 } })).toEqual([2]);
    expect(ids({ requestId: 1, chargingProfile: { chargingLimitSource: ['EMS'] } })).toEqual([]);
  });

  it('drops the TxProfiles of an EVSE when its transaction ends', () => {
    expect(endTransactionProfiles201(profiles, 1).map((p) => p.profile.id)).toEqual([1, 2, 3, 4]);
  });

  it('limits an EVSE by its TxProfile over its TxDefaultProfile, and the station by its max profile', () => {
    const limits = limits201(profiles, 1, NOW, { startedAt: NOW });
    expect(limits.own.limit).toMatchObject({ limit: 5000, chargingProfileId: 5 });
    expect(limits.station.limit).toMatchObject({ limit: 20_000, purpose: 'ChargePointMaxProfile' });
  });
});

describe('2.0.1 composite schedules match 1.6 for equivalent profiles', () => {
  /** The same profile in 1.6 terms. */
  const as16 = (p: ChargingProfile201): ChargingProfile => {
    const [schedule] = p.chargingSchedule;
    if (schedule === undefined) throw new Error('no schedule');
    return {
      chargingProfileId: p.id,
      stackLevel: p.stackLevel,
      chargingProfilePurpose:
        p.chargingProfilePurpose === 'ChargingStationMaxProfile'
          ? 'ChargePointMaxProfile'
          : (p.chargingProfilePurpose as 'TxDefaultProfile'),
      chargingProfileKind: p.chargingProfileKind as 'Absolute' | 'Recurring' | 'Relative',
      ...(p.recurrencyKind !== undefined && { recurrencyKind: p.recurrencyKind }),
      ...(p.validFrom !== undefined && { validFrom: p.validFrom }),
      ...(p.validTo !== undefined && { validTo: p.validTo }),
      chargingSchedule: {
        chargingRateUnit: schedule.chargingRateUnit,
        chargingSchedulePeriod: schedule.chargingSchedulePeriod as never,
        ...(schedule.startSchedule !== undefined && { startSchedule: schedule.startSchedule }),
        ...(schedule.duration !== undefined && { duration: schedule.duration }),
      },
    };
  };
  const entries: [number, ChargingProfile201][] = [
    [
      0,
      profile({
        id: 1,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingSchedule: [
          {
            id: 1,
            startSchedule: new Date(NOW).toISOString(),
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 32 },
              { startPeriod: 1800, limit: 16 },
            ],
          },
        ],
      }),
    ],
    [
      0,
      profile({
        id: 2,
        chargingProfileKind: 'Recurring',
        recurrencyKind: 'Daily',
        chargingSchedule: [
          {
            id: 1,
            startSchedule: '2026-11-15T00:00:00Z',
            duration: 86_400,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 11_000 },
              { startPeriod: 37_800, limit: 6000 },
              { startPeriod: 72_000, limit: 11_000 },
            ],
          },
        ],
      }),
    ],
    [1, profile({ id: 3, stackLevel: 1, validTo: new Date(NOW + 2 * H).toISOString() }, 4000)],
  ];

  it.each([
    [0, 'W'],
    [1, 'W'],
    [1, 'A'],
    [2, 'W'],
  ] as const)('EVSE %i in %s', (evseId, unit) => {
    const profiles201 = install(entries);
    let profiles16: InstalledProfile[] = [];
    for (const [connectorId, p] of entries) {
      const result = installProfile(profiles16, connectorId, as16(p), {
        maxStackLevel: 10,
        maxPeriods: 24,
        maxInstalled: 20,
        allowedUnits: ['A', 'W'],
        connectorIds: [1, 2],
        transactionId: () => undefined,
        now: NOW,
      });
      expect(result.status).toBe('Accepted');
      profiles16 = result.profiles;
    }
    const request = {
      from: NOW,
      durationS: 6 * 3600,
      unit,
      conversion: { voltageV: 230, phases: 3 },
      ratingW: evseId === 0 ? 22_080 : 11_040,
      transaction: () => ({ startedAt: NOW }),
    };
    const v16 = compositeSchedule(profiles16, {
      ...request,
      connectorId: evseId,
      connectorIds: [1, 2],
    });
    const v201 = compositeSchedule201(profiles201, { ...request, evseId, evseIds: [1, 2] });
    expect(v201).toEqual({
      evseId,
      duration: v16.duration,
      scheduleStart: v16.startSchedule,
      chargingRateUnit: v16.chargingRateUnit,
      chargingSchedulePeriod: v16.chargingSchedulePeriod,
    });
    expect(v201.chargingSchedulePeriod.length).toBeGreaterThan(1);
  });
});
