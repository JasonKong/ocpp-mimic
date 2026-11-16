<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  api,
  apiToken,
  connectEvents,
  onUnauthorized,
  setApiToken,
  type DeviceModelEntry,
  type EventsConnection,
  type FrameRecord,
  type NewStation,
  type ReferenceTariff,
  type PersonaInfo,
  type RecordEntry,
  type SessionDetail,
  type SessionSummary,
  type StationSnapshot,
  type StationSummary,
} from './api.js';
import { formatRoute, parseRoute } from './sessions.js';
import SessionsView from './components/SessionsView.vue';
import DeviceModelBrowser from './components/DeviceModelBrowser.vue';
import FleetOverview from './components/FleetOverview.vue';
import MessageLog from './components/MessageLog.vue';
import StationDetail from './components/StationDetail.vue';
import StationList from './components/StationList.vue';
import TransactionEvents from './components/TransactionEvents.vue';

/** Every station as a summary; only the selected one has its full snapshot and records. */
const summaries = reactive(new Map<string, StationSummary>());
const records = reactive(new Map<string, RecordEntry[]>());
const personas = ref<PersonaInfo[]>([]);
const selectedId = ref<string | undefined>();
const selected = ref<StationSnapshot | undefined>();
/** The selected 2.0.1 station's Device Model; undefined while loading. */
const deviceModel = ref<DeviceModelEntry[] | undefined>();
const error = ref<string | undefined>();
/** The engine answered 401: it was started with an API token, and this tab has none or a wrong one. */
const needsToken = ref(false);
const tokenInput = ref('');
const hadToken = apiToken() !== undefined;
const stopUnauthorized = onUnauthorized(() => (needsToken.value = true));
function saveToken() {
  setApiToken(tokenInput.value.trim());
  // Every view and the events socket start again with the token.
  location.reload();
}
const live = ref(false);
const MAX_RECORDS = 1000;
let events: EventsConnection | undefined;

/** The selected station's tab, its sessions and the open one (#/stations/<id>/sessions/<n>). */
const tab = ref<'station' | 'sessions'>('station');
const sessions = ref<SessionSummary[]>([]);
const sessionN = ref<number | undefined>();
const sessionDetail = ref<SessionDetail | undefined>();
const sessionFrames = ref<FrameRecord[] | undefined>();
const showTruth = ref(false);
/** The engine's reference tariff, loaded with the Sessions tab. */
const tariff = ref<ReferenceTariff | undefined>();
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
/** A newer change of the open session came while its detail was loading. */
let detailLoading = false;
let detailStale = false;

function syncRoute() {
  const id = selectedId.value;
  if (id === undefined) return;
  const hash = formatRoute({
    stationId: id,
    sessions: tab.value === 'sessions',
    ...(tab.value === 'sessions' && sessionN.value !== undefined && { n: sessionN.value }),
  });
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function loadSessions(id: string) {
  if (tariff.value === undefined) {
    void guard(async () => {
      tariff.value = (await api.tariff()).tariff;
    });
  }
  await guard(async () => {
    const list = (await api.sessions(id)).sessions;
    if (selectedId.value !== id) return;
    sessions.value = list;
    if (sessionN.value === undefined && list[0] !== undefined) await openSession(list[0].n);
  });
}

async function loadDetail() {
  const id = selectedId.value;
  const n = sessionN.value;
  if (id === undefined || n === undefined) return;
  if (detailLoading) {
    detailStale = true;
    return;
  }
  detailLoading = true;
  try {
    await guard(async () => {
      const detail = await api.session(id, n);
      if (selectedId.value === id && sessionN.value === n) sessionDetail.value = detail;
    });
  } finally {
    detailLoading = false;
  }
  if (detailStale) {
    detailStale = false;
    await loadDetail();
  }
}

async function openSession(n: number) {
  sessionN.value = n;
  sessionDetail.value = undefined;
  sessionFrames.value = undefined;
  syncRoute();
  await loadDetail();
}

let framesLoading = false;
async function loadSessionFrames() {
  const id = selectedId.value;
  const n = sessionN.value;
  if (id === undefined || n === undefined || framesLoading) return;
  framesLoading = true;
  try {
    await guard(async () => {
      const { frames } = await api.sessionFrames(id, n);
      if (selectedId.value === id && sessionN.value === n) sessionFrames.value = frames;
    });
  } finally {
    framesLoading = false;
  }
}

async function openTab(next: 'station' | 'sessions') {
  tab.value = next;
  syncRoute();
  if (next === 'sessions' && selectedId.value !== undefined) await loadSessions(selectedId.value);
}

/** A session changed on the engine: the list follows, and the open one reloads. */
function sessionChanged(summary: SessionSummary) {
  if (summary.stationId !== selectedId.value) return;
  const index = sessions.value.findIndex((s) => s.n === summary.n);
  if (index >= 0) sessions.value.splice(index, 1, summary);
  else sessions.value = [summary, ...sessions.value].sort((a, b) => b.n - a.n);
  if (summary.n === sessionN.value) {
    // The frames reload in the background; the log keeps the old ones meanwhile.
    void loadSessionFrames();
    void loadDetail();
  } else if (sessionN.value === undefined && tab.value === 'sessions') {
    void openSession(summary.n);
  }
}

async function saveTariff(next: ReferenceTariff) {
  await guard(async () => {
    tariff.value = (await api.setTariff(next)).tariff;
  });
  await loadDetail();
}

async function remoteStart(request: { idToken: string; type?: string; evseId?: number }) {
  const id = selectedId.value;
  if (id === undefined) return;
  await guard(async () => {
    const answer = await api.remoteStart(
      id,
      { idToken: request.idToken, ...(request.type !== undefined && { type: request.type }) },
      request.evseId,
    );
    if (answer.status !== 'Accepted') error.value = `${answer.action}: ${answer.status}`;
  });
}

/** Opens what the address names, when it names a known station. */
async function applyRoute() {
  const route = parseRoute(location.hash);
  if (route === undefined) return;
  // The tab first, so selecting the station keeps the address and loads its sessions.
  tab.value = route.sessions ? 'sessions' : 'station';
  if (route.stationId !== selectedId.value) await select(route.stationId);
  else if (route.sessions) await loadSessions(route.stationId);
  if (route.sessions && route.n !== undefined && route.n !== sessionN.value) {
    await openSession(route.n);
  }
  syncRoute();
}

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
  sessions.value = [];
  sessionN.value = undefined;
  sessionDetail.value = undefined;
  sessionFrames.value = undefined;
  syncRoute();
  // A session the address names is opened by applyRoute; it wins over the newest one.
  if (tab.value === 'sessions') void loadSessions(id);
  // Only the selected station's records and snapshots come over the socket.
  events?.subscribe([id]);
  records.clear();
  let ocpp: string | undefined;
  await guard(async () => {
    const [snapshot, { entries }] = await Promise.all([api.station(id), api.messages(id)]);
    if (selectedId.value !== id) return;
    selected.value = snapshot;
    ocpp = snapshot.ocpp;
    records.set(id, entries);
  });
  if (ocpp !== '1.6') await loadDeviceModel(id);
}

async function setVariable(component: string, variable: string, value: string) {
  const id = selectedId.value;
  if (id === undefined) return;
  await guard(async () => {
    const result = await api.setVariable(id, component, variable, value);
    if (result.status !== 'Accepted' && result.status !== 'RebootRequired') {
      error.value = `${component}.${variable}: ${result.status}${result.reason === undefined ? '' : ` (${result.reason})`}`;
    }
  });
  await loadDeviceModel(id);
}

async function loadDeviceModel(id: string) {
  deviceModel.value = undefined;
  await guard(async () => {
    const { variables } = await api.deviceModel(id);
    if (selectedId.value === id) deviceModel.value = variables;
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
        const card = value as { idTag: string; type?: string };
        const { result } = await api.idTag(id, c, card.idTag, card.type);
        if (result !== 'authorized' && result !== 'stopping')
          error.value = `Card ${card.idTag}: ${result}`;
        return;
      }
      case 'payment': {
        const { result } = await api.payment(id, c, value as Record<string, unknown>);
        if (result !== 'authorized') error.value = `Payment card: ${result}`;
        return;
      }
      case 'stopPayment': {
        const { result } = await api.stopPayment(id, c);
        if (result === 'no-payment') error.value = 'No payment to stop';
        return;
      }
      case 'priority': {
        const { result } = await api.priority(id, c, value === true);
        if (result !== 'activated' && result !== 'deactivated') {
          error.value = `Priority charging: ${result}`;
        }
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
          const route = parseRoute(location.hash);
          if (route !== undefined && summaries.has(route.stationId)) void applyRoute();
          else void select(stationList.value[0].id);
        }
      } else if (event.type === 'station') {
        if (event.station.id === selectedId.value) selected.value = event.station;
      } else if (event.type === 'session') {
        sessionChanged(event.session);
      } else {
        addRecord(event.entry);
      }
    },
    (connected) => (live.value = connected),
  );
  await guard(async () => {
    personas.value = (await api.personas()).personas;
  });
  clock = setInterval(() => (now.value = Date.now()), 1000);
  window.addEventListener('hashchange', applyRoute);
});

onUnmounted(() => {
  stopUnauthorized();
  events?.close();
  clearInterval(clock);
  window.removeEventListener('hashchange', applyRoute);
});
</script>

<template>
  <div class="app">
    <header class="bar">
      <h1>ocpp-mimic</h1>
      <span class="live" :class="{ on: live }">{{ live ? 'live' : 'reconnecting…' }}</span>
    </header>
    <form v-if="needsToken" class="token" @submit.prevent="saveToken">
      <label>
        {{ hadToken ? 'The API token was not accepted.' : 'This engine needs an API token.' }}
        <input
          v-model="tokenInput"
          type="password"
          autocomplete="off"
          placeholder="API token"
          aria-label="API token"
        />
      </label>
      <button class="primary" type="submit">Use token</button>
    </form>
    <p v-if="error && !needsToken" class="error" role="alert">
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
          <nav class="tabs" role="tablist">
            <button
              role="tab"
              :aria-selected="tab === 'station'"
              :class="{ on: tab === 'station' }"
              @click="openTab('station')"
            >
              Station
            </button>
            <button
              role="tab"
              :aria-selected="tab === 'sessions'"
              :class="{ on: tab === 'sessions' }"
              @click="openTab('sessions')"
            >
              Sessions
            </button>
          </nav>
          <template v-if="tab === 'station'">
            <StationDetail :station="selected" :persona="selectedPersona" @action="act" />
            <template v-if="selected.ocpp !== '1.6'">
              <TransactionEvents :entries="selectedRecords" />
              <DeviceModelBrowser
                :variables="deviceModel"
                @refresh="selectedId && loadDeviceModel(selectedId)"
                @set="setVariable"
              />
            </template>
            <MessageLog :entries="selectedRecords" :station-id="selectedId" />
          </template>
          <SessionsView
            v-else
            v-model:show-truth="showTruth"
            :station="selected"
            :sessions="sessions"
            :detail="sessionDetail"
            :selected-n="sessionN"
            :frames="sessionFrames"
            :now="now"
            :tariff="tariff"
            :records="selectedRecords"
            @save-tariff="saveTariff"
            @select="openSession"
            @load-frames="loadSessionFrames"
            @remote-start="remoteStart"
          />
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
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: none;
  padding: 6px 12px;
  margin-bottom: -1px;
}
.tabs button.on {
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.token {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.token label {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
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
