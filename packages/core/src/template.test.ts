import { describe, expect, it } from 'vitest';
import { isJsonPath, matchValue, operatorProblems, readPath } from './match.js';
import { maskSecrets, renderTemplates, TemplateError, templateRefs } from './template.js';

const context = {
  vars: { TAG: 'TAG-001', tx: 101, on: true, obj: { a: 1 } },
  env: { TOKEN: 's3cret', EMPTY: '' },
};

describe('templates', () => {
  it('replaces variables in strings at any depth', () => {
    const { value, secrets } = renderTemplates(
      { idTag: '{{TAG}}', nested: [{ text: 'card {{ TAG }} on' }], n: 5 },
      context,
    );
    expect(value).toEqual({ idTag: 'TAG-001', nested: [{ text: 'card TAG-001 on' }], n: 5 });
    expect(secrets).toEqual([]);
  });

  it('keeps the type of a value that is exactly one template', () => {
    expect(
      renderTemplates({ a: '{{tx}}', b: '{{on}}', c: 'tx={{tx}}', d: '{{obj}}' }, context).value,
    ).toEqual({ a: 101, b: true, c: 'tx=101', d: { a: 1 } });
  });

  it('reads environment variables and reports them as secrets', () => {
    const rendered = renderTemplates('Bearer {{env.TOKEN}}', context);
    expect(rendered).toEqual({ value: 'Bearer s3cret', secrets: ['s3cret'] });
    expect(maskSecrets('auth: Bearer s3cret!', rendered.secrets)).toBe('auth: Bearer ***!');
    expect(renderTemplates('{{env.EMPTY}}', context).secrets).toEqual([]);
  });

  it('fails clearly for unknown names', () => {
    expect(() => renderTemplates('{{NOPE}}', context)).toThrow(
      new TemplateError('unknown variable NOPE'),
    );
    expect(() => renderTemplates('{{env.MISSING}}', context)).toThrow(
      'environment variable MISSING is not set',
    );
  });

  it('lists references and malformed templates', () => {
    expect(templateRefs({ a: '{{A}} {{env.B}}', b: ['{{env}}', '{{1x}}', '{{ C }}'] })).toEqual({
      refs: [
        { name: 'A', env: false },
        { name: 'B', env: true },
        { name: 'C', env: false },
      ],
      invalid: ['{{env}}', '{{1x}}'],
    });
  });
});

describe('matching', () => {
  it('matches the given fields only, arrays element by element', () => {
    const actual = { status: 'Charging', errorCode: 'NoError', list: [{ a: 1, b: 2 }] };
    expect(matchValue({ status: 'Charging' }, actual)).toEqual([]);
    expect(matchValue({ list: [{ a: 1 }] }, actual)).toEqual([]);
    expect(matchValue({ status: 'Available', missing: 1 }, actual)).toEqual([
      { path: '$.status', message: 'expected "Available", found "Charging"' },
      { path: '$.missing', message: 'expected 1, found nothing' },
    ]);
    expect(matchValue({ list: [] }, actual)).toEqual([
      { path: '$.list', message: 'expected 0 items, found 1' },
    ]);
    expect(matchValue({ list: { a: 1 } }, actual)).toEqual([
      { path: '$.list', message: 'expected an object, found [{"a":1,"b":2}]' },
    ]);
  });

  it('supports the operators', () => {
    const actual = { id: 'TAG-7', n: 5, s: '125', x: null };
    expect(
      matchValue({ id: { $regex: '^TAG-' }, n: { $gt: 4 }, s: { $gte: 125 } }, actual),
    ).toEqual([]);
    expect(matchValue({ n: { $lt: 5 } }, actual)).toEqual([
      { path: '$.n', message: 'expected a number below 5, found 5' },
    ]);
    expect(matchValue({ id: { $exists: true }, none: { $exists: false } }, actual)).toEqual([]);
    expect(matchValue({ none: { $exists: true } }, actual)).toEqual([
      { path: '$.none', message: 'expected a value, found nothing' },
    ]);
    expect(matchValue({ n: { $ne: 5 } }, actual)).toEqual([
      { path: '$.n', message: 'expected anything but 5' },
    ]);
    expect(matchValue({ x: null }, actual)).toEqual([]);
  });

  it('checks operators before they are used', () => {
    expect(operatorProblems({ a: { $gt: 1 }, b: [{ $regex: 'x' }] })).toEqual([]);
    expect(operatorProblems({ a: { $near: 1 }, b: { $gt: '1' }, c: { $regex: '(' } })).toEqual([
      {
        path: '$.a',
        message: 'unknown operator $near (use $exists, $regex, $ne, $gt, $gte, $lt, $lte)',
      },
      { path: '$.b', message: '$gt takes a number' },
      { path: '$.c', message: '$regex is not a valid regular expression' },
    ]);
  });

  it('reads JSON paths', () => {
    const root = { answer: { transactionId: 7, list: [{ id: 'a' }] } };
    expect(readPath(root, '$.answer.transactionId')).toBe(7);
    expect(readPath(root, '$.answer.list[0].id')).toBe('a');
    expect(readPath(root, '$.answer.nope')).toBeUndefined();
    expect(readPath(root, '$')).toBe(root);
    expect(isJsonPath('$.a[0].b')).toBe(true);
    expect(isJsonPath('answer.id')).toBe(false);
  });
});
