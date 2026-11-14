import { describe, expect, it } from 'vitest';
import {
  expandIdPattern,
  nameProblem,
  parseRampUp,
  rampUpDelays,
  tagsProblem,
} from './fleet-template.js';

describe('expandIdPattern', () => {
  it('counts from the digits in braces, keeping their width', () => {
    expect(expandIdPattern('SIM-{0001}', 3)).toEqual({
      ok: true,
      ids: ['SIM-0001', 'SIM-0002', 'SIM-0003'],
    });
    expect(expandIdPattern('SIM-{1001}', 2)).toEqual({ ok: true, ids: ['SIM-1001', 'SIM-1002'] });
    expect(expandIdPattern('{9}-AC', 2)).toEqual({ ok: true, ids: ['9-AC', '10-AC'] });
  });

  it('needs exactly one counter, a sensible count and usable ids', () => {
    expect(expandIdPattern('SIM', 2)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM-{1}-{1}', 2)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM-{x}', 2)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM-{1}}', 2)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM-{1}', 0)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM-{1}', 10_001)).toMatchObject({ ok: false });
    expect(expandIdPattern('SIM/{1}', 1)).toMatchObject({ ok: false });
    expect(expandIdPattern(`${'X'.repeat(48)}{1}`, 1)).toMatchObject({ ok: false });
  });
});

describe('tags and groups', () => {
  it('accepts short names of letters, digits, dot, underscore and dash', () => {
    expect(nameProblem('ac_22.v-2', 'the group')).toBeUndefined();
    expect(nameProblem('two words', 'the group')).toMatch(/the group must be/);
    expect(nameProblem('', 'the group')).toBeDefined();
    expect(tagsProblem(['ac', 'busy'])).toBeUndefined();
    expect(tagsProblem('ac')).toBeDefined();
    expect(tagsProblem(['ac', 'ac'])).toBe('tags must not repeat');
    expect(tagsProblem(Array.from({ length: 11 }, (_, i) => `t${i}`))).toBe('at most 10 tags');
  });
});

describe('ramp-up', () => {
  it('spreads starts over slots of 1 / rate seconds, jittered within the slot', () => {
    expect(rampUpDelays(4, { rate: 10, jitter: 0 }, () => 0.5)).toEqual([0, 100, 200, 300]);
    expect(rampUpDelays(3, { rate: 10, jitter: 0.5 }, () => 1)).toEqual([50, 150, 250]);
    expect(rampUpDelays(3, false, () => 1)).toEqual([0, 0, 0]);
  });

  it('parses false, defaults and limits', () => {
    expect(parseRampUp(undefined)).toEqual({ ok: true, ramp: { rate: 20, jitter: 0.5 } });
    expect(parseRampUp(false)).toEqual({ ok: true, ramp: false });
    expect(parseRampUp({ rate: 5 })).toEqual({ ok: true, ramp: { rate: 5, jitter: 0.5 } });
    expect(parseRampUp({ rate: 0 })).toMatchObject({ ok: false });
    expect(parseRampUp({ jitter: 2 })).toMatchObject({ ok: false });
    expect(parseRampUp({ speed: 1 })).toMatchObject({ ok: false });
    expect(parseRampUp(true)).toMatchObject({ ok: false });
  });
});
