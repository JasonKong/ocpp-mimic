import { execFileSync } from 'node:child_process';
import { constants, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testPki, TEST_PKI_DIR } from './test-pki.js';
import {
  createCertificateTools,
  createCsr,
  hashDataOf,
  parseCertificates,
  signCsr,
  verifyChain,
  verifySignature,
} from './x509.js';

const ca = new X509Certificate(testPki('ca.crt'));
const client = new X509Certificate(testPki('client.crt'));
const untrusted = new X509Certificate(testPki('other-client.crt'));
const now = Date.parse('2026-11-15T00:00:00Z');

/** openssl, when installed, as an independent check of what we write. */
function openssl(args: string[]): string | undefined {
  try {
    return execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
const dir = mkdtempSync(join(tmpdir(), 'ocpp-mimic-x509-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('certificate hash data', () => {
  it('matches what openssl puts in an OCSP request (RFC 6960)', () => {
    const hash = hashDataOf(client, [ca]);
    expect(hash).toEqual({
      hashAlgorithm: 'SHA256',
      issuerNameHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
      issuerKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
      serialNumber: client.serialNumber.replace(/^0+/, ''),
    });
    const text = openssl([
      'ocsp',
      '-sha256',
      '-issuer',
      join(TEST_PKI_DIR, 'ca.crt'),
      '-cert',
      join(TEST_PKI_DIR, 'client.crt'),
      '-req_text',
      '-no_nonce',
      '-reqout',
      join(dir, 'req.der'),
    ]);
    if (text === undefined) return;
    expect(text).toContain(`Issuer Name Hash: ${hash.issuerNameHash.toUpperCase()}`);
    expect(text).toContain(`Issuer Key Hash: ${hash.issuerKeyHash.toUpperCase()}`);
    expect(text).toContain(`Serial Number: ${hash.serialNumber}`);
    // A root is its own issuer.
    expect(hashDataOf(ca).issuerKeyHash).toBe(hash.issuerKeyHash);
  });
});

describe('chain verification', () => {
  it('accepts a chain to a trusted root within its validity, nothing else', () => {
    expect(verifyChain([client], [ca], now)).toBe(true);
    expect(verifyChain([client, ca], [ca], now)).toBe(true);
    expect(verifyChain([untrusted], [ca], now)).toBe(false);
    expect(verifyChain([client], [], now)).toBe(false);
    expect(verifyChain([client], [ca], Date.parse('2060-01-01T00:00:00Z'))).toBe(false);
    expect(verifyChain([ca], [ca], now)).toBe(true);
    expect(parseCertificates('not a certificate')).toEqual([]);
  });
});

describe('CSRs and signing', () => {
  it('writes a CSR openssl accepts, and signs it into a client certificate of the CA', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const csr = createCsr({ commonName: 'CP-0001', organization: 'Example CPO' }, privateKey);
    expect(csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    writeFileSync(join(dir, 'cp.csr'), csr);
    const checked = openssl(['req', '-in', join(dir, 'cp.csr'), '-noout', '-verify', '-subject']);
    if (checked !== undefined)
      expect(checked).toMatch(/subject=O\s*=\s*Example CPO, CN\s*=\s*CP-0001/);

    const signed = signCsr(csr, { certificate: testPki('ca.crt'), key: testPki('ca.key') });
    const certificate = new X509Certificate(signed);
    expect(certificate.subject).toBe('O=Example CPO\nCN=CP-0001');
    expect(certificate.ca).toBe(false);
    expect(verifyChain([certificate], [ca], Date.now())).toBe(true);
    const tools = createCertificateTools();
    expect(
      tools.matchesKey(signed, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toBe(true);
    expect(
      tools.matchesKey(
        testPki('client.crt'),
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ),
    ).toBe(false);
    writeFileSync(join(dir, 'cp.crt'), signed);
    const verified = openssl([
      'verify',
      '-CAfile',
      join(TEST_PKI_DIR, 'ca.crt'),
      join(dir, 'cp.crt'),
    ]);
    if (verified !== undefined) expect(verified).toContain('OK');

    // A tampered CSR is refused.
    const body = csr.split('\n').slice(1, -2).join('');
    const bytes = Buffer.from(body, 'base64');
    bytes[40] = (bytes[40] ?? 0) ^ 0xff;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${bytes.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
    expect(() =>
      signCsr(tampered, { certificate: testPki('ca.crt'), key: testPki('ca.key') }),
    ).toThrow();
  });

  it('creates EC CSRs too', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const csr = createCsr({ commonName: 'CP-EC' }, privateKey);
    const signed = signCsr(csr, { certificate: testPki('ca.crt'), key: testPki('ca.key') });
    expect(new X509Certificate(signed).publicKey.asymmetricKeyType).toBe('ec');
  });
});

describe('firmware signatures', () => {
  it('verifies RSA-PSS and PKCS #1 signatures over the image', () => {
    const image = Buffer.from('firmware image');
    const key = testPki('client.key');
    const pss = sign('sha256', image, { key, padding: constants.RSA_PKCS1_PSS_PADDING }).toString(
      'base64',
    );
    expect(verifySignature(image, pss, testPki('client.crt'))).toBe(true);
    expect(
      verifySignature(image, sign('sha256', image, key).toString('base64'), testPki('client.crt')),
    ).toBe(true);
    expect(verifySignature(Buffer.from('tampered'), pss, testPki('client.crt'))).toBe(false);
    expect(verifySignature(image, pss, testPki('other-client.crt'))).toBe(false);
  });
});

describe('certificate tools', () => {
  it('inspect, verifyChain and createCsr work on PEM text', () => {
    const tools = createCertificateTools();
    expect(tools.inspect(testPki('client.crt'), [testPki('ca.crt')])?.hashData).toEqual(
      hashDataOf(client, [ca]),
    );
    expect(tools.inspect('garbage')).toBeUndefined();
    expect(tools.verifyChain(testPki('client.crt'), [testPki('ca.crt')], now)).toBe(true);
    expect(tools.verifyChain('', [testPki('ca.crt')], now)).toBe(false);
    const { csr, privateKey } = tools.createCsr({ commonName: 'CP-1', organization: 'CPO' });
    const signed = signCsr(csr, { certificate: testPki('ca.crt'), key: testPki('ca.key') });
    expect(tools.matchesKey(signed, privateKey)).toBe(true);
  });
});
