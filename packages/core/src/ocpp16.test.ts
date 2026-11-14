import { describe, expect, it } from 'vitest';
import { CHARGE_POINT_STATUSES, MessageTypeId, OCPP16_SUBPROTOCOL } from './ocpp16.js';

describe('OCPP 1.6J constants', () => {
  it('uses the ocpp1.6 subprotocol', () => {
    expect(OCPP16_SUBPROTOCOL).toBe('ocpp1.6');
  });

  it('numbers frames CALL=2, CALLRESULT=3, CALLERROR=4', () => {
    expect(MessageTypeId).toEqual({ Call: 2, CallResult: 3, CallError: 4 });
  });

  it('has the nine 1.6 connector statuses', () => {
    expect(CHARGE_POINT_STATUSES).toHaveLength(9);
  });
});
