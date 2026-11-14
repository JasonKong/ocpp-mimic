import { describe, expect, it } from 'vitest';
import { parseBytes, parseLoadPlan, parseShare, selectStations } from './load-plan.js';
import { seededRandom } from './usage.js';

const PLAN = {
  name: 'Two groups',
  csms: 'ws://127.0.0.1:9100/ocpp',
  seed: 7,
  duration: '60m',
  rampUp: { rate: 10, jitter: 0.5 },
  groups: [
    { name: 'ac', count: 3, id: 'AC-{01}', persona: 'load-ac-1.6', tags: ['ac'] },
    {
      name: 'busy',
      count: 2,
      id: 'BUSY-{1}',
      persona: 'load-ac-1.6',
      usage: { sessionsPerHour: 4 },
      config: { HeartbeatInterval: 30 },
    },
  ],
  events: [
    {
      at: '45m',
      inject: { type: 'powerLoss', off: '30s' },
      stations: { share: '40%', group: 'ac' },
    },
    { at: '30m', reconnectStorm: {} },
  ],
  thresholds: {
    bootAcceptedWithin: '60s',
    recoverWithin: '2m',
    unexpectedDisconnects: 0,
    lateWork: { p99: '1s', max: '5s' },
    csmsLatency: { p95: '1s' },
    timeouts: 0,
    callErrors: 0,
    schemaViolations: 0,
    eventLoopDelay: { p99: '100ms' },
    memory: { rss: '2GB', heapGrowth: '10%' },
    sessions: { min: 0.8 },
  },
};

describe('load plans', () => {
  it('parses groups, events in time order and thresholds', () => {
    const parsed = parseLoadPlan(PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { plan } = parsed;
    expect(plan).toMatchObject({
      name: 'Two groups',
      seed: 7,
      durationMs: 3_600_000,
      rampUp: { rate: 10, jitter: 0.5 },
    });
    expect(plan.groups).toEqual([
      {
        name: 'ac',
        ids: ['AC-01', 'AC-02', 'AC-03'],
        persona: 'load-ac-1.6',
        tags: ['ac'],
        usage: true,
      },
      {
        name: 'busy',
        ids: ['BUSY-1', 'BUSY-2'],
        persona: 'load-ac-1.6',
        tags: [],
        usage: { sessionsPerHour: 4 },
        config: { HeartbeatInterval: '30' },
      },
    ]);
    expect(plan.events.map((e) => [e.atMs, e.kind])).toEqual([
      [1_800_000, 'reconnectStorm'],
      [2_700_000, 'inject'],
    ]);
    expect(plan.events[1]).toMatchObject({
      stations: { share: 0.4, group: 'ac' },
      request: { injection: { type: 'powerLoss', offMs: 30_000 } },
    });
    expect(plan.thresholds).toEqual({
      bootAcceptedWithinMs: 60_000,
      recoverWithinMs: 120_000,
      unexpectedDisconnects: 0,
      lateWork: { p99Ms: 1000, maxMs: 5000 },
      csmsLatency: { p95Ms: 1000 },
      timeouts: 0,
      callErrors: 0,
      schemaViolations: 0,
      eventLoopDelay: { p99Ms: 100 },
      memory: { rssBytes: 2 * 1024 ** 3, heapGrowth: 0.1 },
      sessions: { min: 0.8 },
    });
  });

  it('reports problems with paths', () => {
    const bad = (changes: Record<string, unknown>) => {
      const parsed = parseLoadPlan({ ...PLAN, ...changes });
      return parsed.ok ? [] : parsed.issues.map((i) => i.path);
    };
    expect(bad({ csms: 'http://x' })).toEqual(['$.csms']);
    expect(bad({ rampUp: { rate: 0 } })).toEqual(['$.rampUp']);
    expect(bad({ groups: [] })).toContain('$.groups');
    expect(
      bad({
        groups: [
          { name: 'a', count: 2, id: 'X-{1}', persona: 'p' },
          { name: 'a', count: 2, id: 'X-{2}', persona: 'p' },
        ],
        events: [],
      }),
    ).toEqual(['$.groups[1].name', '$.groups[1].id']);
    expect(bad({ events: [{ at: '2h', reconnectStorm: {} }] })).toEqual(['$.events[0].at']);
    expect(bad({ events: [{ at: '1m', explode: {} }] })).toEqual(['$.events[0]']);
    expect(
      bad({ events: [{ at: '1m', reconnectStorm: {}, stations: { group: 'none' } }] }),
    ).toEqual(['$.events[0].stations.group']);
    expect(bad({ events: [{ at: '1m', inject: { type: 'nope' } }] })).toEqual([
      '$.events[0].inject.type',
    ]);
    expect(bad({ thresholds: { memory: { rss: 'lots' } } })).toEqual(['$.thresholds.memory.rss']);
  });

  it('parses sizes and shares', () => {
    expect(parseBytes('512MB')).toBe(512 * 1024 * 1024);
    expect(parseBytes('2gb')).toBe(2 * 1024 ** 3);
    expect(parseBytes('lots')).toBeUndefined();
    expect(parseShare('5%')).toBe(0.05);
    expect(parseShare(0.3)).toBe(0.3);
    expect(parseShare('150%')).toBeUndefined();
  });

  it('selects stations by group, tag, share and count, repeatably for a seed', () => {
    const parsed = parseLoadPlan(PLAN);
    if (!parsed.ok) throw new Error('plan does not parse');
    const { plan } = parsed;
    expect(selectStations(plan, {}, seededRandom(1))).toHaveLength(5);
    expect(selectStations(plan, { tag: 'ac' }, seededRandom(1))).toEqual([
      'AC-01',
      'AC-02',
      'AC-03',
    ]);
    const share = selectStations(plan, { share: 0.4 }, seededRandom(1));
    expect(share).toHaveLength(2);
    expect(selectStations(plan, { share: 0.4 }, seededRandom(1))).toEqual(share);
    expect(selectStations(plan, { count: 1, group: 'busy' }, seededRandom(2))).toHaveLength(1);
  });
});
