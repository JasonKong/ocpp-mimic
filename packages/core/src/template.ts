/**
 * Scenario templates: `{{NAME}}` is replaced by a variable and `{{env.NAME}}`
 * by an environment variable. A string that is exactly one template takes
 * the variable's value with its type, so `"{{tx}}"` can stand for a number.
 */

/** Names a variable can have; `env` is reserved for environment variables. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]*?)\s*\}\}$/;

export interface TemplateContext {
  vars: Readonly<Record<string, unknown>>;
  env: Readonly<Record<string, string | undefined>>;
}

export interface Rendered<T> {
  value: T;
  /** Environment values used, to be masked in output and reports. */
  secrets: string[];
}

export class TemplateError extends Error {}

/** A template reference: a variable, or an environment variable when `env` is true. */
export interface TemplateRef {
  name: string;
  env: boolean;
}

function parseRef(text: string): TemplateRef | undefined {
  if (text.startsWith('env.')) {
    const name = text.slice('env.'.length);
    return VARIABLE_NAME.test(name) ? { name, env: true } : undefined;
  }
  return VARIABLE_NAME.test(text) && text !== 'env' ? { name: text, env: false } : undefined;
}

/** Every template inside `value` (strings at any depth), or the malformed ones as `invalid`. */
export function templateRefs(value: unknown): { refs: TemplateRef[]; invalid: string[] } {
  const refs: TemplateRef[] = [];
  const invalid: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(TEMPLATE)) {
        const ref = parseRef(match[1] ?? '');
        if (ref === undefined) invalid.push(match[0]);
        else refs.push(ref);
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return { refs, invalid };
}

/** Replaces every template inside `value`. Throws a TemplateError for unknown names. */
export function renderTemplates<T>(value: T, context: TemplateContext): Rendered<T> {
  const secrets = new Set<string>();
  const lookup = (text: string): unknown => {
    const ref = parseRef(text);
    if (ref === undefined) throw new TemplateError(`invalid template {{${text}}}`);
    if (ref.env) {
      const found = context.env[ref.name];
      if (found === undefined) {
        throw new TemplateError(`environment variable ${ref.name} is not set`);
      }
      if (found !== '') secrets.add(found);
      return found;
    }
    if (!Object.hasOwn(context.vars, ref.name)) {
      throw new TemplateError(`unknown variable ${ref.name}`);
    }
    return context.vars[ref.name];
  };
  const text = (found: unknown) =>
    typeof found === 'string' ? found : (JSON.stringify(found) ?? String(found));
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = WHOLE_TEMPLATE.exec(node);
      if (whole !== null) return lookup(whole[1] ?? '');
      return node.replace(TEMPLATE, (_match, inner: string) => text(lookup(inner)));
    }
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    }
    return node;
  };
  return { value: visit(value) as T, secrets: [...secrets] };
}

/** `text` with every secret replaced by `***`. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .sort((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.split(secret).join('***'), text);
}
