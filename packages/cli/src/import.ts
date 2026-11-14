/** `ocpp-mimic import`: other logs into ocpp-mimic's log format, masked. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { formatLog, type LogLine } from '@ocpp-mimic/core';
import { importText, maskLines, readMapping, type ImportMapping } from '@ocpp-mimic/engine';
import type { ImportCommand } from './command.js';

export interface ImportIo {
  out: (text: string) => void;
  err: (line: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
}

const CONSOLE: ImportIo = {
  out: (text) => process.stdout.write(text),
  err: console.error,
  env: process.env,
};

/** 0 on success, 1 when some lines could not be read (the rest is written), 2 on errors. */
export async function runImportCommand(
  command: ImportCommand,
  io: ImportIo = CONSOLE,
): Promise<number> {
  let mapping: ImportMapping | undefined;
  if (command.map !== undefined) {
    const read = await readMapping(command.map);
    if (!read.ok) {
      for (const problem of read.problems) io.err(problem);
      return 2;
    }
    mapping = read.mapping;
  }

  const lines: LogLine[] = [];
  let problems = 0;
  let alreadyMasked = true;
  for (const file of command.files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      io.err(`${file}: ${(error as Error).message}`);
      return 2;
    }
    const imported = importText(text, mapping);
    for (const problem of imported.problems) io.err(`${file}: ${problem}`);
    problems += imported.problems.length;
    alreadyMasked &&= imported.masked;
    lines.push(...imported.lines);
  }
  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const mask = command.mask ?? mapping !== undefined;
  let output = lines;
  if (mask && !alreadyMasked) {
    let salt = command.salt ?? io.env?.OCPP_MIMIC_MASK_SALT;
    if (command.saltFile !== undefined) salt = (await readFile(command.saltFile, 'utf8')).trim();
    if (salt === undefined || salt === '') {
      salt = randomBytes(32).toString('hex');
      io.err('No salt given: a random one is used, so these pseudonyms match no other import.');
    }
    output = maskLines(lines, salt, mapping?.mask);
  }
  const text = formatLog(output, {
    masked: mask || alreadyMasked,
    source: command.files.map((file) => basename(file)).join(', '),
  });
  if (command.out !== undefined) await writeFile(command.out, text);
  else io.out(text);
  io.err(
    `${output.length} frames from ${command.files.length} file${command.files.length === 1 ? '' : 's'}${mask ? ', masked' : ''}`,
  );
  return problems > 0 ? 1 : 0;
}
