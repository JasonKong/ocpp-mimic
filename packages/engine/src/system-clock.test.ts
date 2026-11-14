import { describe, expect, it } from 'vitest';
import { createSystemClock, randomIds } from './system-clock.js';

describe('system clock', () => {
  it('fires timers in real time and can cancel them', async () => {
    const clock = createSystemClock();
    const fired: string[] = [];
    clock.setTimer(10, () => fired.push('a'));
    const cancelled = clock.setTimer(10, () => fired.push('b'));
    clock.clearTimer(cancelled);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toEqual(['a']);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(5);
  });

  it('does not keep the process alive with its timers', () => {
    const spy = { ref: true };
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const timer = original(fn, ms);
      const unref = timer.unref.bind(timer);
      timer.unref = () => {
        spy.ref = false;
        return unref();
      };
      return timer;
    }) as typeof setTimeout;
    try {
      const clock = createSystemClock();
      clock.clearTimer(clock.setTimer(1000, () => {}));
    } finally {
      globalThis.setTimeout = original;
    }
    expect(spy.ref).toBe(false);
  });

  it('does not fire timers longer than setTimeout allows at once', async () => {
    const clock = createSystemClock();
    let fired = false;
    // 2099 is far beyond setTimeout's 24.8-day limit, which would fire after 1 ms.
    const handle = clock.setTimer(Date.parse('2099-01-01T00:00:00Z') - Date.now(), () => {
      fired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(false);
    clock.clearTimer(handle);
  });

  it('generates 36-character unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomIds()));
    expect(ids.size).toBe(100);
    expect([...ids].every((id) => id.length === 36)).toBe(true);
  });
});
