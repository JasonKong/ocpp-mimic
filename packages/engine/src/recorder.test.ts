import { describe, expect, it } from 'vitest';
import { createRecorder } from './recorder.js';

describe('recorder', () => {
  it('keeps nothing with a limit of 0, but still tells listeners and matches answers', () => {
    const recorder = createRecorder({ limit: 0 });
    const seen: string[] = [];
    recorder.subscribe((entry) =>
      seen.push(entry.kind === 'frame' ? (entry.action ?? '?') : 'log'),
    );
    recorder.frame('A', 'cp-to-csms', '[2,"1","Heartbeat",{}]');
    recorder.frame('A', 'csms-to-cp', '[3,"1",{"currentTime":"2026-11-15T09:00:00Z"}]');
    recorder.log('A', 'hello');
    expect(seen).toEqual(['Heartbeat', 'Heartbeat', 'log']);
    expect(recorder.query('A')).toEqual([]);
  });

  it('matches responses to requests and keeps schema problems from the check', () => {
    const checked: string[] = [];
    const recorder = createRecorder({
      now: () => Date.parse('2026-11-14T10:00:00Z'),
      check: (action, kind, payload) => {
        checked.push(`${action} ${kind}`);
        return (payload as { bad?: boolean }).bad === true ? ['$.bad: not allowed'] : [];
      },
    });
    const call = recorder.frame('CP', 'cp-to-csms', '[2,"1","Heartbeat",{"bad":true}]');
    const result = recorder.frame('CP', 'csms-to-cp', '[3,"1",{"currentTime":"x"}]');
    const error = recorder.frame('CP', 'cp-to-csms', '[4,"2","NotImplemented","",{}]');
    const garbage = recorder.frame('CP', 'csms-to-cp', 'not json');

    expect(call).toMatchObject({ action: 'Heartbeat', schemaErrors: ['$.bad: not allowed'] });
    expect(result).toMatchObject({ action: 'Heartbeat', messageType: 3 });
    expect(result.schemaErrors).toBeUndefined();
    expect(error.schemaErrors).toBeUndefined();
    expect(garbage.schemaErrors).toBeUndefined();
    expect(checked).toEqual(['Heartbeat request', 'Heartbeat response']);
  });

  it('keeps fault injection marks and skips the schema check for injected frames', () => {
    const recorder = createRecorder({ check: () => ['$.injected: not allowed'] });
    const injected = recorder.frame('CP', 'cp-to-csms', '[2,"1","Heartbeat",{"injected":true}]', {
      injected: 'schemaViolation',
    });
    const dropped = recorder.frame('CP', 'cp-to-csms', '[2,"2","Heartbeat",{}]', {
      injected: 'drop',
      dropped: true,
    });
    expect(injected).toMatchObject({ action: 'Heartbeat', injected: 'schemaViolation' });
    expect(injected.schemaErrors).toBeUndefined();
    expect(dropped).toMatchObject({ injected: 'drop', dropped: true });
  });
  it('keeps the station version on its frames', () => {
    const recorder = createRecorder({ versionOf: (id) => (id === 'S2' ? '2.0.1' : undefined) });
    expect(recorder.frame('S2', 'cp-to-csms', '[2,"a","Heartbeat",{}]').ocpp).toBe('2.0.1');
    expect(recorder.frame('S1', 'cp-to-csms', '[2,"b","Heartbeat",{}]').ocpp).toBeUndefined();
  });

  it("records OCPP-J 2.1's SEND and CALLRESULTERROR on 2.1 stations only", () => {
    const checked: string[] = [];
    const recorder = createRecorder({
      versionOf: (id) => (id === 'V21' ? '2.1' : '2.0.1'),
      check: (action, kind) => {
        checked.push(`${action} ${kind}`);
        return [];
      },
    });
    recorder.frame('V21', 'csms-to-cp', '[2,"c1","ClearCache",{}]');
    recorder.frame('V21', 'cp-to-csms', '[3,"c1",{"status":"Maybe"}]');
    const resultError = recorder.frame(
      'V21',
      'csms-to-cp',
      '[5,"c1","PropertyConstraintViolation","",{}]',
    );
    const send = recorder.frame(
      'V21',
      'cp-to-csms',
      '[6,"s1","NotifyPeriodicEventStream",{"id":1}]',
    );
    expect(resultError).toMatchObject({
      messageType: 5,
      uniqueId: 'c1',
      action: 'ClearCache',
      payload: { errorCode: 'PropertyConstraintViolation' },
    });
    expect(send).toMatchObject({
      messageType: 6,
      uniqueId: 's1',
      action: 'NotifyPeriodicEventStream',
    });
    expect(checked).toEqual([
      'ClearCache request',
      'ClearCache response',
      'NotifyPeriodicEventStream request',
    ]);
    // On a 2.0.1 station the same text is an unknown message type.
    expect(
      recorder.frame('V201', 'cp-to-csms', '[6,"s1","NotifyPeriodicEventStream",{}]').messageType,
    ).toBeUndefined();
  });
});
