import { describe, expect, it } from 'vitest';
import { sequentialIds } from './ids.js';
import { parseFrame, serializeFrame, type Frame } from './ocppj.js';

describe('parseFrame', () => {
  it('parses a CALL', () => {
    expect(parseFrame('[2,"abc","Heartbeat",{}]')).toEqual({
      ok: true,
      frame: { type: 2, id: 'abc', action: 'Heartbeat', payload: {} },
    });
  });

  it('parses a CALLRESULT', () => {
    expect(parseFrame('[3,"abc",{"currentTime":"2026-11-14T10:00:00Z"}]')).toEqual({
      ok: true,
      frame: { type: 3, id: 'abc', payload: { currentTime: '2026-11-14T10:00:00Z' } },
    });
  });

  it('parses a CALLERROR', () => {
    expect(parseFrame('[4,"abc","NotImplemented","no",{}]')).toEqual({
      ok: true,
      frame: {
        type: 4,
        id: 'abc',
        errorCode: 'NotImplemented',
        errorDescription: 'no',
        errorDetails: {},
      },
    });
  });

  it('rejects text that is not JSON or not an array, with nothing to answer', () => {
    expect(parseFrame('{nope')).toMatchObject({ ok: false, error: { reason: 'invalid-json' } });
    expect(parseFrame('{"a":1}')).toMatchObject({ ok: false, error: { reason: 'not-an-array' } });
    const result = parseFrame('{nope');
    expect(result.ok || result.error.replyWith).toBeUndefined();
  });

  it('reports an unknown message type id without asking for an answer', () => {
    const result = parseFrame('[5,"abc"]');
    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown-message-type' } });
    expect(result.ok || result.error.replyWith).toBeUndefined();
  });

  it('rejects missing, empty and over-long uniqueIds', () => {
    for (const text of [
      '[2,1,"Heartbeat",{}]',
      '[2,"","Heartbeat",{}]',
      `[2,"${'x'.repeat(37)}","Heartbeat",{}]`,
    ]) {
      expect(parseFrame(text)).toMatchObject({ ok: false, error: { reason: 'invalid-structure' } });
    }
  });

  it('answers a broken CALL with a readable uniqueId with FormationViolation', () => {
    for (const text of ['[2,"abc","Heartbeat"]', '[2,"abc","",{}]', '[2,"abc","Heartbeat",[]]']) {
      expect(parseFrame(text)).toMatchObject({
        ok: false,
        error: { reason: 'invalid-structure', id: 'abc', replyWith: 'FormationViolation' },
      });
    }
  });

  it('reports broken responses without asking for an answer', () => {
    for (const text of ['[3,"abc"]', '[3,"abc",1]', '[4,"abc","X","y"]', '[4,"abc",1,"y",{}]']) {
      const result = parseFrame(text);
      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'invalid-structure', id: 'abc' },
      });
      expect(result.ok || result.error.replyWith).toBeUndefined();
    }
  });
});

describe('serializeFrame', () => {
  it('writes each frame type as its OCPP-J array and parses back to the same frame', () => {
    const frames: Frame[] = [
      { type: 2, id: 'a', action: 'Heartbeat', payload: {} },
      { type: 3, id: 'b', payload: { status: 'Accepted' } },
      { type: 4, id: 'c', errorCode: 'GenericError', errorDescription: 'x', errorDetails: {} },
    ];
    expect(frames.map(serializeFrame)).toEqual([
      '[2,"a","Heartbeat",{}]',
      '[3,"b",{"status":"Accepted"}]',
      '[4,"c","GenericError","x",{}]',
    ]);
    for (const frame of frames) {
      expect(parseFrame(serializeFrame(frame))).toEqual({ ok: true, frame });
    }
  });
});

describe('sequentialIds', () => {
  it('produces predictable ids', () => {
    const next = sequentialIds('cp-');
    expect([next(), next(), next()]).toEqual(['cp-1', 'cp-2', 'cp-3']);
  });
});
