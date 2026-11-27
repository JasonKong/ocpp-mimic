/**
 * `ocpp-mimic demo`: the built-in CSMS and the engine in one process, both
 * on 127.0.0.1, so the Web UI's Demo page has everything it needs, remote
 * starts and valet included.
 */
import { createEngine, startBuiltinCsms } from '@ocpp-mimic/engine';
import type { DemoCommand } from './command.js';

export interface RunningDemo {
  /** Where stations connect: ws://127.0.0.1:<csmsPort>/ocpp. */
  csmsUrl: string;
  /** The engine's API and Web UI. */
  engineUrl: string;
  /** The Demo page. */
  demoUrl: string;
  stop(): Promise<void>;
}

export async function startDemo(
  command: Omit<DemoCommand, 'kind' | 'host'> & { host?: string; webRoot?: string },
): Promise<RunningDemo> {
  // It keeps no frames, so a demo left running stays small.
  const csms = await startBuiltinCsms({
    port: command.csmsPort,
    host: '127.0.0.1',
    keepFrames: false,
  });
  // The CSMS stays on loopback: only the engine, in this process, talks to it.
  const engine = createEngine({
    port: command.port,
    host: command.host ?? '127.0.0.1',
    ...(command.apiToken !== undefined && { apiToken: command.apiToken }),
    ...(command.webRoot !== undefined && { webRoot: command.webRoot }),
  });
  let engineUrl: string;
  try {
    engineUrl = (await engine.start()).url;
  } catch (error) {
    await csms.stop();
    throw error;
  }
  return {
    csmsUrl: csms.url,
    engineUrl,
    demoUrl: `${engineUrl}/#/demo`,
    async stop() {
      await engine.stop();
      await csms.stop();
    },
  };
}

/** What `demo` prints once it runs. */
export function demoBanner(demo: RunningDemo, defaultCsmsUrl: string): string {
  return [
    `ocpp-mimic demo`,
    `  Demo page:  ${demo.demoUrl}`,
    `  CSMS:       ${demo.csmsUrl}`,
    ...(demo.csmsUrl === defaultCsmsUrl ? [] : [`  Set the page's CSMS field to ${demo.csmsUrl}.`]),
    'Ctrl-C stops both.',
  ].join('\n');
}
