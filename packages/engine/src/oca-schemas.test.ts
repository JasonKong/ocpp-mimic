import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OCPP16_MESSAGES, validate, type Ocpp16Action } from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';
import { loadOcaSchemas, OCA_SCHEMAS_DIR, type PayloadKind } from './oca-schemas.js';

const oca = loadOcaSchemas();

describe('OCA schema files', () => {
  it('are the unchanged published files listed in SHA256SUMS', () => {
    const listed = readFileSync(join(OCA_SCHEMAS_DIR, '..', 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [sum, file] = line.split(/\s+/);
        return { sum, file };
      });
    const files = readdirSync(OCA_SCHEMAS_DIR).filter((name) => name.endsWith('.json'));
    expect(files.sort()).toEqual(listed.map((entry) => entry.file).sort());
    expect(files).toHaveLength(56);
    for (const { sum, file } of listed) {
      const actual = createHash('sha256')
        .update(readFileSync(join(OCA_SCHEMAS_DIR, file ?? '')))
        .digest('hex');
      expect(actual, `${file} differs from the published file`).toBe(sum);
    }
  });

  it('cover every OCPP 1.6 action, request and response', () => {
    expect(oca.actions).toHaveLength(28);
    for (const action of Object.keys(OCPP16_MESSAGES)) expect(oca.actions).toContain(action);
  });

  it('report problems as JSON paths, and nothing for unknown actions', () => {
    expect(oca.check('Heartbeat', 'request', {})).toEqual([]);
    expect(
      oca.check('BootNotification', 'request', { chargePointVendor: 'v'.repeat(21), x: 1 }),
    ).toEqual([
      "$: must have required property 'chargePointModel'",
      '$: must NOT have additional properties (x)',
      '$.chargePointVendor: must NOT have more than 20 characters',
    ]);
    expect(oca.check('NotAnAction', 'request', {})).toBeUndefined();
  });
});

// ---- Cross-check: core's own definitions against the official schemas ----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  maxLength?: number;
  format?: string;
  items?: SchemaNode;
}

interface Case {
  name: string;
  payload: Json;
}

function readSchema(action: string, kind: PayloadKind): SchemaNode {
  const file = `${action}${kind === 'response' ? 'Response' : ''}.json`;
  return JSON.parse(readFileSync(join(OCA_SCHEMAS_DIR, file), 'utf8')) as SchemaNode;
}

/** A value the schema accepts; `full` fills every optional property and string up to maxLength. */
function sample(node: SchemaNode, full: boolean): Json {
  switch (node.type) {
    case 'object': {
      const value: Record<string, Json> = {};
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        if (full || node.required?.includes(name)) value[name] = sample(child, full);
      }
      return value;
    }
    case 'array':
      return [sample(node.items ?? {}, full)];
    case 'integer':
      return 1;
    case 'number':
      return 1.5;
    case 'boolean':
      return true;
    default:
      if (node.enum !== undefined) return node.enum[0] ?? '';
      if (node.format === 'date-time') return '2026-11-14T10:00:00.000Z';
      if (node.format === 'uri') return 'https://example.com/file';
      return 'x'.repeat(full ? (node.maxLength ?? 8) : 1);
  }
}

type Path = (string | number)[];

/** A deep copy of `root` with the value at `path` replaced, or removed when `value` is undefined. */
function replaced(root: Json, path: Path, value: Json | undefined): Json {
  const copy = structuredClone(root);
  if (path.length === 0) return value ?? null;
  let parent = copy as Record<string | number, Json>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, Json>;
  const last = path.at(-1) ?? '';
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return copy;
}

const show = (path: Path) =>
  path.reduce<string>((s, key) => (typeof key === 'number' ? `${s}[${key}]` : `${s}.${key}`), '$');

/** Valid payloads plus one mutation per constraint the official schema expresses. */
function cases(node: SchemaNode, root: Json, path: Path = []): Case[] {
  const at = show(path);
  const out: Case[] = [];
  const wrongType = (value: Json) => {
    if (path.length > 0)
      out.push({ name: `${at} wrong type`, payload: replaced(root, path, value) });
  };
  switch (node.type) {
    case 'object':
      wrongType('x');
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        if (node.required?.includes(name)) {
          out.push({
            name: `${at}.${name} missing`,
            payload: replaced(root, [...path, name], undefined),
          });
        }
        out.push(...cases(child, root, [...path, name]));
      }
      if (node.additionalProperties === false) {
        out.push({
          name: `${at} extra property`,
          payload: replaced(root, [...path, 'unexpected'], 1),
        });
      }
      break;
    case 'array':
      wrongType('x');
      out.push({ name: `${at} empty`, payload: replaced(root, path, []) });
      out.push(...cases(node.items ?? {}, root, [...path, 0]));
      break;
    case 'integer':
      wrongType('1');
      out.push({ name: `${at} fraction`, payload: replaced(root, path, 1.5) });
      break;
    case 'number':
      wrongType('1');
      break;
    case 'boolean':
      wrongType('true');
      break;
    default:
      wrongType(1);
      for (const value of node.enum ?? []) {
        out.push({ name: `${at} = ${value}`, payload: replaced(root, path, value) });
      }
      if (node.enum !== undefined) {
        out.push({ name: `${at} unknown value`, payload: replaced(root, path, 'NotAValue') });
      }
      if (node.maxLength !== undefined) {
        out.push({
          name: `${at} too long`,
          payload: replaced(root, path, 'x'.repeat(node.maxLength + 1)),
        });
      }
      if (node.format === 'date-time') {
        out.push({ name: `${at} not a date`, payload: replaced(root, path, 'yesterday') });
      }
  }
  return out;
}

/**
 * Where core deliberately differs from the official schemas. Each entry is
 * `<action> <kind>: <case> — OCA <verdict>, core <verdict>` with the reason
 * in a comment.
 */
const KNOWN_DIFFERENCES: string[] = [
  // The specification gives these arrays a cardinality of 1..*; the official
  // schemas have no minItems, so they accept empty arrays. core follows the
  // specification text and answers OccurenceConstraintViolation.
  'MeterValues request: $.meterValue empty — OCA accepts, core rejects',
  'MeterValues request: $.meterValue[0].sampledValue empty — OCA accepts, core rejects',
  'StopTransaction request: $.transactionData[0].sampledValue empty — OCA accepts, core rejects',
  'RemoteStartTransaction request: $.chargingProfile.chargingSchedule.chargingSchedulePeriod empty — OCA accepts, core rejects',
];

describe("core's message definitions against the official schemas", () => {
  it('agree on every generated payload, apart from the documented differences', () => {
    const disagreements: string[] = [];
    let checked = 0;
    for (const action of Object.keys(OCPP16_MESSAGES) as Ocpp16Action[]) {
      for (const kind of ['request', 'response'] as const) {
        const node = readSchema(action, kind);
        const full = sample(node, true);
        const all: Case[] = [
          { name: 'minimal', payload: sample(node, false) },
          { name: 'full', payload: full },
          ...cases(node, full),
        ];
        for (const { name, payload } of all) {
          const ocaOk = oca.check(action, kind, payload)?.length === 0;
          const coreOk = validate(OCPP16_MESSAGES[action][kind], payload).ok;
          checked++;
          if (ocaOk !== coreOk) {
            disagreements.push(
              `${action} ${kind}: ${name} — OCA ${ocaOk ? 'accepts' : 'rejects'}, core ${coreOk ? 'accepts' : 'rejects'}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(disagreements).toEqual(KNOWN_DIFFERENCES);
  });
});
