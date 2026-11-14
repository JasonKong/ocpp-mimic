/**
 * A small, dependency-free schema library for OCPP payloads. Each schema
 * checks a value at runtime and carries its TypeScript type, so message
 * types are derived from the same definitions that validate them.
 */

/** The OCPP-J error codes a payload validation problem can map to. */
export type ValidationErrorCode =
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurenceConstraintViolation'
  | 'TypeConstraintViolation';

/** One problem found while validating a value. */
export interface ValidationIssue {
  /** JSON path of the offending value, for example `$.meterValue[0].timestamp`. */
  path: string;
  message: string;
  errorCode: ValidationErrorCode;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; errorCode: ValidationErrorCode; issues: ValidationIssue[] };

/** A runtime check for values of type `T`. Build schemas with the helpers in this module. */
export interface Schema<T> {
  /** Appends every problem with `value` to `issues`. */
  readonly check: (value: unknown, path: string, issues: ValidationIssue[]) => void;
  /** Carries `T` for {@link Infer}; never set at runtime. */
  readonly _type?: T;
}

/** The TypeScript type a schema validates. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/**
 * Validates `value` against `schema`. On failure, `errorCode` is the code of
 * the first issue, which is what a CALLERROR answering the message carries.
 */
export function validate<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  schema.check(value, '$', issues);
  const [first] = issues;
  if (first === undefined) return { ok: true, value: value as T };
  return { ok: false, errorCode: first.errorCode, issues };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeIssue(path: string, expected: string, value: unknown): ValidationIssue {
  return {
    path,
    errorCode: 'TypeConstraintViolation',
    message: `expected ${expected}, got ${describe(value)}`,
  };
}

function propertyIssue(path: string, message: string): ValidationIssue {
  return { path, errorCode: 'PropertyConstraintViolation', message };
}

export function string(options: { maxLength?: number } = {}): Schema<string> {
  return {
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push(typeIssue(path, 'string', value));
      } else if (options.maxLength !== undefined && value.length > options.maxLength) {
        issues.push(propertyIssue(path, `longer than ${options.maxLength} characters`));
      }
    },
  };
}

export function integer(options: { minimum?: number } = {}): Schema<number> {
  return {
    check(value, path, issues) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.push(typeIssue(path, 'integer', value));
      } else if (options.minimum !== undefined && value < options.minimum) {
        issues.push(propertyIssue(path, `less than ${options.minimum}`));
      }
    },
  };
}

export function number(): Schema<number> {
  return {
    check(value, path, issues) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(typeIssue(path, 'number', value));
      }
    },
  };
}

export function boolean(): Schema<boolean> {
  return {
    check(value, path, issues) {
      if (typeof value !== 'boolean') issues.push(typeIssue(path, 'boolean', value));
    },
  };
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 date-time string, as OCPP's `dateTime` type requires. */
export function dateTime(): Schema<string> {
  return {
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push(typeIssue(path, 'date-time string', value));
      } else if (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
        issues.push(propertyIssue(path, `not an RFC 3339 date-time: ${JSON.stringify(value)}`));
      }
    },
  };
}

/** One of a fixed set of strings (an OCPP enumeration). */
export function oneOf<const V extends readonly string[]>(values: V): Schema<V[number]> {
  const allowed = new Set<string>(values);
  return {
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push(typeIssue(path, 'string', value));
      } else if (!allowed.has(value)) {
        issues.push(
          propertyIssue(path, `${JSON.stringify(value)} is not one of ${values.join(', ')}`),
        );
      }
    },
  };
}

export function array<T>(item: Schema<T>, options: { minItems?: number } = {}): Schema<T[]> {
  return {
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push(typeIssue(path, 'array', value));
        return;
      }
      if (options.minItems !== undefined && value.length < options.minItems) {
        issues.push({
          path,
          errorCode: 'OccurenceConstraintViolation',
          message: `fewer than ${options.minItems} items`,
        });
      }
      value.forEach((element, index) => item.check(element, `${path}[${index}]`, issues));
    },
  };
}

type Shape = Record<string, Schema<unknown>>;
type Simplify<T> = { [K in keyof T]: T[K] };

/** The type of an object with the `R` properties required and the `O` properties optional. */
export type ObjectOf<R extends Shape, O extends Shape> = Simplify<
  { [K in keyof R]: Infer<R[K]> } & { [K in keyof O]?: Infer<O[K]> }
>;

/**
 * A JSON object with required and optional properties. Like the OCPP 1.6
 * schemas, it rejects properties it does not know.
 */
export function object<R extends Shape, O extends Shape = Record<never, never>>(
  required: R,
  optional?: O,
): Schema<ObjectOf<R, O>> {
  const optionalShape: Shape = optional ?? {};
  return {
    check(value, path, issues) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push(typeIssue(path, 'object', value));
        return;
      }
      const record = value as Record<string, unknown>;
      for (const [key, schema] of Object.entries(required)) {
        if (record[key] === undefined) {
          issues.push({
            path: `${path}.${key}`,
            errorCode: 'OccurenceConstraintViolation',
            message: 'missing required property',
          });
        } else {
          schema.check(record[key], `${path}.${key}`, issues);
        }
      }
      for (const [key, schema] of Object.entries(optionalShape)) {
        if (record[key] !== undefined) schema.check(record[key], `${path}.${key}`, issues);
      }
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(required, key) && !Object.hasOwn(optionalShape, key)) {
          issues.push({
            path: `${path}.${key}`,
            errorCode: 'FormationViolation',
            message: 'unexpected property',
          });
        }
      }
    },
  };
}
