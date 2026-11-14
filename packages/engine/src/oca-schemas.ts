/**
 * The Open Charge Alliance's official JSON Schemas, shipped unchanged (see
 * `oca-schemas/README.md` for sources and licence) and used as a second check
 * next to core's own message definitions: OCPP 1.6 in `oca-schemas/ocpp16/`
 * (draft-04) and the Security Whitepaper's in `oca-schemas/ocpp16-security/`
 * (draft-06).
 *
 * The files are read as data and handed to a generic validator for their
 * draft. Nothing is generated from them, and they must never be edited.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import AjvDraft04Module from 'ajv-draft-04';
import addFormatsModule from 'ajv-formats';

export const OCA_SCHEMAS_DIR = fileURLToPath(new URL('../oca-schemas/ocpp16/', import.meta.url));
export const OCA_SECURITY_SCHEMAS_DIR = fileURLToPath(
  new URL('../oca-schemas/ocpp16-security/', import.meta.url),
);

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
  addMetaSchema(schema: object): unknown;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

// Both packages are CommonJS with a `default` property; NodeNext sees the module object.
const unwrap = <T>(module: unknown): T => ((module as { default?: T }).default ?? module) as T;
const AjvDraft04 = unwrap<AjvConstructor>(AjvDraft04Module);
const Ajv = unwrap<AjvConstructor>(AjvModule);
const DRAFT_06 = 'http://json-schema.org/draft-06/schema#';
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

/**
 * Loads every `<Action>.json` (request) and `<Action>Response.json`
 * (response) in `dirs`, each with a validator for the draft its `$schema` names.
 */
export function loadOcaSchemas(
  dirs: readonly string[] = [OCA_SCHEMAS_DIR, OCA_SECURITY_SCHEMAS_DIR],
): OcaSchemas {
  const draft04 = new AjvDraft04({ allErrors: true, strict: false });
  addFormats(draft04);
  const draft06 = new Ajv({ allErrors: true, strict: false });
  draft06.addMetaSchema(
    createRequire(import.meta.url)('ajv/dist/refs/json-schema-draft-06.json') as object,
  );
  addFormats(draft06);
  const validators = new Map<string, ValidateFunction>();
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const schema = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { $schema?: string };
      const name = file.slice(0, -'.json'.length);
      const key = name.endsWith('Response')
        ? `${name.slice(0, -'Response'.length)} response`
        : `${name} request`;
      validators.set(key, (schema.$schema === DRAFT_06 ? draft06 : draft04).compile(schema));
    }
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
