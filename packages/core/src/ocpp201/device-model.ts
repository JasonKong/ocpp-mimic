/**
 * The OCPP 2.0.1 Device Model of a station: components (name, instance,
 * EVSE, connector) and their variables (name, instance), each with up to
 * four attributes (Actual, Target, MinSet, MaxSet) and characteristics.
 *
 * Pure: the station gives it the standard variables it implements (see
 * standardVariables), persona and station overrides, saved values, and a
 * reader for values that change on their own (AvailabilityState, Power,
 * DateTime). It answers GetVariables, SetVariables and the reports per use
 * cases B05 to B08 and keeps the values; the station reads its behaviour
 * from it.
 */
import type {
  AttributeEnumType,
  ComponentCriterionEnumType,
  ComponentType,
  ComponentVariableType,
  DataEnumType,
  GetVariableDataType,
  GetVariableResultType,
  MutabilityEnumType,
  ReportBaseEnumType,
  ReportDataType,
  SetVariableDataType,
  SetVariableResultType,
  VariableType,
} from './messages.js';

export type AttributeType = AttributeEnumType;
export type Mutability = MutabilityEnumType;
export type VariableDataType = DataEnumType;

export interface AttributeDefinition {
  mutability: Mutability;
  /** Kept across restarts. */
  persistent: boolean;
  /** Never changes. */
  constant: boolean;
  /** The initial value; undefined leaves the attribute unset. */
  value?: string;
}

export interface VariableDefinition {
  component: ComponentType;
  variable: VariableType;
  dataType: VariableDataType;
  unit?: string;
  /** Allowed values of an OptionList, MemberList or SequenceList, comma-separated. */
  valuesList?: string;
  minLimit?: number;
  /** Highest number, or longest string. */
  maxLimit?: number;
  attributes: Partial<Record<AttributeType, AttributeDefinition>>;
  /** SetVariables answers RebootRequired: the change applies after a reboot. */
  rebootRequired?: boolean;
  /** The Actual value comes from the station's reader, not the store. */
  dynamic?: boolean;
}

type Bare<T> = Omit<T, 'customData'>;
type Component = Bare<ComponentType>;
type Variable = Bare<VariableType>;

/** `Name`, `Name:instance`, `Name@evse` or `Name@evse.connector` (and both forms combined). */
export function componentKey(component: Component): string {
  const instance = component.instance === undefined ? '' : `:${component.instance}`;
  const evse =
    component.evse === undefined
      ? ''
      : `@${component.evse.id}${component.evse.connectorId === undefined ? '' : `.${component.evse.connectorId}`}`;
  return `${component.name}${instance}${evse}`;
}

/** `Name` or `Name:instance`. */
export function variableKey(variable: Variable): string {
  return variable.instance === undefined ? variable.name : `${variable.name}:${variable.instance}`;
}

/** The component a key names; undefined when it is not a key. */
export function parseComponentKey(key: string): Component | undefined {
  const match = /^([A-Za-z0-9_*\-.]+?)(?::([^@]+))?(?:@(\d+)(?:\.(\d+))?)?$/.exec(key);
  if (match === null || match[1] === undefined) return undefined;
  return {
    name: match[1],
    ...(match[2] !== undefined && { instance: match[2] }),
    ...(match[3] !== undefined && {
      evse: {
        id: Number(match[3]),
        ...(match[4] !== undefined && { connectorId: Number(match[4]) }),
      },
    }),
  };
}

export function parseVariableKey(key: string): Variable | undefined {
  const match = /^([A-Za-z0-9_*\-.]+?)(?::(.+))?$/.exec(key);
  if (match === null || match[1] === undefined) return undefined;
  return { name: match[1], ...(match[2] !== undefined && { instance: match[2] }) };
}

const keyOf = (component: Component, variable: Variable) =>
  `${componentKey(component)}/${variableKey(variable)}`;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Why `value` is not a valid value for `definition`, if it is not. */
export function valueProblem(definition: VariableDefinition, value: string): string | undefined {
  const allowed = (definition.valuesList ?? '').split(',').filter((v) => v !== '');
  const range = (n: number) =>
    (definition.minLimit !== undefined && n < definition.minLimit) ||
    (definition.maxLimit !== undefined && n > definition.maxLimit)
      ? `out of range ${definition.minLimit ?? '-∞'} to ${definition.maxLimit ?? '∞'}`
      : undefined;
  switch (definition.dataType) {
    case 'integer':
      return /^-?\d+$/.test(value.trim()) ? range(Number(value)) : 'not an integer';
    case 'decimal':
      return value.trim() !== '' && Number.isFinite(Number(value))
        ? range(Number(value))
        : 'not a number';
    case 'boolean':
      return value === 'true' || value === 'false' ? undefined : 'not true or false';
    case 'dateTime':
      return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'not a date-time';
    case 'OptionList':
      return allowed.includes(value) ? undefined : `not one of ${allowed.join(', ')}`;
    case 'MemberList':
    case 'SequenceList': {
      const items = value === '' ? [] : value.split(',').map((v) => v.trim());
      // A list without a valuesList is open: any items (CustomizationCtrlr.CustomTriggers).
      const unknown =
        definition.valuesList === undefined ? [] : items.filter((item) => !allowed.includes(item));
      if (unknown.length > 0) return `${unknown.join(', ')} not in ${allowed.join(', ')}`;
      return new Set(items).size === items.length ? undefined : 'repeats an item';
    }
    case 'string':
      return definition.maxLimit !== undefined && value.length > definition.maxLimit
        ? `longer than ${definition.maxLimit} characters`
        : undefined;
  }
}

/** A value persona YAML can give: a scalar for a standard variable, or a whole definition. */
export type DeviceModelOverride =
  | string
  | number
  | boolean
  | {
      actual?: string | number | boolean;
      target?: string | number | boolean;
      minSet?: string | number | boolean;
      maxSet?: string | number | boolean;
      mutability?: Mutability;
      persistent?: boolean;
      dataType?: VariableDataType;
      unit?: string;
      valuesList?: string;
      minLimit?: number;
      maxLimit?: number;
    };

/** componentKey → variableKey → override, as in a persona's `deviceModel`. */
export type DeviceModelOverrides = Record<string, Record<string, DeviceModelOverride>>;

const ATTRIBUTES: readonly AttributeType[] = ['Actual', 'Target', 'MinSet', 'MaxSet'];
const OVERRIDE_ATTRIBUTE: Record<string, AttributeType> = {
  actual: 'Actual',
  target: 'Target',
  minSet: 'MinSet',
  maxSet: 'MaxSet',
};

/**
 * Applies overrides to standard definitions: a scalar sets a standard
 * variable's Actual value, an object changes or defines a variable. Returns
 * the new definitions, or the problems.
 */
export function applyOverrides(
  definitions: readonly VariableDefinition[],
  overrides: DeviceModelOverrides | undefined,
): { ok: true; definitions: VariableDefinition[] } | { ok: false; problems: string[] } {
  const byKey = new Map(
    definitions.map((d) => [
      keyOf(d.component, d.variable),
      JSON.parse(JSON.stringify(d)) as VariableDefinition,
    ]),
  );
  const problems: string[] = [];
  for (const [cKey, variables] of Object.entries(overrides ?? {})) {
    const component = parseComponentKey(cKey);
    if (component === undefined) {
      problems.push(`"${cKey}" is not a component like Name, Name:instance or Name@1.1`);
      continue;
    }
    for (const [vKey, override] of Object.entries(variables)) {
      const variable = parseVariableKey(vKey);
      const at = `${cKey}.${vKey}`;
      if (variable === undefined) {
        problems.push(`${at}: "${vKey}" is not a variable like Name or Name:instance`);
        continue;
      }
      const key = keyOf(component, variable);
      const existing = byKey.get(key);
      if (typeof override !== 'object') {
        if (existing === undefined) {
          problems.push(`${at}: not a standard variable; define it with dataType and a value`);
          continue;
        }
        existing.attributes.Actual = {
          ...(existing.attributes.Actual ?? {
            mutability: 'ReadWrite',
            persistent: true,
            constant: false,
          }),
          value: String(override),
        };
        const problem = valueProblem(existing, String(override));
        if (problem !== undefined) problems.push(`${at}: ${problem}`);
        continue;
      }
      const dataType = override.dataType ?? existing?.dataType;
      if (dataType === undefined) {
        problems.push(`${at}: a new variable needs a dataType`);
        continue;
      }
      const base: VariableDefinition = existing ?? {
        component,
        variable,
        dataType,
        attributes: {},
      };
      const next: VariableDefinition = {
        ...base,
        dataType,
        ...(override.unit !== undefined && { unit: override.unit }),
        ...(override.valuesList !== undefined && { valuesList: override.valuesList }),
        ...(override.minLimit !== undefined && { minLimit: override.minLimit }),
        ...(override.maxLimit !== undefined && { maxLimit: override.maxLimit }),
        attributes: { ...base.attributes },
      };
      for (const [field, type] of Object.entries(OVERRIDE_ATTRIBUTE)) {
        const value = override[field as keyof typeof override];
        if (value === undefined && !(type === 'Actual' && next.attributes.Actual === undefined))
          continue;
        next.attributes[type] = {
          mutability: override.mutability ?? next.attributes[type]?.mutability ?? 'ReadWrite',
          persistent: override.persistent ?? next.attributes[type]?.persistent ?? true,
          constant: next.attributes[type]?.constant ?? false,
          ...(value !== undefined
            ? { value: String(value) }
            : next.attributes[type]?.value !== undefined && { value: next.attributes[type].value }),
        };
        if (value !== undefined) {
          const problem = valueProblem(next, String(value));
          if (problem !== undefined) problems.push(`${at}.${field}: ${problem}`);
        }
      }
      byKey.set(key, next);
    }
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, definitions: [...byKey.values()] };
}

export interface DeviceModelOptions {
  definitions: readonly VariableDefinition[];
  /** Saved values: `component/variable/attribute` → value. */
  saved?: Readonly<Record<string, string>>;
  /** Reads a dynamic variable's Actual value by `component/variable` key. */
  read?: (key: string) => string | undefined;
  /** The station's own check of a SetVariables value: why it is refused, or undefined. */
  check?: (key: string, value: string) => string | undefined;
  /** Message limits from DeviceDataCtrlr; read when a request comes in. */
}

export interface DeviceModel {
  /** A value; undefined when the variable or attribute does not exist or is unset. */
  get(component: string, variable: string, attribute?: AttributeType): string | undefined;
  /** Sets a value from the station itself (e.g. the boot interval); no mutability check. */
  set(component: string, variable: string, value: string, attribute?: AttributeType): void;
  getVariables(data: readonly GetVariableDataType[]): GetVariableResultType[];
  /** Answers SetVariables; `changed` lists the `component/variable` keys whose value changed. */
  setVariables(data: readonly SetVariableDataType[]): {
    results: SetVariableResultType[];
    changed: string[];
  };
  /** The report for GetBaseReport; undefined for a base it does not support. */
  baseReport(base: ReportBaseEnumType): ReportDataType[] | undefined;
  /** The report for GetReport. */
  customReport(
    criteria: readonly ComponentCriterionEnumType[] | undefined,
    componentVariables: readonly ComponentVariableType[] | undefined,
  ): ReportDataType[];
  /** Persistent values to save: `component/variable/attribute` → value. */
  persistentValues(): Record<string, string>;
  definitions(): readonly VariableDefinition[];
}

export function createDeviceModel(options: DeviceModelOptions): DeviceModel {
  const entries = new Map<
    string,
    { definition: VariableDefinition; values: Map<AttributeType, string> }
  >();
  for (const definition of options.definitions) {
    const values = new Map<AttributeType, string>();
    for (const type of ATTRIBUTES) {
      const attribute = definition.attributes[type];
      if (attribute?.value !== undefined) values.set(type, attribute.value);
    }
    entries.set(keyOf(definition.component, definition.variable), { definition, values });
  }
  for (const [key, value] of Object.entries(options.saved ?? {})) {
    const cut = key.lastIndexOf('/');
    const entry = entries.get(key.slice(0, cut));
    const type = key.slice(cut + 1) as AttributeType;
    const attribute = entry?.definition.attributes[type];
    if (entry !== undefined && attribute?.persistent === true && !attribute.constant) {
      if (valueProblem(entry.definition, value) === undefined) entry.values.set(type, value);
    }
  }
  const componentKeys = new Set(
    [...entries.values()].map((e) => componentKey(e.definition.component)),
  );

  const valueOf = (
    key: string,
    entry: { definition: VariableDefinition; values: Map<AttributeType, string> },
    type: AttributeType,
  ) =>
    type === 'Actual' && entry.definition.dynamic === true
      ? options.read?.(key)
      : entry.values.get(type);

  function lookup(component: Component, variable: Variable) {
    const cKey = componentKey(component);
    if (!componentKeys.has(cKey)) return { status: 'UnknownComponent' as const };
    const key = `${cKey}/${variableKey(variable)}`;
    const entry = entries.get(key);
    if (entry === undefined) return { status: 'UnknownVariable' as const };
    return { status: 'found' as const, key, entry };
  }

  /** The request's component and variable without customData, as the answer repeats them. */
  const bare = <T extends { customData?: unknown }>(value: T): Bare<T> => {
    const { customData: _dropped, ...rest } = value;
    return rest;
  };

  function reportData(
    key: string,
    entry: { definition: VariableDefinition; values: Map<AttributeType, string> },
  ): ReportDataType {
    const { definition } = entry;
    return {
      component: definition.component,
      variable: definition.variable,
      variableAttribute: ATTRIBUTES.filter((type) => definition.attributes[type] !== undefined).map(
        (type) => {
          const attribute = definition.attributes[type]!;
          const value =
            attribute.mutability === 'WriteOnly' ? undefined : valueOf(key, entry, type);
          return {
            type,
            ...(value !== undefined && { value }),
            mutability: attribute.mutability,
            persistent: attribute.persistent,
            constant: attribute.constant,
          };
        },
      ),
      variableCharacteristics: {
        dataType: definition.dataType,
        supportsMonitoring: false,
        ...(definition.unit !== undefined && { unit: definition.unit }),
        ...(definition.valuesList !== undefined && { valuesList: definition.valuesList }),
        ...(definition.minLimit !== undefined && { minLimit: definition.minLimit }),
        ...(definition.maxLimit !== undefined && { maxLimit: definition.maxLimit }),
      },
    };
  }

  const all = () => [...entries.entries()];
  const truthy = (cKey: string, name: string) => {
    const entry = entries.get(`${cKey}/${name}`);
    if (entry === undefined) return undefined;
    return valueOf(`${cKey}/${name}`, entry, 'Actual') === 'true';
  };

  return {
    get(component, variable, attribute = 'Actual') {
      const key = `${component}/${variable}`;
      const entry = entries.get(key);
      return entry === undefined ? undefined : valueOf(key, entry, attribute);
    },

    set(component, variable, value, attribute = 'Actual') {
      entries.get(`${component}/${variable}`)?.values.set(attribute, value);
    },

    getVariables(data) {
      return data.map((item) => {
        const attributeType = item.attributeType ?? 'Actual';
        const answer = {
          attributeType,
          component: bare(item.component),
          variable: bare(item.variable),
        };
        const found = lookup(item.component, item.variable);
        if (found.status !== 'found') return { ...answer, attributeStatus: found.status };
        const attribute = found.entry.definition.attributes[attributeType];
        if (attribute === undefined) {
          return { ...answer, attributeStatus: 'NotSupportedAttributeType' as const };
        }
        if (attribute.mutability === 'WriteOnly')
          return { ...answer, attributeStatus: 'Rejected' as const };
        // An unset attribute answers an empty string (B06.FR.13).
        const value = valueOf(found.key, found.entry, attributeType) ?? '';
        return {
          ...answer,
          attributeStatus: 'Accepted' as const,
          attributeValue: value.slice(0, 2500),
        };
      });
    },

    setVariables(data) {
      const changed: string[] = [];
      const results = data.map((item) => {
        const attributeType = item.attributeType ?? 'Actual';
        const answer = {
          attributeType,
          component: bare(item.component),
          variable: bare(item.variable),
        };
        const found = lookup(item.component, item.variable);
        if (found.status !== 'found') return { ...answer, attributeStatus: found.status };
        const { definition, values } = found.entry;
        const attribute = definition.attributes[attributeType];
        if (attribute === undefined) {
          return { ...answer, attributeStatus: 'NotSupportedAttributeType' as const };
        }
        const reject = (reasonCode: string, additionalInfo?: string) => ({
          ...answer,
          attributeStatus: 'Rejected' as const,
          attributeStatusInfo: {
            reasonCode,
            ...(additionalInfo !== undefined && { additionalInfo: additionalInfo.slice(0, 512) }),
          },
        });
        if (
          attribute.mutability === 'ReadOnly' ||
          attribute.constant ||
          definition.dynamic === true
        ) {
          return reject('ReadOnly');
        }
        const problem =
          valueProblem(definition, item.attributeValue) ??
          (attributeType === 'Actual'
            ? options.check?.(found.key, item.attributeValue)
            : undefined);
        if (problem !== undefined) return reject('InvalidValue', problem);
        if (values.get(attributeType) !== item.attributeValue) {
          values.set(attributeType, item.attributeValue);
          changed.push(found.key);
        }
        return {
          ...answer,
          attributeStatus:
            definition.rebootRequired === true
              ? ('RebootRequired' as const)
              : ('Accepted' as const),
        };
      });
      return { results, changed };
    },

    baseReport(base) {
      switch (base) {
        case 'FullInventory':
          return all().map(([key, entry]) => reportData(key, entry));
        case 'ConfigurationInventory':
          // What the operator can set (B07.FR.07).
          return all()
            .filter(
              ([, entry]) =>
                Object.values(entry.definition.attributes).some(
                  (a) => a !== undefined && a.mutability !== 'ReadOnly' && !a.constant,
                ) && entry.definition.dynamic !== true,
            )
            .map(([key, entry]) => reportData(key, entry));
        case 'SummaryInventory':
          // Availability of station, EVSEs and connectors, and components with a problem (B07.FR.09).
          return all()
            .filter(([key, entry]) => {
              const name = entry.definition.variable.name;
              if (name === 'AvailabilityState') return true;
              return name === 'Problem' && valueOf(key, entry, 'Actual') === 'true';
            })
            .map(([key, entry]) => reportData(key, entry));
        default:
          return undefined;
      }
    },

    customReport(criteria, componentVariables) {
      let selected = all();
      if (componentVariables !== undefined && componentVariables.length > 0) {
        selected = selected.filter(([, entry]) =>
          componentVariables.some((wanted) => matches(entry.definition, wanted)),
        );
      }
      if (criteria !== undefined && criteria.length > 0) {
        selected = selected.filter(([, entry]) => {
          const cKey = componentKey(entry.definition.component);
          // A component without the variable counts as having it true, except Problem (B08.FR.07 to .10).
          return criteria.some((criterion) => {
            const value = truthy(cKey, criterion);
            return criterion === 'Problem' ? value === true : value !== false;
          });
        });
      }
      return selected.map(([key, entry]) => reportData(key, entry));
    },

    persistentValues() {
      const out: Record<string, string> = {};
      for (const [key, entry] of entries) {
        if (entry.definition.dynamic === true) continue;
        for (const [type, value] of entry.values) {
          const attribute = entry.definition.attributes[type];
          if (attribute?.persistent === true && !attribute.constant) out[`${key}/${type}`] = value;
        }
      }
      return out;
    },

    definitions: () => [...entries.values()].map((e) => e.definition),
  };
}

/**
 * Whether a definition is selected by a GetReport componentVariable: a
 * missing variable means all of the component's variables, a missing
 * instance every instance, a missing EVSE every EVSE (and the top level), a
 * missing connector every connector of the EVSE (B08.FR.20 to .25).
 */
function matches(definition: VariableDefinition, wanted: ComponentVariableType): boolean {
  const c = definition.component;
  const w = wanted.component;
  if (c.name !== w.name) return false;
  if (w.instance !== undefined && c.instance !== w.instance) return false;
  if (w.evse !== undefined) {
    if (c.evse?.id !== w.evse.id) return false;
    if (w.evse.connectorId !== undefined && c.evse.connectorId !== w.evse.connectorId) return false;
  }
  if (wanted.variable === undefined) return true;
  if (definition.variable.name !== wanted.variable.name) return false;
  return (
    wanted.variable.instance === undefined ||
    definition.variable.instance === wanted.variable.instance
  );
}
