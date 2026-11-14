import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpFileTransfer, uploadUrl } from './file-transfer.js';

interface Received {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

async function listen(
  status: (req: IncomingMessage) => number,
): Promise<{ base: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      res.statusCode = status(req);
      res.end('firmware bytes');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, received };
}

describe('HTTP file transfer', () => {
  it('downloads with GET, turning URL credentials into Basic Auth', async () => {
    const { base, received } = await listen((req) => (req.url === '/fw-2.6.0.bin' ? 200 : 404));
    const transfer = createHttpFileTransfer();
    const withUser = base.replace('http://', 'http://ops:s%3Acret@');
    expect(await transfer.download(`${withUser}/fw-2.6.0.bin`)).toBe(true);
    expect(await transfer.download(`${base}/missing.bin`)).toBe(false);
    expect(received.map((r) => [r.method, r.url])).toEqual([
      ['GET', '/fw-2.6.0.bin'],
      ['GET', '/missing.bin'],
    ]);
    expect(received[0]?.authorization).toBe(
      `Basic ${Buffer.from('ops:s:cret').toString('base64')}`,
    );
    expect(received[1]?.authorization).toBeUndefined();
  });

  it('uploads with PUT into the location directory, and fails on errors or no server', async () => {
    const { base, received } = await listen((req) => (req.method === 'PUT' ? 201 : 405));
    const transfer = createHttpFileTransfer({ timeoutMs: 2000 });
    expect(await transfer.upload(`${base}/logs`, 'diagnostics-1.log', 'hello\n')).toBe(true);
    expect(received).toEqual([
      { method: 'PUT', url: '/logs/diagnostics-1.log', authorization: undefined, body: 'hello\n' },
    ]);
    expect(await transfer.upload('http://127.0.0.1:1/logs/', 'x.log', '')).toBe(false);
    expect(await transfer.download('not a url')).toBe(false);
    expect(uploadUrl('ftp://h/dir/', 'a b.log')).toBe('ftp://h/dir/a%20b.log');
  });
});
