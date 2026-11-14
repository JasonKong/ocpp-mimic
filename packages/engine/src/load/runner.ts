/**
 * Runs a load plan (docs/design.md, "M4 scale"): creates the plan's stations
 * on an engine, ramps them up, fires the fleet events, watches the engine's
 * health and the CSMS's answers, and judges the thresholds into a report.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  LOG_FORMAT,
  LOG_VERSION,
  logLine,
  seededRandom,
  selectStations,
  usageModel,
  resolveUsage,
  type LoadEvent,
  type LoadPlan,
  type UsageEvent,
} from '@ocpp-mimic/core';
import { startBuiltinCsms, type BuiltinCsms } from '../csms/builtin-csms.js';
import { createEngine, type Engine } from '../engine.js';
import type { FleetEvent } from '../fleet.js';
import type { MetricsSummary } from '../metrics.js';
import type { StationDefinition } from '../state-store.js';

export interface LoadRunOptions {
  plan: LoadPlan;
  personaDirs?: readonly string[];
  allowedCsms?: readonly string[];
  /** Replaces the plan's csms. */
  csms?: string;
  /** Replaces the plan's duration. */
  durationMs?: number;
  /** Also serve the API and Web UI here while running (0: any free port). */
  port?: number;
  webRoot?: string;
  /** Called with a progress line every `progressMs` (default 10 s). */
  progress?: (line: string) => void;
  progressMs?: number;
  /** Called once the engine listens, with its URL. */
  onStart?: (info: { url: string; csms: string }) => void;
  /** Records kept per station (default 10: full once warmed up, so the heap stays flat). */
  recordLimit?: number;
  /** Streams every frame to `<logDir>/frames.jsonl` in ocpp-mimic's log format. */
  logDir?: string;
}

export interface ThresholdResult {
  name: string;
  limit: string;
  measured: string;
  passed: boolean;
}

export interface LoadEventReport {
  atS: number;
  kind: string;
  stations: number;
  /** Seconds from the event's end until every hit station was connected again. */
  recoveredS?: number;
}

export interface LoadReport {
  name: string;
  csms: string;
  stations: number;
  durationS: number;
  startedAt: string;
  passed: boolean;
  thresholds: ThresholdResult[];
  groups: {
    name: string;
    stations: number;
    sessions: number;
    expectedSessions: number;
    refused: number;
    turnedAway: number;
  }[];
  events: LoadEventReport[];
  engine: {
    cpuMeanPercent: number;
    rssMaxMb: number;
    heapFloorMb: { warm: number; end: number };
    eventLoopDelayMs: { p99: number; max: number };
  };
  metrics: MetricsSummary;
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const mb = (bytes: number) => round(bytes / 1024 / 1024);
const LOOP_RESOLUTION_MS = 10;

/** How long an injected event keeps its stations down, so recovery is timed from its end. */
function downtimeMs(event: LoadEvent): number {
  if (event.kind !== 'inject') return 0;
  const { injection } = event.request;
  if (injection.type === 'powerLoss') {
    return injection.offMs * injection.times + injection.onMs * (injection.times - 1);
  }
  if (injection.type === 'flap') return (injection.downMs + injection.upMs) * injection.times;
  return 0;
}

export async function runLoadPlan(options: LoadRunOptions): Promise<LoadReport> {
  const plan = options.plan;
  const durationMs = options.durationMs ?? plan.durationMs;
  const csmsTarget = options.csms ?? plan.csms;
  let csms: BuiltinCsms | undefined;
  let engine: Engine | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  try {
    if (csmsTarget === 'builtin') {
      csms = await startBuiltinCsms({ keepFrames: false, unknownIdTagPrefix: 'UNKNOWN-' });
    }
    const csmsUrl = csms?.url ?? csmsTarget;
    engine = createEngine({
      port: options.port ?? 0,
      recordLimit: options.recordLimit ?? 10,
      ...(options.personaDirs !== undefined && { personaDirs: options.personaDirs }),
      ...(options.allowedCsms !== undefined && { allowedCsms: options.allowedCsms }),
      ...(options.webRoot !== undefined && { webRoot: options.webRoot }),
    });
    const { url } = await engine.start();
    options.onStart?.({ url, csms: csmsUrl });
    const fleet = engine.fleet;
    const personas = engine.personas;
    if (fleet === undefined || personas === undefined) throw new Error('the engine has no fleet');

    // What the metrics do not keep: boot acceptance, usage sessions per group.
    const groupOf = new Map<string, string>();
    for (const group of plan.groups) for (const id of group.ids) groupOf.set(id, group.name);
    const acceptedAt = new Map<string, number>();
    const perGroup = new Map(
      plan.groups.map((g) => [g.name, { sessions: 0, refused: 0, turnedAway: 0 }]),
    );
    const onUsage = (stationId: string, event: UsageEvent) => {
      const counts = perGroup.get(groupOf.get(stationId) ?? '');
      if (counts === undefined) return;
      if (event.type === 'arrived') counts.sessions += 1;
      else if (event.type === 'refused') counts.refused += 1;
      else if (event.type === 'turned-away') counts.turnedAway += 1;
    };
    // The whole log, streamed: the recorder keeps only the last few records.
    let log: WriteStream | undefined;
    if (options.logDir !== undefined) {
      await mkdir(options.logDir, { recursive: true });
      log = createWriteStream(join(options.logDir, 'frames.jsonl'));
      log.write(
        `${JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION, masked: false, source: plan.name })}\n`,
      );
    }
    const unsubscribe = fleet.subscribe((event: FleetEvent) => {
      if (event.type === 'frame' && log !== undefined) {
        const line = logLine(
          new Date().toISOString(),
          event.stationId,
          event.direction,
          event.text,
          {
            ...(event.injected !== undefined && { injected: event.injected }),
            ...(event.dropped === true && { dropped: true }),
          },
        );
        log.write(`${JSON.stringify(line)}\n`);
      }
      if (event.type === 'usage') onUsage(event.stationId, event.event);
      else if (
        event.type === 'frame' &&
        event.direction === 'csms-to-cp' &&
        !acceptedAt.has(event.stationId) &&
        event.text.includes('"interval"') &&
        event.text.includes('"Accepted"')
      ) {
        acceptedAt.set(event.stationId, Date.now());
      }
    });

    // Every group's stations in one ramp-up, in plan order.
    const definitions: StationDefinition[] = plan.groups.flatMap((group) =>
      group.ids.map((id) => ({
        id,
        persona: group.persona,
        csmsUrl,
        group: group.name,
        tags: group.tags,
        usage: group.usage,
        seed: plan.seed,
        ...(group.config !== undefined && { config: group.config }),
        ...(group.password !== undefined && { password: group.password }),
        ...(group.energyMultiplier !== undefined && { energyMultiplier: group.energyMultiplier }),
      })),
    );
    loop.enable();
    const started = Date.now();
    const cpuStart = process.cpuUsage();
    fleet.addMany(definitions, { rampUp: plan.rampUp });
    const rampEnd =
      started + (plan.rampUp === false ? 0 : (definitions.length / plan.rampUp.rate) * 1000);

    // Memory samples every 5 s, for the RSS peak and heap floors.
    const memory: { at: number; rss: number; heap: number }[] = [];
    const sampleMemory = () => {
      const { rss, heapUsed } = process.memoryUsage();
      memory.push({ at: Date.now() - started, rss, heap: heapUsed });
    };
    sampleMemory();
    const memoryTimer = setInterval(sampleMemory, 5000);
    timers.push(memoryTimer);

    // Fleet events, each timing how long its stations take to come back.
    const random = seededRandom(plan.seed);
    const eventReports: LoadEventReport[] = [];
    const recoveries: Promise<void>[] = [];
    for (const event of plan.events) {
      timers.push(
        setTimeout(() => {
          const ids = selectStations(plan, event.stations, random);
          const report: LoadEventReport = {
            atS: round(event.atMs / 1000),
            kind: event.kind === 'inject' ? event.request.injection.type : event.kind,
            stations: ids.length,
          };
          eventReports.push(report);
          for (const id of ids) {
            if (event.kind === 'reconnectStorm') fleet.get(id)?.transport.restartAfter(0);
            else fleet.inject(id, event.request);
          }
          const back = Date.now() + downtimeMs(event);
          recoveries.push(
            new Promise<void>((resolve) => {
              const check = setInterval(() => {
                if (Date.now() < back) return;
                const down = ids.some((id) => fleet.get(id)?.transport.state !== 'open');
                if (down && Date.now() - started < durationMs) return;
                if (!down) report.recoveredS = round((Date.now() - back) / 1000);
                clearInterval(check);
                resolve();
              }, 250);
              timers.push(check);
            }),
          );
        }, event.atMs),
      );
    }

    const progressMs = options.progressMs ?? 10_000;
    if (options.progress !== undefined) {
      const progress = options.progress;
      timers.push(
        setInterval(() => {
          const m = engine?.metrics.summary();
          if (m === undefined) return;
          const elapsed = Math.round((Date.now() - started) / 1000);
          const sessions = [...perGroup.values()].reduce((sum, g) => sum + g.sessions, 0);
          const charging = (m.connectors.Charging ?? 0) + (m.connectors.SuspendedEV ?? 0);
          progress(
            `[${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}] ` +
              `${m.stations.connected ?? 0}/${definitions.length} online, ${charging} charging, ` +
              `${sessions} sessions, CSMS p95 ${m.csmsLatency.overall.p95} ms, ` +
              `${m.callErrors.received + m.callErrors.sent} CALLERRORs, ${m.answers.timeout ?? 0} timeouts`,
          );
        }, progressMs),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await Promise.all(recoveries);
    for (const timer of timers) clearInterval(timer);
    sampleMemory();
    loop.disable();
    unsubscribe();
    if (log !== undefined) {
      const stream = log;
      await new Promise<void>((resolve) => stream.end(resolve));
    }
    const elapsedS = (Date.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuStart);
    const metrics = engine.metrics.summary();

    // Expected sessions: each connector cycles through a wait for the next
    // driver (exponential, mean 1 / rate), the steps and the stay.
    const groups = plan.groups.map((group) => {
      const persona = personas.get(group.persona);
      const counts = perGroup.get(group.name) ?? { sessions: 0, refused: 0, turnedAway: 0 };
      let expected = 0;
      const resolved = resolveUsage(persona?.definition.usage, group.usage);
      if (group.usage !== false && resolved.model !== undefined && persona !== undefined) {
        const model = resolved.model ?? usageModel({ sessionsPerHour: 1 });
        const step = (model.stepMs.min + model.stepMs.max) / 2;
        const cycleMs =
          3_600_000 / model.sessionsPerHour + (model.stayMs.min + model.stayMs.max) / 2 + 2 * step;
        const index = definitions.findIndex((d) => d.group === group.name);
        group.ids.forEach((_, i) => {
          const startMs = plan.rampUp === false ? 0 : ((index + i) / plan.rampUp.rate) * 1000;
          expected += (persona.options.connectors * Math.max(0, durationMs - startMs)) / cycleMs;
        });
      }
      return {
        name: group.name,
        stations: group.ids.length,
        ...counts,
        expectedSessions: round(expected),
      };
    });

    const warmEnd = Math.min(600_000, durationMs / 4);
    const window = Math.min(300_000, durationMs / 8);
    const floor = (from: number, to: number) =>
      Math.min(...memory.filter((s) => s.at >= from && s.at <= to).map((s) => s.heap), Infinity);
    const heapWarm = floor(warmEnd, warmEnd + window);
    const heapEnd = floor(durationMs - window, Infinity);
    const loopP99 = round(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RESOLUTION_MS));
    const loopMax = round(Math.max(0, loop.max / 1e6 - LOOP_RESOLUTION_MS));
    const rssMax = Math.max(...memory.map((s) => s.rss));

    const thresholds = judge(plan, {
      metrics,
      acceptedAt,
      definitions,
      rampEnd,
      events: eventReports,
      loop: { p99: loopP99, max: loopMax },
      rssMax,
      heapWarm,
      heapEnd,
      groups,
    });
    return {
      name: plan.name,
      csms: csmsUrl,
      stations: definitions.length,
      durationS: round(elapsedS),
      startedAt: new Date(started).toISOString(),
      passed: thresholds.every((t) => t.passed),
      thresholds,
      groups,
      events: eventReports,
      engine: {
        cpuMeanPercent: round(((cpu.user + cpu.system) / 1e6 / elapsedS) * 100),
        rssMaxMb: mb(rssMax),
        heapFloorMb: { warm: mb(heapWarm), end: mb(heapEnd) },
        eventLoopDelayMs: { p99: loopP99, max: loopMax },
      },
      metrics,
    };
  } finally {
    for (const timer of timers) clearInterval(timer);
    loop.disable();
    await engine?.stop();
    await csms?.stop();
  }
}

interface Measured {
  metrics: MetricsSummary;
  acceptedAt: Map<string, number>;
  definitions: StationDefinition[];
  rampEnd: number;
  events: LoadEventReport[];
  loop: { p99: number; max: number };
  rssMax: number;
  heapWarm: number;
  heapEnd: number;
  groups: { sessions: number; expectedSessions: number }[];
}

const seconds = (ms: number) => `${round(ms / 1000)} s`;

/** Each threshold the plan sets, with what was measured. */
export function judge(plan: LoadPlan, m: Measured): ThresholdResult[] {
  const t = plan.thresholds;
  const results: ThresholdResult[] = [];
  const add = (name: string, limit: string, measured: string, passed: boolean) =>
    results.push({ name, limit, measured, passed });
  const atMost = (name: string, limit: number | undefined, value: number, unit = '') => {
    if (limit !== undefined) add(name, `<= ${limit}${unit}`, `${value}${unit}`, value <= limit);
  };

  if (t.bootAcceptedWithinMs !== undefined) {
    const missing = m.definitions.filter((d) => !m.acceptedAt.has(d.id)).length;
    const latest = Math.max(m.rampEnd, ...m.acceptedAt.values());
    const after = Math.max(0, latest - m.rampEnd);
    add(
      'bootAcceptedWithin',
      `every station within ${seconds(t.bootAcceptedWithinMs)} after the ramp-up`,
      missing > 0 ? `${missing} never accepted` : `the last ${seconds(after)} after`,
      missing === 0 && after <= t.bootAcceptedWithinMs,
    );
  }
  if (t.recoverWithinMs !== undefined) {
    const notBack = m.events.filter((e) => e.recoveredS === undefined);
    const slowest = Math.max(0, ...m.events.map((e) => e.recoveredS ?? 0));
    add(
      'recoverWithin',
      `every event within ${seconds(t.recoverWithinMs)}`,
      notBack.length > 0
        ? `${notBack.map((e) => `${e.kind} at ${e.atS} s`).join(', ')} not recovered`
        : m.events.length === 0
          ? 'no events'
          : `slowest ${slowest} s`,
      notBack.length === 0 && slowest * 1000 <= t.recoverWithinMs,
    );
  }
  atMost(
    'unexpectedDisconnects',
    t.unexpectedDisconnects,
    (m.metrics.disconnects.remote ?? 0) + (m.metrics.disconnects.error ?? 0),
  );
  if (t.lateWork !== undefined) {
    atMost('lateWork p99', t.lateWork.p99Ms, m.metrics.lateWork.p99, ' ms');
    atMost('lateWork max', t.lateWork.maxMs, m.metrics.lateWork.max, ' ms');
  }
  if (t.csmsLatency !== undefined) {
    for (const [q, limit] of [
      ['p95', t.csmsLatency.p95Ms],
      ['p99', t.csmsLatency.p99Ms],
    ] as const) {
      if (limit === undefined) continue;
      const overall = m.metrics.csmsLatency.overall[q];
      const worst = Object.entries(m.metrics.csmsLatency.byAction).sort(
        ([, a], [, b]) => b[q] - a[q],
      )[0];
      const worstValue = worst?.[1][q] ?? 0;
      add(
        `csmsLatency ${q}`,
        `<= ${limit} ms, overall and per action`,
        `overall ${overall} ms; slowest ${worst?.[0] ?? '-'} ${worstValue} ms`,
        overall <= limit && worstValue <= limit,
      );
    }
  }
  atMost('timeouts', t.timeouts, m.metrics.answers.timeout ?? 0);
  atMost('callErrors', t.callErrors, m.metrics.callErrors.sent + m.metrics.callErrors.received);
  atMost('schemaViolations', t.schemaViolations, m.metrics.schemaViolations);
  if (t.eventLoopDelay !== undefined) {
    atMost('eventLoopDelay p99', t.eventLoopDelay.p99Ms, m.loop.p99, ' ms');
    atMost('eventLoopDelay max', t.eventLoopDelay.maxMs, m.loop.max, ' ms');
  }
  if (t.memory?.rssBytes !== undefined) {
    add(
      'memory rss',
      `<= ${mb(t.memory.rssBytes)} MB`,
      `${mb(m.rssMax)} MB`,
      m.rssMax <= t.memory.rssBytes,
    );
  }
  if (t.memory?.heapGrowth !== undefined) {
    const growth = m.heapWarm > 0 && Number.isFinite(m.heapWarm) ? m.heapEnd / m.heapWarm - 1 : 0;
    add(
      'memory heapGrowth',
      `heap floor at the end <= ${round(t.memory.heapGrowth * 100)} % above the floor after warm-up`,
      `${mb(m.heapWarm)} -> ${mb(m.heapEnd)} MB (${round(growth * 100)} %)`,
      growth <= t.memory.heapGrowth,
    );
  }
  if (t.sessions !== undefined) {
    const sessions = m.groups.reduce((sum, g) => sum + g.sessions, 0);
    const expected = m.groups.reduce((sum, g) => sum + g.expectedSessions, 0);
    const share = expected > 0 ? sessions / expected : 1;
    add(
      'sessions',
      `>= ${round(t.sessions.min * 100)} % of the expected ${round(expected, 0)}`,
      `${sessions} (${round(share * 100)} %)`,
      share >= t.sessions.min,
    );
  }
  return results;
}
