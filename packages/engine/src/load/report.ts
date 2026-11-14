/** A load run's report as Markdown, JUnit XML and console lines. */
import { escapeXml } from '../scenario/junit.js';
import type { LoadReport } from './runner.js';

export function reportLines(report: LoadReport): string[] {
  const width = Math.max(...report.thresholds.map((t) => t.name.length), 10);
  return [
    `${report.passed ? 'PASSED' : 'FAILED'}: ${report.name} (${report.stations} stations, ${report.durationS} s)`,
    ...report.thresholds.map(
      (t) =>
        `  ${t.passed ? 'PASS' : 'FAIL'}  ${t.name.padEnd(width)}  ${t.measured}  (${t.limit})`,
    ),
  ];
}

export function reportMarkdown(report: LoadReport): string {
  const m = report.metrics;
  const rows = (header: string[], body: (string | number)[][]) =>
    [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');
  return `${[
    `# ${report.name}: ${report.passed ? 'passed' : 'failed'}`,
    '',
    `${report.stations} stations against ${report.csms} for ${report.durationS} s, started ${report.startedAt}.`,
    '',
    '## Thresholds',
    '',
    rows(
      ['', 'Threshold', 'Measured', 'Limit'],
      report.thresholds.map((t) => [t.passed ? 'pass' : '**fail**', t.name, t.measured, t.limit]),
    ),
    '',
    '## Groups',
    '',
    rows(
      ['Group', 'Stations', 'Sessions', 'Expected', 'Refused cards', 'Turned away'],
      report.groups.map((g) => [
        g.name,
        g.stations,
        g.sessions,
        g.expectedSessions,
        g.refused,
        g.turnedAway,
      ]),
    ),
    '',
    '## Fleet events',
    '',
    report.events.length === 0
      ? 'None.'
      : rows(
          ['At (s)', 'Event', 'Stations', 'Back after (s)'],
          report.events.map((e) => [e.atS, e.kind, e.stations, e.recoveredS ?? 'not back']),
        ),
    '',
    '## CSMS latency (ms)',
    '',
    rows(
      ['Action', 'Count', 'p50', 'p95', 'p99', 'Max'],
      [
        [
          'overall',
          m.csmsLatency.overall.count,
          m.csmsLatency.overall.p50,
          m.csmsLatency.overall.p95,
          m.csmsLatency.overall.p99,
          m.csmsLatency.overall.max,
        ],
        ...Object.entries(m.csmsLatency.byAction)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([action, l]) => [action, l.count, l.p50, l.p95, l.p99, l.max]),
      ],
    ),
    '',
    '## Engine',
    '',
    `CPU ${report.engine.cpuMeanPercent} % of a core on average; RSS up to ${report.engine.rssMaxMb} MB; heap floor ${report.engine.heapFloorMb.warm} MB after warm-up, ${report.engine.heapFloorMb.end} MB at the end; event-loop delay p99 ${report.engine.eventLoopDelayMs.p99} ms, max ${report.engine.eventLoopDelayMs.max} ms; late work p99 ${m.lateWork.p99} ms, max ${m.lateWork.max} ms.`,
    '',
    `Frames: ${m.frames.sent} sent, ${m.frames.received} received. Connections: ${m.connections.opened} opened, ${m.connections.failed} failed. Disconnects: ${
      Object.entries(m.disconnects)
        .map(([cause, n]) => `${n} ${cause}`)
        .join(', ') || 'none'
    }. Transactions: ${
      Object.entries(m.transactions)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ') || 'none'
    }; ${(m.energyWh / 1000).toFixed(1)} kWh in finished ones.`,
  ].join('\n')}\n`;
}

/** One testcase per threshold, so CI shows which one failed. */
export function reportJunit(report: LoadReport): string {
  const failures = report.thresholds.filter((t) => !t.passed).length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ocpp-mimic load" tests="${report.thresholds.length}" failures="${failures}" errors="0" time="${report.durationS}">`,
    `  <testsuite name="${escapeXml(report.name)}" tests="${report.thresholds.length}" failures="${failures}" errors="0" time="${report.durationS}" timestamp="${report.startedAt}">`,
    ...report.thresholds.flatMap((t) => [
      `    <testcase name="${escapeXml(t.name)}" classname="${escapeXml(report.name)}" time="0">`,
      ...(t.passed
        ? []
        : [
            `      <failure message="${escapeXml(`${t.measured}; limit ${t.limit}`)}" type="threshold"/>`,
          ]),
      `      <system-out>${escapeXml(`measured ${t.measured}; limit ${t.limit}`)}</system-out>`,
      '    </testcase>',
    ]),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
