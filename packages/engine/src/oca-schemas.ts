/**
 * The Open Charge Alliance's official OCPP 1.6 JSON Schemas, shipped unchanged
 * in `oca-schemas/ocpp16/` (see the README there for source and licence), used
 * as a second check next to core's own message definitions.
 *
 * The files are read as data and handed to a generic draft-04 validator.
 * Nothing is generated from them, and they must never be edited.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvDraft04Module from 'ajv-draft-04';
import addFormatsModule from 'ajv-formats';

export const OCA_SCHEMAS_DIR = fileURLToPath(new URL('../oca-schemas/ocpp16/', import.meta.url));

export type PayloadKind = 'request' | 'response';

export interface OcaSchemas {
  /** Actions with an official schema, for example `BootNotification`. */
  readonly actions: readonly string[];
  /**
   * Problems the official schema finds in `payload`, as `$.path: message`
   * lines; empty when it passes, undefined when the action has no schema.
   */
  check(action: string, kind: PayloadKind, payload: unknown): string[] | undefined;
}

interface AjvError {
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
interface ValidateFunction {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}
interface AjvInstance {
  compile(schema: object): ValidateFunction;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

// Both packages are CommonJS with a `default` property; NodeNext sees the module object.
const unwrap = <T>(module: unknown): T => ((module as { default?: T }).default ?? module) as T;
const AjvDraft04 = unwrap<AjvConstructor>(AjvDraft04Module);
const addFormats = unwrap<(ajv: AjvInstance) => void>(addFormatsModule);

/** `/meterValue/0/timestamp` → `$.meterValue[0].timestamp`, the path style core uses. */
function jsonPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .reduce(
      (path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`),
      '$',
    );
}

function describe(error: AjvError): string {
  const extra =
    error.params.additionalProperty !== undefined
      ? ` (${String(error.params.additionalProperty)})`
      : Array.isArray(error.params.allowedValues)
        ? ` (${error.params.allowedValues.join(', ')})`
        : '';
  return `${jsonPath(error.instancePath)}: ${error.message ?? 'is invalid'}${extra}`;
}

/** Loads every `<Action>.json` (request) and `<Action>Response.json` (response) in `dir`. */
export function loadOcaSchemas(dir: string = OCA_SCHEMAS_DIR): OcaSchemas {
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = new Map<string, ValidateFunction>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const schema = JSON.parse(readFileSync(join(dir, file), 'utf8')) as object;
    const name = file.slice(0, -'.json'.length);
    const key = name.endsWith('Response')
      ? `${name.slice(0, -'Response'.length)} response`
      : `${name} request`;
    validators.set(key, ajv.compile(schema));
  }
  const actions = [
    ...new Set([...validators.keys()].map((key) => key.split(' ')[0] ?? key)),
  ].sort();

  return {
    actions,
    check(action, kind, payload) {
      const validator = validators.get(`${action} ${kind}`);
      if (validator === undefined) return undefined;
      if (validator(payload)) return [];
      return (validator.errors ?? []).map(describe);
    },
  };
}
