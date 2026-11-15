<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DeviceModelEntry } from '../api.js';
import { groupDeviceModel } from '../format.js';

const props = defineProps<{
  /** Undefined while loading. */
  variables: DeviceModelEntry[] | undefined;
}>();
const emit = defineEmits<{
  refresh: [];
  /** A local operator sets an Actual value. */
  set: [component: string, variable: string, value: string];
}>();

const filter = ref('');
/** The variable being edited, `component/variable`, and the value typed so far. */
const editing = ref<{ key: string; value: string } | undefined>();
const keyOf = (v: DeviceModelEntry) => `${v.component}/${v.variable}`;
const writable = (v: DeviceModelEntry) => attribute(v, 'Actual')?.mutability === 'ReadWrite';

function startEdit(v: DeviceModelEntry) {
  editing.value = { key: keyOf(v), value: attribute(v, 'Actual')?.value ?? '' };
}

function save(v: DeviceModelEntry) {
  if (editing.value === undefined) return;
  emit('set', v.component, v.variable, editing.value.value);
  editing.value = undefined;
}
const groups = computed(() => groupDeviceModel(props.variables ?? [], filter.value));

const attribute = (v: DeviceModelEntry, type: string) => v.attributes.find((a) => a.type === type);

/** The Actual value; a write-only one is never shown. */
function actual(v: DeviceModelEntry): string {
  const a = attribute(v, 'Actual');
  if (a === undefined) return '';
  if (a.mutability === 'WriteOnly') return '(write-only)';
  return a.value ?? '';
}

function mutability(v: DeviceModelEntry): string {
  const m = attribute(v, 'Actual')?.mutability;
  return m === 'ReadWrite' ? 'RW' : m === 'ReadOnly' ? 'RO' : m === 'WriteOnly' ? 'WO' : '';
}

/** Target, MinSet and MaxSet, when the variable has them. */
function others(v: DeviceModelEntry): string {
  return v.attributes
    .filter((a) => a.type !== 'Actual')
    .map((a) => `${a.type} ${a.value ?? '—'}`)
    .join(' · ');
}

function characteristics(v: DeviceModelEntry): string {
  return [
    `${v.dataType}${v.unit === undefined ? '' : ` (${v.unit})`}`,
    v.minLimit === undefined ? undefined : `min ${v.minLimit}`,
    v.maxLimit === undefined ? undefined : `max ${v.maxLimit}`,
    v.valuesList === undefined ? undefined : v.valuesList,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}
</script>

<template>
  <section class="device-model">
    <header>
      <h3>Device Model</h3>
      <input
        v-model="filter"
        type="search"
        placeholder="Filter components, variables, values"
        aria-label="Filter the Device Model"
      />
      <button @click="emit('refresh')">Refresh</button>
    </header>
    <p v-if="variables === undefined" class="empty">Loading…</p>
    <p v-else-if="groups.length === 0" class="empty">Nothing matches.</p>
    <details v-for="group in groups" :key="group.component" :open="filter !== ''">
      <summary>
        {{ group.component }} <span class="count">{{ group.variables.length }}</span>
      </summary>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Actual</th>
            <th></th>
            <th>Other attributes</th>
            <th>Characteristics</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in group.variables" :key="v.variable">
            <td>{{ v.variable }}</td>
            <td class="value">
              <form
                v-if="editing?.key === keyOf(v)"
                class="edit"
                @submit.prevent="save(v)"
                @keydown.esc="editing = undefined"
              >
                <input v-model="editing.value" :aria-label="`New value of ${v.variable}`" />
                <button type="submit" class="primary">Set</button>
                <button type="button" @click="editing = undefined">Cancel</button>
              </form>
              <template v-else>
                {{ actual(v) }}
                <button
                  v-if="writable(v)"
                  class="link"
                  :title="`Set ${v.variable} as a local operator`"
                  @click="startEdit(v)"
                >
                  edit
                </button>
              </template>
            </td>
            <td class="mutability">{{ mutability(v) }}</td>
            <td>{{ others(v) }}</td>
            <td class="muted">{{ characteristics(v) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>

<style scoped>
.device-model {
  display: grid;
  gap: 8px;
}
header {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
h3 {
  margin: 0;
  font-size: 14px;
}
header input {
  flex: 1;
  min-width: 160px;
}
.empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
.count {
  font-weight: 400;
  color: var(--muted);
}
table {
  border-collapse: collapse;
  font-size: 12px;
  margin: 4px 0 8px 16px;
}
th,
td {
  text-align: left;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th {
  color: var(--muted);
  font-weight: 500;
}
.value {
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
.mutability,
.muted {
  color: var(--muted);
}
.edit {
  display: flex;
  gap: 4px;
}
.edit input {
  width: 120px;
}
.link {
  border: none;
  background: none;
  padding: 0 4px;
  color: var(--muted);
  text-decoration: underline;
  font-size: 11px;
}
</style>
