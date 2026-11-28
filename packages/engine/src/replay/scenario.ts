/**
 * `ocpp-mimic replay`: a scenario that replays one station of a log, run
 * directly or written out as YAML with the frames inline, to edit.
 */
import { logVersions, parseScenario, type LogLine, type Scenario } from '@ocpp-mimic/core';
import { stringify } from 'yaml';
import type { CompareMode, ReplayBoot } from './replay.js';

export interface ReplayScenarioOptions {
  /** The log file, absolute. */
  file: string;
  station: string;
  lines: readonly LogLine[];
  csms?: string;
  persona?: string;
  speed?: number;
  maxGapMs?: number;
  compare?: CompareMode;
  boot?: ReplayBoot;
}

const seconds = (ms: number) => `${Math.round(ms) / 1000}s`;

/** The scenario as a document: the log by reference, or (`inline`) its frames. */
export function replayDocument(
  options: ReplayScenarioOptions,
  inline: boolean,
): Record<string, unknown> {
  const first = Date.parse(options.lines[0]?.at ?? '') || 0;
  // The replay station speaks the log's version: a 2.0.1 log replays as generic-2.0.1.
  const version = logVersions(options.lines).get(options.station) ?? '1.6';
  const persona = options.persona ?? `generic-${version}`;
  return {
    name: `Replay of ${options.station} from ${options.file.split(/[\\/]/).pop() ?? options.file}`,
    csms: options.csms ?? 'builtin',
    station: { id: options.station, persona, replay: true },
    steps: [
      {
        replay: {
          ...(inline
            ? {
                frames: options.lines.map((line) => ({
                  at: seconds(Date.parse(line.at) - first),
                  [line.direction === 'cp-to-csms' ? 'sent' : 'received']: line.frame,
                })),
              }
            : { log: options.file, logStation: options.station }),
          ...(options.speed !== undefined && options.speed !== 1 && { speed: options.speed }),
          ...(options.maxGapMs !== undefined && { maxGap: seconds(options.maxGapMs) }),
          ...(options.compare !== undefined &&
            options.compare !== 'status' && { compare: options.compare }),
          ...(options.boot !== undefined && options.boot !== 'auto' && { boot: options.boot }),
        },
      },
    ],
  };
}

export function replayScenario(options: ReplayScenarioOptions): Scenario {
  const parsed = parseScenario(replayDocument(options, false), 'replay');
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.scenario;
}

/** The scenario as YAML, frames inline, so it can be edited and kept. */
export function replayYaml(options: ReplayScenarioOptions): string {
  return `# Written by ocpp-mimic replay; edit the frames to change what is sent.\n${stringify(
    replayDocument(options, true),
    { lineWidth: 0 },
  )}`;
}
