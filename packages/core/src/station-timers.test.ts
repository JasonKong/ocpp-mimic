import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { createStationTimers } from './station-timers.js';

describe('station timers', () => {
  it('run, stop, and stop for good on halt', async () => {
    const clock = new ManualClock();
    const timers = createStationTimers(clock);
    const fired: string[] = [];
    timers.later(10, () => fired.push('a'));
    const b = timers.later(20, () => fired.push('b'));
    timers.later(30, () => fired.push('c'));
    timers.stop(b);
    timers.stop(undefined);
    clock.advance(10);
    expect(fired).toEqual(['a']);
    let waited = false;
    void timers.delay(5).then(() => (waited = true));
    clock.advance(5);
    await Promise.resolve();
    expect(waited).toBe(true);
    timers.halt();
    expect(timers.halted).toBe(true);
    timers.later(1, () => fired.push('after halt'));
    clock.advance(100);
    expect(fired).toEqual(['a']);
  });
});
