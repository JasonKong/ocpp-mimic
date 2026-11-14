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
    expect(parseCommand(['serve', '--record-limit', '0'])).toMatchObject({ recordLimit: 0 });
    expect(
      parseCommand([
        'serve',
        '--otlp-endpoint',
        'http://localhost:4318',
        '--otlp-header',
        'x-key=v=1',
      ]),
    ).toMatchObject({ otlpEndpoint: 'http://localhost:4318', otlpHeaders: { 'x-key': 'v=1' } });
    expect(parseCommand(['serve', '--otlp-endpoint', 'localhost:4318'])).toMatchObject({
      kind: 'error',
    });
    expect(parseCommand(['serve', '--otlp-header', 'a=b'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['serve', '--record-limit', 'lots'])).toMatchObject({ kind: 'error' });
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
        '--junit',
        'reports/junit.xml',
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
      junit: 'reports/junit.xml',
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
      message: '--port is an option of serve and csms',
    });
    expect(parseCommand(['serve', '--delay', '1s'])).toEqual({
      kind: 'error',
      message: '--delay is an option of csms',
    });
    expect(parseCommand(['serve', '--bail'])).toEqual({
      kind: 'error',
      message: '--bail is an option of run',
    });
  });

  it('runs the built-in CSMS on port 9100 by default', () => {
    expect(parseCommand(['csms'])).toEqual({
      kind: 'csms',
      port: 9100,
      host: '127.0.0.1',
      heartbeatInterval: 60,
      unknownPrefix: 'UNKNOWN-',
      statusMs: 60_000,
    });
  });

  it('parses csms with its options', () => {
    expect(
      parseCommand([
        'csms',
        '--port',
        '0',
        '--host',
        '0.0.0.0',
        '--delay',
        '20ms-100ms',
        '--heartbeat-interval',
        '300',
        '--unknown-prefix',
        '',
        '--password',
        'secret-password',
        '--tls-cert',
        'server.pem',
        '--tls-key',
        'server.key',
        '--tls-ca',
        'ca.pem',
        '--client-certificates',
        'required',
        '--status',
        '0',
      ]),
    ).toEqual({
      kind: 'csms',
      port: 0,
      host: '0.0.0.0',
      delay: { minMs: 20, maxMs: 100 },
      heartbeatInterval: 300,
      unknownPrefix: '',
      password: 'secret-password',
      tls: { cert: 'server.pem', key: 'server.key', ca: 'ca.pem', clientCertificates: 'required' },
      statusMs: 0,
    });
    expect(parseCommand(['csms', '--delay', '50ms'])).toMatchObject({
      delay: { minMs: 50, maxMs: 50 },
    });
  });

  it('rejects bad csms options', () => {
    for (const args of [
      ['--delay', '100ms-20ms'],
      ['--delay', 'soon'],
      ['--heartbeat-interval', '1.5'],
      ['--status', 'often'],
      ['--client-certificates', 'maybe'],
      ['--tls-cert', 'server.pem'],
      ['--client-certificates', 'required'],
    ]) {
      expect(parseCommand(['csms', ...args]), args.join(' ')).toMatchObject({ kind: 'error' });
    }
    expect(parseCommand(['csms', 'extra'])).toEqual({
      kind: 'error',
      message: 'Unexpected argument: extra',
    });
  });

  it('parses import with its options, and run with --log-dir', () => {
    expect(
      parseCommand([
        'import',
        'a.csv',
        'b.csv',
        '--map',
        'm.yaml',
        '--salt',
        's',
        '-o',
        'out.jsonl',
      ]),
    ).toEqual({
      kind: 'import',
      files: ['a.csv', 'b.csv'],
      map: 'm.yaml',
      salt: 's',
      out: 'out.jsonl',
    });
    expect(parseCommand(['import', 'a.jsonl', '--mask', '--salt-file', 'salt.txt'])).toEqual({
      kind: 'import',
      files: ['a.jsonl'],
      mask: true,
      saltFile: 'salt.txt',
    });
    expect(parseCommand(['import', 'a.csv', '--map', 'm.yaml', '--no-mask'])).toMatchObject({
      mask: false,
    });
    expect(parseCommand(['import'])).toEqual({ kind: 'error', message: 'import needs a log file' });
    expect(parseCommand(['import', 'a', '--mask', '--no-mask'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['import', 'a', '--salt', 'x', '--salt-file', 'y'])).toMatchObject({
      kind: 'error',
    });
    expect(parseCommand(['run', 'a.yaml', '--log-dir', 'logs'])).toMatchObject({
      kind: 'run',
      logDir: 'logs',
  it('parses load with its options', () => {
    expect(parseCommand(['load', 'plan.yaml'])).toEqual({
      kind: 'load',
      plan: 'plan.yaml',
      personas: [],
      allowCsms: [],
    });
    expect(
      parseCommand([
        'load',
        'plan.yaml',
        '--csms',
        'builtin',
        '--duration',
        '2m',
        '--report-dir',
        'out',
        '--junit',
        'out/load.xml',
        '--port',
        '0',
        '--personas',
        'scenarios/personas',
      ]),
    ).toEqual({
      kind: 'load',
      plan: 'plan.yaml',
      csms: 'builtin',
      durationMs: 120_000,
      reportDir: 'out',
      junit: 'out/load.xml',
      port: 0,
      personas: ['scenarios/personas'],
      allowCsms: [],
    });
    expect(parseCommand(['load'])).toEqual({ kind: 'error', message: 'load needs a load plan file' });
    expect(parseCommand(['load', 'p.yaml', '--duration', 'soon'])).toMatchObject({ kind: 'error' });
    expect(parseCommand(['load', 'p.yaml', '--bail'])).toEqual({
      kind: 'error',
      message: '--bail is an option of run',
    });
  });

  it('prints help with no command, and the version with -v', () => {
    expect(parseCommand([])).toEqual({ kind: 'help' });
    expect(parseCommand(['-v'])).toEqual({ kind: 'version' });
  });
});
