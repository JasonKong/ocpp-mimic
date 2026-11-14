/**
 * The charge point's certificates (Security Whitepaper M03 to M05, A02,
 * L01): the CA certificates installed by the CSMS, and the charge point's own
 * certificate with its private key. Core keeps them; the X.509 work itself
 * (parsing, chains, CSRs, signatures) is an injected CertificateTools from the
 * engine, so core stays free of crypto code.
 */
import type { CertificateHashData } from './ocpp16-messages.js';

export type CertificateUse = 'CentralSystemRootCertificate' | 'ManufacturerRootCertificate';

/** A CA certificate in the charge point's trust store. */
export interface InstalledCertificate {
  certificateType: CertificateUse;
  /** PEM. */
  certificate: string;
  hashData: CertificateHashData;
}

/** The charge point's own certificate (PEM, leaf first) and its private key (PEM). */
export interface ChargePointCertificate {
  certificate: string;
  privateKey: string;
}

export interface CertificateInfo {
  hashData: CertificateHashData;
  /** Validity period, ms since the epoch. */
  validFrom: number;
  validTo: number;
}

/** X.509 operations the charge point needs, provided by the engine. */
export interface CertificateTools {
  /** The first certificate in `pem`, or undefined if it does not parse. `others` may hold its issuer. */
  inspect(pem: string, others?: readonly string[]): CertificateInfo | undefined;
  /** Whether `chain` (PEM, leaf first) is valid at `now` and leads to one of `roots` (PEM). */
  verifyChain(chain: string, roots: readonly string[], now: number): boolean;
  /** A new key pair and a CSR for it (both PEM); the private key never leaves the station. */
  createCsr(subject: { commonName: string; organization?: string }): {
    csr: string;
    privateKey: string;
  };
  /** Whether the certificate (PEM) holds the public key of `privateKey` (PEM). */
  matchesKey(certificate: string, privateKey: string): boolean;
  /** Whether `signature` (base64) over `data` verifies with the certificate's key. */
  verifySignature(data: Uint8Array, signature: string, certificate: string): boolean;
}

/** Whether two CertificateHashData name the same certificate (hex compared case-insensitively). */
export function sameCertificate(a: CertificateHashData, b: CertificateHashData): boolean {
  return (
    a.hashAlgorithm === b.hashAlgorithm &&
    a.issuerNameHash.toLowerCase() === b.issuerNameHash.toLowerCase() &&
    a.issuerKeyHash.toLowerCase() === b.issuerKeyHash.toLowerCase() &&
    a.serialNumber.replace(/^0+(?=.)/, '').toUpperCase() ===
      b.serialNumber.replace(/^0+(?=.)/, '').toUpperCase()
  );
}
