/**
 * Persona calibration (docs/design.md, "M4 scale"): derives a persona's values
 * from logs of one or more stations of the same model. Every value comes with
 * how many samples it rests on and their spread; a value with fewer than 3
 * samples is reported as not derived.
 */
import { createConfig, STANDARD_CONFIG_KEYS } from './config.js';
import type { LogLine } from './log-format.js';

/** Fewer samples than this, and a value is not derived. */
export const MIN_SAMPLES = 3;

export interface Derived {
  /** Persona path, e.g. `config.HeartbeatInterval`. */
  name: string;
  value?: unknown;
  samples: number;
  /** p10 to p90 of the samples, when they are numbers. */
  spread?: [number, number];
  /** Why it was not derived, or how. */
  note?: string;
}

export interface Calibration {
  /** The persona document (YAML-ready), with only what was derived. */
  persona: Record<string, unknown>;
  derived: Derived[];
  stations: string[];
  frames: number;
}

type Frame = unknown[];
type Payload = Record<string, unknown>;

const median = (values: readonly number[]) => quantile(values, 0.5);
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (at - low);
}
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const seconds = (ms: number) => `${round(ms / 1000, 1)}s`;
const mostCommon = <T>(values: readonly T[]): T | undefined => {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const entry = counts.get(key) ?? { value, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.value;
};

interface Event {
  at: number;
  station: string;
  direction: LogLine['direction'];
  frame: Frame;
}

export interface CalibrateOptions {
  /** The persona's id. Default: the model with `-calibrated`. */
  name?: string;
  /** The persona it extends. Default generic-1.6. */
  extends?: string;
}

export function calibrate(lines: readonly LogLine[], options: CalibrateOptions = {}): Calibration {
  const events: Event[] = lines
    .filter((line): line is LogLine & { frame: unknown[] } => Array.isArray(line.frame))
    .map((line) => ({
      at: Date.parse(line.at),
      station: line.station,
      direction: line.direction,
      frame: line.frame,
    }))
    .sort((a, b) => a.at - b.at);
  const stations = [...new Set(events.map((e) => e.station))].sort();
  const derived: Derived[] = [];
  const persona: Record<string, unknown> = {};
  const set = (path: string, value: unknown) => {
    const parts = path.split('.');
    let node = persona;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1) ?? path] = value;
  };
  /** Records a derivation from numeric samples: their median, when there are enough. */
  const fromSamples = (
    name: string,
    samples: readonly number[],
    toValue: (median: number) => unknown,
    note?: string,
  ) => {
    if (samples.length < MIN_SAMPLES) {
      derived.push({ name, samples: samples.length, note: note ?? 'too few samples' });
      return;
    }
    const value = toValue(median(samples));
    derived.push({
      name,
      value,
      samples: samples.length,
      spread: [round(quantile(samples, 0.1), 1), round(quantile(samples, 0.9), 1)],
      ...(note !== undefined && { note }),
    });
    set(name, value);
  };

  // Calls and their answers, per station.
  const callsFrom = (direction: LogLine['direction'], action?: string) =>
    events.filter(
      (e) =>
        e.direction === direction &&
        e.frame[0] === 2 &&
        (action === undefined || e.frame[2] === action),
    );
  const answerTo = (call: Event): Event | undefined =>
    events.find(
      (e) =>
        e.station === call.station &&
        e.direction !== call.direction &&
        e.frame[0] !== 2 &&
        e.frame[1] === call.frame[1] &&
        e.at >= call.at,
    );
  const payload = (e: Event): Payload => (e.frame[e.frame[0] === 2 ? 3 : 2] ?? {}) as Payload;
  const perStation = <T>(items: readonly T[], station: (item: T) => string) => {
    const map = new Map<string, T[]>();
    for (const item of items) map.set(station(item), [...(map.get(station(item)) ?? []), item]);
    return [...map.values()];
  };
  /** Gaps between consecutive events of each station, without the outliers of an outage. */
  const gaps = (items: readonly Event[]) => {
    const all = perStation(items, (e) => e.station).flatMap((list) =>
      list.slice(1).map((e, i) => e.at - (list[i]?.at ?? e.at)),
    );
    const typical = median(all);
    return all.filter((gap) => gap > 0 && gap <= typical * 3);
  };

  // BootNotification fields (serial numbers are the station's own, not the model's).
  const boots = callsFrom('cp-to-csms', 'BootNotification').map(payload);
  if (boots.length > 0) {
    const fields = [
      'chargePointVendor',
      'chargePointModel',
      'firmwareVersion',
      'meterType',
    ] as const;
    const boot: Payload = {};
    for (const field of fields) {
      const value = mostCommon(boots.map((b) => b[field]).filter((v) => v !== undefined));
      if (value !== undefined) boot[field] = value;
    }
    derived.push({ name: 'boot', value: boot, samples: boots.length });
    set('boot', boot);
  } else {
    derived.push({ name: 'boot', samples: 0, note: 'no BootNotification in the log' });
  }

  // Connectors: the highest connectorId reported.
  const statuses = callsFrom('cp-to-csms', 'StatusNotification');
  const connectorIds = statuses.map((e) => Number(payload(e).connectorId)).filter((n) => n > 0);
  if (connectorIds.length > 0) {
    const connectors = Math.max(...connectorIds);
    derived.push({ name: 'connectors', value: connectors, samples: connectorIds.length });
    set('connectors', connectors);
  } else {
    derived.push({ name: 'connectors', samples: 0, note: 'no StatusNotification for a connector' });
  }

  // Configuration from the latest GetConfiguration answer, known and valid keys only.
  const configuration = callsFrom('csms-to-cp', 'GetConfiguration')
    .map(answerTo)
    .filter((e): e is Event => e !== undefined && e.frame[0] === 3)
    .at(-1);
  const config: Record<string, string> = {};
  if (configuration !== undefined) {
    const keys = (payload(configuration).configurationKey ?? []) as {
      key: string;
      value?: string;
    }[];
    for (const { key, value } of keys) {
      if (value === undefined || key === 'AuthorizationKey' || key === 'NumberOfConnectors')
        continue;
      if (key === 'SupportedFeatureProfiles' || !(key in STANDARD_CONFIG_KEYS)) continue;
      try {
        createConfig({ numberOfConnectors: 1, values: { [key]: value } });
        config[key] = value;
      } catch {
        // a value the simulator would refuse is left out
      }
    }
    derived.push({
      name: 'config',
      value: { ...config },
      samples: keys.length,
      note: 'the latest GetConfiguration answer',
    });
  }

  // Intervals: heartbeats, and periodic meter values within transactions.
  fromSamples('config.HeartbeatInterval', gaps(callsFrom('cp-to-csms', 'Heartbeat')), (ms) =>
    Math.round(ms / 1000),
  );
  const meterValues = callsFrom('cp-to-csms', 'MeterValues').filter((e) => {
    const p = payload(e);
    const values = (p.meterValue ?? []) as { sampledValue?: { context?: string }[] }[];
    const context = values[0]?.sampledValue?.[0]?.context ?? 'Sample.Periodic';
    return p.transactionId !== undefined && context === 'Sample.Periodic';
  });
  fromSamples('config.MeterValueSampleInterval', gaps(meterValues), (ms) => Math.round(ms / 1000));
  for (const [key, value] of Object.entries(config)) {
    if (key === 'HeartbeatInterval' || key === 'MeterValueSampleInterval') continue;
    set(`config.${key}`, Number.isNaN(Number(value)) || value === '' ? value : value);
  }

  // Measurands and offered power, from the sampled values.
  const sampled = meterValues.flatMap((e) =>
    ((payload(e).meterValue ?? []) as { sampledValue?: Payload[] }[]).flatMap(
      (v) => v.sampledValue ?? [],
    ),
  );
  const measurands = [
    ...new Set(sampled.map((v) => String(v.measurand ?? 'Energy.Active.Import.Register'))),
  ].sort();
  if (measurands.length > 0) {
    const value = measurands.join(',');
    derived.push({ name: 'config.MeterValuesSampledData', value, samples: sampled.length });
    set('config.MeterValuesSampledData', value);
  }
  const watts = (measurand: string) =>
    sampled
      .filter((v) => v.measurand === measurand)
      .map((v) => Number(v.value) * (String(v.unit ?? 'W').toLowerCase() === 'kw' ? 1000 : 1))
      .filter((n) => Number.isFinite(n) && n > 0);
  const offered = watts('Power.Offered');
  const active = watts('Power.Active.Import');
  const power = offered.length >= MIN_SAMPLES ? offered : active;
  if (power.length >= MIN_SAMPLES) {
    const value = Math.round(quantile(power, 0.95));
    derived.push({
      name: 'power.offeredW',
      value,
      samples: power.length,
      spread: [round(quantile(power, 0.1), 0), round(quantile(power, 0.9), 0)],
      note: offered.length >= MIN_SAMPLES ? 'p95 of Power.Offered' : 'p95 of Power.Active.Import',
    });
    set('power.offeredW', value);
  } else {
    derived.push({
      name: 'power.offeredW',
      samples: power.length,
      note: 'no Power.Offered or Power.Active.Import',
    });
  }

  // Timing: how long the station takes to act on a command (the persona's
  // delays apply to what follows the answer, not the answer itself).
  const nextCall = (after: Event, action: string) =>
    events.find(
      (e) =>
        e.station === after.station &&
        e.direction === 'cp-to-csms' &&
        e.frame[0] === 2 &&
        e.frame[2] === action &&
        e.at > after.at,
    );
  const followUps: Record<string, (call: Event) => Event | undefined> = {
    TriggerMessage: (call) => nextCall(call, String(payload(call).requestedMessage)),
    RemoteStopTransaction: (call) => nextCall(call, 'StopTransaction'),
    ChangeAvailability: (call) => nextCall(call, 'StatusNotification'),
  };
  const allDelays: number[] = [];
  for (const [command, next] of Object.entries(followUps)) {
    const delays = callsFrom('csms-to-cp', command)
      .filter((call) => {
        const answer = answerTo(call);
        return (
          answer !== undefined && answer.frame[0] === 3 && payload(answer).status === 'Accepted'
        );
      })
      .map((call) => {
        const follow = next(call);
        return follow === undefined ? undefined : follow.at - call.at;
      })
      .filter((ms): ms is number => ms !== undefined && ms < 60_000);
    allDelays.push(...delays);
    if (delays.length >= MIN_SAMPLES)
      fromSamples(`timing.commandDelays.${command}`, delays, seconds);
  }
  fromSamples(
    'timing.actionDelay',
    allDelays,
    seconds,
    'from TriggerMessage, RemoteStopTransaction and ChangeAvailability to what they ask for',
  );
  const starts = callsFrom('cp-to-csms', 'StartTransaction');
  const startDelays = starts
    .map((start) => {
      const authorize = [...callsFrom('cp-to-csms', 'Authorize')]
        .filter((a) => a.station === start.station && a.at <= start.at && start.at - a.at < 120_000)
        .map(answerTo)
        .filter((a): a is Event => a !== undefined && a.at <= start.at)
        .at(-1);
      return authorize === undefined ? undefined : start.at - authorize.at;
    })
    .filter((ms): ms is number => ms !== undefined);
  fromSamples('timing.startTransactionDelay', startDelays, seconds, 'from the Authorize answer');
  for (const type of ['Soft', 'Hard'] as const) {
    const downtimes = callsFrom('csms-to-cp', 'Reset')
      .filter((call) => payload(call).type === type)
      .map((call) => {
        const boot = callsFrom('cp-to-csms', 'BootNotification').find(
          (b) => b.station === call.station && b.at > call.at,
        );
        return boot === undefined ? undefined : boot.at - call.at;
      })
      .filter((ms): ms is number => ms !== undefined && ms < 3_600_000);
    fromSamples(`timing.resetDowntime.${type.toLowerCase()}`, downtimes, seconds);
  }

  // Faults: every errorCode / info / vendorErrorCode reported with a fault.
  const faults = statuses
    .map(payload)
    .filter((p) => p.errorCode !== undefined && p.errorCode !== 'NoError')
    .map((p) => ({
      errorCode: p.errorCode,
      ...(p.info !== undefined && { info: p.info }),
      ...(p.vendorErrorCode !== undefined && { vendorErrorCode: p.vendorErrorCode }),
    }));
  const uniqueFaults = [...new Map(faults.map((f) => [JSON.stringify(f), f])).values()].map(
    (f) => ({
      name: [f.errorCode, f.info].filter((v) => v !== undefined).join(' '),
      ...f,
    }),
  );
  if (uniqueFaults.length > 0) {
    derived.push({ name: 'faults', value: uniqueFaults, samples: faults.length });
    set('faults', uniqueFaults);
  } else {
    derived.push({ name: 'faults', samples: 0, note: 'no faults reported' });
  }

  // Sessions: how drivers use the station, for the usage model.
  const stops = callsFrom('cp-to-csms', 'StopTransaction');
  const sessions = starts
    .map((start) => {
      const answer = answerTo(start);
      const tx = answer === undefined ? undefined : payload(answer).transactionId;
      const stop = stops.find(
        (s) => s.station === start.station && payload(s).transactionId === tx && s.at > start.at,
      );
      return stop === undefined ? undefined : { start, stop, ms: stop.at - start.at };
    })
    .filter((s): s is { start: Event; stop: Event; ms: number } => s !== undefined);
  const durations = sessions.map((s) => s.ms);
  if (durations.length >= MIN_SAMPLES && events.length > 1) {
    const connectors = Math.max(1, Number(persona.connectors ?? 1));
    const spanHours = ((events.at(-1)?.at ?? 0) - (events[0]?.at ?? 0)) / 3_600_000;
    const busyHours = durations.reduce((sum, ms) => sum + ms, 0) / 3_600_000;
    const freeHours = Math.max(spanHours * connectors * stations.length - busyHours, 1 / 60);
    const rate = round(starts.length / freeHours, 2);
    derived.push({
      name: 'usage.sessionsPerHour',
      value: rate,
      samples: starts.length,
      note: 'sessions per free connector-hour',
    });
    set('usage.sessionsPerHour', rate);
    const stay = { min: seconds(quantile(durations, 0.1)), max: seconds(quantile(durations, 0.9)) };
    derived.push({
      name: 'usage.stay',
      value: stay,
      samples: durations.length,
      spread: [round(quantile(durations, 0.1) / 1000), round(quantile(durations, 0.9) / 1000)],
      note: 'p10 to p90 of StartTransaction to StopTransaction',
    });
    set('usage.stay', stay);
    const reasons = sessions.map((s) => String(payload(s.stop).reason ?? 'Local'));
    const card = reasons.filter((r) => r === 'Local').length;
    const unplug = reasons.filter((r) => r === 'EVDisconnected').length;
    if (card + unplug >= MIN_SAMPLES) {
      const stopBy = {
        card: round(card / (card + unplug), 2),
        unplug: round(unplug / (card + unplug), 2),
      };
      derived.push({ name: 'usage.stopBy', value: stopBy, samples: card + unplug });
      set('usage.stopBy', stopBy);
    }
  } else {
    derived.push({ name: 'usage', samples: durations.length, note: 'too few complete sessions' });
  }
  const authorizations = callsFrom('cp-to-csms', 'Authorize')
    .map(answerTo)
    .filter((a): a is Event => a !== undefined && a.frame[0] === 3);
  if (authorizations.length >= MIN_SAMPLES) {
    const refused = authorizations.filter(
      (a) => (payload(a).idTagInfo as { status?: string } | undefined)?.status !== 'Accepted',
    ).length;
    const share = round(refused / authorizations.length, 2);
    derived.push({
      name: 'usage.idTags.unknownShare',
      value: share,
      samples: authorizations.length,
    });
    if (persona.usage !== undefined) set('usage.idTags.unknownShare', share);
  }

  const model = String((persona.boot as Payload | undefined)?.chargePointModel ?? 'station');
  const id = options.name ?? `${model.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}-calibrated`;
  return {
    persona: {
      persona: id,
      extends: options.extends ?? 'generic-1.6',
      description: `Calibrated from ${events.length} frames of ${stations.length} station${stations.length === 1 ? '' : 's'}`,
      ...persona,
    },
    derived,
    stations,
    frames: events.length,
  };
}

/** The calibration report as Markdown: each value with its samples and spread. */
export function calibrationReport(calibration: Calibration): string {
  const rows = calibration.derived.map((d) => {
    const value = d.value === undefined ? 'not derived' : `\`${JSON.stringify(d.value)}\``;
    const spread = d.spread === undefined ? '' : `${d.spread[0]} to ${d.spread[1]}`;
    return `| ${d.name} | ${value} | ${d.samples} | ${spread} | ${d.note ?? ''} |`;
  });
  return [
    `# Calibration of ${String(calibration.persona.persona)}`,
    '',
    `${calibration.frames} frames from ${calibration.stations.length} station(s): ${calibration.stations.join(', ')}. Values need at least ${MIN_SAMPLES} samples.`,
    '',
    '| Value | Derived | Samples | Spread (p10 to p90) | Note |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
