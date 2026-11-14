/**
 * Serves the built Web UI (apps/web/dist) from the engine, so a single
 * process hosts both the API and the UI.
 */
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Answers GET requests for files under `root`; unknown paths get index.html
 * so client-side routes work. Answers false when it did not handle the request.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const base = resolve(root);
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const candidate = resolve(join(base, normalize(pathname)));
  if (candidate !== base && !candidate.startsWith(base + sep)) return false;

  for (const path of [candidate, join(base, 'index.html')]) {
    try {
      const info = await stat(path);
      const file = info.isDirectory() ? join(path, 'index.html') : path;
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}
