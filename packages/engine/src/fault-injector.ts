/**
 * Fault Injector: sits on a station's wire, between the charge point and its
 * transport, and changes, delays, drops or adds frames as the active
 * injections say. Frames it touches are reported with the injection's type,
 * so the message log can show them and the OCA schema check can skip them.
 */
import {
  MessageTypeId,
  parseFrame,
  serializeFrame,
  type Frame,
  type Injection,
  type InjectionRequest,
} from '@ocpp-mimic/core';

export type WireDirection = 'cp-to-csms' | 'csms-to-cp';

export interface ActiveInjection {
  id: string;
  injection: Injection;
  /** When it ends (ISO 8601), for injections with a duration. */
  until?: string;
  /** Frames it still affects, for counted injections. */
  remaining?: number;
}

export interface FaultInjectorOptions {
  /** Puts a frame on the wire to the CSMS; `injected` names the injection that changed or made it. */
  toCsms(text: string, injected?: string): void;
  /** Hands a frame from the CSMS to the charge point. */
  toChargePoint(text: string): void;
  /** A frame the injector kept from the other side (dropped, or a CALL left unanswered). */
  swallowed(direction: WireDirection, text: string, injected: string): void;
  goOffline(): void;
  goOnline(): void;
  /** The list of active injections changed. */
  onChange?: () => void;
  random?: () => number;
}

export interface FaultInjector {
  add(request: InjectionRequest): ActiveInjection;
  /** Ends every injection; a flapping connection comes back up. */
  clear(): void;
  list(): ActiveInjection[];
  /** A frame from the charge point to the CSMS. */
  outgoing(text: string): void;
  /** A frame from the CSMS to the charge point. */
  incoming(text: string): void;
}

interface Entry extends ActiveInjection {
  timers: ReturnType<typeof setTimeout>[];
}

/** How long a frame held for `outOfOrder` waits for a frame to swap with. */
const HOLD_MS = 1000;

export function createFaultInjector(options: FaultInjectorOptions): FaultInjector {
  const random = options.random ?? Math.random;
  const entries: Entry[] = [];
  let nextId = 0;
  /** The last CALL the charge point sent, for `duplicateId`. */
  let lastCallId: string | undefined;
  /** uniqueId the CSMS will answer with → the charge point's own, after a `duplicateId`. */
  const renamed = new Map<string, string>();
  let held: { text: string; injected?: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Per direction, when the last delayed frame is due, so delays keep the order. */
  const due: Record<WireDirection, number> = { 'cp-to-csms': 0, 'csms-to-cp': 0 };
  let offlineByFlap = false;

  function remove(entry: Entry): void {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    entry.timers.forEach(clearTimeout);
    options.onChange?.();
    if (entry.injection.type === 'flap' && offlineByFlap) {
      offlineByFlap = false;
      options.goOnline();
    }
  }

  /** The first active injection of `type` that `matches`; counted ones are used up. */
  function take<T extends Injection['type']>(
    type: T,
    matches: (injection: Extract<Injection, { type: T }>) => boolean = () => true,
  ): Extract<Injection, { type: T }> | undefined {
    for (const entry of entries) {
      if (entry.injection.type !== type) continue;
      const injection = entry.injection as Extract<Injection, { type: T }>;
      if (!matches(injection)) continue;
      if (entry.remaining !== undefined) {
        entry.remaining -= 1;
        if (entry.remaining <= 0) remove(entry);
      }
      return injection;
    }
    return undefined;
  }

  const callOf = (frame: Frame | undefined, action: string | undefined) =>
    frame?.type === MessageTypeId.Call && (action === undefined || frame.action === action);

  function latencyFor(direction: WireDirection): number {
    const wanted = direction === 'cp-to-csms' ? 'sent' : 'received';
    return entries
      .map((e) => e.injection)
      .filter((i) => i.type === 'latency' && (i.direction === 'both' || i.direction === wanted))
      .reduce((total, i) => total + (i.type === 'latency' ? i.ms : 0), 0);
  }

  /** Runs `deliver` after the direction's latency, keeping the frames in order. */
  function later(direction: WireDirection, deliver: () => void): void {
    const ms = latencyFor(direction);
    if (ms === 0 && due[direction] <= Date.now()) {
      deliver();
      return;
    }
    const at = Math.max(Date.now() + ms, due[direction]);
    due[direction] = at;
    setTimeout(deliver, at - Date.now());
  }

  function dropped(direction: WireDirection, frame: Frame | undefined): boolean {
    const wanted = direction === 'cp-to-csms' ? 'sent' : 'received';
    const drop = take('drop', (i) => {
      if (i.direction !== wanted) return false;
      if (i.action !== undefined && !callOf(frame, i.action)) return false;
      return random() < (i.probability ?? 1);
    });
    return drop !== undefined;
  }

  function send(text: string, injected?: string): void {
    later('cp-to-csms', () => options.toCsms(text, injected));
  }

  function flap(entry: Entry, injection: Extract<Injection, { type: 'flap' }>): void {
    let cycle = 0;
    const down = () => {
      offlineByFlap = true;
      options.goOffline();
      entry.timers.push(setTimeout(up, injection.downMs));
    };
    const up = () => {
      offlineByFlap = false;
      options.goOnline();
      cycle += 1;
      if (cycle < injection.times) entry.timers.push(setTimeout(down, injection.upMs));
      else remove(entry);
    };
    down();
  }

  return {
    add({ injection, forMs }) {
      const counted =
        'count' in injection && typeof injection.count === 'number'
          ? injection.count
          : injection.type === 'outOfOrder'
            ? 1
            : undefined;
      const entry: Entry = {
        id: `inj-${++nextId}`,
        injection,
        timers: [],
        ...(forMs !== undefined && { until: new Date(Date.now() + forMs).toISOString() }),
        ...(counted !== undefined && { remaining: counted }),
      };
      entries.push(entry);
      options.onChange?.();
      if (forMs !== undefined) entry.timers.push(setTimeout(() => remove(entry), forMs));
      if (injection.type === 'flap') flap(entry, injection);
      return {
        id: entry.id,
        injection,
        ...(entry.until !== undefined && { until: entry.until }),
        ...(entry.remaining !== undefined && { remaining: entry.remaining }),
      };
    },

    clear() {
      for (const entry of [...entries]) remove(entry);
      if (held !== undefined) {
        clearTimeout(held.timer);
        const { text, injected } = held;
        held = undefined;
        send(text, injected);
      }
    },

    list() {
      return entries.map(({ id, injection, until, remaining }) => ({
        id,
        injection,
        ...(until !== undefined && { until }),
        ...(remaining !== undefined && { remaining }),
      }));
    },

    outgoing(original) {
      let text = original;
      const parsed = parseFrame(text);
      let frame = parsed.ok ? parsed.frame : undefined;
      let injected: string | undefined;

      if (frame !== undefined) {
        if (frame.type === MessageTypeId.Call) {
          const drift = entries
            .map((e) => e.injection)
            .reduce((total, i) => total + (i.type === 'clockDrift' ? i.ms : 0), 0);
          if (drift !== 0 && hasTimestamp(frame.payload)) {
            frame = { ...frame, payload: mapTimestamps(frame.payload, (t) => shift(t, drift)) };
            injected = 'clockDrift';
          }
          if (hasTimestamp(frame.payload) && take('badTimestamp') !== undefined) {
            frame = { ...frame, payload: mapTimestamps(frame.payload, () => 'not-a-timestamp') };
            injected = 'badTimestamp';
          }
          const violation = take('schemaViolation', (i) => callOf(frame, i.action));
          if (violation !== undefined) {
            frame = { ...frame, payload: { ...frame.payload, injected: true } };
            injected = 'schemaViolation';
          }
          const previous = lastCallId;
          lastCallId = frame.id;
          if (previous !== undefined && take('duplicateId') !== undefined) {
            // The CSMS sees the previous uniqueId again; its answer is renamed back.
            renamed.set(previous, frame.id);
            frame = { ...frame, id: previous };
            injected = 'duplicateId';
          }
        } else if (take('unknownId') !== undefined) {
          frame = { ...frame, id: `unknown-${Math.floor(random() * 1e9)}` };
          injected = 'unknownId';
        }
        if (injected !== undefined) text = serializeFrame(frame);
      }
      if (take('malformedJson') !== undefined) {
        text = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
        injected = 'malformedJson';
      }
      if (dropped('cp-to-csms', frame)) {
        options.swallowed('cp-to-csms', text, 'drop');
        return;
      }

      if (held !== undefined) {
        // The frame after the held one goes first.
        clearTimeout(held.timer);
        const first = held;
        held = undefined;
        send(text, injected ?? 'outOfOrder');
        send(first.text, first.injected ?? 'outOfOrder');
        return;
      }
      if (take('outOfOrder') !== undefined) {
        held = {
          text,
          ...(injected !== undefined && { injected }),
          timer: setTimeout(() => {
            const frameHeld = held;
            held = undefined;
            if (frameHeld !== undefined) send(frameHeld.text, frameHeld.injected ?? 'outOfOrder');
          }, HOLD_MS),
        };
        return;
      }
      send(text, injected);
    },

    incoming(original) {
      later('csms-to-cp', () => {
        let text = original;
        const parsed = parseFrame(text);
        const frame = parsed.ok ? parsed.frame : undefined;
        if (dropped('csms-to-cp', frame)) {
          options.swallowed('csms-to-cp', text, 'drop');
          return;
        }
        if (frame?.type === MessageTypeId.Call) {
          if (take('noAnswer', (i) => callOf(frame, i.action)) !== undefined) {
            options.swallowed('csms-to-cp', text, 'noAnswer');
            return;
          }
          const error = take('callError', (i) => callOf(frame, i.action));
          if (error !== undefined) {
            options.swallowed('csms-to-cp', text, 'callError');
            send(
              serializeFrame({
                type: MessageTypeId.CallError,
                id: frame.id,
                errorCode: error.errorCode,
                errorDescription: 'Injected fault',
                errorDetails: {},
              }),
              'callError',
            );
            return;
          }
        } else if (frame !== undefined && renamed.has(frame.id)) {
          const id = renamed.get(frame.id) ?? frame.id;
          renamed.delete(frame.id);
          text = serializeFrame({ ...frame, id });
        }
        options.toChargePoint(text);
      });
    },
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Whether a payload has a `timestamp` field anywhere (StatusNotification, meter values, ...). */
function hasTimestamp(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTimestamp);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => (key === 'timestamp' && typeof child === 'string') || hasTimestamp(child),
  );
}

/** A copy of `value` with every `timestamp` string replaced by `change(timestamp)`. */
function mapTimestamps<T>(value: T, change: (timestamp: string) => string): T {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        key,
        key === 'timestamp' && typeof child === 'string' ? change(child) : walk(child),
      ]),
    );
  };
  return walk(value as Json) as T;
}

function shift(timestamp: string, ms: number): string {
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? timestamp : new Date(at + ms).toISOString();
}
