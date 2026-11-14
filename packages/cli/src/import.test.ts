import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportCommand } from './command.js';
import { runImportCommand } from './import.js';

const IMPORT = fileURLToPath(new URL('../../../scenarios/import/', import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function work(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-import-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

async function run(command: Omit<ImportCommand, 'kind'>, env: Record<string, string> = {}) {
  let out = '';
  const err: string[] = [];
  const code = await runImportCommand(
    { kind: 'import', ...command },
    { out: (text) => (out += text), err: (line) => err.push(line), env },
  );
  return { code, out, err };
}

const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
const CSV = [
  'logged_at,charge_box_id,direction,message',
  `2026-11-15 09:00:00.000,SITE-1,IN,${quote('[2,"1","Authorize",{"idTag":"CARD-1"}]')}`,
  `2026-11-15 09:00:00.050,SITE-1,OUT,${quote('[3,"1",{"idTagInfo":{"status":"Accepted"}}]')}`,
].join('\n');

describe('ocpp-mimic import', () => {
  it('imports a CSV through the example mapping, masked with the salt from the environment', async () => {
    const dir = await work({ 'log.csv': CSV });
    const { code, out, err } = await run(
      { files: [join(dir, 'log.csv')], map: join(IMPORT, 'csv-mapping.yaml') },
      { OCPP_MIMIC_MASK_SALT: 'test-salt' },
    );
    expect(code, err.join('\n')).toBe(0);
    expect(err).toEqual(['2 frames from 1 file, masked']);
    const log = parseLog(out);
    expect(log.header).toEqual({
      format: 'ocpp-mimic-log',
      version: 1,
      masked: true,
      source: 'log.csv',
    });
    expect(log.lines).toHaveLength(2);
    expect(log.lines[0]?.station).toMatch(/^CP-/);
    expect(JSON.stringify(log.lines)).not.toContain('CARD-1');
    expect(JSON.stringify(log.lines)).not.toContain('SITE-1');

    const again = await run(
      { files: [join(dir, 'log.csv')], map: join(IMPORT, 'csv-mapping.yaml') },
      { OCPP_MIMIC_MASK_SALT: 'test-salt' },
    );
    expect(again.out).toBe(out);
  });

  it('writes to a file, warns about a random salt, and leaves own logs unmasked unless asked', async () => {
    const dir = await work({ 'log.csv': CSV });
    const target = join(dir, 'out.jsonl');
    const first = await run({
      files: [join(dir, 'log.csv')],
      map: join(IMPORT, 'csv-mapping.yaml'),
      out: target,
    });
    expect(first.code).toBe(0);
    expect(first.err[0]).toMatch(/random one is used/);
    const own = await run({ files: [target] });
    expect(own.code).toBe(0);
    // Already masked: read as it is.
    expect(parseLog(own.out).header?.masked).toBe(true);
    const plain = (await readFile(target, 'utf8')).replace('"masked":true', '"masked":false');
    await writeFile(join(dir, 'plain.jsonl'), plain);
    expect(parseLog((await run({ files: [join(dir, 'plain.jsonl')] })).out).header?.masked).toBe(
      false,
    );
    const masked = await run({ files: [join(dir, 'plain.jsonl')], mask: true, salt: 'x' });
    expect(parseLog(masked.out).header?.masked).toBe(true);
  });

  it('exits 1 with the problem lines but writes the rest, and 2 for a bad mapping', async () => {
    const dir = await work({
      'log.csv': `${CSV}\n2026-11-15 09:00:01.000,SITE-1,SIDEWAYS,"[]"`,
      'bad.yaml': 'format: xml\n',
    });
    const partial = await run({
      files: [join(dir, 'log.csv')],
      map: join(IMPORT, 'csv-mapping.yaml'),
      salt: 's',
    });
    expect(partial.code).toBe(1);
    expect(partial.err[0]).toMatch(/line 4: direction "SIDEWAYS" is not mapped/);
    expect(parseLog(partial.out).lines).toHaveLength(2);
    const bad = await run({ files: [join(dir, 'log.csv')], map: join(dir, 'bad.yaml') });
    expect(bad.code).toBe(2);
  });
});
