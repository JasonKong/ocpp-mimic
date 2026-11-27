<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  api,
  connectEvents,
  type EventsConnection,
  type FrameRecord,
  type OcppVersion,
  type StationSnapshot,
} from '../api.js';
import {
  appUserFor,
  bayView,
  carFor,
  cardFor,
  clockText,
  createPortTracker,
  DEFAULT_SETUP,
  DEMO_SPEEDS,
  DEMO_TAG,
  DEMO_VERSIONS,
  demoStations,
  frameLabel,
  START_MODES,
  VALET_TOKEN,
  type BayView,
  type DemoCar,
  type DemoSetup,
  type FrameLabel,
} from '../demo.js';

const STORAGE_KEY = 'ocpp-mimic.demo';

function stored(): DemoSetup | undefined {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text === null ? undefined : { ...DEFAULT_SETUP, ...(JSON.parse(text) as DemoSetup) };
  } catch {
    return undefined;
  }
}
function remember(value: DemoSetup) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Without storage the page still works; it only forgets the setup on reload.
  }
}

/** The settings being chosen, and the ones the car park was built with. */
const setup = reactive<DemoSetup>({ ...(stored() ?? DEFAULT_SETUP) });
const built = ref<DemoSetup | undefined>();
const stations = reactive(new Map<string, StationSnapshot>());
const busy = ref(false);
const error = ref<string | undefined>();
const now = ref(Date.now());

/** Bays where a session ran since the car was plugged in, and when each car became full. */
const hadTransaction = reactive(new Set<string>());
const fullSince = reactive(new Map<string, number>());

interface FeedItem {
  seq: number;
  at: string;
  stationId: string;
  /** The connector or EVSE the message is about, when it says. */
  port?: number;
  up: boolean;
  label: FrameLabel;
  payload: unknown;
}
const feed = ref<FeedItem[]>([]);
let portOf = createPortTracker();
const openSeq = ref<number | undefined>();
const MAX_FEED = 120;

interface Capsule {
  key: number;
  up: boolean;
  label: FrameLabel;
}
const capsules = reactive(new Map<string, Capsule[]>());
let capsuleKey = 0;
const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let events: EventsConnection | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

const mode = computed(() => START_MODES.find((m) => m.id === setup.mode) ?? START_MODES[0]);
const builtMode = computed(() => START_MODES.find((m) => m.id === built.value?.mode));
const changed = computed(
  () =>
    built.value === undefined ||
    (['ocpp', 'mode', 'chargers', 'ports', 'speed', 'csmsUrl'] as const).some(
      (key) => built.value?.[key] !== setup[key],
    ),
);

interface Bay {
  key: string;
  stationId: string;
  connectorId: number;
  /** Counts every bay of the car park from 0, for its car and its card. */
  index: number;
  car: DemoCar;
  view: BayView;
}

interface Charger {
  station: StationSnapshot;
  bays: Bay[];
}

const chargers = computed<Charger[]>(() => {
  let index = 0;
  return [...stations.values()]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((station) => ({
      station,
      bays: station.connectors.map((connector) => {
        const key = `${station.id}/${connector.connectorId}`;
        const bay: Bay = {
          key,
          stationId: station.id,
          connectorId: connector.connectorId,
          index,
          car: carFor(index),
          view: bayView(connector, station.ocpp, hadTransaction.has(key)),
        };
        index += 1;
        return bay;
      }),
    }));
});
const bays = computed(() => chargers.value.flatMap((c) => c.bays));

/** Keeps what the bays need beyond a snapshot: whether a session ran, and since when a car is full. */
function track(station: StationSnapshot) {
  for (const connector of station.connectors) {
    const key = `${station.id}/${connector.connectorId}`;
    if (connector.transactionId !== undefined) hadTransaction.add(key);
    if (!connector.plugged) hadTransaction.delete(key);
    const view = bayView(connector, station.ocpp, hadTransaction.has(key));
    if (view.phase === 'full') {
      if (!fullSince.has(key)) fullSince.set(key, Date.now());
    } else {
      fullSince.delete(key);
    }
  }
}

function addFrame(entry: FrameRecord) {
  if (!stations.has(entry.stationId) || entry.messageType === undefined) return;
  const label = frameLabel(entry);
  const up = entry.direction === 'cp-to-csms';
  const port = portOf(entry);
  const item: FeedItem = {
    seq: entry.seq,
    at: entry.at,
    stationId: entry.stationId,
    ...(port !== undefined && { port }),
    up,
    label,
    payload: entry.payload,
  };
  feed.value = [item, ...feed.value].slice(0, MAX_FEED);
  if (reducedMotion) return;
  const lane = capsules.get(entry.stationId) ?? [];
  const capsule: Capsule = { key: ++capsuleKey, up, label };
  capsules.set(entry.stationId, [...lane, capsule].slice(-8));
  setTimeout(() => {
    const current = capsules.get(entry.stationId) ?? [];
    capsules.set(
      entry.stationId,
      current.filter((c) => c.key !== capsule.key),
    );
  }, 1700);
}

async function guard(work: () => Promise<unknown>) {
  error.value = undefined;
  try {
    await work();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function watchStations(ids: string[]) {
  events?.subscribe(ids);
}

async function load(ids: string[]) {
  const snapshots = await Promise.all(ids.map((id) => api.station(id)));
  stations.clear();
  for (const snapshot of snapshots) {
    stations.set(snapshot.id, snapshot);
    track(snapshot);
  }
}

/** Deletes the demo stations and builds the car park the setup describes. */
async function build() {
  busy.value = true;
  await guard(async () => {
    const next: DemoSetup = { ...setup };
    await api.deleteStations({ tag: DEMO_TAG });
    stations.clear();
    hadTransaction.clear();
    fullSince.clear();
    feed.value = [];
    portOf = createPortTracker();
    capsules.clear();
    const definitions = demoStations(next);
    for (const definition of definitions) await api.createStation(definition);
    // Valet is the CSMS's doing: it starts a session on every plug-in. The CSMS keeps
    // that per station id, so the other modes turn it off for ids a valet build used.
    for (const { id } of definitions) {
      if (next.mode === 'valet') {
        await api.autoStart(id, { idToken: VALET_TOKEN, type: 'Central' });
      } else {
        await api.autoStart(id, null).catch(() => {
          // Not the built-in CSMS: there is no auto start to turn off.
        });
      }
    }
    built.value = next;
    remember(next);
    const ids = definitions.map((d) => d.id);
    watchStations(ids);
    await load(ids);
  });
  busy.value = false;
}

async function act(work: () => Promise<unknown>) {
  await guard(work);
}

const plug = (bay: Bay) => act(() => api.plug(bay.stationId, bay.connectorId, bay.car.profile));
const unplug = (bay: Bay) => act(() => api.unplug(bay.stationId, bay.connectorId));
async function tapCard(bay: Bay) {
  await act(async () => {
    const station = stations.get(bay.stationId);
    const type = station?.ocpp === '1.6' ? undefined : 'ISO14443';
    const { result } = await api.idTag(bay.stationId, bay.connectorId, cardFor(bay.index), type);
    if (result !== 'authorized' && result !== 'stopping') {
      error.value = `${cardFor(bay.index)}: ${result}`;
    }
  });
}
async function appStart(bay: Bay) {
  await act(async () => {
    const answer = await api.remoteStart(
      bay.stationId,
      { idToken: appUserFor(bay.index), type: 'Central' },
      bay.connectorId,
    );
    if (answer.status !== 'Accepted') error.value = `${answer.action}: ${answer.status}`;
  });
}
async function appStop(bay: Bay) {
  await act(async () => {
    const answer = await api.remoteStop(bay.stationId, bay.connectorId);
    if (answer.status !== 'Accepted') error.value = `${answer.action}: ${answer.status}`;
  });
}

/** Every bay at once, as cars arriving together would. */
async function everyBay(pick: (bay: Bay) => boolean, work: (bay: Bay) => Promise<unknown>) {
  await Promise.all(bays.value.filter(pick).map(work));
}
const plugAll = () => everyBay((b) => b.view.phase === 'empty', plug);
const unplugAll = () => everyBay((b) => b.view.plugged, unplug);
const startAll = () =>
  everyBay(
    (b) => b.view.phase === 'plugged',
    (b) => (built.value?.mode === 'card' ? tapCard(b) : appStart(b)),
  );

const canStartAll = computed(
  () =>
    (built.value?.mode === 'card' || built.value?.mode === 'app') &&
    bays.value.some((b) => b.view.phase === 'plugged'),
);

const PHASE_TEXT: Record<BayView['phase'], string> = {
  empty: 'Empty bay',
  plugged: 'Plugged in',
  starting: 'Starting',
  charging: 'Charging',
  full: 'Full',
  suspended: 'Paused',
  finished: 'Session ended',
  fault: 'Fault',
  unavailable: 'Unavailable',
};

/** What the bay waits for, in the words of the chosen start. */
function waitingText(bay: Bay): string | undefined {
  if (bay.view.phase === 'plugged') {
    switch (built.value?.mode) {
      case 'card':
        return 'Waiting for a card';
      case 'app':
        return 'Waiting for the app';
      case 'valet':
        return 'The CSMS starts it';
      default:
        return 'Starting by itself';
    }
  }
  if (bay.view.phase === 'finished') return 'Unplug to free the bay';
  if (bay.view.phase === 'full') {
    const since = fullSince.get(bay.key);
    return since === undefined
      ? 'Full'
      : `Full, still in the bay for ${clockText(now.value - since)}`;
  }
  return undefined;
}

const versionLabel = (ocpp: OcppVersion) => (ocpp === '1.6' ? '1.6J' : ocpp);
const portName = (ocpp: OcppVersion) => (ocpp === '1.6' ? 'Connector' : 'EVSE');
const kw = (w: number) => (w / 1000).toFixed(1);
const modelOf = (station: StationSnapshot) => station.persona;
const connectionText = (station: StationSnapshot) =>
  station.connected
    ? station.registration === 'Accepted'
      ? 'online'
      : station.registration
    : 'connecting…';

const csmsLine = computed(() => {
  switch (built.value?.mode) {
    case 'valet':
      return `Starts a session on every plug-in, as ${VALET_TOKEN}`;
    case 'app':
      return 'Sends remote starts and stops for the app';
    case 'card':
      return 'Authorizes every card';
    case 'free-vend':
      return 'Accepts the sessions the stations start';
    default:
      return '';
  }
});

/** App and valet need ocpp-mimic's built-in CSMS, which can send the remote starts. */
const needsBuiltin = computed(
  () =>
    (built.value?.mode === 'app' || built.value?.mode === 'valet') &&
    [...stations.values()].some((s) => s.connected && s.csms === 'external'),
);
const anyConnecting = computed(() => [...stations.values()].some((s) => !s.connected));

function capsuleText(label: FrameLabel): string {
  if (label.kind === 'call') return label.text;
  if (label.kind === 'error') return `${label.text} ✕`;
  return label.status ?? '✓';
}

function timeOf(at: string) {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

onMounted(async () => {
  events = connectEvents(
    (event) => {
      if (event.type === 'station') {
        if (!stations.has(event.station.id)) return;
        stations.set(event.station.id, event.station);
        track(event.station);
      } else if (event.type === 'record' && event.entry.kind === 'frame') {
        addFrame(event.entry);
      }
    },
    () => {},
  );
  clock = setInterval(() => (now.value = Date.now()), 1000);
  // Pick up a car park built earlier, when its stations are still there.
  await guard(async () => {
    const previous = stored();
    const { stations: tagged } = await api.stationSummaries({ tag: DEMO_TAG });
    if (previous === undefined || tagged.length === 0) return;
    built.value = previous;
    const ids = tagged.map((s) => s.id);
    watchStations(ids);
    await load(ids);
  });
});

onUnmounted(() => {
  events?.close();
  clearInterval(clock);
});
</script>

<template>
  <section class="demo">
    <div class="setup" aria-label="Car park setup">
      <div class="row">
        <span class="label">OCPP version</span>
        <div class="segmented" role="radiogroup" aria-label="OCPP version">
          <button
            v-for="v in DEMO_VERSIONS"
            :key="v"
            role="radio"
            :aria-checked="setup.ocpp === v"
            :class="['v-' + v.replace(/\./g, ''), { on: setup.ocpp === v }]"
            @click="setup.ocpp = v"
          >
            {{ versionLabel(v) }}
          </button>
        </div>
      </div>
      <div class="row">
        <span class="label">How sessions start</span>
        <div class="segmented" role="radiogroup" aria-label="How sessions start">
          <button
            v-for="m in START_MODES"
            :key="m.id"
            role="radio"
            :aria-checked="setup.mode === m.id"
            :class="{ on: setup.mode === m.id }"
            @click="setup.mode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <p class="summary">{{ mode?.summary }}</p>
      <div class="row">
        <span class="label">Charge points</span>
        <div class="segmented" role="radiogroup" aria-label="Charge points">
          <button
            v-for="n in [1, 2, 3]"
            :key="n"
            role="radio"
            :aria-checked="setup.chargers === n"
            :class="{ on: setup.chargers === n }"
            @click="setup.chargers = n"
          >
            {{ n }}
          </button>
        </div>
        <span class="label">Ports each</span>
        <div class="segmented" role="radiogroup" aria-label="Ports on each charge point">
          <button
            v-for="n in [1, 2] as const"
            :key="n"
            role="radio"
            :aria-checked="setup.ports === n"
            :class="{ on: setup.ports === n }"
            @click="setup.ports = n"
          >
            {{ n === 1 ? 'Single' : 'Dual' }}
          </button>
        </div>
        <label class="label">
          Battery speed
          <select v-model.number="setup.speed" aria-label="Battery speed">
            <option v-for="s in DEMO_SPEEDS" :key="s" :value="s">
              {{ s === 1 ? 'Real time' : `×${s}` }}
            </option>
          </select>
        </label>
      </div>
      <div class="row">
        <label class="label csms-field">
          CSMS
          <input v-model.trim="setup.csmsUrl" spellcheck="false" aria-label="CSMS address" />
        </label>
        <button class="primary" :disabled="busy || setup.csmsUrl === ''" @click="build">
          {{
            built ? (changed ? 'Rebuild with these settings' : 'Start again') : 'Build the car park'
          }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error" role="alert">
      {{ error }} <button class="link" @click="error = undefined">dismiss</button>
    </p>
    <p v-if="needsBuiltin" class="warning">
      {{ builtMode?.label }} needs ocpp-mimic's built-in CSMS, which sends the remote starts. Start
      it with <code>ocpp-mimic csms</code> and use its address.
    </p>
    <p v-else-if="built && anyConnecting" class="warning">
      Waiting for the CSMS at <code>{{ built.csmsUrl }}</code
      >. Start ocpp-mimic's with <code>ocpp-mimic csms</code>.
    </p>

    <template v-if="built && chargers.length > 0">
      <div class="bulk">
        <button :disabled="!bays.some((b) => b.view.phase === 'empty')" @click="plugAll">
          Plug in every car
        </button>
        <button
          v-if="built.mode === 'card' || built.mode === 'app'"
          :disabled="!canStartAll"
          @click="startAll"
        >
          {{ built.mode === 'card' ? 'Tap every card' : 'Start every car in the app' }}
        </button>
        <button :disabled="!bays.some((b) => b.view.plugged)" @click="unplugAll">
          Unplug every car
        </button>
        <span class="muted">
          {{ builtMode?.label }} · OCPP {{ versionLabel(built.ocpp) }} ·
          {{ built.speed === 1 ? 'real time' : `batteries ×${built.speed}` }}
        </span>
      </div>

      <div class="stage" :style="{ '--rows': chargers.length }">
        <template v-for="(charger, row) in chargers" :key="charger.station.id">
          <article class="charger" :style="{ gridRow: row + 1 }">
            <header>
              <strong>{{ charger.station.id }}</strong>
              <span class="badge" :class="'v-' + charger.station.ocpp.replace(/\./g, '')">
                {{ versionLabel(charger.station.ocpp) }}
              </span>
              <span class="muted">{{ modelOf(charger.station) }}</span>
              <span class="dot" :class="{ on: charger.station.connected }">
                {{ connectionText(charger.station) }}
              </span>
            </header>
            <div class="bays">
              <div
                v-for="bay in charger.bays"
                :key="bay.key"
                class="bay"
                :class="'phase-' + bay.view.phase"
              >
                <div class="bay-head">
                  <span>{{ portName(charger.station.ocpp) }} {{ bay.connectorId }}</span>
                  <code class="status">{{ bay.view.status }}</code>
                </div>
                <svg
                  class="scene"
                  viewBox="0 0 240 96"
                  role="img"
                  :aria-label="`${bay.car.name}: ${PHASE_TEXT[bay.view.phase]}`"
                >
                  <!-- The port on the pedestal. -->
                  <rect x="4" y="10" width="26" height="76" rx="5" class="pedestal" />
                  <rect x="9" y="17" width="16" height="11" rx="2" class="screen" />
                  <circle cx="17" cy="44" r="5" class="socket" />
                  <!-- The parking bay. -->
                  <rect x="70" y="8" width="164" height="84" rx="6" class="bay-lines" />
                  <template v-if="bay.view.plugged">
                    <path
                      d="M 17 44 C 40 44, 46 66, 84 62"
                      class="cable"
                      :class="{ flowing: bay.view.phase === 'charging' }"
                    />
                  </template>
                  <g
                    v-if="bay.view.plugged || bay.view.phase !== 'empty'"
                    class="car"
                    :transform="'translate(82 26)'"
                  >
                    <path
                      d="M 6 40 L 6 28 Q 8 22 18 20 L 40 8 Q 46 5 56 5 L 98 5 Q 108 5 116 14 L 128 22 Q 140 24 142 32 L 142 40 Z"
                      :fill="bay.car.colour"
                    />
                    <path d="M 44 11 L 58 9 L 74 9 L 74 20 L 34 20 Z" class="window" />
                    <path d="M 80 9 L 98 9 Q 106 9 112 16 L 116 20 L 80 20 Z" class="window" />
                    <circle cx="34" cy="42" r="9" class="wheel" />
                    <circle cx="112" cy="42" r="9" class="wheel" />
                    <circle cx="34" cy="42" r="3.5" class="hub" />
                    <circle cx="112" cy="42" r="3.5" class="hub" />
                    <path
                      v-if="bay.view.phase === 'charging'"
                      d="M 74 22 L 66 33 L 72 33 L 68 42 L 79 29 L 72 29 Z"
                      class="bolt"
                    />
                    <g v-if="bay.view.phase === 'full'" class="full-mark">
                      <rect x="52" y="-14" width="44" height="16" rx="8" />
                      <text x="74" y="-2.5" text-anchor="middle">FULL</text>
                    </g>
                  </g>
                  <text v-else x="152" y="54" text-anchor="middle" class="empty-text">
                    Empty bay
                  </text>
                </svg>
                <div v-if="bay.view.soc !== undefined" class="battery">
                  <div class="soc">
                    <div
                      class="fill"
                      :class="{ full: bay.view.phase === 'full' }"
                      :style="{ width: `${Math.min(100, bay.view.soc)}%` }"
                    />
                  </div>
                  <span class="numbers">
                    <strong>{{ Math.floor(bay.view.soc) }}%</strong>
                    · {{ kw(bay.view.powerW) }} kW
                    <template v-if="bay.view.addedKWh !== undefined">
                      · +{{ bay.view.addedKWh.toFixed(1) }} kWh
                    </template>
                  </span>
                </div>
                <p class="phase">
                  <strong>{{ PHASE_TEXT[bay.view.phase] }}</strong>
                  <template v-if="bay.view.phase !== 'empty'"> · {{ bay.car.name }}</template>
                  <span v-if="waitingText(bay)" class="muted"> — {{ waitingText(bay) }}</span>
                </p>
                <div class="actions">
                  <button v-if="bay.view.phase === 'empty'" class="primary" @click="plug(bay)">
                    Plug in
                  </button>
                  <template v-if="built.mode === 'card'">
                    <button
                      v-if="bay.view.phase === 'plugged'"
                      class="primary"
                      @click="tapCard(bay)"
                    >
                      Tap card
                    </button>
                    <button v-if="bay.view.transaction" @click="tapCard(bay)">
                      Tap card to stop
                    </button>
                  </template>
                  <template v-if="built.mode === 'app'">
                    <button
                      v-if="bay.view.phase === 'plugged'"
                      class="primary"
                      @click="appStart(bay)"
                    >
                      Start in app
                    </button>
                    <button v-if="bay.view.transaction" @click="appStop(bay)">Stop in app</button>
                  </template>
                  <button v-if="bay.view.plugged" @click="unplug(bay)">Unplug</button>
                </div>
              </div>
            </div>
          </article>
          <div class="lane" :style="{ gridRow: row + 1 }" aria-hidden="true">
            <span class="track up" />
            <span class="track down" />
            <span
              v-for="capsule in capsules.get(charger.station.id) ?? []"
              :key="capsule.key"
              class="capsule"
              :class="[capsule.up ? 'up' : 'down', capsule.label.kind]"
            >
              {{ capsuleText(capsule.label) }}
            </span>
          </div>
        </template>
        <aside class="csms" :style="{ gridRow: `1 / span ${chargers.length}` }">
          <strong>CSMS</strong>
          <code>{{ built.csmsUrl }}</code>
          <p>{{ csmsLine }}</p>
        </aside>
      </div>

      <section class="feed" aria-label="OCPP messages">
        <h2>OCPP messages</h2>
        <p v-if="feed.length === 0" class="muted">Plug in a car to see what the stations say.</p>
        <ol>
          <li v-for="item in feed" :key="item.seq">
            <button
              class="feed-row"
              :aria-expanded="openSeq === item.seq"
              @click="openSeq = openSeq === item.seq ? undefined : item.seq"
            >
              <span class="time">{{ timeOf(item.at) }}</span>
              <span class="who">
                {{ item.stationId }}
                <template v-if="item.port !== undefined">
                  · {{ portName(stations.get(item.stationId)?.ocpp ?? '1.6') }} {{ item.port }}
                </template>
              </span>
              <span class="dir" :class="item.up ? 'up' : 'down'">
                {{ item.up ? 'station → CSMS' : 'CSMS → station' }}
              </span>
              <span class="action" :class="item.label.kind">
                {{ item.label.kind === 'call' ? item.label.text : `${item.label.text} answer` }}
              </span>
              <span
                v-if="item.label.status"
                class="chip"
                :class="item.label.status === 'Accepted' ? 'good' : 'bad'"
              >
                {{ item.label.status }}
              </span>
            </button>
            <pre v-if="openSeq === item.seq">{{ JSON.stringify(item.payload, null, 2) }}</pre>
          </li>
        </ol>
      </section>
    </template>
    <p v-else-if="!busy" class="placeholder">
      Choose a version and how sessions start, then build the car park. The stations are real
      ocpp-mimic stations: every message below goes over the wire to the CSMS.
    </p>
  </section>
</template>

<style scoped>
.demo {
  display: grid;
  gap: 16px;
}
.setup {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.label {
  font-size: 12px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.csms-field input {
  width: 260px;
  max-width: 60vw;
  font-family: ui-monospace, monospace;
}
.summary {
  margin: -2px 0 0;
  font-size: 13px;
  color: var(--muted);
}
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.segmented button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 5px 12px;
}
.segmented button + button {
  border-left: 1px solid var(--border);
}
.segmented button.on {
  background: var(--accent);
  color: var(--accent-ink);
}
.segmented button.v-16.on {
  background: var(--v16);
}
.segmented button.v-201.on {
  background: var(--v201);
}
.segmented button.v-21.on {
  background: var(--v21);
}
.bulk {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.muted {
  color: var(--muted);
  font-size: 13px;
}
.warning {
  background: var(--warn-bg);
  color: var(--warn);
  padding: 8px 12px;
  border-radius: 6px;
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
.placeholder {
  color: var(--muted);
}

/* The car park: charge points on the left, the CSMS on the right, the wire between. */
.stage {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(120px, 1fr) 170px;
  gap: 12px 0;
  align-items: stretch;
}
.charger {
  grid-column: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.charger header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
}
.badge.v-16 {
  background: var(--v16-bg);
  color: var(--v16);
}
.badge.v-201 {
  background: var(--v201-bg);
  color: var(--v201);
}
.badge.v-21 {
  background: var(--v21-bg);
  color: var(--v21);
}
.dot {
  font-size: 12px;
  color: var(--muted);
}
.dot::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--warn);
}
.dot.on::before {
  background: var(--good);
}
.bays {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.bay {
  width: 270px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  display: grid;
  gap: 6px;
  transition: border-color 0.3s;
}
.bay.phase-charging {
  border-color: var(--good);
}
.bay.phase-full {
  border-color: var(--accent);
}
.bay.phase-fault {
  border-color: var(--bad);
}
.bay-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.status {
  font-size: 11px;
  color: var(--ink);
}
.scene {
  width: 100%;
  height: auto;
}
.pedestal {
  fill: var(--hover);
  stroke: var(--border);
}
.screen {
  fill: var(--v201-bg);
}
.socket {
  fill: var(--ink);
}
.bay-lines {
  fill: none;
  stroke: var(--border);
  stroke-dasharray: 6 5;
}
.cable {
  fill: none;
  stroke: var(--ink);
  stroke-width: 3;
  stroke-linecap: round;
}
.cable.flowing {
  stroke: var(--good);
  stroke-dasharray: 5 7;
  animation: flow 0.6s linear infinite;
}
@keyframes flow {
  to {
    stroke-dashoffset: -12;
  }
}
.window {
  fill: var(--bg);
  opacity: 0.85;
}
.wheel {
  fill: #1f2328;
}
.hub {
  fill: #9ca3af;
}
.bolt {
  fill: #facc15;
  stroke: #1f2328;
  stroke-width: 0.8;
}
.full-mark rect {
  fill: var(--accent);
}
.full-mark text {
  fill: var(--accent-ink);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.empty-text {
  fill: var(--muted);
  font-size: 12px;
}
.battery {
  display: grid;
  gap: 4px;
}
.soc {
  height: 8px;
  border-radius: 4px;
  background: var(--hover);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--good);
  transition: width 0.8s ease;
}
.fill.full {
  background: var(--accent);
}
.numbers {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.phase {
  margin: 0;
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.actions button,
.bulk button {
  font-size: 13px;
}

.lane {
  grid-column: 2;
  position: relative;
  min-height: 80px;
  overflow: hidden;
}
.track {
  position: absolute;
  left: 8px;
  right: 8px;
  border-top: 1px dashed var(--border);
}
.track.up {
  top: 40%;
}
.track.down {
  top: 60%;
}
.capsule {
  position: absolute;
  white-space: nowrap;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  animation-duration: 1.6s;
  animation-timing-function: ease-in-out;
  animation-fill-mode: forwards;
}
.capsule.up {
  top: calc(40% - 11px);
  animation-name: to-csms;
}
.capsule.down {
  top: calc(60% - 11px);
  animation-name: to-station;
}
.capsule.call {
  border-color: var(--accent);
  color: var(--accent);
}
.capsule.result {
  color: var(--good);
}
.capsule.error {
  color: var(--bad);
  border-color: var(--bad);
}
@keyframes to-csms {
  from {
    left: 0;
    transform: translateX(0);
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  to {
    left: 100%;
    transform: translateX(-100%);
    opacity: 0;
  }
}
@keyframes to-station {
  from {
    left: 100%;
    transform: translateX(-100%);
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  to {
    left: 0;
    transform: translateX(0);
    opacity: 0;
  }
}
.csms {
  grid-column: 3;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  text-align: center;
}
.csms code {
  font-size: 11px;
  word-break: break-all;
  color: var(--muted);
}
.csms p {
  margin: 0;
  font-size: 13px;
}

.feed h2 {
  font-size: 15px;
  margin: 0 0 8px;
}
.feed ol {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.feed li + li {
  border-top: 1px solid var(--border);
}
.feed-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  width: 100%;
  border: none;
  border-radius: 0;
  background: none;
  text-align: left;
  padding: 6px 10px;
  font-size: 13px;
}
.feed-row:hover {
  background: var(--hover);
}
.time {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.who {
  font-weight: 600;
}
.dir {
  font-size: 12px;
  color: var(--muted);
}
.action.call {
  color: var(--accent);
}
.action.error {
  color: var(--bad);
}
.chip {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
}
.chip.good {
  background: var(--good-bg);
  color: var(--good);
}
.chip.bad {
  background: var(--bad-bg);
  color: var(--bad);
}
.feed pre {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  background: var(--hover);
  overflow: auto;
}

@media (max-width: 900px) {
  .stage {
    grid-template-columns: 1fr;
  }
  .charger,
  .csms {
    grid-column: 1;
    grid-row: auto !important;
  }
  .lane {
    display: none;
  }
  .bay {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cable.flowing {
    animation: none;
  }
  .fill {
    transition: none;
  }
}
</style>
