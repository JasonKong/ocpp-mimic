/** `ocpp-mimic calibrate`: a persona derived from logs. */
import { readFile, writeFile } from 'node:fs/promises';
import { calibrate, calibrationReport, parseLog, type LogLine } from '@ocpp-mimic/core';
import { personaYaml } from '@ocpp-mimic/engine';
import type { CalibrateCommand } from './command.js';

export interface CalibrateIo {
  out: (text: string) => void;
  err: (line: string) => void;
}

const CONSOLE: CalibrateIo = { out: (text) => process.stdout.write(text), err: console.error };

/** 0 when a persona was written, 2 when the logs could not be read or hold nothing to use. */
export async function runCalibrateCommand(
  command: CalibrateCommand,
  io: CalibrateIo = CONSOLE,
): Promise<number> {
  const lines: LogLine[] = [];
  for (const file of command.logs) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      io.err(`${file}: ${(error as Error).message}`);
      return 2;
    }
    const parsed = parseLog(text);
    for (const problem of parsed.problems) io.err(`${file}: ${problem}`);
    if (parsed.problems.length > 0) return 2;
    lines.push(...parsed.lines);
  }
  const wanted = new Set(command.stations);
  const picked = wanted.size === 0 ? lines : lines.filter((line) => wanted.has(line.station));
  if (picked.length === 0) {
    io.err(
      wanted.size === 0 ? 'the logs have no frames' : `no frames of ${command.stations.join(', ')}`,
    );
    return 2;
  }
  const calibration = calibrate(picked, {
    ...(command.name !== undefined && { name: command.name }),
    ...(command.extends !== undefined && { extends: command.extends }),
  });
  const yaml = personaYaml(
    calibration.persona,
    `Calibrated by ocpp-mimic from ${calibration.frames} frames of ${calibration.stations.join(', ')}.\nCheck the values before using it; the report lists their samples.`,
  );
  if (command.out !== undefined) await writeFile(command.out, yaml);
  else io.out(yaml);
  if (command.report !== undefined) await writeFile(command.report, calibrationReport(calibration));
  const found = calibration.derived.filter((d) => d.value !== undefined).length;
  io.err(
    `${found} values derived, ${calibration.derived.length - found} not (too few samples or not in the logs)`,
  );
  return 0;
}
