/**
 * The committed test PKI (packages/engine/test-pki): a CA, a CSMS server
 * certificate for localhost / 127.0.0.1 and a charge point certificate, for
 * TLS tests and scenarios. TEST ONLY: the private keys are public.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_PKI_DIR = fileURLToPath(new URL('../test-pki/', import.meta.url));

/** Reads a file of the test PKI, e.g. `ca.crt`. */
export function testPki(file: string): string {
  return readFileSync(join(TEST_PKI_DIR, file), 'utf8');
}
