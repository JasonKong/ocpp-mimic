/**
 * Persona calibration (docs/design.md, "M4 scale"): derives a persona's values
 * from logs of one or more stations of the same model. Every value comes with
 * how many samples it rests on and their spread; a value with fewer than 3
 * samples is reported as not derived. A 2.0.1 log gives a persona that
 * extends generic-2.0.1, with Device Model values instead of configuration
 * keys (from the station's NotifyReport, when the log has one).
 */
import { createConfig, STANDARD_CONFIG_KEYS } from './config.js';
import { logVersions, type LogLine, type LogOcppVersion } from './log-format.js';
import { ChargePointErrorCodeSchema } from './ocpp16-messages.js';
import { componentKey, variableKey } from './ocpp201/device-model.js';
import { validate } from './schema.js';
import { standardVariables } from './ocpp201/standard-variables.js';

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
const structuredCloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
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
  /** The persona it extends. Default generic-1.6, generic-2.0.1 or generic-2.1, by the log's version. */
  extends?: string;
}

/** Whether a 2.0.1 techCode is a 1.6 ChargePointErrorCode (else a vendor's code). */
const isErrorCode = (code: string) => validate(ChargePointErrorCodeSchema, code).ok;

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
  // The log's version: what most of its stations speak (ties go to the newer version).
  const versionCounts = [...logVersions(lines).values()];
  const count = (v: LogOcppVersion) => versionCounts.filter((c) => c === v).length;
  const version: LogOcppVersion = (['2.1', '2.0.1', '1.6'] as const).reduce((best, v) =>
    count(v) > count(best) ? v : best,
  );
  // 2.1 builds on 2.0.1: a 2.x log is read the same way, with 2.1's additions.
  const is201 = version !== '1.6';
  const is21 = version === '2.1';
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
  // 2.0.1 keeps them in the chargingStation block.
  const boots = callsFrom('cp-to-csms', 'BootNotification')
    .map(payload)
    .map((p) => (is201 ? ((p.chargingStation ?? {}) as Payload) : p));
  if (boots.length > 0) {
    const fields = is201
      ? (['vendorName', 'model', 'firmwareVersion'] as const)
      : (['chargePointVendor', 'chargePointModel', 'firmwareVersion', 'meterType'] as const);
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

  // Connectors: the highest connectorId reported (2.x: the highest EVSE). A 2.1 station
  // may report availability with NotifyEvent on Connector.AvailabilityState instead.
  const statuses = callsFrom('cp-to-csms', 'StatusNotification');
  const availabilityEvents = is21
    ? callsFrom('cp-to-csms', 'NotifyEvent')
        .flatMap((e) => (payload(e).eventData ?? []) as Payload[])
        .filter(
          (d) =>
            (d.component as Payload | undefined)?.name === 'Connector' &&
            (d.variable as Payload | undefined)?.name === 'AvailabilityState',
        )
    : [];
  const connectorIds = [
    ...statuses.map((e) => Number(is201 ? payload(e).evseId : payload(e).connectorId)),
    ...availabilityEvents.map((d) =>
      Number(((d.component as Payload).evse as Payload | undefined)?.id),
    ),
  ].filter((n) => n > 0);
  if (is21) {
    // generic-2.1 reports with NotifyEvent; a station that sends StatusNotification says so.
    const method =
      statuses.length > 0 && availabilityEvents.length === 0
        ? 'StatusNotification'
        : availabilityEvents.length > 0
          ? 'NotifyEvent'
          : undefined;
    if (method !== undefined) {
      derived.push({
        name: 'connectorStatus',
        value: method,
        samples: statuses.length + availabilityEvents.length,
      });
      if (method === 'StatusNotification') set('connectorStatus', method);
    } else {
      derived.push({ name: 'connectorStatus', samples: 0, note: 'no connector availability' });
    }
  }
  if (connectorIds.length > 0) {
    const connectors = Math.max(...connectorIds);
    derived.push({ name: 'connectors', value: connectors, samples: connectorIds.length });
    set('connectors', connectors);
  } else {
    derived.push({
      name: 'connectors',
      samples: 0,
      note: is21 ? 'no connector availability reported' : 'no StatusNotification for a connector',
    });
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

  // 2.0.1: Device Model values from the station's latest full NotifyReport, where
  // they differ from the standard variables' defaults and an operator can set them.
  const deviceModel: Record<string, Record<string, string>> = {};
  if (is201) {
    const reports = callsFrom('cp-to-csms', 'NotifyReport');
    const lastRequest =
      reports.at(-1) === undefined ? undefined : payload(reports.at(-1)!).requestId;
    const items = reports
      .filter((e) => payload(e).requestId === lastRequest)
      .flatMap((e) => (payload(e).reportData ?? []) as Payload[]);
    const defaults = new Map(
      standardVariables({
        ocpp: is21 ? '2.1' : '2.0.1',
        connectors: Number(persona.connectors ?? 1),
        features: [
          'Core',
          'AdvancedSecurity',
          'LocalAuthListManagement',
          'SmartCharging',
          'Reservation',
        ],
        offeredW: 0,
      }).map((d) => [`${componentKey(d.component)}/${variableKey(d.variable)}`, d] as const),
    );
    let differing = 0;
    for (const item of items) {
      const component = componentKey(item.component as Parameters<typeof componentKey>[0]);
      const variable = variableKey(item.variable as Parameters<typeof variableKey>[0]);
      const actual = ((item.variableAttribute ?? []) as Payload[]).find(
        (a) => (a.type ?? 'Actual') === 'Actual',
      );
      const known = defaults.get(`${component}/${variable}`);
      if (
        actual?.value === undefined ||
        actual.mutability !== 'ReadWrite' ||
        known === undefined ||
        known.dynamic === true ||
        known.attributes.Actual?.value === actual.value
      ) {
        continue;
      }
      (deviceModel[component] ??= {})[variable] = String(actual.value);
      differing += 1;
    }
    if (items.length > 0) {
      derived.push({
        name: 'deviceModel',
        value: structuredCloneJson(deviceModel),
        samples: items.length,
        note: `the latest NotifyReport: ${differing} writable values that differ from the defaults`,
      });
    }
  }

  // Intervals: heartbeats, and periodic meter values within transactions.
  const heartbeatPath = is201
    ? 'deviceModel.OCPPCommCtrlr.HeartbeatInterval'
    : 'config.HeartbeatInterval';
  const intervalPath = is201
    ? 'deviceModel.SampledDataCtrlr.TxUpdatedInterval'
    : 'config.MeterValueSampleInterval';
  for (const [component, variables] of Object.entries(deviceModel)) {
    for (const [variable, value] of Object.entries(variables)) {
      set(`deviceModel.${component}.${variable}`, value);
    }
  }
  fromSamples(heartbeatPath, gaps(callsFrom('cp-to-csms', 'Heartbeat')), (ms) =>
    Math.round(ms / 1000),
  );
  const meterValues = is201
    ? callsFrom('cp-to-csms', 'TransactionEvent').filter(
        (e) =>
          payload(e).eventType === 'Updated' && payload(e).triggerReason === 'MeterValuePeriodic',
      )
    : callsFrom('cp-to-csms', 'MeterValues').filter((e) => {
        const p = payload(e);
        const values = (p.meterValue ?? []) as { sampledValue?: { context?: string }[] }[];
        const context = values[0]?.sampledValue?.[0]?.context ?? 'Sample.Periodic';
        return p.transactionId !== undefined && context === 'Sample.Periodic';
      });
  fromSamples(intervalPath, gaps(meterValues), (ms) => Math.round(ms / 1000));
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
    const name = is201
      ? 'deviceModel.SampledDataCtrlr.TxUpdatedMeasurands'
      : 'config.MeterValuesSampledData';
    derived.push({ name, value, samples: sampled.length });
    set(name, value);
  }
  // 1.6 has the unit on the sampled value, 2.0.1 in unitOfMeasure.
  const unitOf = (v: Payload) =>
    String(v.unit ?? (v.unitOfMeasure as Payload | undefined)?.unit ?? 'W').toLowerCase();
  const watts = (measurand: string) =>
    sampled
      .filter((v) => v.measurand === measurand)
      .map((v) => Number(v.value) * (unitOf(v) === 'kw' ? 1000 : 1))
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
  const endedAfter = (after: Event) =>
    events.find(
      (e) =>
        e.station === after.station &&
        e.direction === 'cp-to-csms' &&
        e.frame[0] === 2 &&
        e.frame[2] === 'TransactionEvent' &&
        payload(e).eventType === 'Ended' &&
        e.at > after.at,
    );
  const followUps: Record<string, (call: Event) => Event | undefined> = is201
    ? {
        TriggerMessage: (call) => nextCall(call, String(payload(call).requestedMessage)),
        RequestStopTransaction: endedAfter,
        ChangeAvailability: (call) => nextCall(call, 'StatusNotification'),
      }
    : {
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
    `from ${Object.keys(followUps).join(', ')} to what they ask for`,
  );
  // 2.0.1 transactions start with TransactionEvent Started.
  const starts = is201
    ? callsFrom('cp-to-csms', 'TransactionEvent').filter((e) => payload(e).eventType === 'Started')
    : callsFrom('cp-to-csms', 'StartTransaction');
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
  // A 2.0.1 station starts on its start points; the delay is a 1.6 setting.
  if (!is201) {
    fromSamples('timing.startTransactionDelay', startDelays, seconds, 'from the Authorize answer');
  }
  for (const type of ['Soft', 'Hard'] as const) {
    // 2.0.1: OnIdle restarts like a soft reset, Immediate like a hard one.
    const resetType = is201 ? (type === 'Soft' ? 'OnIdle' : 'Immediate') : type;
    const downtimes = callsFrom('csms-to-cp', 'Reset')
      .filter((call) => payload(call).type === resetType && payload(call).evseId === undefined)
      .map((call) => {
        const boot = callsFrom('cp-to-csms', 'BootNotification').find(
          (b) => b.station === call.station && b.at > call.at,
        );
        return boot === undefined ? undefined : boot.at - call.at;
      })
      .filter((ms): ms is number => ms !== undefined && ms < 3_600_000);
    fromSamples(`timing.resetDowntime.${type.toLowerCase()}`, downtimes, seconds);
  }

  // Faults: every errorCode / info / vendorErrorCode reported with a fault. A
  // 2.0.1 station reports them as a raised Problem variable in NotifyEvent:
  // techCode is a 1.6 error code or the vendor's own, techInfo the info.
  const faults = is201
    ? callsFrom('cp-to-csms', 'NotifyEvent')
        .flatMap((e) => (payload(e).eventData ?? []) as Payload[])
        .filter(
          (d) =>
            (d.variable as Payload | undefined)?.name === 'Problem' &&
            d.actualValue === 'true' &&
            d.techCode !== undefined,
        )
        .map((d) => {
          const code = String(d.techCode);
          return {
            errorCode: isErrorCode(code) ? code : 'OtherError',
            ...(d.techInfo !== undefined && { info: d.techInfo }),
            ...(!isErrorCode(code) && { vendorErrorCode: code }),
          };
        })
    : statuses
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
  const transactionOf = (e: Event) =>
    is201
      ? (payload(e).transactionInfo as Payload | undefined)?.transactionId
      : payload(e).transactionId;
  const stops = is201
    ? callsFrom('cp-to-csms', 'TransactionEvent').filter((e) => payload(e).eventType === 'Ended')
    : callsFrom('cp-to-csms', 'StopTransaction');
  const sessions = starts
    .map((start) => {
      // 1.6: the CSMS gives the transactionId; 2.0.1: the station's own.
      const answer = is201 ? start : answerTo(start);
      const tx =
        answer === undefined
          ? undefined
          : is201
            ? transactionOf(start)
            : payload(answer).transactionId;
      const stop = stops.find(
        (s) => s.station === start.station && transactionOf(s) === tx && s.at > start.at,
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
      note: is201
        ? 'p10 to p90 of TransactionEvent Started to Ended'
        : 'p10 to p90 of StartTransaction to StopTransaction',
    });
    set('usage.stay', stay);
    const reasons = sessions.map((s) =>
      String(
        (is201
          ? (payload(s.stop).transactionInfo as Payload | undefined)?.stoppedReason
          : payload(s.stop).reason) ?? 'Local',
      ),
    );
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
      (a) =>
        ((payload(a).idTagInfo ?? payload(a).idTokenInfo) as { status?: string } | undefined)
          ?.status !== 'Accepted',
    ).length;
    const share = round(refused / authorizations.length, 2);
    derived.push({
      name: 'usage.idTags.unknownShare',
      value: share,
      samples: authorizations.length,
    });
    if (persona.usage !== undefined) set('usage.idTags.unknownShare', share);
  }

  const bootBlock = persona.boot as Payload | undefined;
  const model = String((is201 ? bootBlock?.model : bootBlock?.chargePointModel) ?? 'station');
  const id = options.name ?? `${model.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}-calibrated`;
  return {
    persona: {
      persona: id,
      extends: options.extends ?? `generic-${version}`,
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
