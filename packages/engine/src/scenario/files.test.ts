import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { variableProblems } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { findScenarioFiles, readScenarioFile } from './files.js';

const EXAMPLES = fileURLToPath(new URL('../../../../scenarios/examples/', import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-scenarios-'));
  dirs.push(dir);
  return dir;
}

describe('scenario files', () => {
  it('validates every reference example', async () => {
    const files = await findScenarioFiles([EXAMPLES]);
    expect(files.map((f) => f.slice(EXAMPLES.length))).toEqual([
      'app-triggered-start.yaml',
      'fault.yaml',
      'local-card-session.yaml',
      'ocpp201-sessions.yaml',
      'ocpp21-sessions.yaml',
      'outage-resend.yaml',
      'remote-start-stop.yaml',
    ]);
    let scenarios = 0;
    for (const file of files) {
      const read = await readScenarioFile(file);
      expect(read.errors).toEqual([]);
      for (const document of read.documents) {
        expect(document.errors, document.label).toEqual([]);
        const scenario = document.scenario;
        expect(scenario).toBeDefined();
        if (scenario === undefined) continue;
        // The app template takes APP_API from --var.
        expect(variableProblems(scenario, ['APP_API']), document.label).toEqual([]);
        scenarios++;
      }
    }
    expect(scenarios).toBe(8);
  });

  it('validates every scenario file in the repository', async () => {
    const root = fileURLToPath(new URL('../../../../scenarios/', import.meta.url));
    // These hold personas, load plans, import mappings and logs, not scenarios.
    const other = ['/personas/', '/load/', '/import/', '/logs/'];
    const files = (await findScenarioFiles([root])).filter(
      (f) => !other.some((dir) => f.slice(root.length - 1).startsWith(dir)),
    );
    expect(files.length).toBeGreaterThan(6);
    const problems: string[] = [];
    for (const file of files) {
      const read = await readScenarioFile(file, file.slice(root.length));
      problems.push(...read.errors);
      for (const document of read.documents) {
        problems.push(...document.errors);
        if (document.scenario !== undefined) {
          problems.push(
            ...variableProblems(document.scenario, ['APP_API']).map(
              (p) => `${document.label}: ${p}`,
            ),
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('reports YAML and validation errors with file, document and step', async () => {
    const dir = await tempDir();
    const file = join(dir, 'bad.yaml');
    await writeFile(
      file,
      [
        'name: first',
        'station: { id: SIM-1, persona: generic-1.6 }',
        'steps:',
        '  - plugIn: { connector: x }',
        '---',
        'name: second',
        'steps: [ { online: {} }',
        '---',
        '',
      ].join('\n'),
    );
    const read = await readScenarioFile(file, 'bad.yaml');
    expect(read.documents.map((d) => d.label)).toEqual(['bad.yaml#1', 'bad.yaml#2']);
    expect(read.documents[0]?.name).toBe('first');
    expect(read.documents[0]?.errors).toEqual([
      'bad.yaml#1: $.steps[0].plugIn.connector: expected integer, got string',
    ]);
    expect(read.documents[1]?.errors[0]).toMatch(/^bad\.yaml#2: .*at line \d+/);
  });

  it('finds .yaml and .yml files recursively in sorted order, and reports unreadable files', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'b', 'two.yml'), '');
    await writeFile(join(dir, 'a.yaml'), '');
    await writeFile(join(dir, 'notes.txt'), '');
    expect((await findScenarioFiles([dir])).map((f) => f.slice(dir.length + 1))).toEqual([
      'a.yaml',
      join('b', 'two.yml'),
    ]);
    expect((await readScenarioFile(join(dir, 'a.yaml'), 'a.yaml')).errors).toEqual([
      'a.yaml: no scenarios in the file',
    ]);
    expect((await readScenarioFile(join(dir, 'missing.yaml'), 'missing.yaml')).errors[0]).toMatch(
      /^missing\.yaml: cannot read the file/,
    );
  });
});
