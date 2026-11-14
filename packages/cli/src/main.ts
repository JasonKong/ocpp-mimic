#!/usr/bin/env node
import { VERSION } from '@ocpp-mimic/core';
import { createEngine } from '@ocpp-mimic/engine';
import { USAGE, parseCommand } from './command.js';

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
    const engine = createEngine({ port: command.port, host: command.host });
    try {
      const { url } = await engine.start();
      console.log(`ocpp-mimic engine listening on ${url}`);
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
