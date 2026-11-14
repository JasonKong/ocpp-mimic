/**
 * Partial matching for scenario expectations: every field the expectation
 * gives must be present and equal; other fields are ignored. Arrays match
 * element by element and must have the same length. A field can hold
 * operators instead of a value (an object whose keys all start with `$`);
 * every operator given must hold.
 */

export const MATCH_OPERATORS = [
  '$exists',
  '$regex',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$contains',
  '$size',
] as const;
export type MatchOperator = (typeof MATCH_OPERATORS)[number];

export interface Mismatch {
  /** JSON path of the value that did not match, for example `$.payload.reason`. */
  path: string;
  message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The operators `value` stands for, when it is an object whose keys all start with `$`. */
function operatorsOf(value: unknown): { op: string; arg: unknown }[] | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => key.startsWith('$'))) return undefined;
  return keys.map((op) => ({ op, arg: value[op] }));
}

const COMPARISONS = ['$gt', '$gte', '$lt', '$lte'];

const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value));

/** Problems with the operators used in an expectation. */
export function operatorProblems(expected: unknown, path = '$'): Mismatch[] {
  const operators = operatorsOf(expected);
  if (operators !== undefined)
    return operators.flatMap(({ op, arg }) => checkOperator(op, arg, path));
  if (Array.isArray(expected)) {
    return expected.flatMap((item, index) => operatorProblems(item, `${path}[${index}]`));
  }
  if (isObject(expected)) {
    return Object.entries(expected).flatMap(([key, child]) =>
      operatorProblems(child, `${path}.${key}`),
    );
  }
  return [];
}

function checkOperator(op: string, arg: unknown, path: string): Mismatch[] {
  const problem = (message: string) => [{ path, message }];
  if (!(MATCH_OPERATORS as readonly string[]).includes(op)) {
    return problem(`unknown operator ${op} (use ${MATCH_OPERATORS.join(', ')})`);
  }
  if (op === '$exists' && typeof arg !== 'boolean') return problem('$exists takes true or false');
  if (op === '$regex') {
    if (typeof arg !== 'string') return problem('$regex takes a string');
    try {
      new RegExp(arg);
    } catch {
      return problem('$regex is not a valid regular expression');
    }
  }
  // A template ("{{before}}") becomes a number before matching.
  const template = typeof arg === 'string' && /^\{\{[^{}]+\}\}$/.test(arg.trim());
  if (COMPARISONS.includes(op) && typeof arg !== 'number' && !template)
    return problem(`${op} takes a number (or a template for one)`);
  if (op === '$contains') return operatorProblems(arg, `${path}.$contains`);
  if (op === '$size') {
    const size = operatorsOf(arg);
    if (typeof arg === 'number' && Number.isInteger(arg) && arg >= 0) return [];
    if (size !== undefined && size.every(({ op: inner }) => COMPARISONS.includes(inner))) {
      return operatorProblems(arg, `${path}.$size`);
    }
    return problem('$size takes a whole number or comparisons such as { $gte: 1 }');
  }
  return [];
}

/** A number, or a string holding one (OCPP sends meter values as strings). */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function applyOperator(op: string, arg: unknown, actual: unknown, path: string): Mismatch[] {
  const fail = (message: string) => [{ path, message }];
  switch (op) {
    case '$exists':
      return (actual !== undefined) === arg
        ? []
        : fail(
            arg === true
              ? 'expected a value, found nothing'
              : `expected nothing, found ${show(actual)}`,
          );
    case '$regex':
      return typeof actual === 'string' && new RegExp(String(arg)).test(actual)
        ? []
        : fail(`expected a string matching /${String(arg)}/, found ${show(actual)}`);
    case '$ne':
      return equal(arg, actual) ? fail(`expected anything but ${show(arg)}`) : [];
    case '$contains': {
      if (!Array.isArray(actual)) return fail(`expected an array, found ${show(actual)}`);
      if (actual.some((item) => matchValue(arg, item).length === 0)) return [];
      return fail(
        `expected an item matching ${show(arg)} among ${actual.length} item${actual.length === 1 ? '' : 's'}`,
      );
    }
    case '$size': {
      if (!Array.isArray(actual)) return fail(`expected an array, found ${show(actual)}`);
      if (typeof arg === 'number') {
        return actual.length === arg ? [] : fail(`expected ${arg} items, found ${actual.length}`);
      }
      return matchValue(arg, actual.length, `${path}.length`);
    }
    default: {
      const value = numeric(actual);
      const bound = Number(arg);
      const ok =
        value !== undefined &&
        ((op === '$gt' && value > bound) ||
          (op === '$gte' && value >= bound) ||
          (op === '$lt' && value < bound) ||
          (op === '$lte' && value <= bound));
      const words = { $gt: 'above', $gte: 'at least', $lt: 'below', $lte: 'at most' } as const;
      return ok
        ? []
        : fail(
            `expected a number ${words[op as keyof typeof words]} ${bound}, found ${show(actual)}`,
          );
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every way `actual` fails to match `expected`; empty when it matches. */
export function matchValue(expected: unknown, actual: unknown, path = '$'): Mismatch[] {
  const operators = operatorsOf(expected);
  if (operators !== undefined) {
    return operators.flatMap(({ op, arg }) => applyOperator(op, arg, actual, path));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual))
      return [{ path, message: `expected an array, found ${show(actual)}` }];
    if (actual.length !== expected.length) {
      return [{ path, message: `expected ${expected.length} items, found ${actual.length}` }];
    }
    return expected.flatMap((item, index) => matchValue(item, actual[index], `${path}[${index}]`));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [{ path, message: `expected an object, found ${show(actual)}` }];
    return Object.entries(expected).flatMap(([key, child]) =>
      matchValue(child, actual[key], `${path}.${key}`),
    );
  }
  if (actual === undefined) return [{ path, message: `expected ${show(expected)}, found nothing` }];
  return equal(expected, actual)
    ? []
    : [{ path, message: `expected ${show(expected)}, found ${show(actual)}` }];
}

const PATH = /^\$((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/;

/** True when `path` is a JSON path like `$.answer.transactionId` or `$.items[0].id`. */
export function isJsonPath(path: string): boolean {
  return PATH.test(path);
}

/** The value at `path` inside `root`, or undefined when there is none. */
export function readPath(root: unknown, path: string): unknown {
  const match = PATH.exec(path);
  if (match === null) return undefined;
  const segments = [...(match[1] ?? '').matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)];
  let node: unknown = root;
  for (const [, key, index] of segments) {
    if (key !== undefined) node = isObject(node) ? node[key] : undefined;
    else node = Array.isArray(node) ? node[Number(index)] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}
