/**
 * Metrics: counters, gauges and latency histograms over the fleet's frames
 * and connections (docs/design.md, "M4 scale"). They come from the frames as
 * recorded on the wire and from transport events, so they work with the Event
 * Recorder keeping nothing. Labels stay at action, persona and group, so
 * 1,000 stations cost no more series than one. Served as Prometheus text and
 * as JSON.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RpcEvent, UsageEvent } from '@ocpp-mimic/core';
import type { FrameRecord } from './recorder.js';
import type { TransportEvent } from './transport.js';

/** Prometheus buckets for latencies, in seconds. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Log-scaled buckets 2 % apart, from 10 µs: percentiles within about 2 %. */
const LOG_BASE = 1.02;
const LOG_MIN = 1e-5;

/**
 * A latency histogram: exact counts for the Prometheus buckets, plus
 * log-scaled buckets for percentiles.
 */
export class Histogram {
  count = 0;
  sum = 0;
  /** The largest value seen. */
  max = 0;
  readonly bucketCounts: number[];
  /** Log bucket index → count. */
  private readonly fine = new Map<number, number>();

  constructor(readonly buckets: readonly number[] = LATENCY_BUCKETS) {
    this.bucketCounts = buckets.map(() => 0);
  }

  observe(seconds: number): void {
    const value = Math.max(0, seconds);
    this.count += 1;
    this.sum += value;
    if (value > this.max) this.max = value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] ?? 0)) this.bucketCounts[i] = (this.bucketCounts[i] ?? 0) + 1;
    }
    const index = value <= LOG_MIN ? 0 : Math.ceil(Math.log(value / LOG_MIN) / Math.log(LOG_BASE));
    this.fine.set(index, (this.fine.get(index) ?? 0) + 1);
  }

  /** Adds another histogram with the same buckets to this one. */
  merge(other: Histogram): void {
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
    other.bucketCounts.forEach((n, i) => {
      this.bucketCounts[i] = (this.bucketCounts[i] ?? 0) + n;
    });
    for (const [index, n] of other.fine) this.fine.set(index, (this.fine.get(index) ?? 0) + n);
  }

  /** The value at quantile `q` (0 to 1), as the upper edge of its 2 % bucket; 0 when empty. */
  percentile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil(q * this.count));
    let seen = 0;
    for (const index of [...this.fine.keys()].sort((a, b) => a - b)) {
      seen += this.fine.get(index) ?? 0;
      if (seen >= rank) return index === 0 ? LOG_MIN : LOG_MIN * LOG_BASE ** index;
    }
    return 0;
  }
}

/** Series of one metric, keyed by their label values. */
class Family<T> {
  readonly series = new Map<string, { labels: Record<string, string>; value: T }>();

  constructor(private readonly create: () => T) {}

  get(labels: Record<string, string>): T {
    const key = JSON.stringify(labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { labels, value: this.create() };
      this.series.set(key, entry);
    }
    return entry.value;
  }
}

class Counter {
  value = 0;
}

type Series = Map<string, { labels: Record<string, string>; value: number }>;

/** Gauges read from the stations on each scrape. */
interface Gauges {
  stations: Record<string, number>;
  connectors: Record<string, number>;
  stationSeries: Series;
  connectorSeries: Series;
  queued: number;
}

/** What metrics need to know about a station when it is scraped. */
export interface MeteredStation {
  id: string;
  persona: string;
  group?: string;
  running: boolean;
  /** The transport state. */
  transport: string;
  /** Messages with guaranteed delivery waiting to be sent. */
  queuedMessages(): number;
}

export interface MetricsOptions {
  /** The stations, read on every scrape for the gauges. */
  stations(): Iterable<MeteredStation>;
  /** A station's persona, group and OCPP version, for labels. */
  labelsOf(stationId: string): { persona: string; group: string; ocpp?: string } | undefined;
  /** Milliseconds; injected for tests. */
  now?: () => number;
  version?: string;
}

export interface MetricsSummary {
  stations: Record<string, number>;
  connectors: Record<string, number>;
  csmsLatency: { overall: LatencySummary; byAction: Record<string, LatencySummary> };
  answers: Record<string, number>;
  callsReceived: number;
  callErrors: { sent: number; received: number };
  schemaViolations: number;
  frames: { sent: number; received: number };
  connections: { opened: number; failed: number };
  disconnects: Record<string, number>;
  transactions: Record<string, number>;
  energyWh: number;
  sessionsTurnedAway: number;
  offlineQueue: number;
  lateWork: LatencySummary;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  process: { cpuSeconds: number; rssBytes: number; heapUsedBytes: number };
}

export interface LatencySummary {
  count: number;
  /** Milliseconds. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Metrics {
  /** A frame as recorded on the wire (after the Fault Injector). */
  frame(record: FrameRecord): void;
  transport(stationId: string, event: TransportEvent): void;
  rpc(stationId: string, event: RpcEvent): void;
  /** How late scheduled work ran, in milliseconds. */
  lateness(ms: number): void;
  /** Something a usage model driver did. */
  usage(stationId: string, event: UsageEvent): void;
  /** A station was removed: its in-flight CALLs and connector statuses are forgotten. */
  forget(stationId: string): void;
  /** Every metric with its current samples. */
  families(): MetricFamily[];
  prometheus(): string;
  summary(): MetricsSummary;
  stop(): void;
}

/** The loop delay monitor's interval; what it records includes it, so it is subtracted. */
const LOOP_RESOLUTION_MS = 10;
/** Event-loop delay is reported over windows of this length. */
const LOOP_WINDOW_MS = 10_000;

const latencySummary = (h: Histogram | undefined): LatencySummary => ({
  count: h?.count ?? 0,
  p50: round((h?.percentile(0.5) ?? 0) * 1000),
  p95: round((h?.percentile(0.95) ?? 0) * 1000),
  p99: round((h?.percentile(0.99) ?? 0) * 1000),
  max: round((h?.max ?? 0) * 1000),
});
const round = (value: number) => Math.round(value * 10) / 10;

export function createMetrics(options: MetricsOptions): Metrics {
  const now = options.now ?? Date.now;
  const labels = (stationId: string) => {
    const found = options.labelsOf(stationId);
    return { persona: found?.persona ?? '', group: found?.group ?? '' };
  };
  /** The station's OCPP version: connection and frame metrics carry it (two values). */
  const versionOf = (stationId: string) => options.labelsOf(stationId)?.ocpp ?? '';

  const csmsResponse = new Family(() => new Histogram());
  const answers = new Family(() => new Counter());
  const callsReceived = new Family(() => new Counter());
  const callErrors = new Family(() => new Counter());
  const schemaViolations = new Family(() => new Counter());
  const frames = new Family(() => new Counter());
  const frameBytes = new Family(() => new Counter());
  const connections = new Family(() => new Counter());
  const disconnects = new Family(() => new Counter());
  const transactions = new Family(() => new Counter());
  const energy = new Family(() => new Counter());
  const turnedAway = new Family(() => new Counter());
  const lateWork = new Histogram();
  const overall = new Histogram();

  /** `${stationId} ${uniqueId}` → the station's CALL waiting for its answer. */
  const pending = new Map<string, { action: string; sentAt: number; payload: unknown }>();
  /** `${stationId} ${transactionId}` → meterStart, for the energy of finished sessions. */
  const meterStarts = new Map<string, number>();
  /** stationId → connectorId → last reported status. */
  const statuses = new Map<string, Map<number, string>>();
  /** Per station: open now, and a connection attempt under way. */
  const open = new Set<string>();
  const attempting = new Set<string>();

  /** CALLs in flight when a connection goes can never be answered on it. */
  const dropPending = (stationId: string) => {
    const prefix = `${stationId} `;
    for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
  };

  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();
  /** The last 10-second window: quantiles in ms, plus its count and sum for the summary. */
  let loopWindow = { p50: 0, p99: 0, max: 0, count: 0, sumMs: 0 };
  const loopMs = (nanoseconds: number) =>
    round(Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS));
  const loopTimer = setInterval(() => {
    const count = loop.count;
    loopWindow = {
      p50: loopMs(loop.percentile(50)),
      p99: loopMs(loop.percentile(99)),
      max: loopMs(loop.max),
      count,
      sumMs: count === 0 ? 0 : Math.max(0, loop.mean / 1e6 - LOOP_RESOLUTION_MS) * count,
    };
    loop.reset();
  }, LOOP_WINDOW_MS);
  loopTimer.unref();

  function answered(
    record: FrameRecord,
    call: { action: string; sentAt: number; payload: unknown },
  ) {
    const { persona, group } = labels(record.stationId);
    const seconds = (now() - call.sentAt) / 1000;
    csmsResponse.get({ action: call.action, persona, group }).observe(seconds);
    overall.observe(seconds);
    const outcome = record.messageType === 4 ? 'error' : 'result';
    answers.get({ action: call.action, outcome }).value += 1;
    if (record.messageType !== 3) return;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const status = (payload.idTagInfo as { status?: string } | undefined)?.status;
    if (call.action === 'TransactionEvent') {
      // 2.0.1: a Started event begins a transaction unless its token is refused.
      const eventType = (call.payload as { eventType?: string }).eventType;
      const tokenStatus = (payload.idTokenInfo as { status?: string } | undefined)?.status;
      if (eventType === 'Started') {
        transactions.get({
          outcome: tokenStatus === undefined || tokenStatus === 'Accepted' ? 'started' : 'refused',
        }).value += 1;
      } else if (eventType === 'Ended') {
        transactions.get({ outcome: 'stopped' }).value += 1;
      }
    } else if (call.action === 'StartTransaction') {
      transactions.get({ outcome: status === 'Accepted' ? 'started' : 'refused' }).value += 1;
      const meterStart = (call.payload as { meterStart?: number }).meterStart;
      if (typeof payload.transactionId === 'number' && typeof meterStart === 'number') {
        meterStarts.set(`${record.stationId} ${payload.transactionId}`, meterStart);
      }
    } else if (call.action === 'StopTransaction') {
      transactions.get({ outcome: 'stopped' }).value += 1;
    }
  }

  const families = () =>
    familiesOf(gauges(), {
      csmsResponse,
      answers,
      callsReceived,
      callErrors,
      schemaViolations,
      frames,
      frameBytes,
      connections,
      disconnects,
      transactions,
      energy,
      turnedAway,
      lateWork,
      loopWindow,
      version: options.version,
    });

  return {
    frame(record) {
      const direction = record.direction === 'cp-to-csms' ? 'sent' : 'received';
      if (record.dropped !== true) {
        const ocpp = versionOf(record.stationId);
        frames.get({ direction, ocpp }).value += 1;
        frameBytes.get({ direction, ocpp }).value += Buffer.byteLength(record.text);
      }
      if (record.schemaErrors !== undefined && record.action !== undefined) {
        schemaViolations.get({ direction, action: record.action }).value += 1;
      }
      if (record.messageType === 4 && record.action !== undefined) {
        const code = String((record.payload as { errorCode?: string } | undefined)?.errorCode);
        callErrors.get({ direction, action: record.action, code }).value += 1;
      }
      if (record.dropped === true || record.uniqueId === undefined) return;
      const key = `${record.stationId} ${record.uniqueId}`;
      if (direction === 'sent') {
        if (record.messageType !== 2 || record.action === undefined) return;
        pending.set(key, { action: record.action, sentAt: now(), payload: record.payload });
        const payload = (record.payload ?? {}) as Record<string, unknown>;
        if (record.action === 'StatusNotification' && typeof payload.connectorId === 'number') {
          let connectors = statuses.get(record.stationId);
          if (connectors === undefined) statuses.set(record.stationId, (connectors = new Map()));
          // 2.0.1 reports per EVSE (EVSE n holds connector n) with connectorStatus.
          const connectorId = typeof payload.evseId === 'number' ? payload.evseId : payload.connectorId;
          const status = payload.connectorStatus ?? payload.status;
          if (connectorId > 0) connectors.set(connectorId, String(status));
        } else if (record.action === 'TransactionEvent') {
          const transactionId = (payload.transactionInfo as { transactionId?: string } | undefined)
            ?.transactionId;
          const register = energyRegister(payload.meterValue);
          const key = `${record.stationId} ${String(transactionId)}`;
          if (payload.eventType === 'Started' && register !== undefined) {
            meterStarts.set(key, register);
          } else if (payload.eventType === 'Ended') {
            const start = meterStarts.get(key);
            meterStarts.delete(key);
            if (start !== undefined && register !== undefined) {
              energy.get(labels(record.stationId)).value += Math.max(0, register - start);
            }
          }
        } else if (record.action === 'StopTransaction') {
          const start = meterStarts.get(`${record.stationId} ${String(payload.transactionId)}`);
          if (start !== undefined && typeof payload.meterStop === 'number') {
            meterStarts.delete(`${record.stationId} ${String(payload.transactionId)}`);
            energy.get(labels(record.stationId)).value += Math.max(0, payload.meterStop - start);
          }
        }
        return;
      }
      if (record.messageType === 2) {
        if (record.action !== undefined) callsReceived.get({ action: record.action }).value += 1;
        return;
      }
      const call = pending.get(key);
      if (call === undefined) return;
      pending.delete(key);
      answered(record, call);
    },

    transport(stationId, event) {
      if (event.type === 'connecting') {
        attempting.add(stationId);
      } else if (event.type === 'open') {
        attempting.delete(stationId);
        open.add(stationId);
        connections.get({ outcome: 'opened', ocpp: versionOf(stationId) }).value += 1;
      } else if (event.type === 'close' && open.has(stationId)) {
        // The CSMS closed it, or the connection broke (1006: no close frame).
        open.delete(stationId);
        disconnects.get({ cause: event.code === 1006 ? 'error' : 'remote' }).value += 1;
        dropPending(stationId);
      } else if (event.type === 'state' && event.state !== 'open' && event.state !== 'connecting') {
        if (attempting.delete(stationId)) {
          connections.get({ outcome: 'failed', ocpp: versionOf(stationId) }).value += 1;
        }
        // Closed without a close event: the station dropped it itself (stopped,
        // taken offline, an injection, a reset).
        if (open.delete(stationId)) disconnects.get({ cause: 'local' }).value += 1;
        dropPending(stationId);
      }
    },

    rpc(stationId, event) {
      if (event.type !== 'timeout') return;
      const key = `${stationId} ${event.id}`;
      pending.delete(key);
      answers.get({ action: event.action, outcome: 'timeout' }).value += 1;
    },

    lateness(ms) {
      lateWork.observe(ms / 1000);
    },

    usage(stationId, event) {
      if (event.type === 'turned-away') turnedAway.get(labels(stationId)).value += 1;
    },

    forget(stationId) {
      const prefix = `${stationId} `;
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      for (const key of meterStarts.keys()) if (key.startsWith(prefix)) meterStarts.delete(key);
      statuses.delete(stationId);
      open.delete(stationId);
      attempting.delete(stationId);
    },

    families,

    prometheus() {
      return prometheusText(families());
    },

    summary() {
      const g = gauges();
      const sum = (
        family: Family<Counter>,
        match: (labels: Record<string, string>) => boolean = () => true,
      ) =>
        [...family.series.values()]
          .filter((s) => match(s.labels))
          .reduce((total, s) => total + s.value.value, 0);
      const byLabel = (family: Family<Counter>, label: string) => {
        const result: Record<string, number> = {};
        for (const { labels: l, value } of family.series.values()) {
          const key = l[label] ?? '';
          result[key] = (result[key] ?? 0) + value.value;
        }
        return result;
      };
      const byAction: Record<string, Histogram> = {};
      for (const { labels: l, value } of csmsResponse.series.values()) {
        const action = l.action ?? '';
        const merged = byAction[action] ?? new Histogram();
        merged.merge(value);
        byAction[action] = merged;
      }
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        stations: g.stations,
        connectors: g.connectors,
        csmsLatency: {
          overall: latencySummary(overall),
          byAction: Object.fromEntries(
            Object.entries(byAction).map(([action, h]) => [action, latencySummary(h)]),
          ),
        },
        answers: byLabel(answers, 'outcome'),
        callsReceived: sum(callsReceived),
        callErrors: {
          sent: sum(callErrors, (l) => l.direction === 'sent'),
          received: sum(callErrors, (l) => l.direction === 'received'),
        },
        schemaViolations: sum(schemaViolations),
        frames: {
          sent: sum(frames, (l) => l.direction === 'sent'),
          received: sum(frames, (l) => l.direction === 'received'),
        },
        connections: {
          opened: sum(connections, (l) => l.outcome === 'opened'),
          failed: sum(connections, (l) => l.outcome === 'failed'),
        },
        disconnects: byLabel(disconnects, 'cause'),
        transactions: byLabel(transactions, 'outcome'),
        energyWh: sum(energy),
        sessionsTurnedAway: sum(turnedAway),
        offlineQueue: g.queued,
        lateWork: latencySummary(lateWork),
        eventLoopDelayMs: { p50: loopWindow.p50, p99: loopWindow.p99, max: loopWindow.max },
        process: {
          cpuSeconds: round((cpu.user + cpu.system) / 1e6),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        },
      };
    },

    stop() {
      clearInterval(loopTimer);
      loop.disable();
    },
  };

  /** Gauges from the stations as they are now. */
  function gauges(): Gauges {
    const stations: Record<string, number> = {};
    const connectors: Record<string, number> = {};
    const stationSeries: Series = new Map();
    const connectorSeries: Series = new Map();
    let queued = 0;
    const add = (map: Series, l: Record<string, string>) => {
      const key = JSON.stringify(l);
      const entry = map.get(key) ?? { labels: l, value: 0 };
      entry.value += 1;
      map.set(key, entry);
    };
    for (const station of options.stations()) {
      const state = stationState(station);
      const group = station.group ?? '';
      stations[state] = (stations[state] ?? 0) + 1;
      add(stationSeries, { state, persona: station.persona, group });
      for (const status of statuses.get(station.id)?.values() ?? []) {
        connectors[status] = (connectors[status] ?? 0) + 1;
        add(connectorSeries, { status, persona: station.persona, group });
      }
      if (station.running) queued += station.queuedMessages();
    }
    return { stations, connectors, stationSeries, connectorSeries, queued };
  }
}

/** The Energy.Active.Import.Register reading (Wh) among 2.0.1 meter values, if any. */
function energyRegister(meterValue: unknown): number | undefined {
  if (!Array.isArray(meterValue)) return undefined;
  for (const value of meterValue as { sampledValue?: unknown }[]) {
    for (const sample of (value.sampledValue ?? []) as {
      value?: unknown;
      measurand?: string;
      unitOfMeasure?: { unit?: string; multiplier?: number };
    }[]) {
      const measurand = sample.measurand ?? 'Energy.Active.Import.Register';
      if (measurand !== 'Energy.Active.Import.Register' || typeof sample.value !== 'number') continue;
      const kilo = sample.unitOfMeasure?.unit === 'kWh' ? 1000 : 1;
      return sample.value * kilo * 10 ** (sample.unitOfMeasure?.multiplier ?? 0);
    }
  }
  return undefined;
}

function stationState(station: MeteredStation): string {
  if (!station.running || station.transport === 'stopped') return 'stopped';
  if (station.transport === 'open') return 'connected';
  if (station.transport === 'offline' || station.transport === 'half-open') return 'offline';
  return 'connecting';
}

const escape = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
const labelText = (labels: Record<string, string>, extra: Record<string, string> = {}) => {
  const all = { ...labels, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
};

/** One sample of a metric family. */
export type MetricPoint =
  | { labels: Record<string, string>; value: number }
  | { labels: Record<string, string>; histogram: Histogram }
  | {
      labels: Record<string, string>;
      summary: { quantiles: [number, number][]; sum: number; count: number };
    };

/** A metric with its samples, written as Prometheus text or OTLP. */
export interface MetricFamily {
  name: string;
  help: string;
  type: 'gauge' | 'counter' | 'histogram' | 'summary';
  points: MetricPoint[];
}

type FamilyInputs = {
  csmsResponse: Family<Histogram>;
  answers: Family<Counter>;
  callsReceived: Family<Counter>;
  callErrors: Family<Counter>;
  schemaViolations: Family<Counter>;
  frames: Family<Counter>;
  frameBytes: Family<Counter>;
  connections: Family<Counter>;
  disconnects: Family<Counter>;
  transactions: Family<Counter>;
  energy: Family<Counter>;
  turnedAway: Family<Counter>;
  lateWork: Histogram;
  loopWindow: { p50: number; p99: number; max: number; count: number; sumMs: number };
  version: string | undefined;
};

function familiesOf(g: Gauges, m: FamilyInputs): MetricFamily[] {
  const families: MetricFamily[] = [];
  const gauge = (name: string, help: string, points: MetricPoint[]) =>
    families.push({ name, help, type: 'gauge', points });
  const counter = (name: string, help: string, family: Family<Counter>) =>
    families.push({
      name,
      help,
      type: 'counter',
      points: [...family.series.values()].map(({ labels, value }) => ({
        labels,
        value: value.value,
      })),
    });
  const series = (map: Series): MetricPoint[] =>
    [...map.values()].map(({ labels, value }) => ({ labels, value }));

  if (m.version !== undefined) {
    gauge('ocpp_mimic_info', 'The ocpp-mimic version.', [
      { labels: { version: m.version }, value: 1 },
    ]);
  }
  gauge('ocpp_mimic_stations', 'Stations by connection state.', series(g.stationSeries));
  gauge(
    'ocpp_mimic_connectors',
    'Connectors by their last reported status.',
    series(g.connectorSeries),
  );
  families.push({
    name: 'ocpp_mimic_csms_response_seconds',
    help: "Time from a station's CALL to the CSMS's answer.",
    type: 'histogram',
    points: [...m.csmsResponse.series.values()].map(({ labels, value }) => ({
      labels,
      histogram: value,
    })),
  });
  counter(
    'ocpp_mimic_csms_answers_total',
    'Answers to station CALLs: result, error or timeout.',
    m.answers,
  );
  counter('ocpp_mimic_calls_received_total', 'CALLs from the CSMS.', m.callsReceived);
  counter('ocpp_mimic_callerrors_total', 'CALLERRORs, sent and received.', m.callErrors);
  counter(
    'ocpp_mimic_schema_violations_total',
    'Frames the OCA schemas refuse.',
    m.schemaViolations,
  );
  counter('ocpp_mimic_frames_total', 'Frames on the wire.', m.frames);
  counter('ocpp_mimic_frame_bytes_total', 'Bytes of frames on the wire.', m.frameBytes);
  counter('ocpp_mimic_connections_total', 'Connection attempts: opened or failed.', m.connections);
  counter(
    'ocpp_mimic_disconnects_total',
    'Connections lost: local, remote or error.',
    m.disconnects,
  );
  counter(
    'ocpp_mimic_transactions_total',
    'Transactions started, refused and stopped.',
    m.transactions,
  );
  counter('ocpp_mimic_energy_wh_total', 'Energy of finished transactions, in Wh.', m.energy);
  counter(
    'ocpp_mimic_sessions_turned_away_total',
    'Usage model drivers who found no free connector.',
    m.turnedAway,
  );
  gauge('ocpp_mimic_offline_queue_messages', 'Messages waiting for delivery.', [
    { labels: {}, value: g.queued },
  ]);
  families.push({
    name: 'ocpp_mimic_work_lateness_seconds',
    help: 'How late scheduled work ran.',
    type: 'histogram',
    points: [{ labels: {}, histogram: m.lateWork }],
  });
  // A summary over the last 10-second window; quantile 1 is the maximum.
  families.push({
    name: 'ocpp_mimic_eventloop_delay_seconds',
    help: 'Event-loop delay over the last 10 s.',
    type: 'summary',
    points: [
      {
        labels: {},
        summary: {
          quantiles: [
            [0.5, m.loopWindow.p50 / 1000],
            [0.99, m.loopWindow.p99 / 1000],
            [1, m.loopWindow.max / 1000],
          ],
          sum: m.loopWindow.sumMs / 1000,
          count: m.loopWindow.count,
        },
      },
    ],
  });
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  families.push({
    name: 'process_cpu_seconds_total',
    help: 'User and system CPU time.',
    type: 'counter',
    points: [{ labels: {}, value: (cpu.user + cpu.system) / 1e6 }],
  });
  gauge('process_resident_memory_bytes', 'Resident memory.', [{ labels: {}, value: memory.rss }]);
  gauge('nodejs_heap_size_used_bytes', 'V8 heap in use.', [{ labels: {}, value: memory.heapUsed }]);
  return families;
}

/** The Prometheus text format (0.0.4). */
export function prometheusText(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    const { name } = family;
    lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} ${family.type}`);
    for (const point of family.points) {
      if ('value' in point) {
        lines.push(`${name}${labelText(point.labels)} ${point.value}`);
      } else if ('histogram' in point) {
        const h = point.histogram;
        h.buckets.forEach((bound, i) => {
          lines.push(
            `${name}_bucket${labelText(point.labels, { le: String(bound) })} ${h.bucketCounts[i] ?? 0}`,
          );
        });
        lines.push(`${name}_bucket${labelText(point.labels, { le: '+Inf' })} ${h.count}`);
        lines.push(`${name}_sum${labelText(point.labels)} ${h.sum}`);
        lines.push(`${name}_count${labelText(point.labels)} ${h.count}`);
      } else {
        for (const [quantile, value] of point.summary.quantiles) {
          lines.push(`${name}${labelText(point.labels, { quantile: String(quantile) })} ${value}`);
        }
        lines.push(`${name}_sum${labelText(point.labels)} ${point.summary.sum}`);
        lines.push(`${name}_count${labelText(point.labels)} ${point.summary.count}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
