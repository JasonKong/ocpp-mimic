/**
 * The user guide's examples are checked, so they cannot silently rot: every
 * YAML and JSON block validates as what it shows, and every `--option` it
 * names exists for its command (docs/design.md, "M8 Release", T120).
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  parseLoadPlan,
  parseLog,
  parseScenario,
  resolvePersonas,
  tariffProblems,
  UsageSchema,
  validate,
} from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BENCH_OPTIONS } from './bench.js';
import { COMMANDS } from './command.js';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const GUIDES = ['docs/guide.md', 'docs/guide.zh-CN.md'];

/** Options of other tools that the guide shows next to ocpp-mimic's. */
const OTHER_TOOLS = new Set(['global', 'rm', 'add-host']);

interface Block {
  lang: string;
  text: string;
  line: number;
}

function blocks(markdown: string): Block[] {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((m) => ({
    lang: m[1] ?? '',
    text: m[2] ?? '',
    line: markdown.slice(0, m.index).split('\n').length,
  }));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const builtInPersonas = () => {
  const dir = new URL('packages/engine/personas/', ROOT);
  return readdirSync(dir).map((file) => ({
    source: file,
    data: parse(readFileSync(new URL(file, dir), 'utf8')) as unknown,
  }));
};

/** What a block is, and the problems found when checking it as that. */
function check(block: Block): { kind: string; problems: string[] } {
  if (block.lang === 'yaml') {
    const doc: unknown = parse(block.text);
    if (Array.isArray(doc)) {
      // A list of steps, as in the http example.
      const result = parseScenario({
        name: 'guide steps',
        station: { id: 'SIM-001', persona: 'generic-1.6' },
        steps: doc,
      });
      return { kind: 'steps', problems: result.ok ? [] : result.errors };
    }
    if (isObject(doc) && typeof doc.persona === 'string') {
      const { personas, errors } = resolvePersonas([
        ...builtInPersonas(),
        { source: 'guide', data: doc },
      ]);
      return {
        kind: 'persona',
        problems: [...errors, ...(personas.has(doc.persona) ? [] : ['not resolved'])],
      };
    }
    if (isObject(doc) && 'steps' in doc) {
      const result = parseScenario(doc);
      return { kind: 'scenario', problems: result.ok ? [] : result.errors };
    }
    if (isObject(doc) && 'groups' in doc) {
      const result = parseLoadPlan(doc);
      return {
        kind: 'load plan',
        problems: result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`),
      };
    }
    if (isObject(doc) && Object.keys(doc).join() === 'usage') {
      const result = validate(UsageSchema, doc.usage);
      return { kind: 'usage', problems: result.ok ? [] : [JSON.stringify(result)] };
    }
    return { kind: 'unknown YAML', problems: ['the test does not know what this block is'] };
  }
  if (block.lang === 'json') {
    if (block.text.trim().startsWith('{"at"')) {
      return { kind: 'log line', problems: parseLog(block.text).problems };
    }
    const doc: unknown = JSON.parse(block.text);
    if (isObject(doc) && 'tariffId' in doc)
      return { kind: 'tariff', problems: tariffProblems(doc) };
    if (isObject(doc) && 'count' in doc && typeof doc.id === 'string') {
      return {
        kind: 'bulk template',
        problems: /\{\d+\}/.test(doc.id) ? [] : ['the id needs a counter such as {0001}'],
      };
    }
    return { kind: 'unknown JSON', problems: ['the test does not know what this block is'] };
  }
  return { kind: block.lang, problems: [] };
}

describe.each(GUIDES)('%s', (guide) => {
  const markdown = read(guide);

  it('has YAML and JSON examples that validate', () => {
    const checked = blocks(markdown)
      .filter((b) => b.lang === 'yaml' || b.lang === 'json')
      .map((b) => ({ line: b.line, ...check(b) }));
    expect(checked.map((c) => c.kind).sort()).toEqual(
      [
        'bulk template',
        'load plan',
        'log line',
        'persona',
        'scenario',
        'steps',
        'tariff',
        'usage',
      ].sort(),
    );
    for (const c of checked) expect(c.problems, `${guide}:${c.line} (${c.kind})`).toEqual([]);
  });

  it('names only options that exist, each with a command that takes it', () => {
    const known = new Set<string>([
      'version',
      'help',
      ...Object.values(COMMANDS).flat(),
      ...Object.keys(BENCH_OPTIONS),
      ...OTHER_TOOLS,
    ]);
    const named = [...markdown.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
    expect(named.filter((option) => !known.has(option))).toEqual([]);

    // On a command line, every option belongs to that command.
    for (const [, command, rest] of markdown.matchAll(
      /ocpp-mimic (serve|run|csms|import|replay|calibrate|load|samples)\b([^\n`|]*)/g,
    )) {
      const allowed: readonly string[] = COMMANDS[command as keyof typeof COMMANDS];
      for (const [, option] of (rest ?? '').matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
        expect(allowed, `ocpp-mimic ${command} --${option} in ${guide}`).toContain(option);
      }
    }
  });
});
