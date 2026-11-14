/**
 * Real-time implementations of core's injected dependencies: the clock and
 * the uniqueId generator. One clock instance is shared by every charge point
 * in the engine.
 */
import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator, TimerHandle } from '@ocpp-mimic/core';

export function createSystemClock(): Clock {
  const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
  let nextHandle = 1;
  return {
    now: () => Date.now(),
    setTimer(delayMs, callback) {
      const handle = nextHandle++;
      const timer = setTimeout(
        () => {
          timers.delete(handle);
          callback();
        },
        Math.max(0, delayMs),
      );
      // Simulation timers (heartbeats, meter samples, reconnects) never keep the
      // process alive on their own: `serve` stays up through its HTTP server, and
      // `run` must exit once its scenarios are done.
      timer.unref();
      timers.set(handle, timer);
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
