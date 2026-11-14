import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_MAIN, DEFAULT_BENCH, percentiles, runBench } from './bench.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('percentiles', () => {
  it('gives p50, p99 and max', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(values)).toEqual({ count: 100, p50: 51, p99: 100, max: 100 });
    expect(percentiles([])).toEqual({ count: 0, p50: 0, p99: 0, max: 0 });
  });
});

describe('bench', () => {
  // Needs the built CLI (packages/cli/dist/main.js, from tsc -b) to start the CSMS child.
  it.skipIf(!existsSync(CLI_MAIN))(
    'runs stations against ocpp-mimic csms and writes samples and a summary',
    { timeout: 30_000 },
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'ocpp-mimic-bench-'));
      dirs.push(out);
      const lines: string[] = [];
      const { samples, summary } = await runBench(
        {
          ...DEFAULT_BENCH,
          stations: 4,
          rate: 20,
          durationMs: 3000,
          sampleMs: 1000,
          charging: 0.5,
          heartbeatInterval: 1,
          csmsDelay: '0',
          out,
        },
        (line) => lines.push(line),
      );
      expect(summary).toMatchObject({ stations: 4, notAccepted: 0 });
      expect(summary.connectMs.count).toBe(4);
      expect(summary.acceptedMs.count).toBe(4);
      expect(summary.heartbeatLateMs.count).toBeGreaterThan(0);
      expect(samples.at(-1)).toMatchObject({ stations: 4, connected: 4, accepted: 4, charging: 2 });
      expect(lines.at(-1)).toMatch(/csms process/);
      const csv = await readFile(join(out, 'samples.csv'), 'utf8');
      expect(csv.split('\n')[0]).toBe(
        't,stations,connected,accepted,charging,framesOut,framesIn,cpu,rssMb,heapMb,loopP50Ms,loopP99Ms,loopMaxMs',
      );
      expect(JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))).toMatchObject({
        summary: { stations: 4 },
      });
    },
  );
});
