/**
 * Masking logs on import (docs/design.md, "M4 scale"): identifiers get
 * stable pseudonyms, secrets and opaque data are removed. core has no
 * crypto, so the caller passes the keyed hash (the engine uses HMAC-SHA-256
 * with the salt): one value always gets the same pseudonym under one salt,
 * so sessions still line up after masking.
 */
import type { LogLine } from './log-format.js';

/** Hex digest of `text` under the caller's key. */
export type KeyedHash = (text: string) => string;

export interface MaskRules {
  /**
   * More payload paths to mask: `Action.field.sub` (array levels left out)
   * or `*.field` for any action. Strings get pseudonyms, other values go.
   */
  paths?: string[];
  /** Paths masked by default that are kept. */
  keep?: string[];
}

const REMOVED = '<removed>';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(hex: string): string {
  let bits = '';
  for (const char of hex) bits += parseInt(char, 16).toString(2).padStart(4, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/** Field name → how it is pseudonymized: kind (part of the hash input), prefix, maximum length. */
const PSEUDONYMS: Record<string, { kind: string; prefix: string; max: number }> = {
  idTag: { kind: 'idTag', prefix: 'T', max: 20 },
  parentIdTag: { kind: 'idTag', prefix: 'T', max: 20 },
  chargePointSerialNumber: { kind: 'serial', prefix: 'S', max: 25 },
  chargeBoxSerialNumber: { kind: 'serial', prefix: 'S', max: 25 },
  meterSerialNumber: { kind: 'serial', prefix: 'S', max: 25 },
  iccid: { kind: 'sim', prefix: 'SIM', max: 20 },
  imsi: { kind: 'sim', prefix: 'SIM', max: 20 },
};

/** Fields whose values are removed wherever they occur. */
const SECRETS = new Set(['certificate', 'certificateChain', 'csr']);

export interface Masker {
  /** A station id's pseudonym. */
  station(id: string): string;
  /** A masked copy of a log line. Answers are matched to their CALL for the action. */
  line(line: LogLine): LogLine;
}

export function createMasker(hash: KeyedHash, rules: MaskRules = {}): Masker {
  const keep = new Set(rules.keep ?? []);
  const extra = new Set(rules.paths ?? []);
  /** `${station} ${uniqueId}` → the CALL's action, for its answer. */
  const actions = new Map<string, string>();
  const pseudonym = (kind: string, prefix: string, max: number, value: string) =>
    prefix + base32(hash(`${kind}:${value}`)).slice(0, Math.min(10, max - prefix.length));

  const matches = (set: Set<string>, path: string) => {
    if (set.has(path)) return true;
    const rest = path.slice(path.indexOf('.') + 1);
    return set.has(`*.${rest}`);
  };

  function walk(value: unknown, path: string, action: string): unknown {
    if (Array.isArray(value)) return value.map((item) => walk(item, path, action));
    if (typeof value === 'object' && value !== null) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [
          key,
          field(key, child, `${path}.${key}`, action, object),
        ]),
      );
    }
    return value;
  }

  function field(
    key: string,
    value: unknown,
    path: string,
    action: string,
    object: Record<string, unknown>,
  ): unknown {
    if (matches(keep, path)) return value;
    if (matches(extra, path)) {
      return typeof value === 'string' ? pseudonym(`custom:${path}`, 'X', 20, value) : REMOVED;
    }
    const kind = PSEUDONYMS[key];
    if (kind !== undefined && typeof value === 'string') {
      return pseudonym(kind.kind, kind.prefix, kind.max, value);
    }
    if (SECRETS.has(key)) return REMOVED;
    if (action === 'DataTransfer' && key === 'data') return REMOVED;
    // AuthorizationKey values, in ChangeConfiguration and GetConfiguration answers.
    if (key === 'value' && object.key === 'AuthorizationKey') return '***';
    if (key === 'location' && typeof value === 'string') {
      return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^/@]*@/i, '$1:***@');
    }
    return walk(value, path, action);
  }

  return {
    station: (id) => pseudonym('station', 'CP-', 48, id),

    line(line) {
      const station = pseudonym('station', 'CP-', 48, line.station);
      if (line.frame === undefined) {
        // Text that is not a message may hold anything.
        return { ...line, station, text: REMOVED };
      }
      const frame = [...line.frame];
      const [type, id] = frame;
      const key = `${line.station} ${String(id)}`;
      if (type === 2) {
        const action = String(frame[2]);
        actions.set(key, action);
        frame[3] = walk(frame[3], action, action);
      } else if (type === 3) {
        const action = actions.get(key) ?? '?';
        actions.delete(key);
        frame[2] = walk(frame[2], action, action);
      } else if (type === 4) {
        actions.delete(key);
      }
      return { ...line, station, frame };
    },
  };
}
