<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { NewStation, PersonaInfo, StationSummary } from '../api.js';

const props = defineProps<{
  stations: StationSummary[];
  personas: PersonaInfo[];
  selectedId: string | undefined;
}>();
const emit = defineEmits<{
  select: [id: string];
  create: [station: NewStation];
}>();

const showForm = ref(false);
const form = reactive({
  id: '',
  count: 1,
  group: '',
  persona: '',
  csmsUrl: localStorageGet('ocpp-mimic.csmsUrl') ?? 'ws://localhost:9000/ocpp',
  password: '',
});
const search = ref('');
const state = ref('');
const group = ref('');

function localStorageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function submit() {
  const persona = form.persona || props.personas[0]?.id || '';
  try {
    localStorage.setItem('ocpp-mimic.csmsUrl', form.csmsUrl);
  } catch {
    // remembering the URL is only a convenience
  }
  emit('create', {
    id: form.id.trim(),
    persona,
    csmsUrl: form.csmsUrl.trim(),
    ...(form.password !== '' && { password: form.password }),
    ...(form.count > 1 && { count: form.count }),
    ...(form.group.trim() !== '' && { group: form.group.trim() }),
  });
  form.id = '';
  showForm.value = false;
}

const groups = computed(() =>
  [...new Set(props.stations.flatMap((s) => (s.group === undefined ? [] : [s.group])))].sort(),
);

const filtered = computed(() => {
  const text = search.value.trim().toLowerCase();
  return props.stations.filter(
    (s) =>
      (text === '' || s.id.toLowerCase().includes(text)) &&
      (state.value === '' || s.state === state.value) &&
      (group.value === '' || s.group === group.value),
  );
});

// Only the rows in view are rendered, so a list of thousands stays fast.
const ROW = 36;
const HEIGHT = 520;
const scrollTop = ref(0);
const view = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / ROW) - 5);
  const count = Math.ceil(HEIGHT / ROW) + 10;
  return { first, rows: filtered.value.slice(first, first + count) };
});

function statusClass(station: StationSummary): string {
  if (station.state === 'stopped') return 'muted';
  if (station.connectors.some((c) => c.status === 'Faulted')) return 'bad';
  if (station.state === 'connected' && station.registration === 'Accepted') return 'good';
  if (station.state === 'offline') return 'warn';
  return 'pending';
}

function meta(station: StationSummary): string {
  if (station.state === 'stopped') return 'Stopped';
  // 2.0.1 reports Occupied; the charging itself shows in the station's view.
  const charging = station.connectors.filter(
    (c) => c.status === 'Charging' || c.status === 'Occupied',
  ).length;
  if (charging > 0) return `Charging ${charging}`;
  return station.state === 'connected' ? station.registration : station.state;
}
</script>

<template>
  <aside class="stations">
    <header>
      <h2>
        Charge points <span class="count">{{ stations.length }}</span>
      </h2>
      <button class="primary" @click="showForm = !showForm">
        {{ showForm ? 'Cancel' : 'Add' }}
      </button>
    </header>

    <form v-if="showForm" class="create" @submit.prevent="submit">
      <label>
        {{ form.count > 1 ? 'Id with a counter' : 'Charge point id' }}
        <input v-model="form.id" required :placeholder="form.count > 1 ? 'SIM-{001}' : 'SIM-001'" />
      </label>
      <label>
        How many
        <input v-model.number="form.count" type="number" min="1" max="10000" />
      </label>
      <label v-if="form.count > 1">
        Group (optional)
        <input v-model="form.group" placeholder="ac" />
      </label>
      <label>
        Persona
        <select v-model="form.persona">
          <option v-for="persona in personas" :key="persona.id" :value="persona.id">
            {{ persona.id }} · OCPP {{ persona.ocpp }}
          </option>
        </select>
      </label>
      <label>
        CSMS URL
        <input v-model="form.csmsUrl" required placeholder="ws://localhost:9000/ocpp" />
      </label>
      <label>
        Password (optional)
        <input v-model="form.password" type="password" autocomplete="off" />
      </label>
      <button class="primary" type="submit">
        {{ form.count > 1 ? `Create and start ${form.count}` : 'Create and start' }}
      </button>
    </form>

    <p v-if="stations.length === 0 && !showForm" class="empty">
      No charge points yet. Add one to connect it to a CSMS.
    </p>

    <div v-if="stations.length > 0" class="filters">
      <input v-model="search" type="search" placeholder="Search ids" aria-label="Search ids" />
      <select v-model="state" aria-label="Connection state">
        <option value="">All states</option>
        <option value="connected">Connected</option>
        <option value="connecting">Connecting</option>
        <option value="offline">Offline</option>
        <option value="stopped">Stopped</option>
      </select>
      <select v-if="groups.length > 0" v-model="group" aria-label="Group">
        <option value="">All groups</option>
        <option v-for="name in groups" :key="name" :value="name">{{ name }}</option>
      </select>
    </div>

    <div
      class="list"
      :style="{ maxHeight: `${HEIGHT}px` }"
      @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
    >
      <ul :style="{ height: `${filtered.length * ROW}px` }">
        <li
          v-for="(station, i) in view.rows"
          :key="station.id"
          :class="{ selected: station.id === selectedId }"
          :style="{ top: `${(view.first + i) * ROW}px` }"
          @click="emit('select', station.id)"
        >
          <span class="dot" :class="statusClass(station)" />
          <span class="name">{{ station.id }}</span>
          <span v-if="station.ocpp === '2.0.1'" class="version" title="OCPP 2.0.1">2.0.1</span>
          <span class="meta">{{ meta(station) }}</span>
        </li>
      </ul>
    </div>
    <p v-if="stations.length > 0 && filtered.length === 0" class="empty">No match.</p>
  </aside>
</template>

<style scoped>
.stations {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 15px;
}
.count {
  font-weight: 400;
  color: var(--muted);
  font-size: 13px;
}
.version {
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted);
}
.create {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.filters input {
  flex: 1 1 100%;
}
.filters select {
  flex: 1;
}
.list {
  overflow-y: auto;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
}
li {
  position: absolute;
  left: 0;
  right: 0;
  height: 32px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
}
li:hover {
  background: var(--hover);
}
li.selected {
  background: var(--selected);
}
.name {
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: var(--muted);
}
.empty {
  color: var(--muted);
  font-size: 13px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--muted);
}
.dot.good {
  background: var(--good);
}
.dot.warn {
  background: var(--warn);
}
.dot.bad {
  background: var(--bad);
}
.dot.pending {
  background: var(--accent);
}
</style>
