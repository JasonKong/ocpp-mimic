/** The WebSocket subprotocol of OCPP 2.1 (Part 4, 3.1.2). */
export const OCPP21_SUBPROTOCOL = 'ocpp2.1';

/**
 * OCPP-J 2.1 message type numbers (Part 4, 4.1.3): 2.0.1's three plus
 * CALLRESULTERROR, an error answer to a CALLRESULT, and SEND, a message that
 * is never answered.
 */
export const OCPP21_MESSAGE_TYPES = {
  Call: 2,
  CallResult: 3,
  CallError: 4,
  CallResultError: 5,
  Send: 6,
} as const;

/**
 * IdToken types: in 2.1 `idToken.type` is a string of up to 20 characters, and
 * these are its predefined values (Part 2 appendix, IdTokenEnumStringType).
 * DirectPayment, EVCCID and VIN are new in 2.1.
 */
export const OCPP21_ID_TOKEN_TYPES = [
  'Central',
  'DirectPayment',
  'eMAID',
  'EVCCID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
  'VIN',
] as const;

/** Predefined connector types (Part 2 appendix, ConnectorEnumStringType); open in 2.1. */
export const OCPP21_CONNECTOR_TYPES = [
  'cCCS1',
  'cCCS2',
  'cChaoJi',
  'cG105',
  'cGBT-DC',
  'cLECCS',
  'cMCS',
  'cNACS',
  'cNACS-CCS1',
  'cCCS1-NACS',
  'cTesla',
  'cType1',
  'cType2',
  'cUltraChaoJi',
  's309-1P-16A',
  's309-1P-32A',
  's309-3P-16A',
  's309-3P-32A',
  'sBS1361',
  'sCEE-7-7',
  'sType1',
  'sType2',
  'sType3',
  'wInductive',
  'wResonant',
  'Other1PhMax16A',
  'Other1PhOver16A',
  'Other3Ph',
  'Pan',
  'Undetermined',
  'Unknown',
] as const;

/** Predefined charging limit sources (Part 2 appendix, ChargingLimitSourceEnumStringType); open in 2.1. */
export const OCPP21_CHARGING_LIMIT_SOURCES = ['EMS', 'Other', 'SO', 'CSO'] as const;
