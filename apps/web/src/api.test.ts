import { describe, expect, it } from 'vitest';
import { tokenProtocol } from './api.js';

describe('API token', () => {
  it('encodes the token as the engine reads it: base64url of its UTF-8 bytes', () => {
    // Expected values from Python's base64.urlsafe_b64encode without padding.
    for (const [token, encoded] of [
      ['secret', 'c2VjcmV0'],
      ['ä-ö-ü?/+=', 'w6Qtw7Ytw7w_Lys9'],
      ['~~~?', 'fn5-Pw'],
    ]) {
      expect(tokenProtocol(token!)).toBe(`ocpp-mimic.token.${encoded}`);
    }
  });
});
