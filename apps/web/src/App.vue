<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  api,
  connectEvents,
  type EventsConnection,
  type NewStation,
  type PersonaInfo,
  type RecordEntry,
  type StationSnapshot,
  type StationSummary,
} from './api.js';
import FleetOverview from './components/FleetOverview.vue';
import MessageLog from './components/MessageLog.vue';
import StationDetail from './components/StationDetail.vue';
import StationList from './components/StationList.vue';

/** Every station as a summary; only the selected one has its full snapshot and records. */
const summaries = reactive(new Map<string, StationSummary>());
const records = reactive(new Map<string, RecordEntry[]>());
const personas = ref<PersonaInfo[]>([]);
const selectedId = ref<string | undefined>();
const selected = ref<StationSnapshot | undefined>();
const error = ref<string | undefined>();
const live = ref(false);
const MAX_RECORDS = 1000;
let events: EventsConnection | undefined;

const stationList = computed(() =>
  [...summaries.values()].sort((a, b) => a.id.localeCompare(b.id)),
);
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
  selected.value = undefined;
  // Only the selected station's records and snapshots come over the socket.
  events?.subscribe([id]);
  records.clear();
  await guard(async () => {
    const [snapshot, { entries }] = await Promise.all([api.station(id), api.messages(id)]);
    if (selectedId.value !== id) return;
    selected.value = snapshot;
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
    if ((station.count ?? 1) > 1) {
      const { ids } = await api.createStations({ ...station, count: station.count ?? 1 });
      if (ids[0] !== undefined) await select(ids[0]);
      return;
    }
    const { count: _count, ...single } = station;
    const created = await api.createStation(single);
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
        summaries.delete(id);
        records.delete(id);
        selected.value = undefined;
        selectedId.value = undefined;
        if (stationList.value[0] !== undefined) await select(stationList.value[0].id);
        return;
    }
  });
}

onMounted(async () => {
  events = connectEvents(
    (event) => {
      if (event.type === 'fleet') {
        if (event.full) summaries.clear();
        for (const summary of event.stations) summaries.set(summary.id, summary);
        for (const id of event.removed) summaries.delete(id);
        if (selectedId.value === undefined && stationList.value[0] !== undefined) {
          void select(stationList.value[0].id);
        }
      } else if (event.type === 'station') {
        if (event.station.id === selectedId.value) selected.value = event.station;
      } else {
        addRecord(event.entry);
      }
    },
    (connected) => (live.value = connected),
  );
  await guard(async () => {
    personas.value = (await api.personas()).personas;
  });
});

onUnmounted(() => events?.close());
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
      <div class="content">
        <FleetOverview :stations="stationList" />
        <template v-if="selected">
          <StationDetail :station="selected" :persona="selectedPersona" @action="act" />
          <MessageLog :entries="selectedRecords" :station-id="selectedId" />
        </template>
        <p v-else class="placeholder">Add a charge point, or pick one on the left.</p>
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
  grid-template-columns: 280px 1fr;
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
