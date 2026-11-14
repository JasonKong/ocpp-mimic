/**
 * Firmware Management helpers: how long the simulated steps take, how they
 * end, and the version a firmware file installs. The flows themselves live
 * in the charge point; real transfers are an injected FileTransfer.
 */

export type StepOutcome = 'succeed' | 'fail';

export interface FirmwareSettings {
  downloadMs: number;
  installMs: number;
  uploadMs: number;
  download: StepOutcome;
  install: StepOutcome;
  upload: StepOutcome;
}

export const DEFAULT_FIRMWARE_SETTINGS: FirmwareSettings = {
  downloadMs: 10_000,
  installMs: 10_000,
  uploadMs: 5_000,
  download: 'succeed',
  install: 'succeed',
  upload: 'succeed',
};

/**
 * Real file transfers, provided by the engine when a persona asks for them.
 * Each resolves to whether the transfer worked. `upload` puts `content` at
 * `url` exactly; `fileName` names the file in the request.
 */
export interface FileTransfer {
  download(location: string): Promise<boolean>;
  upload(url: string, fileName: string, content: string): Promise<boolean>;
}

/** GetDiagnostics: the location is a directory, so the file goes inside it. */
export function diagnosticsUploadUrl(location: string, fileName: string): string {
  return `${location.endsWith('/') ? location : `${location}/`}${encodeURIComponent(fileName)}`;
}

/**
 * GetLog: the file name is appended only when the location ends with a slash
 * (Security Whitepaper N01.FR.21); otherwise the location is the file's URL.
 */
export function logUploadUrl(remoteLocation: string, fileName: string): string {
  return remoteLocation.endsWith('/')
    ? `${remoteLocation}${encodeURIComponent(fileName)}`
    : remoteLocation;
}

/** True for the locations a FileTransfer handles: HTTP and HTTPS. */
export function isHttpLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/**
 * The firmware version a location installs: the version in its file name
 * (`fw-2.5.1.bin` → `2.5.1`), else the current version with `-updated`.
 */
export function firmwareVersionFrom(location: string, current: string | undefined): string {
  const file =
    location
      .split(/[/?#]/)
      .filter((part) => part !== '')
      .at(-1) ?? '';
  const match = /(\d+(?:\.\d+)+)/.exec(file);
  if (match?.[1] !== undefined) return match[1];
  return `${current ?? '0.0.0'}-updated`;
}

/** `diagnostics-20261114T100000Z.log` for the given moment. */
export function diagnosticsFileName(now: number, prefix = 'diagnostics'): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${prefix}-${stamp}.log`;
}
