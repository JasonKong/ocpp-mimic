/** Display helpers for the message log and station views. */
import type { DeviceModelEntry, FrameRecord, RecordEntry } from './api.js';

const TYPE_LABELS = { 2: 'CALL', 3: 'RESULT', 4: 'ERROR', 5: 'RES.ERR', 6: 'SEND' } as const;

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
  if (record.messageType === 4 || record.messageType === 5)
    return `${String(field(p, 'errorCode'))} ${String(field(p, 'errorDescription') ?? '')}`.trim();
  const status = field(p, 'status');
  if (record.messageType === 3) {
    const transactionId = field(p, 'transactionId');
    const idTagStatus = field(field(p, 'idTagInfo'), 'status');
    const idTokenStatus = field(field(p, 'idTokenInfo'), 'status');
    const parts = [
      status !== undefined ? String(status) : undefined,
      transactionId !== undefined ? `tx ${String(transactionId)}` : undefined,
      idTagStatus !== undefined ? `idTag ${String(idTagStatus)}` : undefined,
      idTokenStatus !== undefined ? `idToken ${String(idTokenStatus)}` : undefined,
    ].filter((part) => part !== undefined);
    return parts.join(' · ');
  }
  switch (record.action) {
    case 'StatusNotification': {
      // 2.0.1: EVSE and connector with connectorStatus.
      const connectorStatus = field(p, 'connectorStatus');
      if (connectorStatus !== undefined) {
        return `EVSE ${String(field(p, 'evseId'))}/${String(field(p, 'connectorId'))} → ${String(connectorStatus)}`;
      }
      const error = field(p, 'errorCode');
      return `connector ${String(field(p, 'connectorId'))} → ${String(status)}${error !== undefined && error !== 'NoError' ? ` (${String(error)})` : ''}`;
    }
    case 'TransactionEvent': {
      const info = field(p, 'transactionInfo');
      const chargingState = field(info, 'chargingState');
      const stoppedReason = field(info, 'stoppedReason');
      return [
        `${String(field(p, 'eventType'))} #${String(field(p, 'seqNo'))}`,
        String(field(p, 'triggerReason')),
        chargingState === undefined ? undefined : String(chargingState),
        stoppedReason === undefined ? undefined : String(stoppedReason),
      ]
        .filter((part) => part !== undefined)
        .join(' · ');
    }
    case 'RequestStartTransaction':
      return String(field(field(p, 'idToken'), 'idToken'));
    case 'RequestStopTransaction':
      return `tx ${String(field(p, 'transactionId'))}`;
    case 'SetVariables':
    case 'GetVariables': {
      const list = record.action === 'SetVariables' ? 'setVariableData' : 'getVariableData';
      const items = (field(p, list) ?? []) as unknown[];
      return items
        .map((item) => {
          const name = `${String(field(field(item, 'component'), 'name'))}.${String(field(field(item, 'variable'), 'name'))}`;
          const value = field(item, 'attributeValue');
          return value === undefined ? name : `${name} = ${String(value)}`;
        })
        .join(', ');
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
      return String(field(p, 'idTag'));
    case 'Authorize':
      return String(field(p, 'idTag') ?? field(field(p, 'idToken'), 'idToken'));
    case 'RemoteStopTransaction':
      return `tx ${String(field(p, 'transactionId'))}`;
    case 'Reset':
      return String(field(p, 'type'));
    case 'ChangeAvailability':
      return String(field(p, 'type') ?? field(p, 'operationalStatus'));
    case 'ChangeConfiguration':
      return `${String(field(p, 'key'))} = ${String(field(p, 'value'))}`;
    case 'TriggerMessage':
      return String(field(p, 'requestedMessage'));
    default:
      return '';
  }
}

/** A TransactionEvent the station sent, for the transaction view. */
export interface TransactionEventRow {
  seq: number;
  at: string;
  evseId?: number;
  transactionId: string;
  seqNo: number;
  eventType: string;
  triggerReason: string;
  chargingState?: string;
  stoppedReason?: string;
  idToken?: string;
  offline: boolean;
}

/** The TransactionEvents in a station's records, oldest first, optionally of one EVSE. */
export function transactionEvents(
  entries: readonly RecordEntry[],
  evseId?: number,
): TransactionEventRow[] {
  return entries.flatMap((entry) => {
    if (
      entry.kind !== 'frame' ||
      entry.direction !== 'cp-to-csms' ||
      entry.messageType !== 2 ||
      entry.action !== 'TransactionEvent'
    ) {
      return [];
    }
    const p = entry.payload;
    const info = field(p, 'transactionInfo');
    const evse = field(field(p, 'evse'), 'id');
    if (evseId !== undefined && evse !== undefined && evse !== evseId) return [];
    const chargingState = field(info, 'chargingState');
    const stoppedReason = field(info, 'stoppedReason');
    const idToken = field(field(p, 'idToken'), 'idToken');
    return [
      {
        seq: entry.seq,
        at: entry.at,
        ...(typeof evse === 'number' && { evseId: evse }),
        transactionId: String(field(info, 'transactionId')),
        seqNo: Number(field(p, 'seqNo')),
        eventType: String(field(p, 'eventType')),
        triggerReason: String(field(p, 'triggerReason')),
        ...(chargingState !== undefined && { chargingState: String(chargingState) }),
        ...(stoppedReason !== undefined && { stoppedReason: String(stoppedReason) }),
        ...(idToken !== undefined && { idToken: String(idToken) }),
        offline: field(p, 'offline') === true,
      },
    ];
  });
}

/** A component of the Device Model with its variables, for the browser. */
export interface DeviceModelGroup {
  component: string;
  variables: DeviceModelEntry[];
}

/**
 * The Device Model by component, in a stable order (station components,
 * then each EVSE followed by its connectors), keeping variables whose component,
 * variable or Actual value contains `filter` (case-insensitive).
 */
export function groupDeviceModel(
  variables: readonly DeviceModelEntry[],
  filter = '',
): DeviceModelGroup[] {
  const text = filter.trim().toLowerCase();
  const matches = (v: DeviceModelEntry) =>
    text === '' ||
    v.component.toLowerCase().includes(text) ||
    v.variable.toLowerCase().includes(text) ||
    (v.attributes.find((a) => a.type === 'Actual')?.value ?? '').toLowerCase().includes(text);
  const groups = new Map<string, DeviceModelEntry[]>();
  for (const v of variables.filter(matches)) {
    groups.set(v.component, [...(groups.get(v.component) ?? []), v]);
  }
  const order = (component: string) => {
    const at = /@(\d+)(?:\.(\d+))?$/.exec(component);
    return at === null ? [0, 0, 0] : [1, Number(at[1]), at[2] === undefined ? 0 : Number(at[2])];
  };
  return [...groups]
    .sort(([a], [b]) => {
      const [x, y] = [order(a), order(b)];
      for (let i = 0; i < 3; i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) return d;
      }
      return a.localeCompare(b);
    })
    .map(([component, list]) => ({
      component,
      variables: [...list].sort((a, b) => a.variable.localeCompare(b.variable)),
    }));
}

/** The tone of a status badge: 1.6 statuses, 2.0.1 connector statuses and charging states. */
export function statusTone(status: string): string {
  if (status === 'Charging') return 'good';
  if (status === 'Faulted') return 'bad';
  if (status === 'Unavailable') return 'muted';
  if (
    status.startsWith('Suspended') ||
    status === 'Finishing' ||
    status === 'Preparing' ||
    status === 'Reserved' ||
    status === 'Occupied' ||
    status === 'EVConnected'
  ) {
    return 'warn';
  }
  return '';
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
