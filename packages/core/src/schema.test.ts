import { describe, expect, it } from 'vitest';
import { array, dateTime, integer, object, oneOf, string, validate, type Infer } from './schema.js';

const Sample = object(
  { name: string({ maxLength: 5 }), count: integer({ minimum: 0 }) },
  { kind: oneOf(['a', 'b']), tags: array(string(), { minItems: 1 }), at: dateTime() },
);

describe('schema validation', () => {
  it('accepts a valid value and keeps it as is', () => {
    const value = { name: 'ok', count: 1, kind: 'a', tags: ['x'], at: '2026-11-14T10:00:00Z' };
    expect(validate(Sample, value)).toEqual({ ok: true, value });
  });

  it('reports a wrong type as TypeConstraintViolation', () => {
    const result = validate(Sample, { name: 'ok', count: 1.5 });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'TypeConstraintViolation',
      issues: [{ path: '$.count', message: 'expected integer, got number' }],
    });
  });

  it('reports a missing required property as OccurenceConstraintViolation', () => {
    expect(validate(Sample, { name: 'ok' })).toMatchObject({
      ok: false,
      errorCode: 'OccurenceConstraintViolation',
      issues: [{ path: '$.count' }],
    });
  });

  it('reports bad values as PropertyConstraintViolation', () => {
    const tooLong = validate(Sample, { name: 'toolong', count: 0 });
    const notInEnum = validate(Sample, { name: 'ok', count: 0, kind: 'c' });
    const negative = validate(Sample, { name: 'ok', count: -1 });
    const badDate = validate(Sample, { name: 'ok', count: 0, at: '2026-11-14 10:00' });
    for (const result of [tooLong, notInEnum, negative, badDate]) {
      expect(result).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
    }
  });

  it('reports unknown properties as FormationViolation', () => {
    expect(validate(Sample, { name: 'ok', count: 0, extra: true })).toMatchObject({
      ok: false,
      errorCode: 'FormationViolation',
      issues: [{ path: '$.extra' }],
    });
  });

  it('checks array items and their minimum count with indexed paths', () => {
    expect(validate(Sample, { name: 'ok', count: 0, tags: [] })).toMatchObject({
      ok: false,
      errorCode: 'OccurenceConstraintViolation',
    });
    expect(validate(Sample, { name: 'ok', count: 0, tags: ['x', 2] })).toMatchObject({
      ok: false,
      issues: [{ path: '$.tags[1]', errorCode: 'TypeConstraintViolation' }],
    });
  });

  it('collects every issue, the first one deciding the error code', () => {
    const result = validate(Sample, { name: 7, count: 'x', extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(['$.name', '$.count', '$.extra']);
      expect(result.errorCode).toBe('TypeConstraintViolation');
    }
  });

  it('rejects non-objects at the root', () => {
    expect(validate(Sample, [])).toMatchObject({ ok: false, errorCode: 'TypeConstraintViolation' });
  });

  it('derives the TypeScript type from the definition', () => {
    type SampleType = Infer<typeof Sample>;
    const value: SampleType = { name: 'a', count: 1, kind: 'b' };
    // @ts-expect-error count is required
    const missing: SampleType = { name: 'a' };
    // @ts-expect-error kind only allows 'a' or 'b'
    const wrongKind: SampleType = { name: 'a', count: 1, kind: 'c' };
    expect([value, missing, wrongKind]).toHaveLength(3);
  });
});
