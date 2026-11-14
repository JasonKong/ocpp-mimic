import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine.js';
import { Histogram, type MetricFamily } from './metrics.js';
import { otlpFromEnvironment, otlpRequest, parseKeyValues, startOtlpExporter } from './otlp.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** Loosely typed OTLP JSON keeps the assertions short. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** A fake collector: keeps each request's path, headers and JSON body. */
async function collector(status = 200) {
  const requests: { path: string; headers: Record<string, unknown>; body: Loose }[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(text) });
      res.writeHead(status).end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function families(): MetricFamily[] {
  const h = new Histogram([0.1, 1]);
  h.observe(0.05);
  h.observe(0.5);
  h.observe(2);
  return [
    {
      name: 'ocpp_mimic_stations',
      help: 'Stations.',
      type: 'gauge',
      points: [{ labels: { state: 'connected' }, value: 3 }],
    },
    {
      name: 'ocpp_mimic_frames_total',
      help: 'Frames.',
      type: 'counter',
      points: [{ labels: { direction: 'sent' }, value: 7 }],
    },
    {
      name: 'ocpp_mimic_csms_response_seconds',
      help: 'Latency.',
      type: 'histogram',
      points: [{ labels: { action: 'Heartbeat' }, histogram: h }],
    },
    {
      name: 'ocpp_mimic_eventloop_delay_seconds',
      help: 'Delay.',
      type: 'summary',
      points: [
        {
          labels: {},
          summary: {
            quantiles: [
              [0.5, 0.001],
              [1, 0.02],
            ],
            sum: 0.5,
            count: 100,
          },
        },
      ],
    },
  ];
}

describe('OTLP encoding', () => {
  it('writes gauges, cumulative sums without _total, histograms with per-bucket counts, and summaries', () => {
    const request = otlpRequest(
      families(),
      { 'service.name': 'ocpp-mimic' },
      { name: 'ocpp-mimic', version: '1' },
      1000,
      3000,
    ) as Loose;
    const [resourceMetrics] = request.resourceMetrics;
    expect(resourceMetrics.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'ocpp-mimic' } },
    ]);
    const metrics = resourceMetrics.scopeMetrics[0].metrics;
    expect(metrics.map((m: { name: string }) => m.name)).toEqual([
      'ocpp_mimic_stations',
      'ocpp_mimic_frames',
      'ocpp_mimic_csms_response_seconds',
      'ocpp_mimic_eventloop_delay_seconds',
    ]);
    expect(metrics[0].gauge.dataPoints[0]).toEqual({
      attributes: [{ key: 'state', value: { stringValue: 'connected' } }],
      startTimeUnixNano: '1000000000',
      timeUnixNano: '3000000000',
      asDouble: 3,
    });
    expect(metrics[1].sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect(metrics[2]).toMatchObject({ unit: 's' });
    expect(metrics[2].histogram.dataPoints[0]).toMatchObject({
      count: '3',
      sum: 2.55,
      max: 2,
      bucketCounts: ['1', '1', '1'],
      explicitBounds: [0.1, 1],
    });
    expect(metrics[3].summary.dataPoints[0]).toMatchObject({
      count: '100',
      quantileValues: [
        { quantile: 0.5, value: 0.001 },
        { quantile: 1, value: 0.02 },
      ],
    });
  });

  it('reads the standard environment variables', () => {
    expect(parseKeyValues('a=1, b = two%20words,broken')).toEqual({ a: '1', b: 'two words' });
    expect(otlpFromEnvironment({})).toBeUndefined();
    expect(
      otlpFromEnvironment({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=k',
        OTEL_METRIC_EXPORT_INTERVAL: '5000',
        OTEL_SERVICE_NAME: 'mimic-lab',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test',
      }),
    ).toEqual({
      endpoint: 'http://collector:4318',
      headers: { 'x-api-key': 'k' },
      intervalMs: 5000,
      attributes: { 'deployment.environment': 'test' },
      serviceName: 'mimic-lab',
    });
  });
});

describe('OTLP exporter', () => {
  it('posts JSON to /v1/metrics with the headers and resource attributes', async () => {
    const fake = await collector();
    const exporter = startOtlpExporter(
      { endpoint: fake.url, headers: { 'x-api-key': 'secret' }, attributes: { lab: 'a' } },
      { families, version: '9.9.9', run: 'run-1' },
    );
    expect(await exporter.push()).toBe(true);
    await exporter.stop();
    expect(fake.requests).toHaveLength(2);
    const [first] = fake.requests;
    expect(first?.path).toBe('/v1/metrics');
    expect(first?.headers['content-type']).toBe('application/json');
    expect(first?.headers['x-api-key']).toBe('secret');
    expect(first?.body.resourceMetrics[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'ocpp-mimic' } },
      { key: 'service.version', value: { stringValue: '9.9.9' } },
      { key: 'ocpp_mimic.run', value: { stringValue: 'run-1' } },
      { key: 'lab', value: { stringValue: 'a' } },
    ]);
  });

  it('reports a failing collector once until it works again', async () => {
    const fake = await collector(503);
    const errors: string[] = [];
    const exporter = startOtlpExporter(
      { endpoint: `${fake.url}/v1/metrics` },
      { families, version: '1', run: 'r', onError: (message) => errors.push(message) },
    );
    expect(await exporter.push()).toBe(false);
    expect(await exporter.push()).toBe(false);
    await exporter.stop();
    expect(errors).toEqual([`OTLP export to ${fake.url}/v1/metrics failed: HTTP 503`]);
  });
});

describe('engine OTLP export', () => {
  it('pushes the engine metrics while it runs and once more when it stops', async () => {
    const fake = await collector();
    const engine = createEngine({
      port: 0,
      otlp: { endpoint: fake.url, intervalMs: 50 },
      runId: 'test-run',
    });
    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await engine.stop();
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    const last = fake.requests.at(-1)?.body;
    const names = last.resourceMetrics[0].scopeMetrics[0].metrics.map(
      (m: { name: string }) => m.name,
    );
    expect(names).toContain('ocpp_mimic_stations');
    expect(names).toContain('process_cpu_seconds');
    expect(last.resourceMetrics[0].resource.attributes).toContainEqual({
      key: 'ocpp_mimic.run',
      value: { stringValue: 'test-run' },
    });
  });
});
