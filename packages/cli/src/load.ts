/** `ocpp-mimic load <plan>`: runs a load plan and writes its report. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ALLOWED_CSMS,
  readLoadPlan,
  reportJunit,
  reportLines,
  reportMarkdown,
  runLoadPlan,
  type OtlpOptions,
} from '@ocpp-mimic/engine';
import type { LoadCommand } from './command.js';

export interface LoadIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const CONSOLE: LoadIo = { out: console.log, err: console.error };

/** 0 when every threshold passed, 1 when one failed, 2 when the plan could not run. */
export async function runLoadCommand(
  command: LoadCommand,
  io: LoadIo = CONSOLE,
  otlp?: OtlpOptions,
): Promise<number> {
  const read = await readLoadPlan(command.plan);
  if (!read.ok) {
    for (const problem of read.problems) io.err(problem);
    return 2;
  }
  const plan = read.plan;
  const stations = plan.groups.reduce((sum, g) => sum + g.ids.length, 0);
  let report;
  try {
    report = await runLoadPlan({
      plan,
      personaDirs: command.personas,
      allowedCsms: [...DEFAULT_ALLOWED_CSMS, ...command.allowCsms],
      ...(command.csms !== undefined && { csms: command.csms }),
      ...(command.durationMs !== undefined && { durationMs: command.durationMs }),
      ...(command.port !== undefined && { port: command.port }),
      ...(command.webRoot !== undefined && { webRoot: command.webRoot }),
      ...(command.recordLimit !== undefined && { recordLimit: command.recordLimit }),
      ...(command.logDir !== undefined && { logDir: command.logDir }),
      ...(otlp !== undefined && { otlp }),
      progress: io.out,
      onStart: ({ url, csms }) => {
        io.out(`ocpp-mimic load: ${plan.name}: ${stations} stations against ${csms}`);
        if (command.port !== undefined) io.out(`API, Web UI and /metrics on ${url}`);
      },
    });
  } catch (error) {
    io.err(`load failed: ${(error as Error).message}`);
    return 2;
  }
  for (const line of reportLines(report)) io.out(line);
  if (command.reportDir !== undefined) {
    await mkdir(command.reportDir, { recursive: true });
    await writeFile(join(command.reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(command.reportDir, 'report.md'), reportMarkdown(report));
  }
  if (command.junit !== undefined) {
    await mkdir(dirname(command.junit), { recursive: true });
    await writeFile(command.junit, reportJunit(report));
  }
  return report.passed ? 0 : 1;
}
