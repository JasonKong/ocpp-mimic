import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';

describe('ManualClock', () => {
  it('fires due timers in time order and moves now with them', () => {
    const clock = new ManualClock(1_000);
    const fired: Array<[string, number]> = [];
    clock.setTimer(300, () => fired.push(['b', clock.now()]));
    clock.setTimer(100, () => fired.push(['a', clock.now()]));
    clock.setTimer(900, () => fired.push(['late', clock.now()]));

    clock.advance(500);

    expect(fired).toEqual([
      ['a', 1_100],
      ['b', 1_300],
    ]);
    expect(clock.now()).toBe(1_500);
  });

  it('fires timers due at the same moment in the order they were set', () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimer(10, () => fired.push('first'));
    clock.setTimer(10, () => fired.push('second'));

    clock.advance(10);

    expect(fired).toEqual(['first', 'second']);
  });

  it('does not fire a cleared timer', () => {
    const clock = new ManualClock();
    let fired = false;
    const handle = clock.setTimer(10, () => {
      fired = true;
    });

    clock.clearTimer(handle);
    clock.advance(20);

    expect(fired).toBe(false);
  });

  it('fires a timer set by a callback when it falls due in the same advance', () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    clock.setTimer(10, () => {
      fired.push(clock.now());
      clock.setTimer(10, () => fired.push(clock.now()));
    });

    clock.advance(25);

    expect(fired).toEqual([10, 20]);
  });
});
