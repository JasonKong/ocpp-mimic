#!/usr/bin/env node
// Builds the publishable `ocpp-mimic` npm package from the workspace, after
// `pnpm build`: core, engine and cli bundled into dist/, with the Web UI,
// the built-in personas, the OCA schemas, the test PKI and the samples next to
// it, then `npm pack`s it. Usage: node tools/pack.mjs [--out <dir>]
//
// Layout of the package (the engine finds ../personas, ../oca-schemas and
// ../test-pki from dist/, as it does from packages/engine/dist/):
//   dist/ocpp-mimic.js (checks the Node.js version, then loads the rest)
//   personas/  oca-schemas/  test-pki/  web/  samples/
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rolldown } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out ?? join(root, 'release');
const stage = join(out, 'package');

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const engine = readJson('packages/engine/package.json');
const version = /VERSION = '([^']+)'/.exec(
  readFileSync(join(root, 'packages/core/src/version.ts'), 'utf8'),
)?.[1];
if (version === undefined) throw new Error('no VERSION in packages/core/src/version.ts');

for (const built of ['packages/cli/dist/bin.js', 'apps/web/dist/index.html']) {
  if (!existsSync(join(root, built))) throw new Error(`${built} is missing: run pnpm build first`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The workspace packages are bundled; npm dependencies and Node built-ins stay imports.
// The entry stays tiny and loads the rest with a dynamic import, so an old
// Node.js gets the version message instead of a failed import.
const bundle = await rolldown({
  input: { 'ocpp-mimic': join(root, 'packages/cli/dist/bin.js') },
  platform: 'node',
  external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@ocpp-mimic/'),
});
await bundle.write({
  dir: join(stage, 'dist'),
  format: 'esm',
  entryFileNames: '[name].js',
  chunkFileNames: '[name]-[hash].js',
});
await bundle.close();
const entry = join(stage, 'dist/ocpp-mimic.js');
const entryText = readFileSync(entry, 'utf8');
if (!entryText.startsWith('#!')) writeFileSync(entry, `#!/usr/bin/env node\n${entryText}`);

const copy = (from, to) => cpSync(join(root, from), join(stage, to), { recursive: true });
copy('packages/engine/personas', 'personas');
copy('packages/engine/oca-schemas', 'oca-schemas');
copy('packages/engine/test-pki', 'test-pki');
copy('apps/web/dist', 'web');
for (const sample of ['personas', 'examples', 'load', 'import', 'logs']) {
  copy(`scenarios/${sample}`, `samples/${sample}`);
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'README.md']) {
  copy(file, file);
}

const dependencies = Object.fromEntries(
  Object.entries(engine.dependencies).filter(([name]) => !name.startsWith('@ocpp-mimic/')),
);
const manifest = {
  name: 'ocpp-mimic',
  version,
  description:
    'OCPP 1.6J, 2.0.1 and 2.1 charge point simulator: Web UI, scenarios for CI, load tests',
  license: 'BUSL-1.1',
  type: 'module',
  bin: { 'ocpp-mimic': 'dist/ocpp-mimic.js' },
  engines: { node: '>=24' },
  dependencies,
  repository: { type: 'git', url: 'git+https://github.com/JasonKong/ocpp-mimic.git' },
  homepage: 'https://github.com/JasonKong/ocpp-mimic#readme',
  bugs: 'https://github.com/JasonKong/ocpp-mimic/issues',
  keywords: ['ocpp', 'ev-charging', 'charge-point', 'simulator', 'csms', 'load-testing'],
  files: ['dist', 'personas', 'oca-schemas', 'test-pki', 'web', 'samples'],
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packed = execFileSync('npm', ['pack', '--pack-destination', out, '--json'], {
  cwd: stage,
  encoding: 'utf8',
});
const [{ filename, size, entryCount }] = JSON.parse(packed);
console.log(`${join(out, filename)}: ${entryCount} files, ${(size / 1024).toFixed(0)} kB`);
