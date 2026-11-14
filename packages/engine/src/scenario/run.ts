/**
 * Running scenario files: find and validate every file first, then run the
 * scenarios one at a time. This is what `ocpp-mimic run` calls.
 */
import { variableProblems, type Scenario } from '@ocpp-mimic/core';
import { displayPath, findScenarioFiles, readScenarioFile } from './files.js';
import { runScenario, type RunOptions, type ScenarioRunResult } from './runner.js';

export interface FileRun {
  /** The file as shown in reports (relative to the working directory when inside it). */
  file: string;
  results: ScenarioRunResult[];
}

export interface RunSummary {
  files: FileRun[];
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
}

export type PreparedRun =
  | { ok: true; files: { file: string; scenarios: { label: string; scenario: Scenario }[] }[] }
  | { ok: false; problems: string[] };

export interface FilesRunOptions extends RunOptions {
  /** Stop after the first scenario that does not pass. */
  bail?: boolean;
  /** Called after each scenario, for live output. */
  onScenario?: (result: ScenarioRunResult, file: string) => void;
}

/**
 * Finds and validates every scenario in `paths`, including template names
 * against `vars` and built-in CSMS steps against a `csms` override.
 */
export async function prepareScenarioFiles(
  paths: readonly string[],
  options: Pick<RunOptions, 'vars' | 'csms'> = {},
): Promise<PreparedRun> {
  const problems: string[] = [];
  const files: { file: string; scenarios: { label: string; scenario: Scenario }[] }[] = [];
  const found = await findScenarioFiles(paths);
  if (found.length === 0)
    return { ok: false, problems: [`no scenario files in ${paths.join(', ')}`] };
  for (const path of found) {
    const file = displayPath(path);
    const read = await readScenarioFile(path, file);
    problems.push(...read.errors);
    const scenarios: { label: string; scenario: Scenario }[] = [];
    for (const document of read.documents) {
      problems.push(...document.errors);
      const scenario = document.scenario;
      if (scenario === undefined) continue;
      problems.push(
        ...variableProblems(scenario, Object.keys(options.vars ?? {})).map(
          (problem) => `${document.label}: ${problem}`,
        ),
      );
      const csms = options.csms ?? scenario.csms;
      if (
        csms !== 'builtin' &&
        scenario.steps.some((s) => s.kind === 'csmsCall' || s.kind === 'csmsReply')
      ) {
        problems.push(`${document.label}: built-in CSMS steps cannot run against ${csms}`);
      }
      scenarios.push({ label: document.label, scenario });
    }
    files.push({ file, scenarios });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

/** Runs every scenario of a prepared run, one at a time. */
export async function runPreparedScenarios(
  prepared: Extract<PreparedRun, { ok: true }>,
  options: FilesRunOptions = {},
): Promise<RunSummary> {
  const started = Date.now();
  const summary: RunSummary = { files: [], passed: 0, failed: 0, errors: 0, durationMs: 0 };
  outer: for (const { file, scenarios } of prepared.files) {
    const run: FileRun = { file, results: [] };
    summary.files.push(run);
    for (const { label, scenario } of scenarios) {
      const result = await runScenario(scenario, label, options);
      run.results.push(result);
      if (result.status === 'passed') summary.passed++;
      else if (result.status === 'failed') summary.failed++;
      else summary.errors++;
      options.onScenario?.(result, file);
      if (options.bail === true && result.status !== 'passed') break outer;
    }
  }
  summary.durationMs = Date.now() - started;
  return summary;
}
