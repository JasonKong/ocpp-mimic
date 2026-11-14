import { parseArgs } from 'node:util';
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

export type Command =
  ServeCommand | { kind: 'version' } | { kind: 'help' } | { kind: 'error'; message: string };

export const USAGE = `Usage: ocpp-mimic <command> [options]

Commands:
  serve                  Start the engine, its HTTP API and the Web UI

Options:
  --port <number>        Port for the HTTP API (default ${DEFAULT_PORT})
  --host <host>          Interface to bind (default 127.0.0.1)
  --store <file>         SQLite file that keeps stations across restarts
                         (default: nothing is kept)
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
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });

    if (values.version) return { kind: 'version' };
    const [name, ...rest] = positionals;
    if (values.help || name === undefined) return { kind: 'help' };
    if (name !== 'serve') return { kind: 'error', message: `Unknown command: ${name}` };
    if (rest.length > 0) return { kind: 'error', message: `Unexpected argument: ${rest[0]}` };

    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { kind: 'error', message: `Invalid port: ${values.port}` };
    }
    const badPrefix = values['allow-csms'].find((prefix) => !/^wss?:\/\/.+/.test(prefix));
    if (badPrefix !== undefined) {
      return {
        kind: 'error',
        message: `--allow-csms needs a ws:// or wss:// prefix, got ${badPrefix}`,
      };
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
