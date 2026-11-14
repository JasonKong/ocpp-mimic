/** `ocpp-mimic replay <log>`: replays a station's log, or writes it as a scenario. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLog } from '@ocpp-mimic/core';
import {
  formatScenarioResult,
  replayScenario,
  replayYaml,
  runScenario,
  stationLines,
} from '@ocpp-mimic/engine';
import type { ReplayCommand } from './command.js';

export interface ReplayIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const CONSOLE: ReplayIo = { out: console.log, err: console.error };

/** 0 when the replay matched the log (or the scenario was written), 1 when it did not, 2 on errors. */
export async function runReplayCommand(
  command: ReplayCommand,
  io: ReplayIo = CONSOLE,
): Promise<number> {
  const file = resolve(command.log);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    io.err(`${command.log}: ${(error as Error).message}`);
    return 2;
  }
  const parsed = parseLog(text);
  for (const problem of parsed.problems) io.err(`${command.log}: ${problem}`);
  if (parsed.problems.length > 0) return 2;
  const picked = stationLines(parsed.lines, command.station);
  if (!picked.ok) {
    io.err(`${command.log}: ${picked.problem}`);
    return 2;
  }
  const options = {
    file,
    station: picked.station,
    lines: picked.lines,
    ...(command.csms !== undefined && { csms: command.csms }),
    ...(command.persona !== undefined && { persona: command.persona }),
    ...(command.speed !== undefined && { speed: command.speed }),
    ...(command.maxGapMs !== undefined && { maxGapMs: command.maxGapMs }),
    ...(command.compare !== undefined && { compare: command.compare }),
  };
  if (command.write !== undefined) {
    await writeFile(command.write, replayYaml(options));
    io.out(`Wrote ${command.write}: ${picked.lines.length} frames of ${picked.station}`);
    return 0;
  }
  const scenario = replayScenario(options);
  const result = await runScenario(scenario, `${command.log}#${picked.station}`, {
    personaDirs: command.personas,
    allowCsms: command.allowCsms,
  });
  for (const line of formatScenarioResult(result)) io.out(line);
  return result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}
