/**
 * The timers of one station, on the injected clock. Every timer set and not
 * yet fired or stopped is tracked, so `halt()` stops them all at once and
 * none fires afterwards: a station the fleet replaces or removes keeps
 * nothing alive. Shared by the charge points of every OCPP version.
 */
import type { Clock, TimerHandle } from './clock.js';

export interface StationTimers {
  /** Runs `fn` after `delayMs`, unless the station has halted by then. */
  later(delayMs: number, fn: () => unknown): TimerHandle;
  /** Stops a timer; undefined is ignored. */
  stop(timer: TimerHandle | undefined): void;
  /** Resolves after `ms` (never, once halted). */
  delay(ms: number): Promise<void>;
  /** Stops every timer for good; later() still returns handles but they never fire. */
  halt(): void;
  readonly halted: boolean;
}

export function createStationTimers(clock: Clock): StationTimers {
  const timers = new Set<TimerHandle>();
  let halted = false;
  const later = (delayMs: number, fn: () => unknown): TimerHandle => {
    const handle: TimerHandle = clock.setTimer(delayMs, () => {
      timers.delete(handle);
      if (!halted) void fn();
    });
    timers.add(handle);
    return handle;
  };
  return {
    later,
    stop(timer) {
      if (timer === undefined) return;
      clock.clearTimer(timer);
      timers.delete(timer);
    },
    delay: (ms) => new Promise<void>((resolve) => later(ms, resolve)),
    halt() {
      halted = true;
      for (const timer of timers) clock.clearTimer(timer);
      timers.clear();
    },
    get halted() {
      return halted;
    },
  };
}
