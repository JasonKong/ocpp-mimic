import { describe, expect, it } from 'vitest';
import { INJECTION_TYPES, parseInjection } from './injections.js';

describe('fault injections', () => {
  it('parses each type with its defaults and a duration', () => {
    expect(parseInjection({ type: 'latency', ms: '2s', for: '30s' })).toEqual({
      ok: true,
      request: { injection: { type: 'latency', ms: 2000, direction: 'both' }, forMs: 30_000 },
    });
    expect(parseInjection({ type: 'flap', down: 500, up: '1s' })).toEqual({
      ok: true,
      request: { injection: { type: 'flap', downMs: 500, upMs: 1000, times: 1 } },
    });
    expect(parseInjection({ type: 'callError', action: 'Reset', station: 'CP-1' })).toEqual({
      ok: true,
      request: { injection: { type: 'callError', errorCode: 'InternalError', action: 'Reset' } },
    });
    expect(parseInjection({ type: 'malformedJson' })).toMatchObject({
      request: { injection: { type: 'malformedJson', count: 1 } },
    });
    expect(parseInjection({ type: 'powerLoss', off: '10s', times: 3 })).toEqual({
      ok: true,
      request: { injection: { type: 'powerLoss', offMs: 10_000, onMs: 5000, times: 3 } },
    });
    expect(parseInjection({ type: 'meterRollback', wh: 500 })).toMatchObject({
      request: { injection: { type: 'meterRollback', wh: 500, connector: 1 } },
    });
    expect(parseInjection({ type: 'clockDrift', ms: -90_000 })).toMatchObject({
      request: { injection: { type: 'clockDrift', ms: -90_000 } },
    });
    expect(INJECTION_TYPES).toHaveLength(16);
  });

  it('reports unknown types and bad parameters with their path', () => {
    const problems = (value: unknown) => {
      const parsed = parseInjection(value, '$.steps[0].inject');
      return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(problems({ type: 'meltdown' })[0]).toMatch(
      /^\$\.steps\[0\]\.inject\.type: must be one of latency/,
    );
    expect(problems({ type: 'drop', direction: 'sideways', probability: 2 })).toEqual([
      expect.stringMatching(/\.direction: /),
      expect.stringMatching(/\.probability: not between 0 and 1/),
    ]);
    expect(problems({ type: 'latency' })).toEqual([
      expect.stringMatching(/\.ms: missing required property/),
    ]);
    expect(problems({ type: 'outOfOrder', count: 2 })).toEqual([
      expect.stringMatching(/unexpected property|count/),
    ]);
    expect(problems({ type: 'noAnswer', for: 'later' })[0]).toMatch(/\.for: not a duration/);
    expect(problems('drop')).toEqual(['$.steps[0].inject: expected a map']);
  });
});
