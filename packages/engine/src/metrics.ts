/**
 * Metrics: counters, gauges and latency histograms over the fleet's frames
 * and connections (docs/design.md, "M4 scale"). They come from the frames as
 * recorded on the wire and from transport events, so they work with the Event
 * Recorder keeping nothing. Labels stay at action, persona and group, so
 * 1,000 stations cost no more series than one. Served as Prometheus text and
 * as JSON.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RpcEvent } from '@ocpp-mimic/core';
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
  /** A station's persona and group, for labels. */
  labelsOf(stationId: string): { persona: string; group: string } | undefined;
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
}

export interface Metrics {
  /** A frame as recorded on the wire (after the Fault Injector). */
  frame(record: FrameRecord): void;
  transport(stationId: string, event: TransportEvent): void;
  rpc(stationId: string, event: RpcEvent): void;
  /** How late scheduled work ran, in milliseconds. */
  lateness(ms: number): void;
  /** A station was removed: its in-flight CALLs and connector statuses are forgotten. */
  forget(stationId: string): void;
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
});
const round = (value: number) => Math.round(value * 10) / 10;

export function createMetrics(options: MetricsOptions): Metrics {
  const now = options.now ?? Date.now;
  const labels = (stationId: string) => options.labelsOf(stationId) ?? { persona: '', group: '' };

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
    if (call.action === 'StartTransaction') {
      transactions.get({ outcome: status === 'Accepted' ? 'started' : 'refused' }).value += 1;
      const meterStart = (call.payload as { meterStart?: number }).meterStart;
      if (typeof payload.transactionId === 'number' && typeof meterStart === 'number') {
        meterStarts.set(`${record.stationId} ${payload.transactionId}`, meterStart);
      }
    } else if (call.action === 'StopTransaction') {
      transactions.get({ outcome: 'stopped' }).value += 1;
    }
  }

  return {
    frame(record) {
      const direction = record.direction === 'cp-to-csms' ? 'sent' : 'received';
      if (record.dropped !== true) {
        frames.get({ direction }).value += 1;
        frameBytes.get({ direction }).value += Buffer.byteLength(record.text);
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
          if (payload.connectorId > 0) connectors.set(payload.connectorId, String(payload.status));
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
        connections.get({ outcome: 'opened' }).value += 1;
      } else if (event.type === 'close' && open.has(stationId)) {
        // The CSMS closed it, or the connection broke (1006: no close frame).
        open.delete(stationId);
        disconnects.get({ cause: event.code === 1006 ? 'error' : 'remote' }).value += 1;
      } else if (event.type === 'state' && event.state !== 'open' && event.state !== 'connecting') {
        if (attempting.delete(stationId)) connections.get({ outcome: 'failed' }).value += 1;
        // Closed without a close event: the station dropped it itself (stopped,
        // taken offline, an injection, a reset).
        if (open.delete(stationId)) disconnects.get({ cause: 'local' }).value += 1;
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

    forget(stationId) {
      const prefix = `${stationId} `;
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      for (const key of meterStarts.keys()) if (key.startsWith(prefix)) meterStarts.delete(key);
      statuses.delete(stationId);
      open.delete(stationId);
      attempting.delete(stationId);
    },

    prometheus() {
      return prometheusText(gauges(), {
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
        lateWork,
        loopWindow,
        version: options.version,
      });
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

function prometheusText(
  g: Gauges,
  m: {
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
    lateWork: Histogram;
    loopWindow: { p50: number; p99: number; max: number; count: number; sumMs: number };
    version: string | undefined;
  },
): string {
  const lines: string[] = [];
  const header = (name: string, type: string, help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const gaugeSeries = (name: string, help: string, series: Series) => {
    header(name, 'gauge', help);
    for (const { labels, value } of series.values())
      lines.push(`${name}${labelText(labels)} ${value}`);
  };
  const counter = (name: string, help: string, family: Family<Counter>) => {
    header(name, 'counter', help);
    for (const { labels, value } of family.series.values()) {
      lines.push(`${name}${labelText(labels)} ${value.value}`);
    }
  };
  const histogram = (
    name: string,
    help: string,
    entries: { labels: Record<string, string>; value: Histogram }[],
  ) => {
    header(name, 'histogram', help);
    for (const { labels, value } of entries) {
      value.buckets.forEach((bound, i) => {
        lines.push(
          `${name}_bucket${labelText(labels, { le: String(bound) })} ${value.bucketCounts[i] ?? 0}`,
        );
      });
      lines.push(`${name}_bucket${labelText(labels, { le: '+Inf' })} ${value.count}`);
      lines.push(`${name}_sum${labelText(labels)} ${value.sum}`);
      lines.push(`${name}_count${labelText(labels)} ${value.count}`);
    }
  };

  if (m.version !== undefined) {
    header('ocpp_mimic_info', 'gauge', 'The ocpp-mimic version.');
    lines.push(`ocpp_mimic_info${labelText({ version: m.version })} 1`);
  }
  gaugeSeries('ocpp_mimic_stations', 'Stations by connection state.', g.stationSeries);
  gaugeSeries(
    'ocpp_mimic_connectors',
    'Connectors by their last reported status.',
    g.connectorSeries,
  );
  histogram(
    'ocpp_mimic_csms_response_seconds',
    "Time from a station's CALL to the CSMS's answer.",
    [...m.csmsResponse.series.values()],
  );
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
  header('ocpp_mimic_offline_queue_messages', 'gauge', 'Messages waiting for delivery.');
  lines.push(`ocpp_mimic_offline_queue_messages ${g.queued}`);
  histogram('ocpp_mimic_work_lateness_seconds', 'How late scheduled work ran.', [
    { labels: {}, value: m.lateWork },
  ]);
  // A summary over the last 10-second window; quantile 1 is the maximum.
  header('ocpp_mimic_eventloop_delay_seconds', 'summary', 'Event-loop delay over the last 10 s.');
  for (const [quantile, ms] of [
    ['0.5', m.loopWindow.p50],
    ['0.99', m.loopWindow.p99],
    ['1', m.loopWindow.max],
  ] as const) {
    lines.push(`ocpp_mimic_eventloop_delay_seconds${labelText({ quantile })} ${ms / 1000}`);
  }
  lines.push(`ocpp_mimic_eventloop_delay_seconds_sum ${m.loopWindow.sumMs / 1000}`);
  lines.push(`ocpp_mimic_eventloop_delay_seconds_count ${m.loopWindow.count}`);
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  header('process_cpu_seconds_total', 'counter', 'User and system CPU time.');
  lines.push(`process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
  header('process_resident_memory_bytes', 'gauge', 'Resident memory.');
  lines.push(`process_resident_memory_bytes ${memory.rss}`);
  header('nodejs_heap_size_used_bytes', 'gauge', 'V8 heap in use.');
  lines.push(`nodejs_heap_size_used_bytes ${memory.heapUsed}`);
  return `${lines.join('\n')}\n`;
}
