/**
 * Replay (docs/design.md, "M4 scale"): sends a log's charge-point frames over
 * a replay station's connection with the recorded gaps, answers the CSMS's
 * CALLs with the recorded answers, and compares the CSMS's answers with the
 * recorded ones. uniqueIds are fresh and timestamps move to the present. 1.6
 * transactionIds follow the CSMS's new ones; 2.0.1 transactionIds, which the
 * station makes, are fresh, seqNo stays, and remoteStartIds follow the ones
 * the CSMS sends in RequestStartTransaction. 2.1 tariffIds follow the tariffs
 * the CSMS installs, and the DirectPayment tokens (pspRefs) of web payments
 * the ones it starts them with.
 */
import { randomUUID } from 'node:crypto';
import { lineFrame, type LogLine } from '@ocpp-mimic/core';
import type { StationWire } from '../fleet.js';

export type CompareMode = 'status' | 'strict' | 'none';

export interface ReplayOptions {
  wire: StationWire;
  /** One station's log lines, in order. */
  lines: readonly LogLine[];
  /** Gaps are divided by this. Default 1. */
  speed?: number;
  /** Longest wait between two frames sent, after `speed`. Default 30 s. */
  maxGapMs?: number;
  compare?: CompareMode;
  /** How long to wait for each answer from the CSMS. Default 30 s. */
  answerTimeoutMs?: number;
  /** How long to wait for CALLs from the CSMS after the last frame. Default 1 s. */
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayResult {
  /** Charge-point CALLs sent, and how many the CSMS answered. */
  sent: number;
  answered: number;
  /** CSMS CALLs: answered with a recorded answer, without one, and recorded but never seen. */
  csmsCalls: { matched: number; unmatched: string[]; missing: string[] };
  /** Answers or CALLs that differ from the log; empty when the replay matched. */
  differences: string[];
}

/** Fields that change from run to run and are never compared. */
const VOLATILE = new Set([
  'currentTime',
  'transactionId',
  'timestamp',
  'expiryDate',
  'expiryDateTime',
  'cacheExpiryDateTime',
  'remoteStartId',
  'tariffId',
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A copy of `value` with every `timestamp` string moved by `offsetMs`. */
function shiftTimestamps(value: Json, offsetMs: number): Json {
  if (Array.isArray(value)) return value.map((item) => shiftTimestamps(item, offsetMs));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'timestamp' && typeof child === 'string' && !Number.isNaN(Date.parse(child))) {
        return [key, new Date(Date.parse(child) + offsetMs).toISOString()];
      }
      return [key, shiftTimestamps(child, offsetMs)];
    }),
  );
}

/**
 * Ids that differ between the recording and the replay: 1.6 transactionIds
 * (numbers, the CSMS's), 2.x transactionIds (strings, the station's own,
 * fresh for the replay), 2.x remoteStartIds (the CSMS's), and 2.1 tariffIds
 * and DirectPayment tokens of web payments (the CSMS's).
 */
interface IdMaps {
  transactionIds: Map<number, number>;
  stationTransactionIds: Map<string, string>;
  remoteStartIds: Map<number, number>;
  tariffIds: Map<string, string>;
  pspRefs: Map<string, string>;
}

/** A tariff's id in a CSMS command (SetDefaultTariff, ChangeTransactionTariff). */
const tariffIdOf = (payload: unknown): string | undefined => {
  const tariff = (payload as { tariff?: { tariffId?: unknown } } | undefined)?.tariff;
  return typeof tariff?.tariffId === 'string' ? tariff.tariffId : undefined;
};
/** The DirectPayment token a CSMS starts a web payment with (C25). */
const pspRefOf = (payload: unknown): string | undefined => {
  const token = (payload as { idToken?: { idToken?: unknown; type?: unknown } } | undefined)
    ?.idToken;
  return token?.type === 'DirectPayment' && typeof token.idToken === 'string'
    ? token.idToken
    : undefined;
};

/** A copy of `value` with recorded ids replaced by the replay's. */
function mapIds(value: Json, ids: IdMaps): Json {
  if (Array.isArray(value)) return value.map((item) => mapIds(item, ids));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'transactionId' && typeof child === 'number') {
        return [key, ids.transactionIds.get(child) ?? child];
      }
      if (key === 'transactionId' && typeof child === 'string') {
        let fresh = ids.stationTransactionIds.get(child);
        if (fresh === undefined) {
          fresh = randomUUID();
          ids.stationTransactionIds.set(child, fresh);
        }
        return [key, fresh];
      }
      if (key === 'remoteStartId' && typeof child === 'number') {
        return [key, ids.remoteStartIds.get(child) ?? child];
      }
      if (key === 'tariffId' && typeof child === 'string') {
        return [key, ids.tariffIds.get(child) ?? child];
      }
      if (key === 'pspRef' && typeof child === 'string') {
        return [key, ids.pspRefs.get(child) ?? child];
      }
      if (
        key === 'idToken' &&
        child !== null &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        const token = child as { [key: string]: Json };
        if (token.type === 'DirectPayment' && typeof token.idToken === 'string') {
          const mapped = ids.pspRefs.get(token.idToken);
          if (mapped !== undefined) return [key, { ...token, idToken: mapped }];
        }
      }
      return [key, mapIds(child, ids)];
    }),
  );
}

/** `status` fields at any depth, by path. */
function statuses(value: unknown, path = ''): Map<string, unknown> {
  const found = new Map<string, unknown>();
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const at = path === '' ? key : `${path}.${key}`;
    if (key === 'status') found.set(at, child);
    else for (const [p, v] of statuses(child, at)) found.set(p, v);
  }
  return found;
}

/** Differences between two payloads, leaving out volatile fields, as `path: actual, the log has expected`. */
function strictDifferences(actual: unknown, expected: unknown, path = ''): string[] {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return [`${path || 'payload'} has ${actual.length} items, the log has ${expected.length}`];
    }
    return actual.flatMap((item, i) => strictDifferences(item, expected[i], `${path}[${i}]`));
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object' &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(e)])].filter(
      (k) => !VOLATILE.has(k),
    );
    return keys.flatMap((key) =>
      strictDifferences(a[key], e[key], path === '' ? key : `${path}.${key}`),
    );
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [
        `${path || 'payload'} is ${JSON.stringify(actual)}, the log has ${JSON.stringify(expected)}`,
      ];
}

/** How an answer from the CSMS differs from the recorded one. */
function compareAnswers(actual: unknown[], expected: unknown[], mode: CompareMode): string[] {
  if (mode === 'none') return [];
  const [actualType] = actual;
  const [expectedType] = expected;
  if (actualType !== expectedType) {
    const name = (type: unknown) => (type === 4 ? 'a CALLERROR' : 'a CALLRESULT');
    return [`the answer is ${name(actualType)}, the log has ${name(expectedType)}`];
  }
  if (actualType === 4) {
    return actual[2] === expected[2]
      ? []
      : [`the error is ${String(actual[2])}, the log has ${String(expected[2])}`];
  }
  if (mode === 'strict') return strictDifferences(actual[2], expected[2]);
  const got = statuses(actual[2]);
  const want = statuses(expected[2]);
  return [...want].flatMap(([path, value]) =>
    got.get(path) === value
      ? []
      : [`${path} is ${JSON.stringify(got.get(path))}, the log has ${JSON.stringify(value)}`],
  );
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { wire, lines } = options;
  const speed = options.speed ?? 1;
  const maxGapMs = options.maxGapMs ?? 30_000;
  const compare = options.compare ?? 'status';
  const answerTimeoutMs = options.answerTimeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const result: ReplayResult = {
    sent: 0,
    answered: 0,
    csmsCalls: { matched: 0, unmatched: [], missing: [] },
    differences: [],
  };

  // What the log says the CSMS answered (by the station's uniqueId), and the
  // station's recorded answers to the CSMS's CALLs (by the CSMS's uniqueId).
  const csmsAnswers = new Map<string, { frame: unknown[]; n: number }>();
  const stationAnswers = new Map<string, unknown[]>();
  const recordedCsmsCalls: { action: string; id: string; payload: unknown; n: number }[] = [];
  lines.forEach((line, index) => {
    const frame = line.frame;
    if (frame === undefined) return;
    const n = index + 1;
    if (line.direction === 'csms-to-cp') {
      if (frame[0] === 2) {
        recordedCsmsCalls.push({
          action: String(frame[2]),
          id: String(frame[1]),
          payload: frame[3],
          n,
        });
      } else csmsAnswers.set(String(frame[1]), { frame, n });
    } else if (frame[0] !== 2) {
      stationAnswers.set(String(frame[1]), frame);
    }
  });

  const firstAt = lines.length > 0 ? Date.parse(lines[0]?.at ?? '') : now();
  const offsetMs = now() - firstAt;
  const ids: IdMaps = {
    transactionIds: new Map(),
    stationTransactionIds: new Map(),
    remoteStartIds: new Map(),
    tariffIds: new Map(),
    pspRefs: new Map(),
  };
  const pending = new Map<string, (frame: unknown[]) => void>();
  let nextId = 0;
  const consumed = new Set<number>();

  // CALLs from the CSMS: answered with the station's recorded answer to the
  // next recorded CALL of the same action.
  const unsubscribe = wire.onFrame((text) => {
    let frame: unknown[];
    try {
      frame = JSON.parse(text) as unknown[];
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    if (frame[0] === 3 || frame[0] === 4) {
      pending.get(String(frame[1]))?.(frame);
      return;
    }
    if (frame[0] !== 2) return;
    const action = String(frame[2]);
    const match = recordedCsmsCalls.findIndex((c, i) => !consumed.has(i) && c.action === action);
    const recorded = recordedCsmsCalls[match];
    const answer = recorded === undefined ? undefined : stationAnswers.get(recorded.id);
    if (recorded === undefined || answer === undefined) {
      result.csmsCalls.unmatched.push(action);
      wire.send(
        JSON.stringify([
          4,
          frame[1],
          'NotImplemented',
          `the log has no ${action} to answer from`,
          {},
        ]),
      );
      return;
    }
    consumed.add(match);
    result.csmsCalls.matched += 1;
    if (compare === 'strict') {
      for (const difference of strictDifferences(frame[3], recorded.payload)) {
        result.differences.push(`${action} from the CSMS (log line ${recorded.n}): ${difference}`);
      }
    }
    // A 2.0.1 remote start: the station's later frames carry the CSMS's new remoteStartId.
    const recordedRemote = (recorded.payload as { remoteStartId?: unknown } | undefined)
      ?.remoteStartId;
    const newRemote = (frame[3] as { remoteStartId?: unknown } | undefined)?.remoteStartId;
    if (typeof recordedRemote === 'number' && typeof newRemote === 'number') {
      ids.remoteStartIds.set(recordedRemote, newRemote);
    }
    // 2.1: a tariff the CSMS installs, a web payment it starts: their new ids.
    const recordedTariff = tariffIdOf(recorded.payload);
    const newTariff = tariffIdOf(frame[3]);
    if (recordedTariff !== undefined && newTariff !== undefined) {
      ids.tariffIds.set(recordedTariff, newTariff);
    }
    const recordedPsp = pspRefOf(recorded.payload);
    const newPsp = pspRefOf(frame[3]);
    if (recordedPsp !== undefined && newPsp !== undefined) ids.pspRefs.set(recordedPsp, newPsp);
    const reply = [...answer];
    reply[1] = frame[1];
    if (reply[0] === 3) reply[2] = mapIds(reply[2] as Json, ids);
    wire.send(JSON.stringify(reply));
  });

  try {
    let previousAt: number | undefined;
    for (const line of lines) {
      if (line.direction !== 'cp-to-csms') continue;
      const frame = line.frame;
      // Answers to the CSMS's CALLs go out when those CALLs come.
      if (frame === undefined || frame[0] !== 2) continue;
      const at = Date.parse(line.at);
      if (previousAt !== undefined) {
        const gap = Math.min(maxGapMs, Math.max(0, (at - previousAt) / speed));
        if (gap > 0) await sleep(gap);
      }
      previousAt = at;
      const recordedId = String(frame[1]);
      const action = String(frame[2]);
      const id = `replay-${++nextId}`;
      const payload = mapIds(shiftTimestamps(frame[3] as Json, offsetMs), ids);
      const answer = new Promise<unknown[] | undefined>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(undefined);
        }, answerTimeoutMs);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply);
        });
      });
      wire.send(JSON.stringify([2, id, action, payload]));
      result.sent += 1;
      const reply = await answer;
      const recorded = csmsAnswers.get(recordedId);
      const where = `${action} (log line ${recorded?.n ?? '?'})`;
      if (reply === undefined) {
        result.differences.push(`${where}: no answer within ${answerTimeoutMs} ms`);
        continue;
      }
      result.answered += 1;
      if (recorded === undefined) continue;
      for (const difference of compareAnswers(reply, recorded.frame, compare)) {
        result.differences.push(`${where}: ${difference}`);
      }
      // The CSMS hands out its own transaction ids; later frames use them.
      const recordedTx = (recorded.frame[2] as { transactionId?: unknown } | undefined)
        ?.transactionId;
      const newTx = (reply[2] as { transactionId?: unknown } | undefined)?.transactionId;
      if (
        action === 'StartTransaction' &&
        typeof recordedTx === 'number' &&
        typeof newTx === 'number'
      ) {
        ids.transactionIds.set(recordedTx, newTx);
      }
    }
    await sleep(options.settleMs ?? 1000);
  } finally {
    unsubscribe();
  }
  result.csmsCalls.missing = recordedCsmsCalls
    .filter((_, i) => !consumed.has(i))
    .map((c) => `${c.action} (log line ${c.n})`);
  if (compare === 'strict') {
    for (const missing of result.csmsCalls.missing) {
      result.differences.push(`${missing} from the CSMS never came`);
    }
    for (const action of result.csmsCalls.unmatched) {
      result.differences.push(`${action} from the CSMS is not in the log`);
    }
  }
  return result;
}

/** The lines of one station: `station`, or the log's only station. */
export function stationLines(
  lines: readonly LogLine[],
  station?: string,
): { ok: true; station: string; lines: LogLine[] } | { ok: false; problem: string } {
  const stations = [...new Set(lines.map((line) => line.station))];
  const chosen = station ?? (stations.length === 1 ? stations[0] : undefined);
  if (chosen === undefined) {
    return {
      ok: false,
      problem:
        stations.length === 0
          ? 'the log has no frames'
          : `the log has ${stations.length} stations (${stations.slice(0, 5).join(', ')}${stations.length > 5 ? ', ...' : ''}); pick one`,
    };
  }
  const picked = lines.filter((line) => line.station === chosen && lineFrame(line) !== undefined);
  if (picked.length === 0) return { ok: false, problem: `the log has no frames of ${chosen}` };
  return { ok: true, station: chosen, lines: picked };
}
