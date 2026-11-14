import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@ocpp-mimic/engine';

export type Command =
  | { kind: 'serve'; port: number; host: string }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const USAGE = `Usage: ocpp-mimic <command> [options]

Commands:
  serve            Start the engine and its HTTP API

Options:
  --port <number>  Port for the HTTP API (default ${DEFAULT_PORT})
  --host <host>    Interface to bind (default 127.0.0.1)
  -v, --version    Print the version
  -h, --help       Print this help`;

export function parseCommand(argv: readonly string[]): Command {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
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
    return { kind: 'serve', port, host: values.host };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
