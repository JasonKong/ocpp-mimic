/** Frame records as ocpp-mimic log lines, for export and `--log-dir`. */
import { formatLog, logLine, type LogLine } from '@ocpp-mimic/core';
import type { FrameRecord, RecordEntry } from '../recorder.js';

export function recordToLine(record: FrameRecord): LogLine {
  return logLine(record.at, record.stationId, record.direction, record.text, {
    ...(record.injected !== undefined && { injected: record.injected }),
    ...(record.dropped === true && { dropped: true }),
    ...(record.ocpp !== undefined && { ocpp: record.ocpp }),
  });
}

/** The JSONL log of a station's frames (log entries left out). */
export function exportLog(entries: readonly RecordEntry[], source = 'export'): string {
  const lines = entries
    .filter((entry): entry is FrameRecord => entry.kind === 'frame')
    .map(recordToLine);
  return formatLog(lines, { masked: false, source });
}
