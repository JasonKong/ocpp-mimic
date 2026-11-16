/**
 * Where the CLI finds the files it ships besides code: the Web UI build and
 * the samples. In the npm package they sit next to dist/ (web/, samples/); in
 * this monorepo they are apps/web/dist and scenarios/.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packaged = (path: string) => fileURLToPath(new URL(`../${path}/`, import.meta.url));
const monorepo = (path: string) => fileURLToPath(new URL(`../../../${path}/`, import.meta.url));

/** The Web UI build: the package's web/, else apps/web/dist in the monorepo. */
export function webRoot(): string {
  const inPackage = packaged('web');
  return existsSync(inPackage) ? inPackage : monorepo('apps/web/dist');
}

/** The samples: the package's samples/, else scenarios/ in the monorepo. */
export function samplesRoot(): string {
  const inPackage = packaged('samples');
  return existsSync(inPackage) ? inPackage : monorepo('scenarios');
}
