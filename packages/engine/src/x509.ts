/**
 * The X.509 work the Security Whitepaper needs, on top of node:crypto: the
 * hash data that identifies a certificate (issuer name and key hashes, serial
 * number), chain verification, CSRs (PKCS #10) for the charge point's new key,
 * and signing a CSR for the built-in CSMS. Node parses and verifies
 * certificates itself; the few DER structures it does not expose (the issuer
 * name, a CSR, a certificate to sign) are read and written here.
 */
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import type { CertificateHashData, CertificateTools } from '@ocpp-mimic/core';

// ---- DER ---------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** The whole element: tag, length and value. */
  raw: Buffer;
  value: Buffer;
}

/** Reads the DER element at `offset`. */
function readTlv(der: Buffer, offset = 0): Tlv {
  const tag = der[offset];
  let length = der[offset + 1];
  if (tag === undefined || length === undefined) throw new Error('truncated DER');
  let header = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + (der[offset + 2 + i] ?? 0);
    header += bytes;
  }
  const end = offset + header + length;
  if (end > der.length) throw new Error('truncated DER');
  return { tag, raw: der.subarray(offset, end), value: der.subarray(offset + header, end) };
}

/** The elements inside a SEQUENCE or SET. */
function children(parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = 0; offset < parent.value.length;) {
    const child = readTlv(parent.value, offset);
    out.push(child);
    offset += child.raw.length;
  }
  return out;
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]) => {
  const value = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const contextTag = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);
const nullValue = () => Buffer.from([0x05, 0x00]);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.from([0]), bytes);
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const booleanValue = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));

function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  // A leading 1 bit would make it negative.
  return tlv(0x02, (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

const OID = {
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

function name(subject: { commonName: string; organization?: string }): Buffer {
  const rdn = (type: string, value: string) => set(sequence(oid(type), utf8(value)));
  return sequence(
    ...(subject.organization !== undefined && subject.organization !== ''
      ? [rdn(OID.organizationName, subject.organization)]
      : []),
    rdn(OID.commonName, subject.commonName),
  );
}

/** The signature algorithm for a key, and how to sign with it. */
function algorithmFor(key: KeyObject): { identifier: Buffer; dsaEncoding?: 'der' } {
  if (key.asymmetricKeyType === 'rsa') {
    return { identifier: sequence(oid(OID.sha256WithRSAEncryption), nullValue()) };
  }
  if (key.asymmetricKeyType === 'ec') {
    return { identifier: sequence(oid(OID.ecdsaWithSHA256)), dsaEncoding: 'der' };
  }
  throw new Error(`unsupported key type ${String(key.asymmetricKeyType)}`);
}

function signWith(key: KeyObject, data: Buffer): Buffer {
  const { dsaEncoding } = algorithmFor(key);
  return sign('sha256', data, dsaEncoding === undefined ? key : { key, dsaEncoding });
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

// ---- Certificates --------------------------------------------------------------

/** Every certificate in a PEM text, in order; empty when there is none or one does not parse. */
export function parseCertificates(text: string): X509Certificate[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    return [];
  }
}

/** The TBSCertificate's fields: version (optional), serial, algorithm, issuer, validity, subject, key. */
function tbsFields(certificate: X509Certificate): Tlv[] {
  const tbs = children(readTlv(certificate.raw))[0];
  if (tbs === undefined) throw new Error('not a certificate');
  const fields = children(tbs);
  return fields[0]?.tag === 0xa0 ? fields.slice(1) : fields;
}

/** The value of the subjectPublicKey BIT STRING, without its unused-bits byte. */
function publicKeyBits(certificate: X509Certificate): Buffer {
  const spki = tbsFields(certificate)[5];
  const bits = spki === undefined ? undefined : children(spki)[1];
  if (bits === undefined) throw new Error('no subject public key');
  return bits.value.subarray(1);
}

/** Whether `issuer` signed `certificate`. */
function issued(issuer: X509Certificate, certificate: X509Certificate): boolean {
  return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
}

/**
 * The CertificateHashData of a certificate (SHA256, as in RFC 6960): the hash
 * of its issuer's DER name, the hash of the issuer's public key (the issuer is
 * looked up in `others`; a certificate without its issuer at hand is hashed
 * with its own key), and the serial number in hex without leading zeros.
 */
export function hashDataOf(
  certificate: X509Certificate,
  others: readonly X509Certificate[] = [],
): CertificateHashData {
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const issuerName = tbsFields(certificate)[2];
  if (issuerName === undefined) throw new Error('no issuer');
  const issuer = [certificate, ...others].find((candidate) => issued(candidate, certificate));
  return {
    hashAlgorithm: 'SHA256',
    issuerNameHash: sha256(issuerName.raw),
    issuerKeyHash: sha256(publicKeyBits(issuer ?? certificate)),
    serialNumber: certificate.serialNumber.replace(/^0+(?=.)/, '').toUpperCase(),
  };
}

/**
 * Whether `chain` (leaf first, then intermediates) is valid at `now` and leads
 * to one of `roots`, every link signed by the next and every certificate in
 * its validity period.
 */
export function verifyChain(
  chain: readonly X509Certificate[],
  roots: readonly X509Certificate[],
  now: number,
): boolean {
  const valid = (c: X509Certificate) =>
    Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
  let current = chain[0];
  const pool = [...chain.slice(1)];
  for (let depth = 0; current !== undefined && depth < 10; depth++) {
    if (!valid(current)) return false;
    const leaf = current;
    const root = roots.find((r) => issued(r, leaf));
    if (root !== undefined) return valid(root);
    // A root presented as the chain's last element must itself be trusted.
    if (roots.some((r) => r.fingerprint256 === leaf.fingerprint256)) return true;
    const index = pool.findIndex((c) => issued(c, leaf));
    current = index < 0 ? undefined : pool.splice(index, 1)[0];
  }
  return false;
}

// ---- CSRs ------------------------------------------------------------------------

export interface Subject {
  commonName: string;
  organization?: string;
}

/** A PKCS #10 certificate signing request for `privateKey`'s public key. */
export function createCsr(subject: Subject, privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const info = sequence(integer(Buffer.from([0])), name(subject), spki, contextTag(0));
  return pem(
    'CERTIFICATE REQUEST',
    sequence(info, algorithmFor(privateKey).identifier, bitString(signWith(privateKey, info))),
  );
}

/** A CSR's subject name (DER) and public key, after checking its signature. */
function readCsr(csrPem: string): { subject: Buffer; publicKey: KeyObject } {
  const body = csrPem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----|\s+/g, '');
  const [info, , signature] = children(readTlv(Buffer.from(body, 'base64')));
  if (info === undefined || signature === undefined) throw new Error('not a CSR');
  const [, subject, spki] = children(info);
  if (subject === undefined || spki === undefined) throw new Error('not a CSR');
  const publicKey = createPublicKey({ key: spki.raw, format: 'der', type: 'spki' });
  const signatureBytes = signature.value.subarray(1);
  const ok =
    publicKey.asymmetricKeyType === 'ec'
      ? verify('sha256', info.raw, { key: publicKey, dsaEncoding: 'der' }, signatureBytes)
      : verify('sha256', info.raw, publicKey, signatureBytes);
  if (!ok) throw new Error('the CSR signature does not verify');
  return { subject: subject.raw, publicKey };
}

/**
 * Signs a CSR as a client certificate (the built-in CSMS's CA): the CSR's
 * subject and key, the CA as issuer, a random serial number, valid from a
 * minute ago for `days`.
 */
export function signCsr(
  csrPem: string,
  ca: { certificate: string; key: string },
  options: { days?: number; now?: number } = {},
): string {
  const { subject, publicKey } = readCsr(csrPem);
  const caCertificate = new X509Certificate(ca.certificate);
  const caKey = createPrivateKey(ca.key);
  const issuer = tbsFields(caCertificate)[4];
  if (issuer === undefined) throw new Error('the CA certificate has no subject');
  const now = options.now ?? Date.now();
  const extension = (id: string, critical: boolean, value: Buffer) =>
    sequence(oid(id), ...(critical ? [booleanValue(true)] : []), octetString(value));
  const tbs = sequence(
    contextTag(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    algorithmFor(caKey).identifier,
    issuer.raw,
    sequence(
      time(new Date(now - 60_000)),
      time(new Date(now + (options.days ?? 365) * 86_400_000)),
    ),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    contextTag(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature and keyEncipherment.
        extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x05, 0xa0]))),
        extension(OID.extKeyUsage, false, sequence(oid(OID.clientAuth))),
      ),
    ),
  );
  return pem(
    'CERTIFICATE',
    sequence(tbs, algorithmFor(caKey).identifier, bitString(signWith(caKey, tbs))),
  );
}

/** Whether a firmware image's signature (base64) verifies with the certificate's key (SHA256). */
export function verifySignature(
  data: Uint8Array,
  signature: string,
  certificatePem: string,
): boolean {
  const [certificate] = parseCertificates(certificatePem);
  if (certificate === undefined) return false;
  const key = certificate.publicKey;
  const bytes = Buffer.from(signature, 'base64');
  try {
    if (key.asymmetricKeyType === 'ec') {
      return verify('sha256', data, { key, dsaEncoding: 'der' }, bytes);
    }
    // RSA-PSS is what the whitepaper asks for (L01.FR.04); PKCS #1 v1.5 is common too.
    return (
      verify('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING }, bytes) ||
      verify('sha256', data, key, bytes)
    );
  } catch {
    return false;
  }
}

// ---- The charge point's tools -------------------------------------------------------

/** CertificateTools for the charge point, backed by node:crypto. */
export function createCertificateTools(): CertificateTools {
  return {
    inspect(text, others = []) {
      const [certificate] = parseCertificates(text);
      if (certificate === undefined) return undefined;
      const pool = others.flatMap(parseCertificates);
      return {
        hashData: hashDataOf(certificate, pool),
        validFrom: Date.parse(certificate.validFrom),
        validTo: Date.parse(certificate.validTo),
      };
    },
    verifyChain(chainText, roots, now) {
      const chain = parseCertificates(chainText);
      return chain.length > 0 && verifyChain(chain, roots.flatMap(parseCertificates), now);
    },
    createCsr(subject) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return {
        csr: createCsr(subject, privateKey),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      };
    },
    matchesKey(certificateText, privateKeyPem) {
      const [certificate] = parseCertificates(certificateText);
      if (certificate === undefined) return false;
      try {
        const fromKey = createPublicKey(createPrivateKey(privateKeyPem)).export({
          type: 'spki',
          format: 'der',
        });
        return fromKey.equals(certificate.publicKey.export({ type: 'spki', format: 'der' }));
      } catch {
        return false;
      }
    },
    verifySignature,
  };
}
