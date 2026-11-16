import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OCPP16_MESSAGES,
  OCPP201_MESSAGES,
  OCPP21_MESSAGES,
  OCPP21_UNCONFIRMED_ACTIONS,
  validate,
  validateOcpp201Request,
  validateOcpp201Response,
  validateOcpp21Request,
  validateOcpp21Response,
  type Ocpp16Action,
  type Ocpp201Action,
  type Ocpp21Action,
} from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';
import {
  loadOcaSchemas,
  OCA_OCPP201_SCHEMAS_DIR,
  OCA_OCPP21_SCHEMAS_DIR,
  OCA_SCHEMA_DIRS,
  OCA_SCHEMAS_DIR,
  OCA_SECURITY_SCHEMAS_DIR,
  type PayloadKind,
} from './oca-schemas.js';

const oca = loadOcaSchemas();
const oca201 = loadOcaSchemas(OCA_SCHEMA_DIRS['2.0.1']);
const oca21 = loadOcaSchemas(OCA_SCHEMA_DIRS['2.1']);

describe('OCA schema files', () => {
  it.each([
    [OCA_SCHEMAS_DIR, 'SHA256SUMS', 56],
    [OCA_SECURITY_SCHEMAS_DIR, 'SHA256SUMS-security', 22],
    [OCA_OCPP201_SCHEMAS_DIR, 'SHA256SUMS-ocpp201', 128],
    [OCA_OCPP21_SCHEMAS_DIR, 'SHA256SUMS-ocpp21', 181],
  ])('in %s are the unchanged published files listed in %s', (dir, sums, count) => {
    const listed = readFileSync(join(dir, '..', sums), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [sum, file] = line.split(/\s+/);
        return { sum, file };
      });
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files.sort()).toEqual(listed.map((entry) => entry.file).sort());
    expect(files).toHaveLength(count);
    for (const { sum, file } of listed) {
      const actual = createHash('sha256')
        .update(readFileSync(join(dir, file ?? '')))
        .digest('hex');
      expect(actual, `${file} differs from the published file`).toBe(sum);
    }
  });

  it('cover every OCPP 1.6 and Security Whitepaper action, request and response', () => {
    expect(oca.actions).toHaveLength(39);
    expect(Object.keys(OCPP16_MESSAGES).sort()).toEqual(oca.actions);
  });

  it('give 2.0.1 its own set: all 64 actions, each with a request and a response schema', () => {
    expect(oca201.actions).toHaveLength(64);
    for (const action of oca201.actions) {
      const files = [`${action}Request.json`, `${action}Response.json`];
      for (const file of files) {
        expect(readdirSync(OCA_OCPP201_SCHEMAS_DIR)).toContain(file);
      }
    }
    expect(oca201.actions).toContain('TransactionEvent');
    expect(oca201.actions).not.toContain('StartTransaction');
    // The default set stays 1.6 only.
    expect(oca.actions).not.toContain('TransactionEvent');
  });

  it('check 2.0.1 payloads against the 2.0.1 schemas (draft-06)', () => {
    expect(
      oca201.check('BootNotification', 'request', {
        reason: 'PowerUp',
        chargingStation: { model: 'M', vendorName: 'V' },
      }),
    ).toEqual([]);
    // The 1.6 shape of the same action fails the 2.0.1 schema.
    expect(
      oca201.check('BootNotification', 'request', {
        chargePointVendor: 'V',
        chargePointModel: 'M',
      }),
    ).toEqual([
      "$: must have required property 'reason'",
      "$: must have required property 'chargingStation'",
      '$: must NOT have additional properties (chargePointVendor)',
      '$: must NOT have additional properties (chargePointModel)',
    ]);
    expect(
      oca201.check('StatusNotification', 'request', {
        timestamp: '2026-11-15T10:00:00Z',
        connectorStatus: 'Preparing',
        evseId: 1,
        connectorId: 1,
      }),
    ).toEqual([
      '$.connectorStatus: must be equal to one of the allowed values (Available, Occupied, Reserved, Unavailable, Faulted)',
    ]);
    expect(oca201.check('Heartbeat', 'response', { currentTime: 'yesterday' })).toEqual([
      '$.currentTime: must match format "date-time"',
    ]);
  });

  it('give 2.1 its own set: all 91 actions, the unconfirmed one with a request schema only', () => {
    expect(oca21.actions).toHaveLength(91);
    const files = readdirSync(OCA_OCPP21_SCHEMAS_DIR);
    for (const action of oca21.actions) {
      if (action === 'NotifyPeriodicEventStream') {
        expect(files).toContain('NotifyPeriodicEventStream.json');
        expect(oca21.check(action, 'response', {})).toBeUndefined();
      } else {
        expect(files).toContain(`${action}Request.json`);
        expect(files).toContain(`${action}Response.json`);
      }
    }
    expect(oca21.actions).toContain('SetDefaultTariff');
    expect(oca201.actions).not.toContain('SetDefaultTariff');
  });

  it('check 2.1 payloads against the 2.1 schemas (draft-06)', () => {
    const limit = { transactionLimit: { maxEnergy: 20000, maxSoC: 80 } };
    expect(oca21.check('TransactionEvent', 'response', limit)).toEqual([]);
    // A 2.1 field fails the 2.0.1 schema of the same action.
    expect(oca201.check('TransactionEvent', 'response', limit)).toEqual([
      '$: must NOT have additional properties (transactionLimit)',
    ]);
    expect(
      oca21.check('Authorize', 'request', {
        idToken: { idToken: 'WVW00000000000001', type: 'VIN' },
      }),
    ).toEqual([]);
    expect(
      oca21.check('UpdateDynamicSchedule', 'request', {
        chargingProfileId: 1,
        scheduleUpdate: { dischargeLimit: 10 },
      }),
    ).toEqual(['$.scheduleUpdate.dischargeLimit: must be <= 0']);
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
    // A draft-06 schema of the whitepaper.
    expect(
      oca.check('SecurityEventNotification', 'request', { type: 'StartupOfTheDevice' }),
    ).toEqual(["$: must have required property 'timestamp'"]);
  });
});

// ---- Cross-check: core's own definitions against the official schemas ----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface SchemaNode {
  $ref?: string;
  definitions?: Record<string, SchemaNode>;
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  maxLength?: number;
  format?: string;
  items?: SchemaNode;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

interface Case {
  name: string;
  payload: Json;
}

function readSchema(
  action: string,
  kind: PayloadKind,
  version: '1.6' | '2.0.1' | '2.1' = '1.6',
): SchemaNode {
  const v2 = version !== '1.6';
  const unconfirmed = action === 'NotifyPeriodicEventStream';
  const file = `${action}${kind === 'response' ? 'Response' : v2 && !unconfirmed ? 'Request' : ''}.json`;
  const dir =
    version === '2.1'
      ? OCA_OCPP21_SCHEMAS_DIR
      : version === '2.0.1'
        ? OCA_OCPP201_SCHEMAS_DIR
        : readdirSync(OCA_SCHEMAS_DIR).includes(file)
          ? OCA_SCHEMAS_DIR
          : OCA_SECURITY_SCHEMAS_DIR;
  const root = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SchemaNode;
  return inline(root, root);
}

/** `node` with every `#/definitions/...` reference replaced by its definition. */
function inline(node: SchemaNode, root: SchemaNode): SchemaNode {
  if (node.$ref !== undefined) {
    const name = node.$ref.replace('#/definitions/', '');
    const target = root.definitions?.[name];
    if (target === undefined) throw new Error(`unresolved ${node.$ref}`);
    return inline(target, root);
  }
  return {
    ...node,
    ...(node.properties !== undefined && {
      properties: Object.fromEntries(
        Object.entries(node.properties).map(([key, child]) => [key, inline(child, root)]),
      ),
    }),
    ...(node.items !== undefined && { items: inline(node.items, root) }),
  };
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
      // 1.5 unless the bounds forbid it (2.1's discharge limits are <= 0).
      return node.maximum !== undefined && node.maximum < 1.5
        ? node.maximum - 0.5
        : node.minimum !== undefined && node.minimum > 1.5
          ? node.minimum + 0.5
          : 1.5;
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

/** The value at `path` in `root`. */
function getAt(root: Json, path: Path): Json {
  let node = root;
  for (const key of path) node = (node as Record<string | number, Json>)[key] ?? null;
  return node;
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
      if (node.maxItems !== undefined) {
        const items = getAt(root, path) as Json[];
        out.push({
          name: `${at} too many`,
          payload: replaced(
            root,
            path,
            Array.from({ length: node.maxItems + 1 }, () => items[0] ?? null),
          ),
        });
      }
      out.push(...cases(node.items ?? {}, root, [...path, 0]));
      break;
    case 'integer':
      wrongType('1');
      out.push({ name: `${at} fraction`, payload: replaced(root, path, 1.5) });
      if (node.minimum !== undefined) {
        out.push({ name: `${at} below minimum`, payload: replaced(root, path, node.minimum - 1) });
      }
      if (node.maximum !== undefined) {
        out.push({ name: `${at} above maximum`, payload: replaced(root, path, node.maximum + 1) });
      }
      break;
    case 'number':
      wrongType('1');
      if (node.minimum !== undefined) {
        out.push({
          name: `${at} below minimum`,
          payload: replaced(root, path, node.minimum - 0.5),
        });
      }
      if (node.maximum !== undefined) {
        out.push({
          name: `${at} above maximum`,
          payload: replaced(root, path, node.maximum + 0.5),
        });
      }
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
  'GetCompositeSchedule response: $.chargingSchedule.chargingSchedulePeriod empty — OCA accepts, core rejects',
  'SetChargingProfile request: $.csChargingProfiles.chargingSchedule.chargingSchedulePeriod empty — OCA accepts, core rejects',
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

/** Where core's 2.0.1 definitions deliberately differ from the official schemas; none so far. */
const KNOWN_DIFFERENCES_201: string[] = [];

describe("core's 2.0.1 message definitions against the official schemas", () => {
  it('cover the same 64 actions', () => {
    expect(Object.keys(OCPP201_MESSAGES).sort()).toEqual(oca201.actions);
  });

  it('agree on every generated payload, apart from the documented differences', () => {
    const disagreements: string[] = [];
    let checked = 0;
    for (const action of Object.keys(OCPP201_MESSAGES) as Ocpp201Action[]) {
      for (const kind of ['request', 'response'] as const) {
        const node = readSchema(action, kind, '2.0.1');
        const full = sample(node, true);
        const all: Case[] = [
          { name: 'minimal', payload: sample(node, false) },
          { name: 'full', payload: full },
          ...cases(node, full),
        ];
        for (const { name, payload } of all) {
          const ocaOk = oca201.check(action, kind, payload)?.length === 0;
          const coreOk = (
            kind === 'request'
              ? validateOcpp201Request(action, payload)
              : validateOcpp201Response(action, payload)
          ).ok;
          checked++;
          if (ocaOk !== coreOk) {
            disagreements.push(
              `${action} ${kind}: ${name} — OCA ${ocaOk ? 'accepts' : 'rejects'}, core ${coreOk ? 'accepts' : 'rejects'}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    expect(disagreements).toEqual(KNOWN_DIFFERENCES_201);
  });

  it('answer with the 2.0.1 spellings of the error codes', () => {
    const extra = validateOcpp201Request('Heartbeat', { unexpected: 1 });
    expect(extra.ok || extra.errorCode).toBe('FormatViolation');
    const missing = validateOcpp201Request('BootNotification', { reason: 'PowerUp' });
    expect(missing.ok || missing.errorCode).toBe('OccurrenceConstraintViolation');
    // customData is allowed on every class, with any vendor properties.
    expect(
      validateOcpp201Request('Heartbeat', { customData: { vendorId: 'acme', anything: [1] } }).ok,
    ).toBe(true);
  });
});

/** Where core's 2.1 definitions deliberately differ from the official schemas; none so far. */
const KNOWN_DIFFERENCES_21: string[] = [];

describe("core's 2.1 message definitions against the official schemas", () => {
  it('cover the same 91 actions, and only the unconfirmed one has no response', () => {
    expect(Object.keys(OCPP21_MESSAGES).sort()).toEqual(oca21.actions);
    expect(OCPP21_UNCONFIRMED_ACTIONS).toEqual(['NotifyPeriodicEventStream']);
  });

  it('agree on every generated payload, apart from the documented differences', () => {
    const disagreements: string[] = [];
    let checked = 0;
    for (const action of Object.keys(OCPP21_MESSAGES) as Ocpp21Action[]) {
      const kinds = (OCPP21_UNCONFIRMED_ACTIONS as readonly string[]).includes(action)
        ? (['request'] as const)
        : (['request', 'response'] as const);
      for (const kind of kinds) {
        const node = readSchema(action, kind, '2.1');
        const full = sample(node, true);
        const all: Case[] = [
          { name: 'minimal', payload: sample(node, false) },
          { name: 'full', payload: full },
          ...cases(node, full),
        ];
        for (const { name, payload } of all) {
          const ocaOk = oca21.check(action, kind, payload)?.length === 0;
          const coreOk = (
            kind === 'request'
              ? validateOcpp21Request(action, payload)
              : validateOcpp21Response(action, payload)
          ).ok;
          checked++;
          if (ocaOk !== coreOk) {
            disagreements.push(
              `${action} ${kind}: ${name} — OCA ${ocaOk ? 'accepts' : 'rejects'}, core ${coreOk ? 'accepts' : 'rejects'}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(6000);
    expect(disagreements).toEqual(KNOWN_DIFFERENCES_21);
  });
});
