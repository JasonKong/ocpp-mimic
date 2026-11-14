/**
 * `ocpp-mimic csms`: the built-in test CSMS as its own process, for example
 * as the target of a load test. It keeps no frames, so memory stays flat over
 * a long run, and reports counters instead: a status line now and then, and a
 * summary when it stops.
 */
import { readFile } from 'node:fs/promises';
import { startBuiltinCsms, type BuiltinCsmsStats } from '@ocpp-mimic/engine';
import type { CsmsCommand } from './command.js';

export interface RunningCsms {
  /** Base URL; stations connect to `${url}/<chargeBoxId>`. */
  url: string;
  stats(): BuiltinCsmsStats;
  /** Stops the CSMS and returns the summary to print. */
  stop(): Promise<string>;
}

const totalCalls = (stats: BuiltinCsmsStats) =>
  Object.values(stats.callsReceived).reduce((sum, n) => sum + n, 0);

/** One line: connections and how many requests were answered. */
export function statusLine(stats: BuiltinCsmsStats): string {
  return (
    `${stats.connected} connected (${stats.opened} opened, ${stats.closed} closed, ` +
    `${stats.refused} refused); ${totalCalls(stats)} requests, ` +
    `${stats.results} answered, ${stats.errors} with CALLERROR`
  );
}

/** The status line, how long it ran, and requests by action, most frequent first. */
export function summary(stats: BuiltinCsmsStats, uptimeMs: number): string {
  const minutes = Math.floor(uptimeMs / 60_000);
  const seconds = Math.round((uptimeMs % 60_000) / 1000);
  const actions = Object.entries(stats.callsReceived).sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  const width = Math.max(0, ...actions.map(([action]) => action.length));
  return [
    `Ran ${minutes}m ${seconds}s. ${statusLine(stats)}`,
    ...actions.map(([action, n]) => `  ${action.padEnd(width)}  ${n}`),
  ].join('\n');
}

export async function startCsmsCommand(
  command: CsmsCommand,
  log: (line: string) => void = console.log,
): Promise<RunningCsms> {
  const tls =
    command.tls === undefined
      ? undefined
      : {
          cert: await readFile(command.tls.cert),
          key: await readFile(command.tls.key),
          ...(command.tls.ca !== undefined && { ca: await readFile(command.tls.ca) }),
          clientCertificates: command.tls.clientCertificates,
        };
  const csms = await startBuiltinCsms({
    port: command.port,
    host: command.host,
    keepFrames: false,
    heartbeatInterval: command.heartbeatInterval,
    unknownIdTagPrefix: command.unknownPrefix,
    ...(command.delay !== undefined && { responseDelay: command.delay }),
    ...(command.password !== undefined && { password: command.password }),
    ...(tls !== undefined && { tls }),
  });
  const started = Date.now();
  const timer =
    command.statusMs > 0
      ? setInterval(() => log(statusLine(csms.stats())), command.statusMs)
      : undefined;
  return {
    url: csms.url,
    stats: () => csms.stats(),
    async stop() {
      clearInterval(timer);
      const stats = csms.stats();
      await csms.stop();
      return summary(stats, Date.now() - started);
    },
  };
}
