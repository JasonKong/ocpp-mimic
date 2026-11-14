import { parseArgs } from 'node:util';
import { parseDuration } from '@ocpp-mimic/core';
import { DEFAULT_ALLOWED_CSMS, DEFAULT_PORT } from '@ocpp-mimic/engine';

export interface ServeCommand {
  kind: 'serve';
  port: number;
  host: string;
  /** SQLite file for station state; omitted = nothing persisted. */
  store?: string;
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
  personas: string[];
  allowCsms: string[];
}

export type Command =
  | ServeCommand
  | RunCommand
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const USAGE = `Usage: ocpp-mimic <command> [options]

Commands:
  serve                  Start the engine, its HTTP API and the Web UI
  run <file|dir>...      Run scenario files (directories are searched for
                         .yaml / .yml files)

Options for serve:
  --port <number>        Port for the HTTP API (default ${DEFAULT_PORT})
  --host <host>          Interface to bind (default 127.0.0.1)
  --store <file>         SQLite file that keeps stations across restarts
                         (default: nothing is kept)

Options for run:
  --csms <url>           Run every scenario against this CSMS instead of its
                         own csms (builtin or a ws:// / wss:// URL)
  --var <NAME=value>     Template variable; repeat for more
  --timeout <duration>   Timeout for scenarios without their own (default 5m)
  --bail                 Stop after the first scenario that does not pass

Options for both:
  --personas <dir>       Extra persona directory; repeat for more
  --allow-csms <prefix>  Also allow CSMS URLs starting with <prefix>; repeat
                         for more (default: ${DEFAULT_ALLOWED_CSMS.slice(0, 2).join(', ')}, ...)
  -v, --version          Print the version
  -h, --help             Print this help`;

export function parseCommand(argv: readonly string[]): Command {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        store: { type: 'string' },
        personas: { type: 'string', multiple: true, default: [] },
        'allow-csms': { type: 'string', multiple: true, default: [] },
        csms: { type: 'string' },
        var: { type: 'string', multiple: true, default: [] },
        timeout: { type: 'string' },
        bail: { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });

    if (values.version) return { kind: 'version' };
    const [name, ...rest] = positionals;
    if (values.help || name === undefined) return { kind: 'help' };
    if (name !== 'serve' && name !== 'run') {
      return { kind: 'error', message: `Unknown command: ${name}` };
    }
    const badPrefix = values['allow-csms'].find((prefix) => !/^wss?:\/\/.+/.test(prefix));
    if (badPrefix !== undefined) {
      return {
        kind: 'error',
        message: `--allow-csms needs a ws:// or wss:// prefix, got ${badPrefix}`,
      };
    }
    if (name === 'run') return parseRun(rest, values);
    if (rest.length > 0) return { kind: 'error', message: `Unexpected argument: ${rest[0]}` };
    for (const option of ['csms', 'timeout'] as const) {
      if (values[option] !== undefined) {
        return { kind: 'error', message: `--${option} is an option of run` };
      }
    }
    if (values.var.length > 0 || values.bail) {
      return { kind: 'error', message: `${values.bail ? '--bail' : '--var'} is an option of run` };
    }

    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { kind: 'error', message: `Invalid port: ${values.port}` };
    }
    return {
      kind: 'serve',
      port,
      host: values.host,
      ...(values.store !== undefined && { store: values.store }),
      personas: values.personas,
      allowCsms: values['allow-csms'],
    };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function parseRun(
  paths: string[],
  values: {
    csms?: string | undefined;
    var: string[];
    timeout?: string | undefined;
    bail: boolean;
    personas: string[];
    'allow-csms': string[];
    port?: string | undefined;
    store?: string | undefined;
  },
): Command {
  if (paths.length === 0)
    return { kind: 'error', message: 'run needs a scenario file or directory' };
  if (values.port !== undefined || values.store !== undefined) {
    return {
      kind: 'error',
      message: `--${values.port !== undefined ? 'port' : 'store'} is an option of serve`,
    };
  }
  if (
    values.csms !== undefined &&
    values.csms !== 'builtin' &&
    !/^wss?:\/\/\S+$/.test(values.csms)
  ) {
    return {
      kind: 'error',
      message: `--csms must be builtin or a ws:// or wss:// URL, got ${values.csms}`,
    };
  }
  const vars: Record<string, string> = {};
  for (const entry of values.var) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry);
    if (match === null || match[1] === 'env') {
      return { kind: 'error', message: `--var needs NAME=value, got ${entry}` };
    }
    vars[match[1] ?? ''] = match[2] ?? '';
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = parseDuration(values.timeout);
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return {
        kind: 'error',
        message: `--timeout needs a duration such as 30s or 5m, got ${values.timeout}`,
      };
    }
  }
  return {
    kind: 'run',
    paths,
    ...(values.csms !== undefined && { csms: values.csms }),
    vars,
    ...(timeoutMs !== undefined && { timeoutMs }),
    bail: values.bail,
    personas: values.personas,
    allowCsms: values['allow-csms'],
  };
}
