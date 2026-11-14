/**
 * Security events (Security Whitepaper, chapter 8): every event goes into
 * the security log; critical ones are also pushed to the CSMS with a
 * SecurityEventNotification, queued while offline (A04).
 */

/** The events the whitepaper lists, with whether each is critical. */
export const SECURITY_EVENTS = {
  FirmwareUpdated: true,
  FailedToAuthenticateAtCentralSystem: false,
  CentralSystemFailedToAuthenticate: false,
  SettingSystemTime: true,
  StartupOfTheDevice: true,
  ResetOrReboot: true,
  SecurityLogWasCleared: true,
  ReconfigurationOfSecurityParameters: false,
  MemoryExhaustion: true,
  InvalidMessages: false,
  AttemptedReplayAttacks: false,
  TamperDetectionActivated: true,
  InvalidFirmwareSignature: false,
  InvalidFirmwareSigningCertificate: true,
  InvalidCentralSystemCertificate: true,
  InvalidChargePointCertificate: true,
  InvalidTLSVersion: true,
  InvalidTLSCipherSuite: true,
  MaintenanceLoginAccepted: true,
  MaintenanceLoginFailed: true,
  DiscardedRenewedClientCertificate: true,
} as const;

export type SecurityEventType = keyof typeof SECURITY_EVENTS;

/** Whether an event is pushed to the CSMS; events the whitepaper does not list are. */
export function isCriticalSecurityEvent(type: string): boolean {
  return (SECURITY_EVENTS as Record<string, boolean>)[type] ?? true;
}

export interface SecurityLogEntry {
  type: string;
  /** ISO 8601. */
  timestamp: string;
  techInfo?: string;
}

/** The security log keeps this many entries, dropping the oldest (a rolling log). */
export const SECURITY_LOG_LENGTH = 500;

/** The security log as a text file, limited to the GetLog time window. */
export function securityLogContent(
  log: readonly SecurityLogEntry[],
  window: { oldestTimestamp?: string; latestTimestamp?: string },
): string {
  const oldest =
    window.oldestTimestamp === undefined ? -Infinity : Date.parse(window.oldestTimestamp);
  const latest =
    window.latestTimestamp === undefined ? Infinity : Date.parse(window.latestTimestamp);
  const lines = log
    .filter((entry) => {
      const at = Date.parse(entry.timestamp);
      return at >= oldest && at <= latest;
    })
    .map((entry) => [entry.timestamp, entry.type, entry.techInfo].filter(Boolean).join(' '));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
