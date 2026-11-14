/** `ocpp-mimic run`: validate every scenario file, run them, report, and set the exit code. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  formatScenarioResult,
  formatSummary,
  prepareScenarioFiles,
  problemsToJUnit,
  runPreparedScenarios,
  toJUnit,
} from '@ocpp-mimic/engine';
import type { RunCommand } from './command.js';

export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

const console_: Output = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * Runs the command and returns the exit code: 0 when every scenario passed,
 * 1 when any failed or errored, 2 when a file does not validate.
 */
export async function runCommand(command: RunCommand, output: Output = console_): Promise<number> {
  const started = new Date();
  const writeJUnit = async (xml: string) => {
    if (command.junit === undefined) return;
    await mkdir(dirname(command.junit), { recursive: true });
    await writeFile(command.junit, xml);
    output.out(`JUnit report written to ${command.junit}`);
  };
  const prepared = await prepareScenarioFiles(command.paths, {
    vars: command.vars,
    ...(command.csms !== undefined && { csms: command.csms }),
  });
  if (!prepared.ok) {
    for (const problem of prepared.problems) output.err(problem);
    output.err(
      `${prepared.problems.length} problem${prepared.problems.length === 1 ? '' : 's'}; nothing was run`,
    );
    await writeJUnit(problemsToJUnit(prepared.problems, started));
    return 2;
  }
  const summary = await runPreparedScenarios(prepared, {
    vars: command.vars,
    bail: command.bail,
    personaDirs: command.personas,
    allowCsms: command.allowCsms,
    ...(command.csms !== undefined && { csms: command.csms }),
    ...(command.timeoutMs !== undefined && { defaultTimeoutMs: command.timeoutMs }),
    onScenario: (result) => {
      for (const line of formatScenarioResult(result)) output.out(line);
    },
  });
  output.out('');
  output.out(formatSummary(summary));
  await writeJUnit(toJUnit(summary, started));
  return summary.failed + summary.errors === 0 ? 0 : 1;
}
