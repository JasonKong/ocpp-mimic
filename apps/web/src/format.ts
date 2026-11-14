/** Display helpers for the message log and station views. */
import type { FrameRecord } from './api.js';

const TYPE_LABELS = { 2: 'CALL', 3: 'RESULT', 4: 'ERROR' } as const;

export function messageTypeLabel(record: FrameRecord): string {
  return record.messageType === undefined ? 'INVALID' : TYPE_LABELS[record.messageType];
}

function field(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

/** A one-line summary of the parts of a frame worth seeing at a glance. */
export function summarize(record: FrameRecord): string {
  const p = record.payload;
  if (record.messageType === 4)
    return `${String(field(p, 'errorCode'))} ${String(field(p, 'errorDescription') ?? '')}`.trim();
  const status = field(p, 'status');
  if (record.messageType === 3) {
    const transactionId = field(p, 'transactionId');
    const idTagStatus = field(field(p, 'idTagInfo'), 'status');
    const parts = [
      status !== undefined ? String(status) : undefined,
      transactionId !== undefined ? `tx ${String(transactionId)}` : undefined,
      idTagStatus !== undefined ? `idTag ${String(idTagStatus)}` : undefined,
    ].filter((part) => part !== undefined);
    return parts.join(' · ');
  }
  switch (record.action) {
    case 'StatusNotification': {
      const error = field(p, 'errorCode');
      return `connector ${String(field(p, 'connectorId'))} → ${String(status)}${error !== undefined && error !== 'NoError' ? ` (${String(error)})` : ''}`;
    }
    case 'StartTransaction':
      return `connector ${String(field(p, 'connectorId'))} · ${String(field(p, 'idTag'))} · ${String(field(p, 'meterStart'))} Wh`;
    case 'StopTransaction':
      return `tx ${String(field(p, 'transactionId'))} · ${String(field(p, 'reason') ?? 'Local')} · ${String(field(p, 'meterStop'))} Wh`;
    case 'MeterValues': {
      const values = field(field(p, 'meterValue'), '0');
      const first = field(field(values, 'sampledValue'), '0');
      return first === undefined
        ? ''
        : `${String(field(first, 'value'))} ${String(field(first, 'unit') ?? '')}`.trim();
    }
    case 'RemoteStartTransaction':
    case 'Authorize':
      return String(field(p, 'idTag'));
    case 'RemoteStopTransaction':
      return `tx ${String(field(p, 'transactionId'))}`;
    case 'Reset':
    case 'ChangeAvailability':
      return String(field(p, 'type'));
    case 'ChangeConfiguration':
      return `${String(field(p, 'key'))} = ${String(field(p, 'value'))}`;
    case 'TriggerMessage':
      return String(field(p, 'requestedMessage'));
    default:
      return '';
  }
}

export function formatEnergy(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(0)} Wh`;
}

export function formatPower(w: number): string {
  return w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${w.toFixed(0)} W`;
}

export function formatTime(iso: string): string {
  return iso.slice(11, 23);
}
