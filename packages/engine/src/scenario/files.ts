/**
 * Reading scenario files: YAML with one scenario per document, validated by
 * core's scenario model. Directories are searched recursively for `.yaml` and
 * `.yml` files in sorted order.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseScenario, type Scenario } from '@ocpp-mimic/core';
import { parseAllDocuments } from 'yaml';
import { TEST_PKI_DIR } from '../test-pki.js';

export interface ScenarioDocument {
  /** `file#n`, with n counting documents from 1. */
  label: string;
  /** Position of the document in the file, from 1. */
  index: number;
  /** The validated scenario, when there are no errors. */
  scenario?: Scenario;
  /** The name from the document, when it has one, for reporting invalid files. */
  name?: string;
  errors: string[];
}

export interface ScenarioFile {
  /** The path as given or found. */
  file: string;
  documents: ScenarioDocument[];
  /** Problems with the file as a whole (unreadable, no scenarios). */
  errors: string[];
}

const SCENARIO_FILE = /\.ya?ml$/;

/** Every scenario file in `paths`: files as given, directories searched recursively. */
export async function findScenarioFiles(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (SCENARIO_FILE.test(entry.name)) found.push(path);
    }
  }
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory() === true) await walk(path);
    else found.push(path);
  }
  return found;
}

/** Reads and validates every scenario in `file`. `name` labels it in errors (default: the path). */
export async function readScenarioFile(file: string, name = file): Promise<ScenarioFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file, documents: [], errors: [`${name}: cannot read the file: ${reason}`] };
  }
  const documents: ScenarioDocument[] = [];
  let index = 0;
  for (const document of parseAllDocuments(text)) {
    // An empty document, such as one after a trailing `---`.
    if (document.errors.length === 0 && document.toJS() == null) continue;
    index++;
    const label = `${name}#${index}`;
    if (document.errors.length > 0) {
      documents.push({
        label,
        index,
        errors: document.errors.map((e) => `${label}: ${e.message.split('\n')[0] ?? e.message}`),
      });
      continue;
    }
    const value: unknown = document.toJS();
    const docName =
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { name?: unknown }).name === 'string'
        ? (value as { name: string }).name
        : undefined;
    const result = parseScenario(value, label);
    if (result.ok) resolveCertificatePaths(result.scenario, dirname(file));
    documents.push({
      label,
      index,
      ...(docName !== undefined && { name: docName }),
      ...(result.ok ? { scenario: result.scenario, errors: [] } : { errors: result.errors }),
    });
  }
  return {
    file,
    documents,
    errors: documents.length === 0 ? [`${name}: no scenarios in the file`] : [],
  };
}

/** `path` relative to `base` when it is inside it, for shorter labels. */
export function displayPath(path: string, base: string = process.cwd()): string {
  const rel = relative(base, path);
  return rel.startsWith('..') ? path : rel;
}

/**
 * Makes a station's certificate paths absolute: `test-pki:<file>` names a
 * file of the committed test PKI, other paths are relative to the scenario file.
 */
export function resolveCertificatePaths(scenario: Scenario, directory: string): void {
  const resolveOne = (path: string) =>
    path.startsWith('test-pki:')
      ? join(TEST_PKI_DIR, path.slice('test-pki:'.length))
      : resolve(directory, path);
  for (const station of scenario.stations) {
    const security = station.security;
    if (security === undefined) continue;
    for (const field of ['ca', 'cert', 'key', 'manufacturerRoot'] as const) {
      const value = security[field];
      if (value !== undefined) security[field] = resolveOne(value);
    }
  }
}
