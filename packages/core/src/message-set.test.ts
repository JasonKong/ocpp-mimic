import { describe, expect, it } from 'vitest';
import {
  isOcpp2,
  MESSAGE_SETS,
  messageSetForSubprotocol,
  OCPP16_MESSAGE_SET,
  OCPP201_MESSAGE_SET,
  OCPP21_MESSAGE_SET,
  OCPP_VERSIONS,
} from './message-set.js';

describe('message sets', () => {
  it('exist for 1.6, 2.0.1 and 2.1, found by their subprotocol', () => {
    expect(OCPP_VERSIONS).toEqual(['1.6', '2.0.1', '2.1']);
    expect(Object.keys(MESSAGE_SETS)).toEqual(['1.6', '2.0.1', '2.1']);
    expect(messageSetForSubprotocol('ocpp1.6')).toBe(OCPP16_MESSAGE_SET);
    expect(messageSetForSubprotocol('ocpp2.0.1')).toBe(OCPP201_MESSAGE_SET);
    expect(messageSetForSubprotocol('ocpp2.1')).toBe(OCPP21_MESSAGE_SET);
    expect(messageSetForSubprotocol('ocpp2.0')).toBeUndefined();
  });

  it("give 2.1 the 91 actions, 2.0.1's error codes and OCPP-J 2.1's message types", () => {
    const set = OCPP21_MESSAGE_SET;
    expect(set.version).toBe('2.1');
    expect(set.isAction('SetDefaultTariff')).toBe(true);
    expect(OCPP201_MESSAGE_SET.isAction('SetDefaultTariff')).toBe(false);
    expect(new Set([...set.chargingStationActions, ...set.csmsActions]).size).toBe(91);
    expect(set.errorCodes).toEqual(OCPP201_MESSAGE_SET.errorCodes);
    expect(set.errorCode('FormationViolation')).toBe('FormatViolation');
    expect(set.ocppj21).toBe(true);
    expect(set.unconfirmedActions).toEqual(['NotifyPeriodicEventStream']);
    expect(OCPP201_MESSAGE_SET.ocppj21).toBe(false);
    expect(OCPP16_MESSAGE_SET.unconfirmedActions).toEqual([]);
  });

  it('tell 2.x versions from 1.6', () => {
    expect(OCPP_VERSIONS.filter(isOcpp2)).toEqual(['2.0.1', '2.1']);
  });
});
