import { describe, expect, it } from 'vitest';
import { parseCommand } from './command.js';

describe('parseCommand', () => {
  it('starts the engine on the default port and loopback interface', () => {
    expect(parseCommand(['serve'])).toEqual({
      kind: 'serve',
      port: 7300,
      host: '127.0.0.1',
      personas: [],
      allowCsms: [],
    });
  });

  it('takes --port and --host', () => {
    expect(parseCommand(['serve', '--port', '9000', '--host', '0.0.0.0'])).toEqual({
      kind: 'serve',
      port: 9000,
      host: '0.0.0.0',
      personas: [],
      allowCsms: [],
    });
  });

  it('takes a store file, extra persona directories and allowed CSMS prefixes', () => {
    expect(
      parseCommand([
        'serve',
        '--store',
        'state.db',
        '--personas',
        './personas',
        '--personas',
        './more',
        '--allow-csms',
        'wss://csms.example.com',
      ]),
    ).toEqual({
      kind: 'serve',
      port: 7300,
      host: '127.0.0.1',
      store: 'state.db',
      personas: ['./personas', './more'],
      allowCsms: ['wss://csms.example.com'],
    });
    expect(parseCommand(['serve', '--allow-csms', 'csms.example.com'])).toMatchObject({
      kind: 'error',
    });
  });

  it('rejects a port that is not a valid number', () => {
    expect(parseCommand(['serve', '--port', 'abc'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['serve', '--port', '70000'])).toMatchObject({ kind: 'error' });
  });

  it('rejects unknown commands and options', () => {
    expect(parseCommand(['launch'])).toEqual({ kind: 'error', message: 'Unknown command: launch' });
    expect(parseCommand(['serve', '--nope'])).toMatchObject({ kind: 'error' });
  });

  it('parses run with its options', () => {
    expect(
      parseCommand([
        'run',
        'scenarios/regression',
        'extra.yaml',
        '--csms',
        'ws://localhost:9000/ocpp',
        '--var',
        'TAG=TAG-1',
        '--var',
        'URL=http://x/?a=b',
        '--timeout',
        '2m',
        '--bail',
        '--personas',
        'scenarios/personas',
        '--allow-csms',
        'wss://csms.example.com',
      ]),
    ).toEqual({
      kind: 'run',
      paths: ['scenarios/regression', 'extra.yaml'],
      csms: 'ws://localhost:9000/ocpp',
      vars: { TAG: 'TAG-1', URL: 'http://x/?a=b' },
      timeoutMs: 120_000,
      bail: true,
      personas: ['scenarios/personas'],
      allowCsms: ['wss://csms.example.com'],
    });
    expect(parseCommand(['run', 'a.yaml'])).toEqual({
      kind: 'run',
      paths: ['a.yaml'],
      vars: {},
      bail: false,
      personas: [],
      allowCsms: [],
    });
  });

  it('rejects bad run arguments and options that belong to the other command', () => {
    expect(parseCommand(['run'])).toEqual({
      kind: 'error',
      message: 'run needs a scenario file or directory',
    });
    expect(parseCommand(['run', 'a.yaml', '--var', 'oops'])).toEqual({
      kind: 'error',
      message: '--var needs NAME=value, got oops',
    });
    expect(parseCommand(['run', 'a.yaml', '--timeout', 'soon'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['run', 'a.yaml', '--csms', 'http://x'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['run', 'a.yaml', '--port', '1'])).toEqual({
      kind: 'error',
      message: '--port is an option of serve',
    });
    expect(parseCommand(['serve', '--bail'])).toEqual({
      kind: 'error',
      message: '--bail is an option of run',
    });
  });

  it('prints help with no command, and the version with -v', () => {
    expect(parseCommand([])).toEqual({ kind: 'help' });
    expect(parseCommand(['-v'])).toEqual({ kind: 'version' });
  });
});
