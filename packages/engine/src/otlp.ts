/**
 * OpenTelemetry export (docs/design.md, "M4 scale"): the metric families
 * pushed over OTLP/HTTP with JSON encoding, cumulative, on an interval. The
 * encoding is written here rather than taken from the official SDK, which
 * would add many packages for a small protocol.
 */
import type { MetricFamily } from './metrics.js';

export interface OtlpOptions {
  /** The OTLP/HTTP base URL (…:4318); `/v1/metrics` is added unless the URL ends with it. */
  endpoint: string;
  headers?: Record<string, string>;
  /** Default 10 s. */
  intervalMs?: number;
  /** Resource attributes on top of service.name and service.version. */
  attributes?: Record<string, string>;
  serviceName?: string;
}

type AnyValue = { stringValue: string };
type KeyValue = { key: string; value: AnyValue };

const attributes = (labels: Record<string, string>): KeyValue[] =>
  Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } }));

/** The `ExportMetricsServiceRequest` JSON for the families at `nowMs`, cumulative since `startMs`. */
export function otlpRequest(
  families: readonly MetricFamily[],
  resource: Record<string, string>,
  scope: { name: string; version: string },
  startMs: number,
  nowMs: number,
): unknown {
  const start = `${BigInt(Math.round(startMs)) * 1_000_000n}`;
  const time = `${BigInt(Math.round(nowMs)) * 1_000_000n}`;
  const point = (labels: Record<string, string>) => ({
    attributes: attributes(labels),
    startTimeUnixNano: start,
    timeUnixNano: time,
  });
  const metrics = families.map((family) => {
    // OTel names counters without Prometheus's _total; exporters add it back.
    const name = family.type === 'counter' ? family.name.replace(/_total$/, '') : family.name;
    const unit = /_seconds$/.test(name) ? 's' : /_bytes$/.test(name) ? 'By' : '';
    const base = { name, description: family.help, ...(unit !== '' && { unit }) };
    switch (family.type) {
      case 'gauge':
        return {
          ...base,
          gauge: {
            dataPoints: family.points.flatMap((p) =>
              'value' in p ? [{ ...point(p.labels), asDouble: p.value }] : [],
            ),
          },
        };
      case 'counter':
        return {
          ...base,
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: family.points.flatMap((p) =>
              'value' in p ? [{ ...point(p.labels), asDouble: p.value }] : [],
            ),
          },
        };
      case 'histogram':
        return {
          ...base,
          histogram: {
            aggregationTemporality: 2,
            dataPoints: family.points.flatMap((p) => {
              if (!('histogram' in p)) return [];
              const h = p.histogram;
              // Prometheus buckets are cumulative; OTLP counts each bucket on its own.
              const counts = [...h.bucketCounts, h.count].map(
                (n, i, all) => n - (i === 0 ? 0 : (all[i - 1] ?? 0)),
              );
              return [
                {
                  ...point(p.labels),
                  count: String(h.count),
                  sum: h.sum,
                  ...(h.count > 0 && { max: h.max }),
                  bucketCounts: counts.map(String),
                  explicitBounds: [...h.buckets],
                },
              ];
            }),
          },
        };
      case 'summary':
        return {
          ...base,
          summary: {
            dataPoints: family.points.flatMap((p) =>
              'summary' in p
                ? [
                    {
                      ...point(p.labels),
                      count: String(p.summary.count),
                      sum: p.summary.sum,
                      quantileValues: p.summary.quantiles.map(([quantile, value]) => ({
                        quantile,
                        value,
                      })),
                    },
                  ]
                : [],
            ),
          },
        };
    }
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes(resource) },
        scopeMetrics: [{ scope, metrics }],
      },
    ],
  };
}

/** `k=v,k2=v2` (URL-encoded values), as in the OTEL_* environment variables. */
export function parseKeyValues(text: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (text ?? '').split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    result[decodeURIComponent(part.slice(0, at).trim())] = decodeURIComponent(
      part.slice(at + 1).trim(),
    );
  }
  return result;
}

/** OTLP options from the standard environment variables, or undefined without an endpoint. */
export function otlpFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): OtlpOptions | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') return undefined;
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return {
    endpoint,
    headers: parseKeyValues(
      env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    ...(Number.isFinite(interval) && interval > 0 && { intervalMs: interval }),
    attributes: parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES),
    ...(env.OTEL_SERVICE_NAME !== undefined && { serviceName: env.OTEL_SERVICE_NAME }),
  };
}

export interface OtlpExporter {
  /** Pushes now; resolves with whether the collector took it. */
  push(): Promise<boolean>;
  stop(): Promise<void>;
}

export function startOtlpExporter(
  options: OtlpOptions,
  source: {
    families: () => MetricFamily[];
    version: string;
    run: string;
    onError?: (message: string) => void;
    fetch?: typeof fetch;
  },
): OtlpExporter {
  const url = /\/v1\/metrics\/?$/.test(options.endpoint)
    ? options.endpoint
    : `${options.endpoint.replace(/\/+$/, '')}/v1/metrics`;
  const resource = {
    'service.name': options.serviceName ?? 'ocpp-mimic',
    'service.version': source.version,
    'ocpp_mimic.run': source.run,
    ...options.attributes,
  };
  const started = Date.now();
  const send = source.fetch ?? fetch;
  let failing = false;

  async function push(): Promise<boolean> {
    const body = JSON.stringify(
      otlpRequest(
        source.families(),
        resource,
        { name: 'ocpp-mimic', version: source.version },
        started,
        Date.now(),
      ),
    );
    try {
      const res = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      failing = false;
      return true;
    } catch (error) {
      // Reported once per run of failures, not on every interval.
      if (!failing) source.onError?.(`OTLP export to ${url} failed: ${(error as Error).message}`);
      failing = true;
      return false;
    }
  }

  const timer = setInterval(() => void push(), options.intervalMs ?? 10_000);
  timer.unref();
  return {
    push,
    async stop() {
      clearInterval(timer);
      await push();
    },
  };
}
