/**
 * Messages with guaranteed delivery (transaction messages, critical
 * security events): sent one at a time once the station is registered, kept
 * while offline, retried on failure with a growing wait, and saved across
 * restarts. When online and idle, a new message goes to the RPC layer at
 * once, so it leaves before later status reports. Shared by the charge
 * points of every OCPP version; what differs (ids filled in on sending,
 * failures not worth retrying) comes in through the options.
 */
import type { TimerHandle } from './clock.js';
import type { JsonObject } from './ocppj.js';
import type { CallFailure, RpcOutcome } from './rpc.js';
import type { StationTimers } from './station-timers.js';

/** A message waiting to be sent; kept across restarts. */
export interface OutboxEntry {
  key: string;
  action: string;
  payload: JsonObject;
  /** Local reference of the transaction the message belongs to. */
  txRef?: string;
  /** Failed attempts so far. */
  attempts: number;
}

export interface OutboxOptions {
  timers: StationTimers;
  /** Whether the station is registered, so messages may go out. */
  online(): boolean;
  /** Sends a CALL; undefined when there is no connection. */
  call(action: string, payload: JsonObject): Promise<RpcOutcome<unknown>> | undefined;
  /** Attempts per message and the retry interval in seconds, read when a message fails. */
  retryPolicy(): { attempts: number; intervalS: number };
  /** A fresh key for a new entry. */
  nextKey(): string;
  /** The payload to send now, or why the entry is dropped unsent. Default: the entry's payload. */
  prepare?(entry: OutboxEntry): { payload: JsonObject } | { drop: string };
  /** Why a failure ends the entry without retrying, if it does. */
  final?(entry: OutboxEntry, failure: CallFailure): string | undefined;
  /** An entry was answered, before it settles. */
  answered?(entry: OutboxEntry, payload: unknown): void;
  /** An entry left the queue, answered or not. */
  settled?(entry: OutboxEntry): void;
  log(message: string): void;
  changed(): void;
}

export interface Outbox {
  /** Queues a message; resolves with its outcome once it was answered, dropped or failed for good. */
  enqueue(action: string, payload: JsonObject, txRef?: string): Promise<RpcOutcome<unknown>>;
  /** Sends the next message if online and nothing is in flight or waiting to be retried. */
  pump(): void;
  /** Stops a pending retry wait (on disconnect); the next pump starts again. */
  pause(): void;
  /** Adds saved or synthesized entries at the end of the queue. */
  restore(entries: readonly OutboxEntry[]): void;
  readonly entries: readonly OutboxEntry[];
}

export function createOutbox(options: OutboxOptions): Outbox {
  const { timers } = options;
  const entries: OutboxEntry[] = [];
  const waiters = new Map<string, (outcome: RpcOutcome<unknown>) => void>();
  let pumping = false;
  let retryTimer: TimerHandle | undefined;

  function settle(entry: OutboxEntry, outcome: RpcOutcome<unknown>): void {
    if (entries[0] === entry) entries.shift();
    waiters.get(entry.key)?.(outcome);
    waiters.delete(entry.key);
    options.settled?.(entry);
    options.changed();
  }

  function pump(): void {
    if (pumping || retryTimer !== undefined || !options.online()) return;
    const entry = entries[0];
    if (entry === undefined) return;
    const prepared = options.prepare?.(entry) ?? { payload: entry.payload };
    if ('drop' in prepared) {
      options.log(`${entry.action} dropped: ${prepared.drop}`);
      settle(entry, { ok: false, failure: { kind: 'Closed' } });
      pump();
      return;
    }
    const sent = options.call(entry.action, prepared.payload);
    if (sent === undefined) return;
    pumping = true;
    void sent.then((outcome) => {
      pumping = false;
      if (!outcome.ok) {
        const { failure } = outcome;
        if (failure.kind === 'Closed') return; // resumes after the next accepted boot
        const final = options.final?.(entry, failure);
        if (final !== undefined) {
          options.log(`${entry.action} dropped: ${final}`);
        } else if (failure.kind !== 'InvalidRequest') {
          entry.attempts += 1;
          const policy = options.retryPolicy();
          if (entry.attempts < policy.attempts) {
            const delayMs = policy.intervalS * 1000 * entry.attempts;
            options.log(`${entry.action} failed (${failure.kind}); retrying in ${delayMs} ms`);
            options.changed();
            retryTimer = timers.later(delayMs, () => {
              retryTimer = undefined;
              pump();
            });
            return;
          }
          options.log(`${entry.action} dropped after ${entry.attempts} failed attempts`);
        }
      } else {
        options.answered?.(entry, outcome.payload);
      }
      settle(entry, outcome);
      pump();
    });
  }

  return {
    enqueue(action, payload, txRef) {
      const key = options.nextKey();
      entries.push({ key, action, payload, ...(txRef !== undefined && { txRef }), attempts: 0 });
      const promise = new Promise<RpcOutcome<unknown>>((resolve) => waiters.set(key, resolve));
      options.changed();
      pump();
      return promise;
    },
    pump,
    pause() {
      timers.stop(retryTimer);
      retryTimer = undefined;
    },
    restore(saved) {
      entries.push(...saved.map((entry) => ({ ...entry })));
    },
    entries,
  };
}
