import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics, Histogram, type Metrics, type MeteredStation } from './metrics.js';
import type { FrameRecord } from './recorder.js';

let metrics: Metrics | undefined;
afterEach(() => {
  metrics?.stop();
  metrics = undefined;
});

describe('Histogram', () => {
  it('counts Prometheus buckets exactly and percentiles within 2 %', () => {
    const h = new Histogram();
    for (let ms = 1; ms <= 1000; ms++) h.observe(ms / 1000);
    expect(h.count).toBe(1000);
    expect(h.bucketCounts[h.buckets.indexOf(0.1)]).toBe(100);
    expect(h.bucketCounts[h.buckets.indexOf(1)]).toBe(1000);
    for (const [q, expected] of [
      [0.5, 0.5],
      [0.95, 0.95],
      [0.99, 0.99],
    ] as const) {
      expect(Math.abs(h.percentile(q) - expected) / expected).toBeLessThan(0.021);
    }
    expect(new Histogram().percentile(0.5)).toBe(0);
  });

  it('merges another histogram', () => {
    const a = new Histogram();
    const b = new Histogram();
    a.observe(0.01);
    b.observe(2);
    a.merge(b);
    expect(a.count).toBe(2);
    expect(a.percentile(1)).toBeGreaterThan(1.9);
  });
});

describe('metrics', () => {
  let clock = 0;
  const stations: MeteredStation[] = [];
  function setup() {
    clock = 1_000_000;
    stations.splice(0, stations.length);
    metrics = createMetrics({
      now: () => clock,
      version: '1.2.3',
      stations: () => stations,
      labelsOf: (id) =>
        id.startsWith('A')
          ? { persona: 'p', group: 'a', ocpp: '1.6' }
          : id.startsWith('B')
            ? { persona: 'p201', group: 'b', ocpp: '2.0.1' }
            : undefined,
    });
    return metrics;
  }
  let seq = 0;
  const frame = (
    stationId: string,
    direction: FrameRecord['direction'],
    messageType: 2 | 3 | 4,
    uniqueId: string,
    action: string | undefined,
    payload: unknown,
    extra: Partial<FrameRecord> = {},
  ): FrameRecord => ({
    kind: 'frame',
    seq: ++seq,
    stationId,
    at: '',
    direction,
    messageType,
    uniqueId,
    ...(action !== undefined && { action }),
    payload,
    text: JSON.stringify([messageType, uniqueId, payload]),
    ...extra,
  });

  it('measures CSMS latency per action and counts answers, errors and timeouts', () => {
    const m = setup();
    m.frame(frame('A-1', 'cp-to-csms', 2, 'u1', 'Heartbeat', {}));
    clock += 40;
    m.frame(frame('A-1', 'csms-to-cp', 3, 'u1', 'Heartbeat', { currentTime: '' }));
    m.frame(frame('A-1', 'cp-to-csms', 2, 'u2', 'DataTransfer', { vendorId: 'x' }));
    clock += 10;
    m.frame(frame('A-1', 'csms-to-cp', 4, 'u2', 'DataTransfer', { errorCode: 'NotImplemented' }));
    m.frame(frame('A-1', 'cp-to-csms', 2, 'u3', 'Heartbeat', {}));
    m.rpc('A-1', { type: 'timeout', id: 'u3', action: 'Heartbeat' });
    m.frame(frame('A-1', 'csms-to-cp', 2, 'c1', 'Reset', { type: 'Soft' }));

    const summary = m.summary();
    expect(summary.csmsLatency.byAction.Heartbeat).toMatchObject({ count: 1 });
    expect(summary.csmsLatency.byAction.Heartbeat!.p50).toBeCloseTo(40, -1);
    expect(summary.answers).toEqual({ result: 1, error: 1, timeout: 1 });
    expect(summary.callErrors).toEqual({ sent: 0, received: 1 });
    expect(summary.callsReceived).toBe(1);
    expect(summary.frames).toEqual({ sent: 3, received: 3 });

    const text = m.prometheus();
    expect(text).toContain(
      'ocpp_mimic_csms_response_seconds_bucket{action="Heartbeat",persona="p",group="a",le="0.05"} 1',
    );
    expect(text).toContain(
      'ocpp_mimic_csms_response_seconds_bucket{action="Heartbeat",persona="p",group="a",le="0.025"} 0',
    );
    expect(text).toContain('ocpp_mimic_csms_answers_total{action="Heartbeat",outcome="timeout"} 1');
    expect(text).toContain(
      'ocpp_mimic_callerrors_total{direction="received",action="DataTransfer",code="NotImplemented"} 1',
    );
    expect(text).toContain('ocpp_mimic_info{version="1.2.3"} 1');
  });

  it('counts transactions, their energy, schema violations and dropped frames', () => {
    const m = setup();
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 's1', 'StartTransaction', { connectorId: 1, meterStart: 1000 }),
    );
    m.frame(
      frame('A-1', 'csms-to-cp', 3, 's1', 'StartTransaction', {
        transactionId: 7,
        idTagInfo: { status: 'Accepted' },
      }),
    );
    m.frame(frame('A-1', 'cp-to-csms', 2, 's2', 'StartTransaction', { meterStart: 0 }));
    m.frame(
      frame('A-1', 'csms-to-cp', 3, 's2', 'StartTransaction', {
        transactionId: 8,
        idTagInfo: { status: 'Invalid' },
      }),
    );
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 's3', 'StopTransaction', { transactionId: 7, meterStop: 4500 }),
    );
    m.frame(frame('A-1', 'csms-to-cp', 3, 's3', 'StopTransaction', {}));
    m.frame(frame('A-1', 'cp-to-csms', 2, 'x', 'Heartbeat', {}, { schemaErrors: ['bad'] }));
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 'y', 'Heartbeat', {}, { dropped: true, injected: 'drop' }),
    );

    const summary = m.summary();
    expect(summary.transactions).toEqual({ started: 1, refused: 1, stopped: 1 });
    expect(summary.energyWh).toBe(3500);
    expect(summary.schemaViolations).toBe(1);
    expect(summary.frames.sent).toBe(4);
    expect(m.prometheus()).toContain('ocpp_mimic_energy_wh_total{persona="p",group="a"} 3500');
  });

  it('classifies connections and disconnects', () => {
    const m = setup();
    const states = (...events: Parameters<Metrics['transport']>[1][]) =>
      events.forEach((e) => m.transport('A-1', e));
    // Opened, then the station dropped it itself.
    states(
      { type: 'connecting', url: '' },
      { type: 'open', protocol: 'ocpp1.6' },
      { type: 'state', state: 'open' },
    );
    states({ type: 'state', state: 'offline' });
    // Opened, then the CSMS closed it.
    states({ type: 'connecting', url: '' }, { type: 'open', protocol: 'ocpp1.6' });
    states({ type: 'close', code: 1000, reason: '' }, { type: 'state', state: 'waiting' });
    // Opened, then the connection broke.
    states({ type: 'connecting', url: '' }, { type: 'open', protocol: 'ocpp1.6' });
    states({ type: 'close', code: 1006, reason: '' }, { type: 'state', state: 'waiting' });
    // A failed attempt.
    states({ type: 'connecting', url: '' }, { type: 'state', state: 'connecting' });
    states({ type: 'close', code: 1006, reason: '' }, { type: 'state', state: 'waiting' });

    const summary = m.summary();
    expect(summary.connections).toEqual({ opened: 3, failed: 1 });
    expect(summary.disconnects).toEqual({ local: 1, remote: 1, error: 1 });
  });

  it('reads station and connector gauges from the stations on each scrape', () => {
    const m = setup();
    stations.push(
      {
        id: 'A-1',
        persona: 'p',
        group: 'a',
        running: true,
        transport: 'open',
        queuedMessages: () => 2,
      },
      {
        id: 'A-2',
        persona: 'p',
        group: 'a',
        running: true,
        transport: 'waiting',
        queuedMessages: () => 0,
      },
      { id: 'B-1', persona: 'q', running: false, transport: 'stopped', queuedMessages: () => 5 },
    );
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 'n1', 'StatusNotification', {
        connectorId: 1,
        status: 'Charging',
      }),
    );
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 'n2', 'StatusNotification', {
        connectorId: 2,
        status: 'Available',
      }),
    );
    m.frame(
      frame('A-1', 'cp-to-csms', 2, 'n3', 'StatusNotification', {
        connectorId: 0,
        status: 'Available',
      }),
    );

    expect(m.summary()).toMatchObject({
      stations: { connected: 1, connecting: 1, stopped: 1 },
      connectors: { Charging: 1, Available: 1 },
      offlineQueue: 2,
    });
    const text = m.prometheus();
    expect(text).toContain('ocpp_mimic_stations{state="connected",persona="p",group="a"} 1');
    expect(text).toContain('ocpp_mimic_stations{state="stopped",persona="q",group=""} 1');
    expect(text).toContain('ocpp_mimic_connectors{status="Charging",persona="p",group="a"} 1');
    m.forget('A-1');
    expect(m.summary().connectors).toEqual({});
  });

  it('writes valid Prometheus text: HELP and TYPE once per metric, sample lines after them', () => {
    const m = setup();
    m.lateness(3);
    m.frame(frame('A-1', 'cp-to-csms', 2, 'u1', 'Heartbeat', {}));
    m.frame(frame('A-1', 'csms-to-cp', 3, 'u1', 'Heartbeat', {}));
    const lines = m.prometheus().trimEnd().split('\n');
    const types = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
    expect(new Set(types).size).toBe(types.length);
    for (const line of lines.filter((l) => !l.startsWith('#'))) {
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$/);
      const name = line.split(/[{ ]/)[0] ?? '';
      expect(types.some((t) => name === t || name.startsWith(`${t}_`))).toBe(true);
    }
    expect(m.summary().lateWork.count).toBe(1);
  });
  it('counts 2.0.1 transactions, energy and EVSE statuses, and labels frames and connections by version', () => {
    const m = setup();
    stations.push({
      id: 'B-1',
      persona: 'p201',
      group: 'b',
      running: true,
      transport: 'open',
      queuedMessages: () => 0,
    });
    m.transport('B-1', { type: 'connecting', url: 'ws://csms/B-1' });
    m.transport('B-1', { type: 'open' });
    m.frame(
      frame('B-1', 'cp-to-csms', 2, 's1', 'StatusNotification', {
        timestamp: '',
        connectorStatus: 'Occupied',
        evseId: 2,
        connectorId: 1,
      }),
    );
    const sample = (value: number, context: string) => [
      { timestamp: '', sampledValue: [{ value, context, measurand: 'Energy.Active.Import.Register' }] },
    ];
    m.frame(
      frame('B-1', 'cp-to-csms', 2, 't1', 'TransactionEvent', {
        eventType: 'Started',
        transactionInfo: { transactionId: 'tx-1' },
        meterValue: sample(1000, 'Transaction.Begin'),
      }),
    );
    m.frame(frame('B-1', 'csms-to-cp', 3, 't1', undefined, { idTokenInfo: { status: 'Accepted' } }));
    m.frame(
      frame('B-1', 'cp-to-csms', 2, 't2', 'TransactionEvent', {
        eventType: 'Ended',
        transactionInfo: { transactionId: 'tx-1' },
        meterValue: sample(4500, 'Transaction.End'),
      }),
    );
    m.frame(frame('B-1', 'csms-to-cp', 3, 't2', undefined, {}));
    m.frame(
      frame('B-1', 'cp-to-csms', 2, 't3', 'TransactionEvent', {
        eventType: 'Started',
        transactionInfo: { transactionId: 'tx-2' },
      }),
    );
    m.frame(frame('B-1', 'csms-to-cp', 3, 't3', undefined, { idTokenInfo: { status: 'Invalid' } }));
    const summary = m.summary();
    expect(summary.transactions).toEqual({ started: 1, stopped: 1, refused: 1 });
    expect(summary.energyWh).toBe(3500);
    expect(summary.connectors).toEqual({ Occupied: 1 });
    const text = m.prometheus();
    expect(text).toContain('ocpp_mimic_frames_total{direction="sent",ocpp="2.0.1"} 4');
    expect(text).toContain('ocpp_mimic_connections_total{outcome="opened",ocpp="2.0.1"} 1');
  });
});
