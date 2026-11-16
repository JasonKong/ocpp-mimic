#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@ocpp-mimic/core';
import {
  API_TOKEN_ENV,
  createEngine,
  DEFAULT_ALLOWED_CSMS,
  exposedWithoutTokenWarning,
  otlpFromEnvironment,
} from '@ocpp-mimic/engine';
import { USAGE, parseCommand } from './command.js';
import { startCsmsCommand } from './csms.js';
import { runImportCommand } from './import.js';
import { runLoadCommand } from './load.js';
import { runReplayCommand } from './replay.js';
import { runCalibrateCommand } from './calibrate.js';
import { runCommand } from './run.js';

/** The Web UI build in this monorepo (apps/web/dist), when it has been built. */
const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));

const command = parseCommand(process.argv.slice(2));

/**
 * OTLP settings: the standard environment variables, with `--otlp-endpoint`
 * and `--otlp-header` taking the endpoint's and headers' place when given.
 */
function otlpOf(options: { otlpEndpoint?: string; otlpHeaders?: Record<string, string> }) {
  const env =
    options.otlpEndpoint === undefined
      ? process.env
      : {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: options.otlpEndpoint,
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
        };
  const otlp = otlpFromEnvironment(env);
  if (otlp === undefined) return {};
  return {
    otlp: {
      ...otlp,
      ...(options.otlpHeaders !== undefined && {
        headers: { ...otlp.headers, ...options.otlpHeaders },
      }),
    },
  };
}

/** The CSMS control API token `serve` uses for remote starts. */
const CSMS_API_TOKEN_ENV = 'OCPP_MIMIC_CSMS_API_TOKEN';

/** A token from the command line, else from the environment; nothing when neither is set. */
function tokenFromEnvironment(given: string | undefined, variable: string): { apiToken?: string } {
  const token = given ?? process.env[variable];
  return token === undefined || token === '' ? {} : { apiToken: token };
}

switch (command.kind) {
  case 'version':
    console.log(VERSION);
    break;
  case 'help':
    console.log(USAGE);
    break;
  case 'error':
    console.error(`${command.message}\n\n${USAGE}`);
    process.exitCode = 2;
    break;
  case 'run':
    process.exitCode = await runCommand(command);
    break;
  case 'import':
    process.exitCode = await runImportCommand(command);
    break;
  case 'calibrate':
    process.exitCode = await runCalibrateCommand(command);
    break;
  case 'replay':
    process.exitCode = await runReplayCommand(command);
    break;
  case 'load':
    process.exitCode = await runLoadCommand(
      {
        ...command,
        ...tokenFromEnvironment(command.apiToken, API_TOKEN_ENV),
        ...(existsSync(WEB_ROOT) && { webRoot: WEB_ROOT }),
      },
      undefined,
      otlpOf(command).otlp,
    );
    break;
  case 'csms': {
    let csms: Awaited<ReturnType<typeof startCsmsCommand>>;
    try {
      csms = await startCsmsCommand({
        ...command,
        ...tokenFromEnvironment(command.apiToken, API_TOKEN_ENV),
      });
    } catch (error) {
      console.error(`Could not start the CSMS: ${(error as Error).message}`);
      process.exit(1);
    }
    console.log(`ocpp-mimic CSMS listening on ${csms.url}/<chargeBoxId>`);
    const exposed = exposedWithoutTokenWarning(
      'The control API of the CSMS',
      command.host,
      command.apiToken ?? process.env[API_TOKEN_ENV],
    );
    if (exposed !== undefined) console.warn(exposed);
    console.log(
      `control API on ${csms.url.replace(/^ws/, 'http').replace(/\/ocpp$/, '')}/api (remote starts from the engine's Web UI)`,
    );
    const shutdown = () => {
      void csms
        .stop()
        .then((text) => console.log(text))
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    break;
  }
  case 'serve': {
    const { apiToken: csmsApiToken } = tokenFromEnvironment(
      command.csmsApiToken,
      CSMS_API_TOKEN_ENV,
    );
    const engine = createEngine({
      port: command.port,
      host: command.host,
      personaDirs: command.personas,
      allowedCsms: [...DEFAULT_ALLOWED_CSMS, ...command.allowCsms],
      ...(command.store !== undefined && { storePath: command.store }),
      ...(command.recordLimit !== undefined && { recordLimit: command.recordLimit }),
      ...(command.sessionsPerStation !== undefined && {
        sessionsPerStation: command.sessionsPerStation,
      }),
      ...otlpOf(command),
      ...(existsSync(WEB_ROOT) && { webRoot: WEB_ROOT }),
      ...tokenFromEnvironment(command.apiToken, API_TOKEN_ENV),
      ...(csmsApiToken !== undefined && { csmsApiToken }),
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
