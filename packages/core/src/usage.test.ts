import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import {
  createUsageDriver,
  seededRandom,
  stationSeed,
  usageModel,
  usageProblems,
  UsageSchema,
  type UsageActions,
  type UsageEvent,
} from './usage.js';
import { validate } from './schema.js';

/** A fake station: two connectors whose cards are authorized unless they start with UNKNOWN-. */
function fakeStation(connectors = 2) {
  const plugged = new Map<number, string | undefined>();
  const transactions = new Set<number>();
  const authorized = new Set<number>();
  const log: string[] = [];
  const actions: UsageActions = {
    connectorIds: () => Array.from({ length: connectors }, (_, i) => i + 1),
    isFree: (c) => !plugged.has(c) && !authorized.has(c),
    plugIn: (c, ev) => {
      plugged.set(c, ev);
      if (authorized.delete(c)) transactions.add(c);
      log.push(`plug ${c}`);
    },
    unplug: (c) => {
      plugged.delete(c);
      transactions.delete(c);
      log.push(`unplug ${c}`);
    },
    presentIdTag: async (c, idTag) => {
      log.push(`card ${c}`);
      if (transactions.delete(c)) return 'stopping';
      if (idTag.startsWith('UNKNOWN-')) return 'other';
      if (plugged.has(c)) transactions.add(c);
      else authorized.add(c);
      return 'authorized';
    },
    isPluggedIn: (c) => plugged.has(c),
    hasTransaction: (c) => transactions.has(c),
  };
  return { actions, plugged, transactions, log };
}

/** Advances the manual clock in steps, letting promise callbacks run between timers. */
async function run(clock: ManualClock, ms: number): Promise<void> {
  const end = clock.now() + ms;
  for (;;) {
    const next = clock.nextTimerAt();
    if (next === undefined || next > end) break;
    clock.advance(next - clock.now());
    await Promise.resolve();
    await Promise.resolve();
  }
  clock.advance(end - clock.now());
}

const MODEL = usageModel({
  sessionsPerHour: 2,
  stay: { min: '10m', max: '40m' },
  evs: { a: 3, b: 1 },
  idTags: { prefix: 'LOAD-', count: 100, unknownShare: 0.1 },
  cardFirst: 0.3,
  stopBy: { card: 0.7, unplug: 0.3 },
});

function drive(seed: number, hours: number, connectors = 2) {
  const clock = new ManualClock(0);
  const station = fakeStation(connectors);
  const events: UsageEvent[] = [];
  const driver = createUsageDriver({
    clock,
    random: seededRandom(seed),
    model: MODEL,
    actions: station.actions,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  return { clock, station, events, driver, done: run(clock, hours * 3_600_000) };
}

describe('usage model', () => {
  it('validates definitions and fills in defaults', () => {
    expect(validate(UsageSchema, { sessionsPerHour: 1 }).ok).toBe(true);
    expect(usageModel({ sessionsPerHour: 1 })).toEqual({
      sessionsPerHour: 1,
      stayMs: { min: 1_200_000, max: 7_200_000 },
      evs: {},
      idTags: { prefix: 'LOAD-', count: 500, unknownShare: 0, unknownPrefix: 'UNKNOWN-' },
      cardFirst: 0.3,
      stopByCard: 0.7,
      stepMs: { min: 5_000, max: 30_000 },
    });
    expect(
      usageProblems({
        sessionsPerHour: 0,
        stay: { min: '1h', max: '10m' },
        cardFirst: 2,
        idTags: { count: 0.5 },
        stopBy: { card: 0, unplug: 0 },
        steps: { min: '0s', max: '1s' },
      }).map((issue) => issue.path),
    ).toEqual([
      '$.sessionsPerHour',
      '$.cardFirst',
      '$.idTags.count',
      '$.stay',
      '$.steps',
      '$.stopBy',
    ]);
  });

  it('gives the same sessions for the same seed, and different ones for other stations', async () => {
    const first = drive(42, 6);
    const second = drive(42, 6);
    const other = drive(stationSeed(1, 'LOAD-0002'), 6);
    await Promise.all([first.done, second.done, other.done]);
    expect(first.events.length).toBeGreaterThan(5);
    expect(second.events).toEqual(first.events);
    expect(other.events).not.toEqual(first.events);
    expect(stationSeed(1, 'LOAD-0001')).not.toBe(stationSeed(1, 'LOAD-0002'));
    expect(stationSeed(1, 'LOAD-0001')).toBe(stationSeed(1, 'LOAD-0001'));
  });

  it('runs sessions at the configured rate while connectors are free, with EV and card shares', async () => {
    // 2 sessions an hour while free, stays of 10 to 40 min (mean 25) plus steps
    // of 5 to 30 s: about 3600 / (1800 + 1540) = 1.08 sessions an hour per connector.
    const { events, done } = drive(7, 200);
    await done;
    const arrived = events.filter((e) => e.type === 'arrived');
    const perConnectorHour = arrived.length / 2 / 200;
    expect(perConnectorHour).toBeGreaterThan(0.9);
    expect(perConnectorHour).toBeLessThan(1.25);
    const share = (pick: (e: Extract<UsageEvent, { type: 'arrived' }>) => boolean) =>
      arrived.filter(pick).length / arrived.length;
    expect(share((e) => e.ev === 'a')).toBeGreaterThan(0.65);
    expect(share((e) => e.ev === 'a')).toBeLessThan(0.85);
    expect(share((e) => e.idTag.startsWith('UNKNOWN-'))).toBeGreaterThan(0.05);
    expect(share((e) => e.idTag.startsWith('UNKNOWN-'))).toBeLessThan(0.15);
    const refused = events.filter((e) => e.type === 'refused').length;
    expect(refused).toBe(arrived.filter((e) => e.idTag.startsWith('UNKNOWN-')).length);
    const left = events.filter(
      (e): e is Extract<UsageEvent, { type: 'left' }> => e.type === 'left',
    );
    expect(left.filter((e) => e.by === 'card').length / left.length).toBeGreaterThan(0.6);
    expect(left.filter((e) => e.by === 'card').length / left.length).toBeLessThan(0.8);
  });

  it('plays a session through: plug, card, stay, card again, unplug', async () => {
    const clock = new ManualClock(0);
    const station = fakeStation(1);
    const driver = createUsageDriver({
      clock,
      random: () => 0.5,
      model: usageModel({
        sessionsPerHour: 1,
        stay: { min: '10m', max: '10m' },
        cardFirst: 0,
        stopBy: { card: 1, unplug: 0 },
      }),
      actions: station.actions,
    });
    driver.start();
    // With every random number 0.5, drivers arrive 2,495 s apart (−ln 0.5 hours).
    await run(clock, 2 * 3_600_000);
    expect(station.log.slice(0, 5)).toEqual(['plug 1', 'card 1', 'card 1', 'unplug 1', 'plug 1']);
    driver.stop();
    const count = station.log.length;
    await run(clock, 10 * 3_600_000);
    expect(station.log).toHaveLength(count);
    expect(driver.running).toBe(false);
  });

  it('turns drivers away from a busy connector and picks a new stay after a restart', async () => {
    const clock = new ManualClock(0);
    const station = fakeStation(1);
    station.plugged.set(1, undefined);
    const events: UsageEvent[] = [];
    const driver = createUsageDriver({
      clock,
      random: seededRandom(3),
      model: usageModel({ sessionsPerHour: 6, stay: { min: '5m', max: '5m' } }),
      actions: station.actions,
      onEvent: (event) => events.push(event),
    });
    driver.start();
    // The cable from before the restart comes out after a stay.
    await run(clock, 5 * 60_000 + 1);
    expect(station.log[0]).toBe('unplug 1');
    station.plugged.set(1, undefined); // someone else plugs in by hand
    await run(clock, 3_600_000);
    expect(events.some((e) => e.type === 'turned-away')).toBe(true);
  });
});
