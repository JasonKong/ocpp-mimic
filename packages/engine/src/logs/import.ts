/**
 * `ocpp-mimic import`: turns other logs into ocpp-mimic's log format, through
 * a mapping that says where each field is (docs/design.md, "M4 scale"):
 * JSONL with field paths, CSV with columns, or plain lines with a regular
 * expression's named groups. Masking uses HMAC-SHA-256 with a salt.
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import {
  createMasker,
  logLine,
  parseLog,
  type LogDirection,
  type LogLine,
  type MaskRules,
} from '@ocpp-mimic/core';

export type TimeFormat = 'iso' | 'epoch-s' | 'epoch-ms';

/** Where a field is: a CSV column (name or 0-based index), a JSON path, or a regex group. */
export interface FieldSpec {
  column?: string | number;
  path?: string;
  group?: string;
}

export interface ImportMapping {
  format: 'jsonl' | 'csv' | 'lines';
  csv: { delimiter: string; header: boolean };
  pattern?: RegExp;
  fields: {
    at: FieldSpec & { time: TimeFormat; timeZone: string };
    station: FieldSpec;
    direction: FieldSpec & { values?: Record<string, LogDirection> };
    frame: FieldSpec;
  };
  mask: MaskRules;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates a parsed mapping document. */
export function parseMapping(
  document: unknown,
): { ok: true; mapping: ImportMapping } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(document)) return { ok: false, problems: ['a mapping must be a map'] };
  const format = document.format;
  if (format !== 'jsonl' && format !== 'csv' && format !== 'lines') {
    problems.push('format must be jsonl, csv or lines');
  }
  const csv = isObject(document.csv) ? document.csv : {};
  const delimiter = csv.delimiter ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1) {
    problems.push('csv.delimiter must be one character');
  }
  let pattern: RegExp | undefined;
  if (format === 'lines') {
    if (typeof document.pattern !== 'string') problems.push('lines needs a pattern');
    else {
      try {
        pattern = new RegExp(document.pattern);
      } catch (error) {
        problems.push(`pattern: ${(error as Error).message}`);
      }
    }
  }
  const fields = isObject(document.fields) ? document.fields : {};
  const spec = (name: string): FieldSpec & Record<string, unknown> => {
    const value = fields[name];
    const given = isObject(value) ? value : {};
    const where = ['column', 'path', 'group'].filter((key) => given[key] !== undefined);
    // Lines default to the group of the field's name; the others must say where.
    if (where.length === 0 && format !== 'lines') {
      problems.push(`fields.${name} needs ${format === 'csv' ? 'a column' : 'a path'}`);
    }
    return given as FieldSpec & Record<string, unknown>;
  };
  const at = spec('at');
  const station = spec('station');
  const direction = spec('direction');
  const frame = spec('frame');
  const time = at.time ?? 'iso';
  if (time !== 'iso' && time !== 'epoch-s' && time !== 'epoch-ms') {
    problems.push('fields.at.time must be iso, epoch-s or epoch-ms');
  }
  const timeZone = at.timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(timeZone) });
  } catch {
    problems.push(`fields.at.timeZone: unknown time zone ${String(timeZone)}`);
  }
  const values = direction.values;
  if (values !== undefined) {
    if (
      !isObject(values) ||
      Object.values(values).some((v) => v !== 'cp-to-csms' && v !== 'csms-to-cp')
    ) {
      problems.push('fields.direction.values must map to cp-to-csms or csms-to-cp');
    }
  }
  const mask = isObject(document.mask) ? document.mask : {};
  const list = (value: unknown, name: string) => {
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
    problems.push(`mask.${name} must be a list of paths`);
    return [];
  };
  const maskRules: MaskRules = { paths: list(mask.paths, 'paths'), keep: list(mask.keep, 'keep') };
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    mapping: {
      format: format as ImportMapping['format'],
      csv: { delimiter: delimiter as string, header: csv.header !== false },
      ...(pattern !== undefined && { pattern }),
      fields: {
        at: { ...at, time: time as TimeFormat, timeZone: String(timeZone) },
        station,
        direction: {
          ...direction,
          ...(values !== undefined && { values: values as Record<string, LogDirection> }),
        },
        frame,
      },
      mask: maskRules,
    },
  };
}

/** Reads and validates a mapping file (YAML). */
export async function readMapping(
  file: string,
): Promise<{ ok: true; mapping: ImportMapping } | { ok: false; problems: string[] }> {
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
  const parsed = parseMapping(document.toJS());
  return parsed.ok
    ? parsed
    : { ok: false, problems: parsed.problems.map((problem) => `${file}: ${problem}`) };
}

/** Rows of a CSV text: quoted fields may hold the delimiter, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

/** The UTC offset of `zone` at `utcMs`, in milliseconds. */
function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Milliseconds since the epoch for a time. ISO times with an offset or Z are
 * taken as they are; ones without (also `2026-11-15 09:00:00.123`) are local
 * time in `timeZone`.
 */
export function parseTime(value: string, format: TimeFormat, timeZone: string): number | undefined {
  const text = value.trim();
  if (format === 'epoch-s' || format === 'epoch-ms') {
    const number = Number(text);
    if (!Number.isFinite(number)) return undefined;
    return format === 'epoch-s' ? Math.round(number * 1000) : number;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      text,
    );
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s = '0', fraction = '0', zone] = match;
  const ms = Number(`0.${fraction}`) * 1000;
  const wall =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) +
    Math.round(ms);
  if (zone !== undefined) {
    if (zone.toUpperCase() === 'Z') return wall;
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.replace(/[+:-]/g, '');
    const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
    return wall - offset;
  }
  // Local time: subtract the zone's offset, checked again at the result for DST changes.
  let utc = wall - zoneOffset(wall, timeZone);
  utc = wall - zoneOffset(utc, timeZone);
  return utc;
}

const getPath = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), value);

/** Log lines from a text in a mapped format, in time order; problems name the input line. */
export function importMapped(
  text: string,
  mapping: ImportMapping,
): { lines: LogLine[]; problems: string[] } {
  const problems: string[] = [];
  const records: { n: number; get: (field: keyof ImportMapping['fields']) => unknown }[] = [];
  const { fields } = mapping;
  if (mapping.format === 'csv') {
    const rows = parseCsv(text, mapping.csv.delimiter);
    const header = mapping.csv.header ? (rows.shift() ?? []) : [];
    rows.forEach((row, index) => {
      records.push({
        n: index + (mapping.csv.header ? 2 : 1),
        get: (field) => {
          const column = fields[field].column;
          const at = typeof column === 'number' ? column : header.indexOf(String(column));
          return at < 0 ? undefined : row[at];
        },
      });
    });
  } else {
    text.split(/\r?\n/).forEach((raw, index) => {
      if (raw.trim() === '') return;
      const n = index + 1;
      if (mapping.format === 'jsonl') {
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          problems.push(`line ${n}: not JSON`);
          return;
        }
        records.push({ n, get: (field) => getPath(value, fields[field].path ?? field) });
      } else {
        const match = mapping.pattern?.exec(raw);
        if (match?.groups === undefined) {
          problems.push(`line ${n}: does not match the pattern`);
          return;
        }
        const groups = match.groups;
        records.push({ n, get: (field) => groups[fields[field].group ?? field] });
      }
    });
  }

  const lines: LogLine[] = [];
  for (const { n, get } of records) {
    const rawAt = get('at');
    const atMs =
      typeof rawAt === 'number'
        ? fields.at.time === 'epoch-s'
          ? rawAt * 1000
          : rawAt
        : typeof rawAt === 'string'
          ? parseTime(rawAt, fields.at.time, fields.at.timeZone)
          : undefined;
    if (atMs === undefined || Number.isNaN(atMs)) {
      problems.push(`line ${n}: no readable time in ${JSON.stringify(rawAt)}`);
      continue;
    }
    const station = get('station');
    if (typeof station !== 'string' || station === '') {
      problems.push(`line ${n}: no station`);
      continue;
    }
    const rawDirection = String(get('direction') ?? '');
    const direction = fields.direction.values?.[rawDirection] ?? rawDirection;
    if (direction !== 'cp-to-csms' && direction !== 'csms-to-cp') {
      problems.push(`line ${n}: direction ${JSON.stringify(rawDirection)} is not mapped`);
      continue;
    }
    const frame = get('frame');
    const frameText = typeof frame === 'string' ? frame : JSON.stringify(frame ?? null);
    lines.push(logLine(new Date(atMs).toISOString(), station, direction, frameText));
  }
  // Stable: lines of the same millisecond keep their order.
  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { lines, problems };
}

/** Lines of ocpp-mimic's own format, or of a mapped one. */
export function importText(
  text: string,
  mapping: ImportMapping | undefined,
): { lines: LogLine[]; problems: string[]; masked: boolean } {
  if (mapping === undefined) {
    const parsed = parseLog(text);
    return {
      lines: parsed.lines,
      problems: parsed.problems,
      masked: parsed.header?.masked ?? false,
    };
  }
  return { ...importMapped(text, mapping), masked: false };
}

/** Masks lines with HMAC-SHA-256 under `salt`. */
export function maskLines(
  lines: readonly LogLine[],
  salt: string,
  rules: MaskRules = {},
): LogLine[] {
  const masker = createMasker(
    (text) => createHmac('sha256', salt).update(text).digest('hex'),
    rules,
  );
  return lines.map((line) => masker.line(line));
}
