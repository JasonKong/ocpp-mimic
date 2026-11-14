import { afterEach, describe, expect, it } from 'vitest';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';
import { connectionSettings, securityEventFor } from './fleet.js';
import { testPki } from './test-pki.js';
import { createTransport, type Transport, type TransportEvent } from './transport.js';

const KEY = 'station-key-0001';
const CP = { certificate: 'CERT', privateKey: 'KEY' };
const none = { centralSystemRoots: [] };

describe('connection settings per Security Profile', () => {
  it('profile 0 sends a password only when one is set', () => {
    expect(connectionSettings('ws://h/ocpp', { profile: 0, ...none })).toEqual({});
    expect(
      connectionSettings('wss://h/ocpp', {
        profile: 0,
        authorizationKey: KEY,
        centralSystemRoots: ['CA'],
      }),
    ).toEqual({ password: KEY, tls: { ca: 'CA' } });
  });

  it('profile 1 needs a key and works over ws and wss', () => {
    expect(connectionSettings('ws://h/ocpp', { profile: 1, ...none })).toEqual({
      error: 'Security Profile 1 needs an AuthorizationKey',
    });
    expect(
      connectionSettings('ws://h/ocpp', { profile: 1, authorizationKey: KEY, ...none }),
    ).toEqual({
      password: KEY,
    });
  });

  it('profile 2 needs wss and a key, and checks the server with the CA over TLS 1.2+', () => {
    const roots = { centralSystemRoots: ['CA1', 'CA2'] };
    expect(
      connectionSettings('ws://h/ocpp', { profile: 2, authorizationKey: KEY, ...roots }),
    ).toEqual({
      error: 'Security Profile 2 needs a wss:// CSMS address',
    });
    expect(connectionSettings('wss://h/ocpp', { profile: 2, ...roots })).toEqual({
      error: 'Security Profile 2 needs an AuthorizationKey',
    });
    expect(
      connectionSettings('wss://h/ocpp', { profile: 2, authorizationKey: KEY, ...roots }),
    ).toEqual({
      password: KEY,
      tls: { ca: 'CA1\nCA2', minVersion: 'TLSv1.2' },
    });
  });

  it('profile 3 uses the client certificate instead of a password', () => {
    const roots = { centralSystemRoots: ['CA'] };
    expect(
      connectionSettings('wss://h/ocpp', { profile: 3, authorizationKey: KEY, ...roots }),
    ).toEqual({
      error: 'Security Profile 3 needs a client certificate and key',
    });
    expect(
      connectionSettings('wss://h/ocpp', {
        profile: 3,
        authorizationKey: KEY,
        ...roots,
        chargePointCertificate: CP,
      }),
    ).toEqual({ tls: { ca: 'CA', cert: 'CERT', key: 'KEY', minVersion: 'TLSv1.2' } });
  });
});

describe('security events for failed connections', () => {
  it('tells refused passwords, bad certificates and old TLS versions apart', () => {
    expect(securityEventFor('Unexpected server response: 401')).toBe(
      'FailedToAuthenticateAtCentralSystem',
    );
    expect(securityEventFor('unable to verify the first certificate')).toBe(
      'InvalidCentralSystemCertificate',
    );
    expect(securityEventFor('self-signed certificate in certificate chain')).toBe(
      'InvalidCentralSystemCertificate',
    );
    expect(securityEventFor("Hostname/IP does not match certificate's altnames")).toBe(
      'InvalidCentralSystemCertificate',
    );
    expect(securityEventFor('unsupported protocol')).toBe('InvalidTLSVersion');
    expect(securityEventFor('connect ECONNREFUSED 127.0.0.1:1')).toBeUndefined();
    expect(securityEventFor('Security Profile 2 needs a wss:// CSMS address')).toBeUndefined();
  });
});

describe('built-in CSMS over TLS', () => {
  let csms: BuiltinCsms | undefined;
  const transports: Transport[] = [];

  afterEach(async () => {
    for (const transport of transports.splice(0)) await transport.stop();
    await csms?.stop();
    csms = undefined;
  });

  function connect(url: string, tls: Parameters<typeof createTransport>[0]['tls']) {
    const events: TransportEvent[] = [];
    let opened = false;
    const transport = createTransport({
      url,
      chargeBoxId: 'CP-TLS',
      backoff: { initialDelayMs: 50, maxDelayMs: 50, factor: 1, jitter: 0 },
      ...(tls !== undefined && { tls }),
      onText: () => {},
      onOpen: () => {
        opened = true;
      },
      onClose: () => {},
      onEvent: (event) => events.push(event),
    });
    transports.push(transport);
    transport.start();
    return { events, opened: () => opened };
  }

  it('serves wss:// and reports a trusted client certificate', async () => {
    csms = await startBuiltinCsms({
      tls: {
        cert: testPki('server.crt'),
        key: testPki('server.key'),
        ca: testPki('ca.crt'),
        clientCertificates: 'optional',
      },
    });
    expect(csms.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/ocpp$/);
    connect(csms.url, {
      ca: testPki('ca.crt'),
      cert: testPki('client.crt'),
      key: testPki('client.key'),
      minVersion: 'TLSv1.2',
    });
    const connection = await csms.waitForConnection('CP-TLS');
    expect(connection.clientCertificate).toEqual({
      subject: { O: 'ocpp-mimic', CN: 'ocpp-mimic-test-cp' },
      authorized: true,
    });
  });

  it('refuses an untrusted client certificate when certificates are required', async () => {
    csms = await startBuiltinCsms({
      tls: {
        cert: testPki('server.crt'),
        key: testPki('server.key'),
        ca: testPki('ca.crt'),
        clientCertificates: 'required',
      },
    });
    const station = connect(csms.url, {
      ca: testPki('ca.crt'),
      cert: testPki('other-client.crt'),
      key: testPki('other-client.key'),
    });
    const deadline = Date.now() + 2000;
    while (!station.events.some((e) => e.type === 'error') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(station.events.some((e) => e.type === 'error')).toBe(true);
    expect(station.opened()).toBe(false);
  });
});
