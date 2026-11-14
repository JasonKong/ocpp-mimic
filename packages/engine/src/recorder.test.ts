import { describe, expect, it } from 'vitest';
import { createRecorder } from './recorder.js';

describe('recorder', () => {
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
});
