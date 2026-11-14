/**
 * Scenario runner: executes one validated scenario on a fresh embedded
 * engine (and the built-in CSMS when the scenario uses it), step by step,
 * and reports a result per step. Everything is torn down afterwards, also
 * after failures and timeouts.
 */
import {
  DEFAULT_SCENARIO_TIMEOUT_MS,
  DEFAULT_WITHIN_MS,
  formatDuration,
  maskSecrets,
  matchValue,
  readPath,
  renderTemplates,
  stepLabel,
  TemplateError,
  variableProblems,
  type JsonObject,
  type Mismatch,
  type Scenario,
  type ScenarioStep,
} from '@ocpp-mimic/core';
import { createEngine, type Engine } from '../engine.js';
import { resolveEv } from '../evs.js';
import { DEFAULT_ALLOWED_CSMS, type VirtualStation } from '../fleet.js';
import type { FrameRecord } from '../recorder.js';
import {
  startBuiltinCsms,
  type BuiltinCsms,
  type BuiltinCsmsOptions,
} from '../csms/builtin-csms.js';
import { testPki } from '../test-pki.js';
import type { BackoffPolicy } from '../transport.js';

export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface StepResult {
  index: number;
  label: string;
  status: StepStatus;
  durationMs: number;
  /** Why the step failed. */
  message?: string;
  /** Expected versus actual values, closest candidates and the like. */
  details?: string[];
}

export type ScenarioStatus = 'passed' | 'failed' | 'error';

export interface ScenarioRunResult {
  name: string;
  /** `file#n` of the scenario. */
  label: string;
  status: ScenarioStatus;
  durationMs: number;
  steps: StepResult[];
  /** For `error`: what went wrong outside the steps (setup, timeout, invalid input). */
  error?: string;
  /** Facts for reports, such as persona and CSMS. */
  properties: Record<string, string>;
}

export interface RunOptions {
  /** Overrides the scenario's `csms`. */
  csms?: string;
  /** `--var` values; they override the scenario's `vars`. */
  vars?: Readonly<Record<string, string>>;
  /** Environment for `{{env.NAME}}`. Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Timeout for scenarios without their own. Default 5 minutes. */
  defaultTimeoutMs?: number;
  /** How long setup waits for each station's BootNotification to be accepted. Default 30 s. */
  bootTimeoutMs?: number;
  personaDirs?: readonly string[];
  /** CSMS URL prefixes allowed besides this machine. */
  allowCsms?: readonly string[];
  backoff?: Partial<BackoffPolicy>;
  /** Called after each step, for live output. */
  onStep?: (result: StepResult, scenario: Scenario) => void;
}

/** A step failure with details for the report. */
class StepFailure extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** Every frame of the run, with a way to wait for the next one. */
class FrameLog {
  readonly frames: FrameRecord[] = [];
  private readonly waiters = new Set<() => void>();

  push(frame: FrameRecord): void {
    this.frames.push(frame);
    for (const wake of [...this.waiters]) wake();
  }

  get lastSeq(): number {
    return this.frames.at(-1)?.seq ?? 0;
  }

  /** Resolves when a frame arrives or at `deadline` (ms since the epoch). */
  waitForFrame(deadline: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      this.waiters.add(done);
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describeMismatches = (mismatches: Mismatch[]) =>
  mismatches.map((m) => `${m.path}: ${m.message}`);
const time = (iso: string) => iso.slice(11, 23);

/** The built-in CSMS for a scenario: its `csmsOptions`, TLS with the test PKI. */
function builtinCsmsOptions(scenario: Scenario): BuiltinCsmsOptions {
  const { tls, passwords } = scenario.csmsOptions ?? {};
  return {
    port: 0,
    // The test CA signs CSRs, so certificate renewal works against the built-in CSMS.
    certificateAuthority: { certificate: testPki('ca.crt'), key: testPki('ca.key') },
    ...(passwords !== undefined && { passwords }),
    ...(tls !== undefined && {
      tls: {
        cert: testPki('server.crt'),
        key: testPki('server.key'),
        ca: testPki('ca.crt'),
        clientCertificates: tls.clientCertificates,
      },
    }),
  };
}

/** Runs one scenario. Never throws: problems end up in the result. */
export async function runScenario(
  scenario: Scenario,
  label: string,
  options: RunOptions = {},
): Promise<ScenarioRunResult> {
  const started = Date.now();
  const csmsTarget = options.csms ?? scenario.csms;
  const builtin = csmsTarget === 'builtin';
  const properties: Record<string, string> = {
    persona: [...new Set(scenario.stations.map((s) => s.persona))].join(', '),
    csms: csmsTarget,
  };
  // Reports must show when energy runs faster than real time.
  const multiplied = scenario.stations.filter((s) => (s.energyMultiplier ?? 1) !== 1);
  if (multiplied.length > 0) {
    properties.energyMultiplier = multiplied
      .map((s) =>
        scenario.stations.length > 1 ? `${s.id} ×${s.energyMultiplier}` : `×${s.energyMultiplier}`,
      )
      .join(', ');
  }
  const steps: StepResult[] = scenario.steps.map((step, index) => ({
    index,
    label: stepLabel(step),
    status: 'skipped',
    durationMs: 0,
  }));
  const secrets = new Set<string>();
  const result = (status: ScenarioStatus, error?: string): ScenarioRunResult => {
    const mask = (text: string) => maskSecrets(text, [...secrets]);
    return {
      name: scenario.name,
      label,
      status,
      durationMs: Date.now() - started,
      steps: steps.map((s) => ({
        ...s,
        ...(s.message !== undefined && { message: mask(s.message) }),
        ...(s.details !== undefined && { details: s.details.map(mask) }),
      })),
      ...(error !== undefined && { error: mask(error) }),
      properties,
    };
  };

  // Problems that need no engine.
  const unknown = variableProblems(scenario, Object.keys(options.vars ?? {}));
  if (unknown.length > 0) return result('error', unknown.join('\n'));
  if (!builtin && scenario.steps.some((s) => s.kind === 'csmsCall' || s.kind === 'csmsReply')) {
    return result('error', `built-in CSMS steps cannot run against ${csmsTarget}`);
  }

  const timeoutMs = scenario.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  const log = new FrameLog();
  const vars: Record<string, unknown> = { ...scenario.vars, ...options.vars };
  const env = options.env ?? process.env;
  /** Per station: seq of the frame the last `expect` matched. */
  const cursors = new Map<string, number>();
  let engine: Engine | undefined;
  let csms: BuiltinCsms | undefined;
  let aborted = false;

  const timeLeft = () => deadline - Date.now();

  try {
    // ---- Setup ----
    if (builtin) csms = await startBuiltinCsms(builtinCsmsOptions(scenario));
    engine = createEngine({
      port: 0,
      allowedCsms: [...DEFAULT_ALLOWED_CSMS, ...(options.allowCsms ?? [])],
      ...(options.personaDirs !== undefined && { personaDirs: options.personaDirs }),
      ...(options.backoff !== undefined && { backoff: options.backoff }),
    });
    engine.recorder.subscribe((entry) => {
      if (entry.kind === 'frame') log.push(entry);
    });
    await engine.start();
    const fleet = engine.fleet;
    if (fleet === undefined) throw new Error('the engine did not start');
    const csmsUrl = csms?.url ?? csmsTarget;
    for (const definition of scenario.stations) {
      const station = fleet.add({
        id: definition.id,
        persona: definition.persona,
        csmsUrl,
        ...(definition.password !== undefined && { password: definition.password }),
        ...(definition.security !== undefined && { security: definition.security }),
        ...(definition.config !== undefined && { config: definition.config }),
        ...(definition.energyMultiplier !== undefined && {
          energyMultiplier: definition.energyMultiplier,
        }),
      });
      if (definition.behaviour !== undefined)
        station.chargePoint.setBehaviour(definition.behaviour);
    }
    const bootTimeout = Math.min(options.bootTimeoutMs ?? 30_000, timeLeft());
    for (const definition of scenario.stations.filter((s) => s.waitForBoot)) {
      const station = fleet.get(definition.id);
      const bootDeadline = Date.now() + bootTimeout;
      while (station?.snapshot().registration !== 'Accepted') {
        if (Date.now() > bootDeadline) {
          throw new Error(
            `station ${definition.id} was not accepted by the CSMS within ${formatDuration(bootTimeout)} (registration ${station?.snapshot().registration ?? 'unknown'}, connection ${station?.snapshot().transport ?? 'unknown'})`,
          );
        }
        await sleep(50);
      }
    }

    const stationOf = (id: string | undefined): VirtualStation => {
      const station = fleet.get(id ?? scenario.stations[0]?.id ?? '');
      if (station === undefined) throw new StepFailure(`no station ${String(id)}`);
      return station;
    };
    /** A connector's snapshot; connector 0 is the whole charge point (status, errorCode). */
    const connectorOf = (station: VirtualStation, connectorId: number) => {
      const snapshot = station.snapshot();
      if (connectorId === 0)
        return { connectorId: 0, ...snapshot.station, transactionId: undefined };
      const found = snapshot.connectors.find((c) => c.connectorId === connectorId);
      if (found === undefined) {
        throw new StepFailure(`station ${station.id} has no connector ${connectorId}`);
      }
      return found;
    };
    const save = (map: Record<string, string> | undefined, root: unknown) => {
      for (const [name, path] of Object.entries(map ?? {})) {
        const value = readPath(root, path);
        if (value === undefined) throw new StepFailure(`nothing at ${path} to save as ${name}`);
        vars[name] = value;
      }
    };

    // ---- Steps ----
    const runStep = async (step: ScenarioStep, stepStartSeq: number): Promise<void> => {
      const station =
        step.kind === 'wait' || step.kind === 'http' ? undefined : stationOf(step.station);
      const refusal = async (act: () => void | string | Promise<void | string>) => {
        let refused: string | undefined;
        try {
          const outcome = await act();
          if (typeof outcome === 'string') refused = outcome;
        } catch (error) {
          if (error instanceof StepFailure) throw error;
          refused = error instanceof Error ? error.message : String(error);
        }
        const expected = 'expectError' in step ? step.expectError : undefined;
        if (expected === undefined) {
          if (refused !== undefined) throw new StepFailure(`refused: ${refused}`);
          return;
        }
        if (refused === undefined)
          throw new StepFailure(
            `expected a refusal containing "${expected}", but the action went through`,
          );
        if (!refused.includes(expected)) {
          throw new StepFailure(`refused with "${refused}", which does not contain "${expected}"`);
        }
      };

      switch (step.kind) {
        case 'plugIn': {
          const target = station!;
          connectorOf(target, step.connector);
          return refusal(() =>
            target.chargePoint.plugIn(step.connector, resolveEv(target, step.ev)),
          );
        }
        case 'unplug': {
          const target = station!;
          connectorOf(target, step.connector);
          return refusal(() =>
            target.chargePoint.unplug(step.connector) === 'locked'
              ? `connector ${step.connector} is locked`
              : undefined,
          );
        }
        case 'presentCard': {
          const target = station!;
          connectorOf(target, step.connector);
          return refusal(async () => {
            const outcome = await target.chargePoint.presentIdTag(step.connector, step.idTag);
            if (step.result !== undefined && outcome !== step.result) {
              throw new StepFailure(`the card was ${outcome}, expected ${step.result}`);
            }
          });
        }
        case 'evSuspend':
        case 'evResume':
        case 'clearFault': {
          const target = station!;
          connectorOf(target, step.connector);
          return refusal(() => {
            if (step.kind === 'evSuspend') target.chargePoint.evSuspend(step.connector);
            else if (step.kind === 'evResume') target.chargePoint.evResume(step.connector);
            else target.chargePoint.clearFault(step.connector);
          });
        }
        case 'fault': {
          const target = station!;
          if (step.connector !== 0) connectorOf(target, step.connector);
          return refusal(() =>
            target.chargePoint.raiseFault(step.connector, {
              errorCode: step.errorCode,
              ...(step.info !== undefined && { info: step.info }),
              ...(step.vendorErrorCode !== undefined && { vendorErrorCode: step.vendorErrorCode }),
            }),
          );
        }
        case 'offline':
          return refusal(() => station!.transport.goOffline(step.mode));
        case 'online':
          return refusal(() => station!.transport.goOnline());
        case 'stopStation':
          return refusal(() => fleet.stop(station!.id));
        case 'startStation':
          return refusal(() => fleet.start(station!.id));
        case 'setBehaviour':
          return refusal(() => station!.chargePoint.setBehaviour(step.behaviour));
        case 'wait':
          await sleepUnlessAborted(step.durationMs);
          return;
        case 'charge': {
          const target = station!;
          const running = () => connectorOf(target, step.connector).transactionId !== undefined;
          if (!running())
            throw new StepFailure(`connector ${step.connector} has no running transaction`);
          await sleepUnlessAborted(step.durationMs);
          if (!running()) {
            throw new StepFailure(
              `the transaction on connector ${step.connector} ended during the charge`,
            );
          }
          return;
        }
        case 'expect':
          return expectMessage(step, station!, stepStartSeq);
        case 'expectNo':
          return expectNoMessage(step, station!, stepStartSeq);
        case 'expectConnector':
        case 'expectStation': {
          const target = station!;
          const read = (): unknown =>
            step.kind === 'expectConnector'
              ? connectorOf(target, step.connector)
              : target.snapshot();
          const until = Date.now() + step.withinMs;
          let mismatches: Mismatch[];
          for (;;) {
            const snapshot = read();
            mismatches = matchValue(step.match, snapshot);
            if (mismatches.length === 0) {
              save(step.save, snapshot);
              return;
            }
            if (Date.now() >= until || aborted) break;
            await sleep(50);
          }
          throw new StepFailure(
            `${step.kind === 'expectConnector' ? `connector ${step.connector}` : `station ${target.id}`} did not match within ${formatDuration(step.withinMs)}`,
            describeMismatches(mismatches),
          );
        }
        case 'csmsCall': {
          if (csms === undefined) throw new StepFailure('needs the built-in CSMS');
          const connection = await csms.waitForConnection(station!.id, DEFAULT_WITHIN_MS);
          const answer = await connection.call(
            step.action,
            step.payload as JsonObject,
            DEFAULT_WITHIN_MS,
          );
          if (step.error !== undefined) {
            if (answer.type !== 4)
              throw new StepFailure(`expected CALLERROR ${step.error}, got a CALLRESULT`, [
                JSON.stringify(answer),
              ]);
            if (answer.errorCode !== step.error) {
              throw new StepFailure(`expected CALLERROR ${step.error}, got ${answer.errorCode}`, [
                answer.errorDescription,
              ]);
            }
            return;
          }
          if (answer.type !== 3) {
            throw new StepFailure(
              answer.type === 4
                ? `the station answered CALLERROR ${answer.errorCode}`
                : 'unexpected answer',
              answer.type === 4 ? [answer.errorDescription] : [],
            );
          }
          if (step.answer !== undefined) {
            const mismatches = matchValue(step.answer, answer.payload, '$.answer');
            if (mismatches.length > 0)
              throw new StepFailure('the answer did not match', describeMismatches(mismatches));
          }
          save(step.save, { answer: answer.payload });
          return;
        }
        case 'csmsReply': {
          if (csms === undefined) throw new StepFailure('needs the built-in CSMS');
          const reply =
            'payload' in step.reply
              ? { payload: step.reply.payload as JsonObject }
              : 'error' in step.reply
                ? { error: step.reply.error }
                : { ignore: true as const };
          csms.setReply(station!.id, step.action, reply, step.times);
          return;
        }
        case 'http':
          return httpStep(step);
      }
    };

    async function httpStep(step: Extract<ScenarioStep, { kind: 'http' }>): Promise<void> {
      const headers: Record<string, string> = {
        ...(step.json !== undefined && { 'content-type': 'application/json' }),
        ...(step.basicAuth !== undefined && {
          authorization: `Basic ${Buffer.from(`${step.basicAuth.user}:${step.basicAuth.password}`).toString('base64')}`,
        }),
        ...step.headers,
      };
      let response: Response;
      try {
        response = await fetch(step.url, {
          method: step.method,
          headers,
          ...(step.json !== undefined && { body: JSON.stringify(step.json) }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(DEFAULT_WITHIN_MS, timeLeft()))),
        });
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.cause instanceof Error
              ? error.cause.message
              : error.message
            : String(error);
        throw new StepFailure(`${step.method} ${step.url} failed: ${reason}`);
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      const body = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      const expectedStatus = step.expect?.status;
      const statusOk =
        expectedStatus !== undefined ? response.status === expectedStatus : response.ok;
      if (!statusOk) {
        throw new StepFailure(
          `${step.method} ${step.url} answered ${response.status}, expected ${expectedStatus ?? 'a 2xx status'}`,
          body === '' ? [] : [`body: ${body}`],
        );
      }
      if (step.expect?.json !== undefined) {
        if (json === undefined) {
          throw new StepFailure('the response is not JSON', body === '' ? [] : [`body: ${body}`]);
        }
        const mismatches = matchValue(step.expect.json, json, '$.json');
        if (mismatches.length > 0) {
          throw new StepFailure('the response did not match', describeMismatches(mismatches));
        }
      }
      save(step.save, { status: response.status, json, text });
    }

    async function sleepUnlessAborted(ms: number): Promise<void> {
      const until = Date.now() + ms;
      while (!aborted && Date.now() < until) await sleep(Math.min(100, until - Date.now()));
    }

    const directionOf = (step: { direction: 'sent' | 'received' }) =>
      step.direction === 'sent' ? 'cp-to-csms' : 'csms-to-cp';
    const callsOf = (
      station: VirtualStation,
      step: { action: string; direction: 'sent' | 'received' },
      after: number,
    ) =>
      log.frames.filter(
        (f) =>
          f.stationId === station.id &&
          f.seq > after &&
          f.messageType === 2 &&
          f.direction === directionOf(step) &&
          f.action === step.action,
      );

    async function expectMessage(
      step: Extract<ScenarioStep, { kind: 'expect' }>,
      station: VirtualStation,
      stepStartSeq: number,
    ): Promise<void> {
      const after =
        step.from === 'start'
          ? 0
          : step.from === 'step'
            ? stepStartSeq
            : (cursors.get(station.id) ?? 0);
      const needAnswer =
        step.answer !== undefined ||
        Object.values(step.save ?? {}).some((p) => p.startsWith('$.answer'));
      const until = Date.now() + step.withinMs;
      let problems: string[];
      for (;;) {
        problems = [];
        for (const call of callsOf(station, step, after)) {
          const at = `${step.action} at ${time(call.at)}`;
          if (step.payload !== undefined) {
            const mismatches = matchValue(step.payload, call.payload, '$.payload');
            if (mismatches.length > 0) {
              problems.push(...describeMismatches(mismatches).map((m) => `${at}: ${m}`));
              continue;
            }
          }
          let answer: unknown;
          if (needAnswer) {
            const reply = log.frames.find(
              (f) =>
                f.stationId === station.id && f.uniqueId === call.uniqueId && f.messageType !== 2,
            );
            if (reply === undefined) {
              problems.push(`${at}: no answer yet`);
              continue;
            }
            if (reply.messageType === 4) {
              problems.push(`${at}: answered with CALLERROR ${JSON.stringify(reply.payload)}`);
              continue;
            }
            if (step.answer !== undefined) {
              const mismatches = matchValue(step.answer, reply.payload, '$.answer');
              if (mismatches.length > 0) {
                problems.push(...describeMismatches(mismatches).map((m) => `${at}: ${m}`));
                continue;
              }
            }
            answer = reply.payload;
          }
          cursors.set(station.id, call.seq);
          save(step.save, { payload: call.payload, answer });
          return;
        }
        if (Date.now() >= until || aborted) break;
        await log.waitForFrame(until);
      }
      const seen = [
        ...new Set(
          log.frames
            .filter(
              (f) =>
                f.stationId === station.id &&
                f.seq > after &&
                f.messageType === 2 &&
                f.direction === directionOf(step),
            )
            .map((f) => f.action ?? '?'),
        ),
      ];
      throw new StepFailure(
        `no matching ${step.action} ${step.direction} within ${formatDuration(step.withinMs)}`,
        problems.length > 0
          ? problems.slice(-6)
          : [
              `${step.direction} since the previous match: ${seen.length > 0 ? seen.join(', ') : 'nothing'}`,
            ],
      );
    }

    async function expectNoMessage(
      step: Extract<ScenarioStep, { kind: 'expectNo' }>,
      station: VirtualStation,
      stepStartSeq: number,
    ): Promise<void> {
      const until = Date.now() + step.withinMs;
      for (;;) {
        const match = callsOf(station, step, stepStartSeq).find(
          (call) =>
            step.payload === undefined || matchValue(step.payload, call.payload).length === 0,
        );
        if (match !== undefined) {
          throw new StepFailure(`${step.action} was ${step.direction} at ${time(match.at)}`, [
            JSON.stringify(match.payload),
          ]);
        }
        if (Date.now() >= until || aborted) return;
        await log.waitForFrame(until);
      }
    }

    let failed = false;
    for (const [index, raw] of scenario.steps.entries()) {
      const record = steps[index];
      if (record === undefined) break;
      const stepStarted = Date.now();
      const stepStartSeq = log.lastSeq;
      try {
        const { kind, name, ...args } = raw;
        const rendered = renderTemplates(args, { vars, env });
        rendered.secrets.forEach((s) => secrets.add(s));
        const step = {
          kind,
          ...(name !== undefined && { name }),
          ...rendered.value,
        } as ScenarioStep;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              aborted = true;
              reject(new StepFailure(`the scenario timed out after ${formatDuration(timeoutMs)}`));
            },
            Math.max(0, timeLeft()),
          );
        });
        try {
          await Promise.race([runStep(step, stepStartSeq), timeout]);
        } finally {
          clearTimeout(timer);
        }
        record.status = 'passed';
      } catch (error) {
        record.status = 'failed';
        if (error instanceof StepFailure) {
          record.message = error.message;
          if (error.details.length > 0) record.details = error.details;
        } else {
          record.message =
            error instanceof TemplateError || error instanceof Error
              ? error.message
              : String(error);
        }
        failed = true;
      }
      record.durationMs = Date.now() - stepStarted;
      options.onStep?.(record, scenario);
      if (failed) break;
    }
    if (aborted)
      return result('error', `the scenario timed out after ${formatDuration(timeoutMs)}`);

    if (scenario.checkSchemas) {
      const broken = log.frames.filter((f) => f.schemaErrors !== undefined);
      const check: StepResult = {
        index: steps.length,
        label: 'every frame passes the official OCA schemas',
        status: broken.length === 0 ? 'passed' : 'failed',
        durationMs: 0,
        ...(broken.length > 0 && {
          message: `${broken.length} frame${broken.length === 1 ? '' : 's'} broke the official OCA schemas`,
          details: broken
            .slice(0, 10)
            .map(
              (f) =>
                `${f.stationId} ${f.direction} ${f.action ?? '?'} (${f.messageType === 2 ? 'CALL' : 'CALLRESULT'}): ${(f.schemaErrors ?? []).join('; ')}`,
            ),
        }),
      };
      steps.push(check);
      options.onStep?.(check, scenario);
      if (broken.length > 0) failed = true;
    }
    return result(failed ? 'failed' : 'passed');
  } catch (error) {
    return result('error', error instanceof Error ? error.message : String(error));
  } finally {
    aborted = true;
    await engine?.stop().catch(() => {});
    await csms?.stop().catch(() => {});
  }
}
