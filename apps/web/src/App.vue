<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  api,
  subscribeEvents,
  type NewStation,
  type PersonaInfo,
  type RecordEntry,
  type StationSnapshot,
} from './api.js';
import MessageLog from './components/MessageLog.vue';
import StationDetail from './components/StationDetail.vue';
import StationList from './components/StationList.vue';

const stations = reactive(new Map<string, StationSnapshot>());
const records = reactive(new Map<string, RecordEntry[]>());
const personas = ref<PersonaInfo[]>([]);
const selectedId = ref<string | undefined>();
const error = ref<string | undefined>();
const live = ref(false);
const MAX_RECORDS = 1000;

const stationList = computed(() => [...stations.values()].sort((a, b) => a.id.localeCompare(b.id)));
const selected = computed(() => (selectedId.value ? stations.get(selectedId.value) : undefined));
const selectedPersona = computed(() =>
  personas.value.find((p) => p.id === selected.value?.persona),
);
const selectedRecords = computed(() =>
  selectedId.value ? (records.get(selectedId.value) ?? []) : [],
);

async function guard(work: () => Promise<unknown>) {
  error.value = undefined;
  try {
    await work();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function select(id: string) {
  selectedId.value = id;
  await guard(async () => {
    const { entries } = await api.messages(id);
    records.set(id, entries);
  });
}

function addRecord(entry: RecordEntry) {
  const list = records.get(entry.stationId);
  if (list === undefined) return; // loaded on selection
  if (list.length > 0 && (list.at(-1)?.seq ?? 0) >= entry.seq) return;
  list.push(entry);
  if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
}

async function create(station: NewStation) {
  await guard(async () => {
    const created = await api.createStation(station);
    stations.set(created.id, created);
    await select(created.id);
  });
}

async function act(name: string, connectorId?: number, value?: unknown) {
  const station = selected.value;
  if (station === undefined) return;
  const id = station.id;
  const c = connectorId ?? 0;
  await guard(async () => {
    switch (name) {
      case 'start':
        return api.start(id);
      case 'stop':
        return api.stop(id);
      case 'offline':
        return api.offline(id, value as 'clean' | 'half-open');
      case 'online':
        return api.online(id);
      case 'clearInjections':
        return api.clearInjections(id);
      case 'inject':
        return api.inject(id, value as Record<string, unknown>);
      case 'energyMultiplier':
        return api.setEnergyMultiplier(id, Number(value));
      case 'behaviour':
        return api.setBehaviour(id, value as Parameters<typeof api.setBehaviour>[1]);
      case 'plug':
        return api.plug(id, c, typeof value === 'string' ? value : undefined);
      case 'unplug':
        return api.unplug(id, c);
      case 'evSuspend':
        return api.evSuspend(id, c);
      case 'evResume':
        return api.evResume(id, c);
      case 'clearFault':
        return api.clearFault(id, c);
      case 'fault':
        return api.fault(id, c, value as Parameters<typeof api.fault>[2]);
      case 'idTag': {
        const { result } = await api.idTag(id, c, String(value));
        if (result !== 'authorized' && result !== 'stopping')
          error.value = `Card ${String(value)}: ${result}`;
        return;
      }
      case 'delete':
        if (!confirm(`Delete charge point ${id}? This stops it and forgets its state.`)) return;
        await api.deleteStation(id);
        stations.delete(id);
        records.delete(id);
        selectedId.value = stationList.value[0]?.id;
        return;
    }
  });
}

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  unsubscribe = subscribeEvents(
    (event) => {
      if (event.type === 'station') stations.set(event.station.id, event.station);
      else if (event.type === 'station-removed') stations.delete(event.stationId);
      else addRecord(event.entry);
    },
    (connected) => (live.value = connected),
  );
  await guard(async () => {
    const [personaList, stationList] = await Promise.all([api.personas(), api.stations()]);
    personas.value = personaList.personas;
    for (const station of stationList.stations) stations.set(station.id, station);
    const first = stationList.stations[0];
    if (first !== undefined) await select(first.id);
  });
});

onUnmounted(() => unsubscribe?.());
</script>

<template>
  <div class="app">
    <header class="bar">
      <h1>ocpp-mimic</h1>
      <span class="live" :class="{ on: live }">{{ live ? 'live' : 'reconnecting…' }}</span>
    </header>
    <p v-if="error" class="error" role="alert">
      {{ error }} <button class="link" @click="error = undefined">dismiss</button>
    </p>
    <main>
      <StationList
        :stations="stationList"
        :personas="personas"
        :selected-id="selectedId"
        @select="select"
        @create="create"
      />
      <div v-if="selected" class="content">
        <StationDetail :station="selected" :persona="selectedPersona" @action="act" />
        <MessageLog :entries="selectedRecords" :station-id="selectedId" />
      </div>
      <div v-else class="content placeholder">
        <p>Add a charge point, or pick one on the left.</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app {
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
h1 {
  margin: 0;
  font-size: 20px;
}
.live {
  font-size: 12px;
  color: var(--muted);
}
.live.on {
  color: var(--good);
}
main {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 24px;
}
.content {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.placeholder {
  color: var(--muted);
}
.error {
  background: var(--bad-bg);
  color: var(--bad);
  padding: 8px 12px;
  border-radius: 6px;
}
.link {
  border: none;
  background: none;
  text-decoration: underline;
  color: inherit;
  padding: 0;
}
@media (max-width: 800px) {
  main {
    grid-template-columns: 1fr;
  }
}
</style>
