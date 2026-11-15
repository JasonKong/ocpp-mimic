import { parseArgs } from 'node:util';
import { parseDuration } from '@ocpp-mimic/core';
import { DEFAULT_ALLOWED_CSMS, DEFAULT_PORT } from '@ocpp-mimic/engine';

export interface ServeCommand {
  kind: 'serve';
  port: number;
  host: string;
  /** SQLite file for station state; omitted = nothing persisted. */
  store?: string;
  /** Records kept per station (default 1000). */
  recordLimit?: number;
  /** Charging sessions kept per station (default 20). */
  sessionsPerStation?: number;
  /** Push metrics over OTLP/HTTP here. */
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  /** Extra persona directories. */
  personas: string[];
  /** CSMS URL prefixes stations may connect to, on top of loopback. */
  allowCsms: string[];
}

export interface RunCommand {
  kind: 'run';
  /** Scenario files and directories. */
  paths: string[];
  /** Overrides every scenario's csms. */
  csms?: string;
  vars: Record<string, string>;
  /** Default scenario timeout in milliseconds. */
  timeoutMs?: number;
  bail: boolean;
  /** Where to write the JUnit XML report. */
  junit?: string;
  /** Where to write each scenario's frames as a JSONL log. */
  logDir?: string;
  personas: string[];
  allowCsms: string[];
}

export interface ImportCommand {
  kind: 'import';
  files: string[];
  /** The mapping file; without it the input is ocpp-mimic's own log format. */
  map?: string;
  /** Mask: by default for mapped input, not for ocpp-mimic's own. */
  mask?: boolean;
  salt?: string;
  saltFile?: string;
  /** Output file; standard output without it. */
  out?: string;
}

export interface ReplayCommand {
  kind: 'replay';
  log: string;
  station?: string;
  csms?: string;
  persona?: string;
  speed?: number;
  maxGapMs?: number;
  compare?: 'status' | 'strict' | 'none';
  /** Write the scenario (frames inline) here instead of running it. */
  write?: string;
  personas: string[];
  allowCsms: string[];
}

export interface CalibrateCommand {
  kind: 'calibrate';
  logs: string[];
  /** Only these stations (all of the logs' stations otherwise). */
  stations: string[];
  name?: string;
  extends?: string;
  /** Persona file; standard output without it. */
  out?: string;
  /** Markdown report of what was derived. */
  report?: string;
}

export type ClientCertificateMode = 'none' | 'optional' | 'required';

export interface CsmsCommand {
  kind: 'csms';
  port: number;
  host: string;
  /** Answer delay range in milliseconds. */
  delay?: { minMs: number; maxMs: number };
  /** Heartbeat interval in seconds, given in BootNotification answers. */
  heartbeatInterval: number;
  /** idTags starting with this are Invalid; empty = all accepted. */
  unknownPrefix: string;
  /** Basic Auth password every station must present. */
  password?: string;
  /** PEM file paths for wss://. */
  tls?: { cert: string; key: string; ca?: string; clientCertificates: ClientCertificateMode };
  /** How often to print a status line, in milliseconds; 0 = never. */
  statusMs: number;
}

export interface LoadCommand {
  kind: 'load';
  /** The load plan file. */
  plan: string;
  csms?: string;
  durationMs?: number;
  reportDir?: string;
  junit?: string;
  /** Serve the API and Web UI here while running. */
  port?: number;
  /** The Web UI build to serve with --port; set by main. */
  webRoot?: string;
  recordLimit?: number;
  logDir?: string;
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  personas: string[];
  allowCsms: string[];
}

export type Command =
  | ServeCommand
  | RunCommand
  | CsmsCommand
  | ImportCommand
  | ReplayCommand
  | CalibrateCommand
  | LoadCommand
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** Default port of `ocpp-mimic csms`; the M4 load plans use it. */
export const DEFAULT_CSMS_PORT = 9100;

export const USAGE = `Usage: ocpp-mimic <command> [options]

Commands:
  serve                  Start the engine, its HTTP API and the Web UI
  run <file|dir>...      Run scenario files (directories are searched for
                         .yaml / .yml files)
  csms                   Run the built-in test CSMS on its own, e.g. as the
                         target of a load test
  import <file>...       Turn logs into ocpp-mimic's log format, masked
  replay <log>           Replay a station's log against a CSMS and compare
                         its answers with the log's
  calibrate <log>...     Derive a persona from logs of stations of one model
  load <plan>            Run a load plan and judge its thresholds

Options for serve:
  --port <number>        Port for the HTTP API (default ${DEFAULT_PORT})
  --host <host>          Interface to bind (default 127.0.0.1)
  --store <file>         SQLite file that keeps stations across restarts
                         (default: nothing is kept)
  --record-limit <n>     Messages and log lines kept per station for the
                         Web UI and API (default 1000; 0 keeps none)
  --sessions-per-station <n>
                         Charging sessions kept per station, with their
                         frames (default 20)
  --otlp-endpoint <url>  Push metrics to an OpenTelemetry collector over
                         OTLP/HTTP (default: OTEL_EXPORTER_OTLP_ENDPOINT)
  --otlp-header <k=v>    Header for the OTLP export; repeat for more

Options for run:
  --csms <url>           Run every scenario against this CSMS instead of its
                         own csms (builtin or a ws:// / wss:// URL)
  --var <NAME=value>     Template variable; repeat for more
  --timeout <duration>   Timeout for scenarios without their own (default 5m)
  --bail                 Stop after the first scenario that does not pass
  --junit <file>         Also write a JUnit XML report to <file>
  --log-dir <dir>        Write each scenario's frames to <dir> as JSONL logs

Options for import (output on standard output unless -o):
  --map <file>           Mapping for JSONL, CSV or log lines (without it the
                         input is ocpp-mimic's own log format)
  --mask / --no-mask     Mask identifiers (default: on for mapped input)
  --salt <text>          Salt for the pseudonyms (or --salt-file, or the
                         OCPP_MIMIC_MASK_SALT variable; random otherwise)
  --salt-file <file>     Read the salt from a file
  -o, --out <file>       Write the log to <file>

Options for load:
  --csms <url>           Run against this CSMS instead of the plan's
  --duration <d>         Run this long instead of the plan's duration
  --report-dir <dir>     Write report.json and report.md there
  --junit <file>         Also write a JUnit XML report (a test case per threshold)
  --port <number>        Also serve the API, the Web UI and /metrics there
  --record-limit <n>     Records kept per station for the Web UI (default 10)
  --log-dir <dir>        Stream every frame to <dir>/frames.jsonl
  --otlp-endpoint <url>, --otlp-header <k=v>
                         Push metrics over OTLP/HTTP, as for serve

Options for replay:
  --station <id>         The log's station, when it has several
  --csms <url>           The CSMS to replay against (default builtin)
  --persona <id>         Persona of the replay station (default generic-1.6)
  --speed <n>            Divide the recorded gaps by <n> (default 1)
  --max-gap <d>          Longest wait between two frames (default 30s)
  --compare <mode>       status (default), strict or none
  --write <file>         Write the scenario, frames inline, instead of running

Options for calibrate:
  --station <id>         Only this station; repeat for more
  --name <id>            The persona's id (default: <model>-calibrated)
  --extends <id>         The persona it extends (default generic-1.6)
  -o, --out <file>       Write the persona there (default: standard output)
  --report <file>        Write what was derived, with samples, as Markdown

Options for serve, run, load and replay:
  --personas <dir>       Extra persona directory; repeat for more
  --allow-csms <prefix>  Also allow CSMS URLs starting with <prefix>; repeat
                         for more (default: ${DEFAULT_ALLOWED_CSMS.slice(0, 2).join(', ')}, ...)

Options for csms (stations connect to ws://<host>:<port>/ocpp/<id>):
  --port <number>        Port to listen on (default ${DEFAULT_CSMS_PORT})
  --host <host>          Interface to bind (default 127.0.0.1)
  --delay <d>[-<d>]      Answer every station request after this delay, or a
                         random one in the range, e.g. 50ms or 20ms-100ms
  --heartbeat-interval <seconds>
                         Interval given in BootNotification answers (default 60)
  --unknown-prefix <s>   idTags starting with <s> are Invalid (default
                         UNKNOWN-; an empty string accepts every idTag)
  --password <password>  Basic Auth password every station must present
  --tls-cert <file>      Serve wss:// with this certificate (PEM) ...
  --tls-key <file>       ... and its private key (PEM)
  --tls-ca <file>        CA (PEM) that client certificates must be signed by
  --client-certificates <none|optional|required>
                         Ask stations for a client certificate (default none)
  --status <duration>    Print a status line this often (default 60s; 0: never)

  -v, --version          Print the version
  -h, --help             Print this help`;

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  store: { type: 'string' },
  personas: { type: 'string', multiple: true },
  'allow-csms': { type: 'string', multiple: true },
  csms: { type: 'string' },
  var: { type: 'string', multiple: true },
  timeout: { type: 'string' },
  bail: { type: 'boolean' },
  junit: { type: 'string' },
  delay: { type: 'string' },
  'heartbeat-interval': { type: 'string' },
  'unknown-prefix': { type: 'string' },
  password: { type: 'string' },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  'tls-ca': { type: 'string' },
  'client-certificates': { type: 'string' },
  status: { type: 'string' },
  'log-dir': { type: 'string' },
  station: { type: 'string', multiple: true },
  name: { type: 'string' },
  extends: { type: 'string' },
  report: { type: 'string' },
  persona: { type: 'string' },
  speed: { type: 'string' },
  'max-gap': { type: 'string' },
  compare: { type: 'string' },
  write: { type: 'string' },
  'record-limit': { type: 'string' },
  'sessions-per-station': { type: 'string' },
  'otlp-endpoint': { type: 'string' },
  'otlp-header': { type: 'string', multiple: true },
  map: { type: 'string' },
  mask: { type: 'boolean' },
  'no-mask': { type: 'boolean' },
  salt: { type: 'string' },
  'salt-file': { type: 'string' },
  out: { type: 'string', short: 'o' },
  duration: { type: 'string' },
  'report-dir': { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];

const COMMANDS = {
  serve: [
    'port',
    'host',
    'store',
    'record-limit',
    'sessions-per-station',
    'otlp-endpoint',
    'otlp-header',
    'personas',
    'allow-csms',
  ],
  run: ['csms', 'var', 'timeout', 'bail', 'junit', 'log-dir', 'personas', 'allow-csms'],
  csms: [
    'port',
    'host',
    'delay',
    'heartbeat-interval',
    'unknown-prefix',
    'password',
    'tls-cert',
    'tls-key',
    'tls-ca',
    'client-certificates',
    'status',
  ],
  import: ['map', 'mask', 'no-mask', 'salt', 'salt-file', 'out'],
  calibrate: ['station', 'name', 'extends', 'out', 'report'],
  replay: [
    'station',
    'csms',
    'persona',
    'speed',
    'max-gap',
    'compare',
    'write',
    'personas',
    'allow-csms',
  ],
  load: [
    'csms',
    'duration',
    'report-dir',
    'junit',
    'port',
    'record-limit',
    'log-dir',
    'otlp-endpoint',
    'otlp-header',
    'personas',
    'allow-csms',
  ],
} as const satisfies Record<string, readonly OptionName[]>;

type CommandName = keyof typeof COMMANDS;

const error = (message: string): Command => ({ kind: 'error', message });

export function parseCommand(argv: readonly string[]): Command {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: OPTIONS,
    });

    if (values.version) return { kind: 'version' };
    const [name, ...rest] = positionals;
    if (values.help || name === undefined) return { kind: 'help' };
    if (!(name in COMMANDS)) return error(`Unknown command: ${name}`);
    const command = name as CommandName;

    // An option of another command is named as such.
    const allowed: readonly string[] = COMMANDS[command];
    for (const option of Object.keys(values)) {
      if (option === 'version' || option === 'help' || allowed.includes(option)) continue;
      const owners = Object.entries(COMMANDS)
        .filter(([, options]) => (options as readonly string[]).includes(option))
        .map(([owner]) => owner);
      const list =
        owners.length > 1 ? `${owners.slice(0, -1).join(', ')} and ${owners.at(-1)}` : owners[0];
      return error(`--${option} is an option of ${list}`);
    }

    const badPrefix = values['allow-csms']?.find((prefix) => !/^wss?:\/\/.+/.test(prefix));
    if (badPrefix !== undefined) {
      return error(`--allow-csms needs a ws:// or wss:// prefix, got ${badPrefix}`);
    }
    if (command === 'run') return parseRun(rest, values);
    if (command === 'import') return parseImport(rest, values);
    if (command === 'replay') return parseReplay(rest, values);
    if (command === 'calibrate') return parseCalibrate(rest, values);
    if (command === 'load') return parseLoad(rest, values);
    if (rest.length > 0) return error(`Unexpected argument: ${rest[0]}`);
    if (command === 'csms') return parseCsms(values);

    const port = parsePort(values.port, DEFAULT_PORT);
    if (port === undefined) return error(`Invalid port: ${values.port}`);
    const recordLimit =
      values['record-limit'] === undefined ? undefined : Number(values['record-limit']);
    if (recordLimit !== undefined && !(Number.isInteger(recordLimit) && recordLimit >= 0)) {
      return error(`--record-limit needs a whole number, got ${values['record-limit']}`);
    }
    const perStation =
      values['sessions-per-station'] === undefined
        ? undefined
        : Number(values['sessions-per-station']);
    if (perStation !== undefined && !(Number.isInteger(perStation) && perStation >= 1)) {
      return error(
        `--sessions-per-station needs a whole number from 1, got ${values['sessions-per-station']}`,
      );
    }
    return {
      kind: 'serve',
      port,
      host: values.host ?? '127.0.0.1',
      ...(values.store !== undefined && { store: values.store }),
      ...(recordLimit !== undefined && { recordLimit }),
      ...(perStation !== undefined && { sessionsPerStation: perStation }),
      ...otlpOptions(values),
      personas: values.personas ?? [],
      allowCsms: values['allow-csms'] ?? [],
    };
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}

/** `--otlp-endpoint` and `--otlp-header`, checked; throws a readable Error. */
function otlpOptions(values: Values): {
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
} {
  const endpoint = values['otlp-endpoint'];
  const headers: Record<string, string> = {};
  for (const entry of values['otlp-header'] ?? []) {
    const at = entry.indexOf('=');
    if (at <= 0) throw new Error(`--otlp-header needs name=value, got ${entry}`);
    headers[entry.slice(0, at)] = entry.slice(at + 1);
  }
  if (endpoint === undefined) {
    if (Object.keys(headers).length > 0) throw new Error('--otlp-header needs --otlp-endpoint');
    return {};
  }
  if (!/^https?:\/\/\S+$/.test(endpoint)) {
    throw new Error(`--otlp-endpoint needs an http:// or https:// URL, got ${endpoint}`);
  }
  return {
    otlpEndpoint: endpoint,
    ...(Object.keys(headers).length > 0 && { otlpHeaders: headers }),
  };
}

function parsePort(value: string | undefined, fallback: number): number | undefined {
  const port = value === undefined ? fallback : Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

function parseRun(paths: string[], values: Values): Command {
  if (paths.length === 0) return error('run needs a scenario file or directory');
  if (
    values.csms !== undefined &&
    values.csms !== 'builtin' &&
    !/^wss?:\/\/\S+$/.test(values.csms)
  ) {
    return error(`--csms must be builtin or a ws:// or wss:// URL, got ${values.csms}`);
  }
  const vars: Record<string, string> = {};
  for (const entry of values.var ?? []) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry);
    if (match === null || match[1] === 'env') {
      return error(`--var needs NAME=value, got ${entry}`);
    }
    vars[match[1] ?? ''] = match[2] ?? '';
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = parseDuration(values.timeout);
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return error(`--timeout needs a duration such as 30s or 5m, got ${values.timeout}`);
    }
  }
  return {
    kind: 'run',
    paths,
    ...(values.csms !== undefined && { csms: values.csms }),
    vars,
    ...(timeoutMs !== undefined && { timeoutMs }),
    bail: values.bail ?? false,
    ...(values.junit !== undefined && { junit: values.junit }),
    ...(values['log-dir'] !== undefined && { logDir: values['log-dir'] }),
    personas: values.personas ?? [],
    allowCsms: values['allow-csms'] ?? [],
  };
}

function parseImport(files: string[], values: Values): Command {
  if (files.length === 0) return error('import needs a log file');
  if (values.mask && values['no-mask']) return error('--mask and --no-mask contradict each other');
  if (values.salt !== undefined && values['salt-file'] !== undefined) {
    return error('give --salt or --salt-file, not both');
  }
  return {
    kind: 'import',
    files,
    ...(values.map !== undefined && { map: values.map }),
    ...(values.mask === true && { mask: true }),
    ...(values['no-mask'] === true && { mask: false }),
    ...(values.salt !== undefined && { salt: values.salt }),
    ...(values['salt-file'] !== undefined && { saltFile: values['salt-file'] }),
    ...(values.out !== undefined && { out: values.out }),
  };
}

function parseCalibrate(logs: string[], values: Values): Command {
  if (logs.length === 0) return error('calibrate needs a log file');
  return {
    kind: 'calibrate',
    logs,
    stations: values.station ?? [],
    ...(values.name !== undefined && { name: values.name }),
    ...(values.extends !== undefined && { extends: values.extends }),
    ...(values.out !== undefined && { out: values.out }),
    ...(values.report !== undefined && { report: values.report }),
  };
}

function parseReplay(rest: string[], values: Values): Command {
  const [log, extra] = rest;
  if (log === undefined) return error('replay needs a log file');
  if ((values.station?.length ?? 0) > 1) return error('replay takes one --station');
  if (extra !== undefined) return error(`Unexpected argument: ${extra}`);
  if (
    values.csms !== undefined &&
    values.csms !== 'builtin' &&
    !/^wss?:\/\/\S+$/.test(values.csms)
  ) {
    return error(`--csms must be builtin or a ws:// or wss:// URL, got ${values.csms}`);
  }
  const speed = values.speed === undefined ? undefined : Number(values.speed);
  if (speed !== undefined && !(speed > 0))
    return error(`--speed needs a number above 0, got ${values.speed}`);
  const maxGapMs = values['max-gap'] === undefined ? undefined : parseDuration(values['max-gap']);
  if (values['max-gap'] !== undefined && maxGapMs === undefined) {
    return error(`--max-gap needs a duration such as 10s, got ${values['max-gap']}`);
  }
  const compare = values.compare;
  if (compare !== undefined && compare !== 'status' && compare !== 'strict' && compare !== 'none') {
    return error(`--compare must be status, strict or none, got ${compare}`);
  }
  return {
    kind: 'replay',
    log,
    ...(values.station?.length === 1 && { station: values.station[0] }),
    ...(values.csms !== undefined && { csms: values.csms }),
    ...(values.persona !== undefined && { persona: values.persona }),
    ...(speed !== undefined && { speed }),
    ...(maxGapMs !== undefined && { maxGapMs }),
    ...(compare !== undefined && { compare }),
    ...(values.write !== undefined && { write: values.write }),
    personas: values.personas ?? [],
    allowCsms: values['allow-csms'] ?? [],
  };
}

function parseLoad(rest: string[], values: Values): Command {
  const [plan, extra] = rest;
  if (plan === undefined) return error('load needs a load plan file');
  if (extra !== undefined) return error(`Unexpected argument: ${extra}`);
  if (
    values.csms !== undefined &&
    values.csms !== 'builtin' &&
    !/^wss?:\/\/\S+$/.test(values.csms)
  ) {
    return error(`--csms must be builtin or a ws:// or wss:// URL, got ${values.csms}`);
  }
  let durationMs: number | undefined;
  if (values.duration !== undefined) {
    durationMs = parseDuration(values.duration);
    if (durationMs === undefined || durationMs <= 0) {
      return error(`--duration needs a duration such as 10m, got ${values.duration}`);
    }
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = parsePort(values.port, 0);
    if (port === undefined) return error(`Invalid port: ${values.port}`);
  }
  const recordLimit =
    values['record-limit'] === undefined ? undefined : Number(values['record-limit']);
  if (recordLimit !== undefined && !(Number.isInteger(recordLimit) && recordLimit >= 0)) {
    return error(`--record-limit needs a whole number, got ${values['record-limit']}`);
  }
  return {
    kind: 'load',
    plan,
    ...(values.csms !== undefined && { csms: values.csms }),
    ...(durationMs !== undefined && { durationMs }),
    ...(values['report-dir'] !== undefined && { reportDir: values['report-dir'] }),
    ...(values.junit !== undefined && { junit: values.junit }),
    ...(port !== undefined && { port }),
    ...(recordLimit !== undefined && { recordLimit }),
    ...(values['log-dir'] !== undefined && { logDir: values['log-dir'] }),
    ...otlpOptions(values),
    personas: values.personas ?? [],
    allowCsms: values['allow-csms'] ?? [],
  };
}

/** `50ms`, or a range `20ms-100ms`; durations without a unit are milliseconds. */
export function parseDelay(value: string): { minMs: number; maxMs: number } | undefined {
  const match = /^([^-]+)(?:-([^-]+))?$/.exec(value.trim());
  if (match === null) return undefined;
  const ms = (text: string) => {
    const number = Number(text);
    return Number.isFinite(number) ? number : parseDuration(text);
  };
  const minMs = ms(match[1] ?? '');
  const maxMs = match[2] === undefined ? minMs : ms(match[2]);
  if (minMs === undefined || maxMs === undefined || minMs < 0 || maxMs < minMs) return undefined;
  return { minMs, maxMs };
}

function parseCsms(values: Values): Command {
  const port = parsePort(values.port, DEFAULT_CSMS_PORT);
  if (port === undefined) return error(`Invalid port: ${values.port}`);

  let delay: { minMs: number; maxMs: number } | undefined;
  if (values.delay !== undefined) {
    delay = parseDelay(values.delay);
    if (delay === undefined) {
      return error(`--delay needs a duration or a range such as 20ms-100ms, got ${values.delay}`);
    }
  }

  const heartbeatInterval =
    values['heartbeat-interval'] === undefined ? 60 : Number(values['heartbeat-interval']);
  if (!Number.isInteger(heartbeatInterval) || heartbeatInterval <= 0) {
    return error(`--heartbeat-interval needs whole seconds, got ${values['heartbeat-interval']}`);
  }

  const statusMs =
    values.status === undefined ? 60_000 : values.status === '0' ? 0 : parseDuration(values.status);
  if (statusMs === undefined || statusMs < 0) {
    return error(`--status needs a duration such as 30s, got ${values.status}`);
  }

  const mode = values['client-certificates'] ?? 'none';
  if (mode !== 'none' && mode !== 'optional' && mode !== 'required') {
    return error(`--client-certificates must be none, optional or required, got ${mode}`);
  }
  const cert = values['tls-cert'];
  const key = values['tls-key'];
  if ((cert === undefined) !== (key === undefined)) {
    return error('--tls-cert and --tls-key go together');
  }
  if (cert === undefined && (values['tls-ca'] !== undefined || mode !== 'none')) {
    return error('--tls-ca and --client-certificates need --tls-cert and --tls-key');
  }

  return {
    kind: 'csms',
    port,
    host: values.host ?? '127.0.0.1',
    ...(delay !== undefined && { delay }),
    heartbeatInterval,
    unknownPrefix: values['unknown-prefix'] ?? 'UNKNOWN-',
    ...(values.password !== undefined && { password: values.password }),
    ...(cert !== undefined &&
      key !== undefined && {
        tls: {
          cert,
          key,
          ...(values['tls-ca'] !== undefined && { ca: values['tls-ca'] }),
          clientCertificates: mode,
        },
      }),
    statusMs,
  };
}
