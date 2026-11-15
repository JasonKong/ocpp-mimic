/**
 * ocpp-mimic's log format (docs/design.md, "M4 scale"): JSONL with an
 * optional header line, then one frame per line. It is what the engine
 * exports, what `import` writes, and what replay and calibration read.
 */
import { isOcpp16Action } from './ocpp16-messages.js';
import { isOcpp201Action } from './ocpp201/messages.js';
import { parseFrame, type Frame } from './ocppj.js';

export const LOG_FORMAT = 'ocpp-mimic-log';
export const LOG_VERSION = 1;

export type LogDirection = 'cp-to-csms' | 'csms-to-cp';

/** The OCPP version a log line's station speaks. */
export type LogOcppVersion = '1.6' | '2.0.1';

export interface LogHeader {
  format: typeof LOG_FORMAT;
  version: typeof LOG_VERSION;
  masked: boolean;
  /** Where the log came from, e.g. `export` or the imported file's name. */
  source?: string;
}

export interface LogLine {
  /** ISO 8601 with milliseconds, UTC. */
  at: string;
  station: string;
  direction: LogDirection;
  /** The OCPP-J message, as an array; absent when the text is not a message. */
  frame?: unknown[];
  /** The raw text of a frame that is not JSON or not a message. */
  text?: string;
  /** The fault injection that changed, made or kept back the frame. */
  injected?: string;
  /** The frame never reached the other side. */
  dropped?: true;
  /** The station's OCPP version; logs written before M5 leave it out (see logVersions). */
  ocpp?: LogOcppVersion;
}

/** A log line for a frame's text: `frame` when it is an OCPP-J message, else `text`. */
export function logLine(
  at: string,
  station: string,
  direction: LogDirection,
  text: string,
  marks: { injected?: string; dropped?: true; ocpp?: LogOcppVersion } = {},
): LogLine {
  let frame: unknown[] | undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && parseFrame(text).ok) frame = value;
  } catch {
    // not JSON: kept as text
  }
  return {
    at,
    station,
    direction,
    ...(frame !== undefined ? { frame } : { text }),
    ...(marks.injected !== undefined && { injected: marks.injected }),
    ...(marks.dropped !== undefined && { dropped: marks.dropped }),
    ...(marks.ocpp !== undefined && { ocpp: marks.ocpp }),
  };
}

/** The version a subprotocol names (`ocpp1.6`, `ocpp2.0.1`), if any. */
export function versionOfSubprotocol(subprotocol: string): LogOcppVersion | undefined {
  if (subprotocol.includes('2.0.1')) return '2.0.1';
  if (subprotocol.includes('1.6')) return '1.6';
  return undefined;
}

/**
 * Each station's OCPP version: the one its lines carry, else what their
 * actions tell (an action only one version has, such as TransactionEvent or
 * StartTransaction). Stations whose actions both versions share are left out.
 */
export function logVersions(lines: readonly LogLine[]): Map<string, LogOcppVersion> {
  const versions = new Map<string, LogOcppVersion>();
  const votes = new Map<string, { '1.6': number; '2.0.1': number }>();
  for (const line of lines) {
    if (line.ocpp !== undefined) {
      versions.set(line.station, line.ocpp);
      continue;
    }
    const frame = line.frame;
    if (frame === undefined || frame[0] !== 2 || typeof frame[2] !== 'string') continue;
    const action = frame[2];
    const only16 = isOcpp16Action(action) && !isOcpp201Action(action);
    const only201 = isOcpp201Action(action) && !isOcpp16Action(action);
    if (!only16 && !only201) continue;
    const count = votes.get(line.station) ?? { '1.6': 0, '2.0.1': 0 };
    count[only16 ? '1.6' : '2.0.1'] += 1;
    votes.set(line.station, count);
  }
  for (const [station, count] of votes) {
    if (versions.has(station)) continue;
    versions.set(station, count['2.0.1'] > count['1.6'] ? '2.0.1' : '1.6');
  }
  return versions;
}

/** The lines with each station's version filled in where logVersions knows it. */
export function withVersions(lines: readonly LogLine[]): LogLine[] {
  const versions = logVersions(lines);
  return lines.map((line) => {
    const ocpp = line.ocpp ?? versions.get(line.station);
    return ocpp === undefined || line.ocpp !== undefined ? line : { ...line, ocpp };
  });
}

/** The JSONL text of a log: the header, then one line per frame. */
export function formatLog(
  lines: readonly LogLine[],
  header: Omit<LogHeader, 'format' | 'version'>,
): string {
  const head: LogHeader = { format: LOG_FORMAT, version: LOG_VERSION, ...header };
  return `${[head, ...lines].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** The text a line stands for: the frame serialized, or the kept text. */
export function lineText(line: LogLine): string {
  return line.frame !== undefined ? JSON.stringify(line.frame) : (line.text ?? '');
}

/** The parsed OCPP-J frame of a line, when it has one. */
export function lineFrame(line: LogLine): Frame | undefined {
  if (line.frame === undefined) return undefined;
  const parsed = parseFrame(JSON.stringify(line.frame));
  return parsed.ok ? parsed.frame : undefined;
}

export interface ParsedLog {
  header?: LogHeader;
  lines: LogLine[];
  /** `line N: problem` for lines that are not log lines. */
  problems: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads ocpp-mimic's JSONL log format. */
export function parseLog(text: string): ParsedLog {
  const result: ParsedLog = { lines: [], problems: [] };
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '') return;
    const n = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      result.problems.push(`line ${n}: not JSON`);
      return;
    }
    if (!isObject(value)) {
      result.problems.push(`line ${n}: expected an object`);
      return;
    }
    if (value.format === LOG_FORMAT) {
      if (value.version !== LOG_VERSION) {
        result.problems.push(`line ${n}: log version ${String(value.version)} is not supported`);
      } else if (n !== 1 && result.header === undefined && result.lines.length > 0) {
        result.problems.push(`line ${n}: the header must come first`);
      } else {
        result.header = value as unknown as LogHeader;
      }
      return;
    }
    const { at, station, direction, frame, text: kept, ocpp } = value;
    if (ocpp !== undefined && ocpp !== '1.6' && ocpp !== '2.0.1') {
      result.problems.push(`line ${n}: "ocpp" must be 1.6 or 2.0.1`);
    } else if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      result.problems.push(`line ${n}: "at" must be an ISO 8601 time`);
    } else if (typeof station !== 'string' || station === '') {
      result.problems.push(`line ${n}: "station" must be a station id`);
    } else if (direction !== 'cp-to-csms' && direction !== 'csms-to-cp') {
      result.problems.push(`line ${n}: "direction" must be cp-to-csms or csms-to-cp`);
    } else if (!Array.isArray(frame) && typeof kept !== 'string') {
      result.problems.push(`line ${n}: needs "frame" (an OCPP-J array) or "text"`);
    } else {
      result.lines.push(value as unknown as LogLine);
    }
  });
  return result;
}
