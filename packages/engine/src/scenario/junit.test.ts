import { describe, expect, it } from 'vitest';
import { problemsToJUnit, toJUnit } from './junit.js';
import type { RunSummary } from './run.js';
import type { ScenarioRunResult } from './runner.js';

const AT = new Date('2026-11-14T10:00:00Z');
const base = { properties: { persona: 'generic-1.6', csms: 'builtin' } };

const passed: ScenarioRunResult = {
  ...base,
  name: 'Card session',
  label: 'examples/card.yaml#1',
  status: 'passed',
  durationMs: 1234,
  steps: [
    { index: 0, label: 'presentCard TAG at connector 1', status: 'passed', durationMs: 12 },
    { index: 1, label: 'plugIn connector 1', status: 'passed', durationMs: 3 },
  ],
};

const failed: ScenarioRunResult = {
  name: 'Fast EV <with> "quotes" & ampersands',
  label: 'examples/card.yaml#2',
  status: 'failed',
  durationMs: 2500,
  properties: { ...base.properties, energyMultiplier: '×60' },
  steps: [
    { index: 0, label: 'plugIn connector 1', status: 'passed', durationMs: 5 },
    {
      index: 1,
      label: 'expect sent StartTransaction',
      status: 'failed',
      durationMs: 2000,
      message: 'no matching StartTransaction sent within 2s',
      details: ['StartTransaction at 10:00:01.000: $.payload.idTag: expected "A", found "B"'],
    },
    { index: 2, label: 'unplug connector 1', status: 'skipped', durationMs: 0 },
  ],
};

const errored: ScenarioRunResult = {
  ...base,
  name: 'Slow',
  label: 'regression/slow.yaml#1',
  status: 'error',
  durationMs: 1000,
  error: 'the scenario timed out after 1s',
  steps: [
    {
      index: 0,
      label: 'wait 10s',
      status: 'failed',
      durationMs: 1000,
      message: 'the scenario timed out after 1s',
    },
  ],
};

const summary: RunSummary = {
  files: [
    { file: 'examples/card.yaml', results: [passed, failed] },
    { file: 'regression/slow.yaml', results: [errored] },
  ],
  passed: 1,
  failed: 1,
  errors: 1,
  durationMs: 4734,
};

describe('JUnit report', () => {
  it('has a suite per file and a case per scenario, with failures, errors and properties', () => {
    expect(toJUnit(summary, AT)).toMatchSnapshot();
  });

  it('counts tests, failures and errors at both levels', () => {
    const xml = toJUnit(summary, AT);
    expect(xml).toContain(
      '<testsuites name="ocpp-mimic" tests="3" failures="1" errors="1" skipped="0" time="4.734">',
    );
    expect(xml).toContain(
      '<testsuite name="examples/card.yaml" tests="2" failures="1" errors="0" skipped="0" time="3.734" timestamp="2026-11-14T10:00:00">',
    );
    expect(xml).toContain(
      '<testsuite name="regression/slow.yaml" tests="1" failures="0" errors="1"',
    );
    expect(xml).toContain('name="Fast EV &lt;with&gt; &quot;quotes&quot; &amp; ampersands"');
    expect([...xml].some((c) => c.charCodeAt(0) < 9)).toBe(false);
  });

  it('reports validation problems as errors', () => {
    expect(problemsToJUnit(['bad.yaml#1: $.steps[0].plugin: unknown step'], AT)).toMatchSnapshot();
  });
});
