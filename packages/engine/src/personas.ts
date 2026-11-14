/**
 * Persona Registry: loads persona YAML files from directories and resolves
 * them with core's persona rules.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePersonas, type PersonaSource, type ResolvedPersona } from '@ocpp-mimic/core';
import { parse } from 'yaml';

/** The personas shipped with the engine, including `generic-1.6`. */
export const BUILT_IN_PERSONAS_DIR = fileURLToPath(new URL('../personas/', import.meta.url));

export interface PersonaRegistry {
  get(id: string): ResolvedPersona | undefined;
  list(): ResolvedPersona[];
  /** Problems that kept a file or persona out of the registry. */
  errors: string[];
  /** Non-fatal problems in personas that were loaded. */
  warnings: string[];
}

/**
 * Loads every `.yaml` / `.yml` file in `dirs` (built-in personas first by
 * default). A persona may extend one from any of the directories.
 */
export async function loadPersonas(
  dirs: readonly string[] = [BUILT_IN_PERSONAS_DIR],
): Promise<PersonaRegistry> {
  const sources: PersonaSource[] = [];
  const errors: string[] = [];

  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort();
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      try {
        sources.push({ source: path, data: parse(await readFile(path, 'utf8')) as unknown });
      } catch (error) {
        errors.push(
          `${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const resolved = resolvePersonas(sources);
  const personas = [...resolved.personas.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    get: (id) => resolved.personas.get(id),
    list: () => personas,
    errors: [...errors, ...resolved.errors],
    warnings: personas.flatMap((persona) => persona.warnings),
  };
}
