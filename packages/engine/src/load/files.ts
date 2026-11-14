/** Reading a load plan file: one YAML document, validated by core. */
import { readFile } from 'node:fs/promises';
import { parseLoadPlan, type LoadPlan } from '@ocpp-mimic/core';
import { parseDocument } from 'yaml';

export async function readLoadPlan(
  file: string,
): Promise<{ ok: true; plan: LoadPlan } | { ok: false; problems: string[] }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, problems: [`${file}: ${(error as Error).message}`] };
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return { ok: false, problems: document.errors.map((e) => `${file}: ${e.message}`) };
  }
  const parsed = parseLoadPlan(document.toJS());
  if (!parsed.ok) {
    return { ok: false, problems: parsed.issues.map((i) => `${file}: ${i.path}: ${i.message}`) };
  }
  return parsed;
}
