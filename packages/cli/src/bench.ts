/**
 * Benchmark harness (`pnpm bench`): N stations in this process, run the way
 * `ocpp-mimic serve` runs them, against `ocpp-mimic csms` in a child process.
 * It samples the engine's health over time (event-loop delay, CPU, memory,
 * frames) and measures how late scheduled messages go out, so the engine's
 * bottlenecks can be found before anything is changed (docs/design.md,
 * "M4 scale").
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeHeapSnapshot } from 'node:v8';
import { createEngine, resolveEv, type Engine, type FleetEvent } from '@ocpp-mimic/engine';

/** The built CLI (from src/ and dist/ alike), which runs the CSMS child. */
export const CLI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
export const BENCH_PERSONAS = fileURLToPath(
  new URL('../../../scenarios/personas/', import.meta.url),
);

export interface BenchOptions {
  stations: number;
  durationMs: number;
  /** Stations started per second. */
  rate: number;
  persona: string;
  personaDirs: string[];
  /** Share of stations that charge on connector 1 once accepted (0 to 1). */
  charging: number;
  /** EV profile the charging stations plug in. */
  ev: string;
  /** The CSMS's answer delay, as for `ocpp-mimic csms --delay`. */
  csmsDelay: string;
  /** Seconds, given by the CSMS in BootNotification answers. */
  heartbeatInterval: number;
  /** MeterValueSampleInterval of the persona, in seconds, to measure meter values against. */
  meterInterval: number;
  sampleMs: number;
  /** Directory for samples.csv and summary.json. */
  out?: string;
  /** SQLite file for station state, as `serve --store`; none by default. */
  store?: string;
  /** Records kept per station, as `serve --record-limit` (default 1000). */
  recordLimit?: number;
  heapSnapshot: boolean;
}

export const DEFAULT_BENCH: BenchOptions = {
  stations: 100,
  durationMs: 5 * 60_000,
  rate: 20,
  persona: 'load-ac-1.6',
  personaDirs: [BENCH_PERSONAS],
  charging: 0.3,
  ev: 'compact-40kwh',
  csmsDelay: '20ms-100ms',
  heartbeatInterval: 60,
  meterInterval: 60,
  sampleMs: 5000,
  heapSnapshot: false,
};

export interface Sample {
  /** Seconds since the first station was added. */
  t: number;
  stations: number;
  connected: number;
  accepted: number;
  charging: number;
  /** Frames a second over the sample, each way. */
  framesOut: number;
  framesIn: number;
  /** Engine CPU over the sample, in % of one core. */
  cpu: number;
  rssMb: number;
  heapMb: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
}

export interface Percentiles {
  count: number;
  p50: number;
  p99: number;
  max: number;
}

export interface BenchSummary {
  stations: number;
  durationS: number;
  /** Station added to its WebSocket open. */
  connectMs: Percentiles;
  /** Station added to BootNotification Accepted. */
  acceptedMs: Percentiles;
  /** How much later than the heartbeat interval each heartbeat went out. */
  heartbeatLateMs: Percentiles;
  /** How much later than the sample interval each periodic MeterValues went out. */
  meterLateMs: Percentiles;
  /** Over all samples after the ramp-up. */
  steady: { cpuMean: number; cpuMax: number; loopP99MaxMs: number; loopMaxMs: number };
  rssMaxMb: number;
  /** Lowest heap of the first and the last quarter of the run (GC floors). */
  heapFloorMb: { first: number; last: number };
  frames: { out: number; in: number };
  csms: { cpuSeconds?: number; rssMb?: number };
  notAccepted: number;
}

export function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
/**
 * monitorEventLoopDelay's sampling interval. What it records includes the
 * interval itself (an idle loop shows about 10 ms), so it is subtracted.
 */
const LOOP_RESOLUTION_MS = 10;
const loopMs = (nanoseconds: number) => round(Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS));
const mb = (bytes: number) => round(bytes / 1024 / 1024);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts `ocpp-mimic csms` on a free port and resolves with its URL. */
async function startCsms(options: BenchOptions): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    [
      CLI_MAIN,
      'csms',
      '--port',
      '0',
      '--delay',
      options.csmsDelay,
      '--heartbeat-interval',
      String(options.heartbeatInterval),
      '--status',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const match = /listening on (\S+)\/<chargeBoxId>/.exec(text);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    child.once('exit', (code) => reject(new Error(`ocpp-mimic csms exited with ${code}`)));
  });
  return { url, child };
}

/** CPU seconds and RSS of another process, from ps (macOS and Linux). */
async function processUsage(pid: number): Promise<{ cpuSeconds?: number; rssMb?: number }> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'time=,rss=', '-p', String(pid)]);
    const [time = '', rss = ''] = stdout.trim().split(/\s+/);
    // [[dd-]hh:]mm:ss[.ff]
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
    const seconds = (clock ?? '')
      .split(':')
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0);
    return { cpuSeconds: round(Number(days) * 86400 + seconds), rssMb: round(Number(rss) / 1024) };
  } catch {
    return {};
  }
}

export async function runBench(
  options: BenchOptions,
  log: (line: string) => void = console.log,
): Promise<{ samples: Sample[]; summary: BenchSummary }> {
  const csms = await startCsms(options);
  let engine: Engine | undefined;
  try {
    // Frames and transport events, counted without touching the engine's own work.
    let framesOut = 0;
    let framesIn = 0;
    const connectedIds = new Set<string>();
    const addedAt = new Map<string, number>();
    const connectMs: number[] = [];
    const lastHeartbeat = new Map<string, number>();
    const heartbeatLate: number[] = [];
    const lastMeter = new Map<string, number>();
    const meterLate: number[] = [];
    const acceptedMs: number[] = [];
    const pendingAccept = new Set<string>();
    const pendingCharge = new Set<string>();
    const readyToCharge: string[] = [];
    const onEvent = (event: FleetEvent) => {
      if (event.type === 'frame') {
        if (event.direction === 'cp-to-csms') {
          framesOut += 1;
          const now = performance.now();
          if (event.text.includes('"Heartbeat"')) {
            const last = lastHeartbeat.get(event.stationId);
            if (last !== undefined)
              heartbeatLate.push(now - last - options.heartbeatInterval * 1000);
            lastHeartbeat.set(event.stationId, now);
          } else if (event.text.includes('"Sample.Periodic"')) {
            const last = lastMeter.get(event.stationId);
            if (last !== undefined) meterLate.push(now - last - options.meterInterval * 1000);
            lastMeter.set(event.stationId, now);
          }
        } else {
          framesIn += 1;
          // Only BootNotification answers carry an interval.
          if (
            event.text.includes('"interval"') &&
            event.text.includes('"Accepted"') &&
            pendingAccept.delete(event.stationId)
          ) {
            acceptedMs.push(performance.now() - (addedAt.get(event.stationId) ?? 0));
            if (pendingCharge.has(event.stationId)) readyToCharge.push(event.stationId);
          }
        }
      } else if (event.type === 'transport' && event.event.type === 'state') {
        if (event.event.state === 'open') {
          if (!connectedIds.has(event.stationId)) {
            const added = addedAt.get(event.stationId);
            if (added !== undefined) connectMs.push(performance.now() - added);
          }
          connectedIds.add(event.stationId);
        } else {
          connectedIds.delete(event.stationId);
          // A gap across a reconnect is not lateness.
          lastHeartbeat.delete(event.stationId);
          lastMeter.delete(event.stationId);
        }
      }
    };

    engine = createEngine({
      port: 0,
      personaDirs: options.personaDirs,
      ...(options.store !== undefined && { storePath: options.store }),
      ...(options.recordLimit !== undefined && { recordLimit: options.recordLimit }),
    });
    await engine.start();
    const fleet = engine.fleet;
    if (fleet === undefined) throw new Error('the engine has no fleet');
    if (engine.personas?.get(options.persona) === undefined) {
      throw new Error(`unknown persona ${options.persona}`);
    }
    // The engine's own event handler stays in place; the bench listens beside it.
    const unsubscribe = fleet.subscribe(onEvent);

    const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    loop.enable();
    const samples: Sample[] = [];
    const started = performance.now();
    let charging = 0;
    let cpu = process.cpuUsage();
    let wall = performance.now();
    let lastFramesOut = 0;
    let lastFramesIn = 0;

    const takeSample = () => {
      const now = performance.now();
      const used = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      const seconds = (now - wall) / 1000;
      samples.push({
        t: round((now - started) / 1000),
        stations: addedAt.size,
        connected: connectedIds.size,
        accepted: addedAt.size - pendingAccept.size,
        charging,
        framesOut: round((framesOut - lastFramesOut) / seconds),
        framesIn: round((framesIn - lastFramesIn) / seconds),
        cpu: round(((used.user + used.system) / 1e6 / seconds) * 100),
        rssMb: mb(memory.rss),
        heapMb: mb(memory.heapUsed),
        loopP50Ms: loopMs(loop.percentile(50)),
        loopP99Ms: loopMs(loop.percentile(99)),
        loopMaxMs: loopMs(loop.max),
      });
      const sample = samples.at(-1);
      if (sample !== undefined) log(formatSample(sample));
      loop.reset();
      cpu = process.cpuUsage();
      wall = now;
      lastFramesOut = framesOut;
      lastFramesIn = framesIn;
    };

    // Accepted stations that should charge start once a second.
    const watch = setInterval(() => {
      for (const id of readyToCharge.splice(0)) {
        const station = fleet.get(id);
        if (station === undefined) continue;
        station.chargePoint.plugIn(1, resolveEv(station, options.ev));
        void station.chargePoint.presentIdTag(1, `BENCH-${id}`).then((result) => {
          if (result === 'authorized') charging += 1;
        });
      }
    }, 1000);

    log(`ocpp-mimic bench: ${options.stations} stations of ${options.persona} against ${csms.url}`);
    log(SAMPLE_HEADER);
    const sampler = setInterval(takeSample, options.sampleMs);
    const chargeEvery = options.charging > 0 ? 1 / options.charging : Infinity;
    for (let i = 0; i < options.stations; i++) {
      const id = `BENCH-${String(i + 1).padStart(4, '0')}`;
      addedAt.set(id, performance.now());
      pendingAccept.add(id);
      if (Math.floor((i + 1) / chargeEvery) > Math.floor(i / chargeEvery)) pendingCharge.add(id);
      fleet.add({ id, persona: options.persona, csmsUrl: csms.url });
      // Spread the starts evenly at `rate` a second.
      const due = started + ((i + 1) / options.rate) * 1000;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const rampS = (performance.now() - started) / 1000;
    const remaining = options.durationMs - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
    clearInterval(sampler);
    clearInterval(watch);
    takeSample();
    loop.disable();
    unsubscribe();

    if (options.heapSnapshot && options.out !== undefined) {
      await mkdir(options.out, { recursive: true });
      writeHeapSnapshot(join(options.out, 'engine.heapsnapshot'));
    }

    const steady = samples.filter((s) => s.t > rampS + options.sampleMs / 1000);
    const quarter = Math.max(1, Math.floor(samples.length / 4));
    const floor = (list: Sample[]) => Math.min(...list.map((s) => s.heapMb));
    const summary: BenchSummary = {
      stations: options.stations,
      durationS: round((performance.now() - started) / 1000),
      connectMs: percentiles(connectMs),
      acceptedMs: percentiles(acceptedMs),
      heartbeatLateMs: percentiles(heartbeatLate),
      meterLateMs: percentiles(meterLate),
      steady: {
        cpuMean: round(steady.reduce((sum, s) => sum + s.cpu, 0) / Math.max(1, steady.length)),
        cpuMax: Math.max(0, ...steady.map((s) => s.cpu)),
        loopP99MaxMs: Math.max(0, ...steady.map((s) => s.loopP99Ms)),
        loopMaxMs: Math.max(0, ...steady.map((s) => s.loopMaxMs)),
      },
      rssMaxMb: Math.max(0, ...samples.map((s) => s.rssMb)),
      heapFloorMb: {
        first: floor(samples.slice(0, quarter)),
        last: floor(samples.slice(-quarter)),
      },
      frames: { out: framesOut, in: framesIn },
      csms: csms.child.pid === undefined ? {} : await processUsage(csms.child.pid),
      notAccepted: pendingAccept.size,
    };
    if (options.out !== undefined) {
      await mkdir(options.out, { recursive: true });
      await writeFile(join(options.out, 'samples.csv'), samplesCsv(samples));
      await writeFile(
        join(options.out, 'summary.json'),
        `${JSON.stringify({ options, summary }, null, 2)}\n`,
      );
    }
    log(formatSummary(summary));
    return { samples, summary };
  } finally {
    await engine?.stop();
    csms.child.kill('SIGTERM');
  }
}

const SAMPLE_HEADER =
  '     t  stations connected accepted charging  out/s   in/s   cpu%  rssMB heapMB loop p50/p99/max ms';

function formatSample(s: Sample): string {
  const pad = (value: number | string, width: number) => String(value).padStart(width);
  return (
    `${pad(s.t, 6)} ${pad(s.stations, 9)} ${pad(s.connected, 9)} ${pad(s.accepted, 8)} ` +
    `${pad(s.charging, 8)} ${pad(s.framesOut, 6)} ${pad(s.framesIn, 6)} ${pad(s.cpu, 6)} ` +
    `${pad(s.rssMb, 6)} ${pad(s.heapMb, 6)} ${s.loopP50Ms}/${s.loopP99Ms}/${s.loopMaxMs}`
  );
}

function samplesCsv(samples: Sample[]): string {
  const keys = Object.keys(samples[0] ?? {}) as (keyof Sample)[];
  return [keys.join(','), ...samples.map((s) => keys.map((k) => s[k]).join(','))].join('\n') + '\n';
}

export function formatSummary(s: BenchSummary): string {
  const p = (x: Percentiles) => `p50 ${x.p50}, p99 ${x.p99}, max ${x.max} (n=${x.count})`;
  return [
    `Summary: ${s.stations} stations for ${s.durationS} s, ${s.notAccepted} not accepted`,
    `  connect ms          ${p(s.connectMs)}`,
    `  accepted ms         ${p(s.acceptedMs)}`,
    `  heartbeat late ms   ${p(s.heartbeatLateMs)}`,
    `  meter values late ms ${p(s.meterLateMs)}`,
    `  steady CPU          mean ${s.steady.cpuMean} %, max ${s.steady.cpuMax} %`,
    `  steady loop delay   p99 up to ${s.steady.loopP99MaxMs} ms, max ${s.steady.loopMaxMs} ms`,
    `  memory              RSS up to ${s.rssMaxMb} MB; heap floor ${s.heapFloorMb.first} -> ${s.heapFloorMb.last} MB`,
    `  frames              ${s.frames.out} sent, ${s.frames.in} received`,
    `  csms process        ${s.csms.cpuSeconds ?? '?'} CPU s, ${s.csms.rssMb ?? '?'} MB`,
  ].join('\n');
}
