/** `ocpp-mimic samples <dir>`: copies the sample files to read, edit and run. */
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { samplesRoot } from './paths.js';

/** The sample folders, in scenarios/ and in the package's samples/. */
export const SAMPLE_DIRS = ['personas', 'examples', 'templates', 'load', 'import', 'logs'] as const;

/** Copies the samples into `target`; files that already exist there are kept. */
export async function copySamples(target: string, root = samplesRoot()): Promise<string[]> {
  const copied: string[] = [];
  for (const dir of SAMPLE_DIRS) {
    await cp(join(root, dir), join(target, dir), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    copied.push(`${dir}/ (${(await readdir(join(root, dir))).length} files)`);
  }
  return copied;
}

export async function runSamplesCommand(
  target: string,
  out: (line: string) => void = console.log,
): Promise<number> {
  const copied = await copySamples(target);
  out(`Copied the samples into ${target}, keeping files that were already there:`);
  for (const line of copied) out(`  ${line}`);
  out('');
  out('Next, for example:');
  out(`  ocpp-mimic run ${join(target, 'examples')} --personas ${join(target, 'personas')}`);
  out(`  ocpp-mimic serve --personas ${join(target, 'personas')}`);
  return 0;
}
