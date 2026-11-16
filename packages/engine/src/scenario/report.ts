/** Console output for scenario runs. */
import { formatDuration } from '@ocpp-mimic/core';
import type { RunSummary } from './run.js';
import type { ScenarioRunResult } from './runner.js';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const MARK = { passed: 'PASS ', failed: 'FAIL ', error: 'ERROR' } as const;

/** Lines for one scenario: a status line, then the failing step or the error. */
export function formatScenarioResult(result: ScenarioRunResult): string[] {
  const facts = [
    seconds(result.durationMs),
    ...(result.properties.energyMultiplier !== undefined
      ? [`energy ${result.properties.energyMultiplier}`]
      : []),
    // A sleeping laptop stretches the time; say so instead of leaving a mystery.
    ...(result.hostAsleepMs !== undefined
      ? [`host asleep ${formatDuration(result.hostAsleepMs)}`]
      : []),
  ];
  const lines = [`${MARK[result.status]} ${result.name} (${facts.join(', ')})  ${result.label}`];
  if (result.status === 'error' && result.error !== undefined) {
    for (const line of result.error.split('\n')) lines.push(`      ${line}`);
  }
  const failing = result.steps.find((step) => step.status === 'failed');
  if (failing !== undefined) {
    lines.push(`      step ${failing.index + 1}: ${failing.label}`);
    if (failing.message !== undefined) lines.push(`        ${failing.message}`);
    for (const detail of failing.details ?? []) lines.push(`        ${detail}`);
  }
  return lines;
}

/** The closing line: counts and total time. */
export function formatSummary(summary: RunSummary): string {
  const parts = [`${summary.passed} passed`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.errors > 0) parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  return `${parts.join(', ')} (${formatDuration(summary.durationMs)})`;
}
