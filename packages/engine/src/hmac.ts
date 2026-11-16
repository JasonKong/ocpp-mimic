/** HMAC-SHA256 from node:crypto, for core's web payment code (C25); core has no crypto. */
import { createHmac } from 'node:crypto';
import type { HmacSha256 } from '@ocpp-mimic/core';

export const hmacSha256: HmacSha256 = (key, message) =>
  new Uint8Array(createHmac('sha256', key).update(message).digest());
