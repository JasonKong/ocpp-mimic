#!/usr/bin/env node
/**
 * `pnpm bench [options]`: runs the benchmark harness (bench.ts). Run node
 * with --cpu-prof to also write a CPU profile.
 */
import { parseArgs } from 'node:util';
import { parseDuration } from '@ocpp-mimic/core';
import { DEFAULT_BENCH, runBench, type BenchOptions } from './bench.js';

const USAGE = `Usage: pnpm bench [options]

  --stations <n>         Stations to run (default ${DEFAULT_BENCH.stations})
  --duration <d>         How long, ramp-up included (default 5m)
  --rate <n>             Stations started a second (default ${DEFAULT_BENCH.rate})
  --persona <id>         Persona (default ${DEFAULT_BENCH.persona}, from scenarios/personas)
  --charging <share>     Share of stations charging on connector 1 (default ${DEFAULT_BENCH.charging})
  --csms-delay <d>[-<d>] The CSMS's answer delay (default ${DEFAULT_BENCH.csmsDelay})
  --sample <d>           Sample interval (default 5s)
  --out <dir>            Write samples.csv and summary.json there
  --store <file>         Keep station state in this SQLite file, as serve --store
  --record-limit <n>     Records kept per station, as serve --record-limit
  --tariff <file>        Reference tariff for the CSMS, sent to 2.1 stations too
                         (as csms --tariff --install-tariff)
  --heap-snapshot        Also write a heap snapshot at the end (needs --out)

CPU profile: node --cpu-prof --cpu-prof-dir=<dir> packages/cli/dist/bench-main.js ...`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    stations: { type: 'string' },
    duration: { type: 'string' },
    rate: { type: 'string' },
    persona: { type: 'string' },
    charging: { type: 'string' },
    'csms-delay': { type: 'string' },
    sample: { type: 'string' },
    out: { type: 'string' },
    store: { type: 'string' },
    'record-limit': { type: 'string' },
    tariff: { type: 'string' },
    'heap-snapshot': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const positive = (name: string, value: string | undefined, fallback: number) => {
  const number = value === undefined ? fallback : Number(value);
  if (!(number > 0)) fail(`--${name} needs a positive number, got ${value}`);
  return number;
};
const duration = (name: string, value: string | undefined, fallback: number) => {
  const ms = value === undefined ? fallback : parseDuration(value);
  if (ms === undefined || ms <= 0) fail(`--${name} needs a duration such as 30s, got ${value}`);
  return ms;
};
function recordLimit(value: string): number {
  const number = Number(value);
  if (!(Number.isInteger(number) && number >= 0))
    fail(`--record-limit needs a whole number, got ${value}`);
  return number;
}

const charging = values.charging === undefined ? DEFAULT_BENCH.charging : Number(values.charging);
if (!(charging >= 0 && charging <= 1)) fail(`--charging needs 0 to 1, got ${values.charging}`);

const options: BenchOptions = {
  ...DEFAULT_BENCH,
  stations: Math.round(positive('stations', values.stations, DEFAULT_BENCH.stations)),
  durationMs: duration('duration', values.duration, DEFAULT_BENCH.durationMs),
  rate: positive('rate', values.rate, DEFAULT_BENCH.rate),
  persona: values.persona ?? DEFAULT_BENCH.persona,
  charging,
  csmsDelay: values['csms-delay'] ?? DEFAULT_BENCH.csmsDelay,
  sampleMs: duration('sample', values.sample, DEFAULT_BENCH.sampleMs),
  ...(values.out !== undefined && { out: values.out }),
  ...(values.store !== undefined && { store: values.store }),
  ...(values['record-limit'] !== undefined && { recordLimit: recordLimit(values['record-limit']) }),
  ...(values.tariff !== undefined && { tariff: values.tariff }),
  heapSnapshot: values['heap-snapshot'] ?? false,
};

try {
  await runBench(options);
} catch (error) {
  console.error(`bench failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
