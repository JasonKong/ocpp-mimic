#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@ocpp-mimic/core';
import { createEngine, DEFAULT_ALLOWED_CSMS } from '@ocpp-mimic/engine';
import { USAGE, parseCommand } from './command.js';

/** The Web UI build in this monorepo (apps/web/dist), when it has been built. */
const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));

const command = parseCommand(process.argv.slice(2));

switch (command.kind) {
  case 'version':
    console.log(VERSION);
    break;
  case 'help':
    console.log(USAGE);
    break;
  case 'error':
    console.error(`${command.message}\n\n${USAGE}`);
    process.exitCode = 1;
    break;
  case 'serve': {
    const engine = createEngine({
      port: command.port,
      host: command.host,
      personaDirs: command.personas,
      allowedCsms: [...DEFAULT_ALLOWED_CSMS, ...command.allowCsms],
      ...(command.store !== undefined && { storePath: command.store }),
      ...(existsSync(WEB_ROOT) && { webRoot: WEB_ROOT }),
    });
    try {
      const { url } = await engine.start();
      console.log(`ocpp-mimic engine listening on ${url}`);
      for (const problem of [
        ...(engine.personas?.errors ?? []),
        ...(engine.personas?.warnings ?? []),
      ]) {
        console.warn(`persona: ${problem}`);
      }
      if (!existsSync(WEB_ROOT))
        console.log('Web UI not built; run `pnpm build` to serve it here.');
    } catch (error) {
      console.error(`Could not start the engine: ${(error as Error).message}`);
      process.exit(1);
    }
    const shutdown = () => {
      void engine.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    break;
  }
}
