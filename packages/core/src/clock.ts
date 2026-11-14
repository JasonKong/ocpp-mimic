/** Opaque handle returned by {@link Clock.setTimer}. */
export type TimerHandle = number;

/**
 * Time source injected into core logic. Core never reads the system clock or
 * schedules timers itself, so the same logic runs under the engine's real
 * scheduler and under {@link ManualClock} in tests and replays.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimer(delayMs: number, callback: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

interface PendingTimer {
  at: number;
  callback: () => void;
}

/** A clock that only moves when told to, for deterministic tests and replays. */
export class ManualClock implements Clock {
  #now: number;
  #nextHandle = 1;
  readonly #timers = new Map<TimerHandle, PendingTimer>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, callback: () => void): TimerHandle {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + Math.max(0, delayMs), callback });
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    this.#timers.delete(handle);
  }

  /** When the earliest pending timer falls due, or undefined without timers. */
  nextTimerAt(): number | undefined {
    let earliest: number | undefined;
    for (const { at } of this.#timers.values()) {
      if (earliest === undefined || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way in
   * time order (timers due at the same moment fire in the order they were set).
   * Timers set by a callback fire in the same call if they fall due in range.
   */
  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      let due: [TimerHandle, PendingTimer] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) {
          due = entry;
        }
      }
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].callback();
    }
    this.#now = target;
  }
}
