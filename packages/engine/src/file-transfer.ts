/**
 * Real file transfers for UpdateFirmware, GetDiagnostics and GetLog: a
 * firmware download is an HTTP GET whose body is read and thrown away, an
 * upload is an HTTP PUT of the file to the URL the charge point worked out. Credentials in
 * the URL (http://user:pass@host/) become Basic Auth, since fetch refuses
 * URLs that carry them. Personas opt in with `firmware.transfer: real`.
 */
import type { FileTransfer } from '@ocpp-mimic/core';

export interface HttpFileTransferOptions {
  /** Gives up on a transfer after this long; 60 s by default. */
  timeoutMs?: number;
}

export function createHttpFileTransfer(options: HttpFileTransferOptions = {}): FileTransfer {
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function request(location: string, init: RequestInit): Promise<boolean> {
    try {
      const url = new URL(location);
      const headers = new Headers(init.headers);
      if (url.username !== '' || url.password !== '') {
        const user = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        headers.set(
          'authorization',
          `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
        );
        url.username = '';
        url.password = '';
      }
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    download: (location) => request(location, { method: 'GET' }),
    upload: (url, fileName, content) =>
      request(url, {
        method: 'PUT',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${fileName.replace(/["\\]/g, '_')}"`,
        },
        body: content,
      }),
  };
}
