/**
 * Real-time implementations of core's injected dependencies: the clock and
 * the uniqueId generator. One clock instance is shared by every charge point
 * in the engine.
 */
import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator, TimerHandle } from '@ocpp-mimic/core';

/** setTimeout's largest delay (about 24.8 days); longer delays would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

export function createSystemClock(): Clock {
  const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
  let nextHandle = 1;

  /** Arms a timer, in steps of at most MAX_TIMER_MS for long delays. */
  function arm(handle: TimerHandle, dueAt: number, callback: () => void): void {
    const delay = Math.max(0, dueAt - Date.now());
    const timer = setTimeout(
      () => {
        if (dueAt > Date.now()) {
          arm(handle, dueAt, callback);
          return;
        }
        timers.delete(handle);
        callback();
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    // Simulation timers (heartbeats, meter samples, reconnects) never keep the
    // process alive on their own: `serve` stays up through its HTTP server, and
    // `run` must exit once its scenarios are done.
    timer.unref();
    timers.set(handle, timer);
  }

  return {
    now: () => Date.now(),
    setTimer(delayMs, callback) {
      const handle = nextHandle++;
      arm(handle, Date.now() + Math.max(0, delayMs), callback);
      return handle;
    },
    clearTimer(handle) {
      const timer = timers.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(handle);
    },
  };
}

/** Random UUIDs: 36 characters, the OCPP-J maximum for a uniqueId. */
export const randomIds: IdGenerator = () => randomUUID();
