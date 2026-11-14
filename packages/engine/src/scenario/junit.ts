/**
 * JUnit XML for scenario runs: one testsuite per file, one testcase per
 * scenario (classname = the file), failure / error with the failing step,
 * durations, and properties such as persona, CSMS and energy multiplier.
 * The layout follows the common JUnit format that CI test reporters read.
 */
import type { RunSummary } from './run.js';
import type { ScenarioRunResult } from './runner.js';

/** Characters XML 1.0 does not allow, even escaped. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escape(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

function testcase(result: ScenarioRunResult, file: string): string[] {
  const lines = [
    `    <testcase name="${escape(result.name)}" classname="${escape(file)}" time="${seconds(result.durationMs)}">`,
  ];
  const properties = { label: result.label, ...result.properties };
  lines.push('      <properties>');
  for (const [name, value] of Object.entries(properties)) {
    lines.push(`        <property name="${escape(name)}" value="${escape(value)}"/>`);
  }
  lines.push('      </properties>');

  const failing = result.steps.find((step) => step.status === 'failed');
  if (result.status === 'error') {
    const message = result.error ?? failing?.message ?? 'error';
    lines.push(
      `      <error message="${escape(message.split('\n')[0] ?? message)}" type="error">${escape(message)}</error>`,
    );
  } else if (result.status === 'failed' && failing !== undefined) {
    const message = `step ${failing.index + 1}: ${failing.label}: ${failing.message ?? 'failed'}`;
    const body = [message, ...(failing.details ?? [])].join('\n');
    lines.push(`      <failure message="${escape(message)}" type="step">${escape(body)}</failure>`);
  }
  const log = result.steps.map(
    (step) =>
      `${step.status.toUpperCase().padEnd(7)} ${String(step.index + 1).padStart(2)}. ${step.label} (${seconds(step.durationMs)}s)${step.message !== undefined ? ` - ${step.message}` : ''}`,
  );
  if (log.length > 0) lines.push(`      <system-out>${escape(log.join('\n'))}</system-out>`);
  lines.push('    </testcase>');
  return lines;
}

/** The JUnit XML document for a run. `timestamp` is when the run started. */
export function toJUnit(summary: RunSummary, timestamp: Date = new Date()): string {
  const count = (results: ScenarioRunResult[], status: ScenarioRunResult['status']) =>
    results.filter((r) => r.status === status).length;
  const all = summary.files.flatMap((f) => f.results);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ocpp-mimic" tests="${all.length}" failures="${count(all, 'failed')}" errors="${count(all, 'error')}" skipped="0" time="${seconds(summary.durationMs)}">`,
  ];
  for (const { file, results } of summary.files) {
    const time = results.reduce((sum, r) => sum + r.durationMs, 0);
    lines.push(
      `  <testsuite name="${escape(file)}" tests="${results.length}" failures="${count(results, 'failed')}" errors="${count(results, 'error')}" skipped="0" time="${seconds(time)}" timestamp="${timestamp.toISOString().slice(0, 19)}">`,
    );
    for (const result of results) lines.push(...testcase(result, file));
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}

/** A JUnit document for files that did not validate: one error testcase per problem. */
export function problemsToJUnit(problems: readonly string[], timestamp: Date = new Date()): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ocpp-mimic" tests="${problems.length}" failures="0" errors="${problems.length}" skipped="0" time="0.000">`,
    `  <testsuite name="validation" tests="${problems.length}" failures="0" errors="${problems.length}" skipped="0" time="0.000" timestamp="${timestamp.toISOString().slice(0, 19)}">`,
  ];
  for (const problem of problems) {
    const [where] = problem.split(': ');
    lines.push(
      `    <testcase name="${escape(where ?? problem)}" classname="validation" time="0.000">`,
      `      <error message="${escape(problem)}" type="invalid"/>`,
      '    </testcase>',
    );
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}
