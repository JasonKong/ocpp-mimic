<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  api,
  connectEvents,
  type EventsConnection,
  type FrameRecord,
  type OcppVersion,
  type PersonaInfo,
  type SiteState,
  type StationSnapshot,
} from '../api.js';
import {
  appUserFor,
  bayView,
  carFor,
  cardFor,
  chargerLabel,
  clockText,
  createPortTracker,
  DEMO_SITE_ID,
  DEMO_WEB_PAYMENT_SECRET,
  DEMO_SPEEDS,
  DEMO_TAG,
  DEMO_VERSIONS,
  demoStations,
  frameLabel,
  MAX_CHARGERS,
  modeAvailable,
  normalizeSetup,
  siteTotals,
  stackedAreas,
  START_MODES,
  VALET_TOKEN,
  type BayView,
  type ChargerPorts,
  type DemoCar,
  type DemoSetup,
  type FrameLabel,
  type PowerSample,
} from '../demo.js';

const STORAGE_KEY = 'ocpp-mimic.demo';

function stored(): DemoSetup | undefined {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text === null ? undefined : normalizeSetup(JSON.parse(text));
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
const copy = (value: DemoSetup): DemoSetup => ({ ...value, chargers: [...value.chargers] });

/** The settings being chosen, and the ones the site was built with. */
const setup = reactive<DemoSetup>(stored() ?? normalizeSetup(undefined));
const built = ref<DemoSetup | undefined>();
const stations = reactive(new Map<string, StationSnapshot>());
const personas = ref<PersonaInfo[]>([]);
const busy = ref(false);
const error = ref<string | undefined>();
const now = ref(Date.now());
/** The site in the built-in CSMS, the limit being dragged, and the power over time. */
const siteState = ref<SiteState | undefined>();
const liveCapacityKW = ref(0);
const samples = ref<PowerSample[]>([]);
const MAX_SAMPLES = 150;

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
// A way of starting the chosen version does not have falls back to a card.
watch(
  () => setup.ocpp,
  (ocpp) => {
    if (!modeAvailable(setup.mode, ocpp)) setup.mode = 'card';
  },
);
const builtMode = computed(() => START_MODES.find((m) => m.id === built.value?.mode));
const changed = computed(
  () => built.value === undefined || JSON.stringify(built.value) !== JSON.stringify(copy(setup)),
);

function addCharger() {
  if (setup.chargers.length < MAX_CHARGERS) setup.chargers.push('dual');
}
function removeCharger(index: number) {
  if (setup.chargers.length > 1) setup.chargers.splice(index, 1);
}
function setPorts(index: number, ports: ChargerPorts) {
  setup.chargers[index] = ports;
}

interface Bay {
  key: string;
  stationId: string;
  connectorId: number;
  /** Counts every bay of the site from 0, for its car and its card. */
  index: number;
  car: DemoCar;
  view: BayView;
}

interface Charger {
  station: StationSnapshot;
  label: string;
  /** What each connector offers at most, in W. */
  offeredW: number;
  /** One supply the connectors share, in W, when the charge point has one. */
  stationW?: number;
  bays: Bay[];
}

const DEFAULT_OFFERED_W = 7360;
const powerOf = (station: StationSnapshot) =>
  personas.value.find((p) => p.id === station.persona)?.power;
const offeredOf = (station: StationSnapshot) => powerOf(station)?.offeredW ?? DEFAULT_OFFERED_W;

const chargers = computed<Charger[]>(() => {
  let index = 0;
  return [...stations.values()]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((station) => ({
      station,
      label: chargerLabel(station.id),
      offeredW: offeredOf(station),
      ...((w) => (w === undefined ? {} : { stationW: w }))(powerOf(station)?.stationW),
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
const totals = computed(() => siteTotals([...stations.values()]));
/** How long the car that became full first has stayed in its bay. */
const longestFullMs = computed(() => {
  const since = [...fullSince.values()];
  return since.length === 0 ? undefined : now.value - Math.min(...since);
});
/** The power a connector could take, for the manager's bars. */
const siteMaxW = computed(() =>
  chargers.value.reduce(
    (sum, c) => sum + Math.min(c.offeredW * c.bays.length, c.stationW ?? Infinity),
    0,
  ),
);

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

async function load(ids: string[]) {
  const snapshots = await Promise.all(ids.map((id) => api.station(id)));
  stations.clear();
  for (const snapshot of snapshots) {
    stations.set(snapshot.id, snapshot);
    track(snapshot);
  }
}

/** Deletes the demo stations and builds the site the setup describes. */
async function build() {
  busy.value = true;
  await guard(async () => {
    const next = copy(setup);
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
      if (next.mode === 'autocharge') await api.setBehaviour(id, { autocharge: true });
      if (next.mode === 'valet') {
        await api.autoStart(id, { idToken: VALET_TOKEN, type: 'Central' });
      } else {
        await api.autoStart(id, null).catch(() => {
          // Not the built-in CSMS: there is no auto start to turn off.
        });
      }
    }
    const ids = definitions.map((d) => d.id);
    // The site's capacity is the CSMS's to share; without one there is no site.
    siteState.value = undefined;
    samples.value = [];
    if (next.capacityKW !== null) {
      siteState.value = await api.setSite(DEMO_SITE_ID, {
        capacityW: next.capacityKW * 1000,
        stations: ids,
      });
      liveCapacityKW.value = next.capacityKW;
    } else {
      await api.deleteSite(DEMO_SITE_ID).catch(() => {
        // There was no site, or the CSMS is not the built-in one.
      });
    }
    built.value = next;
    remember(next);
    events?.subscribe(ids);
    await load(ids);
  });
  busy.value = false;
}

/** A new site limit, as a grid operator might set one: the CSMS re-allocates at once. */
async function applyCapacity() {
  const current = built.value;
  if (current === undefined || current.capacityKW === null) return;
  const capacityKW = liveCapacityKW.value;
  await guard(async () => {
    siteState.value = await api.setSite(DEMO_SITE_ID, {
      capacityW: capacityKW * 1000,
      stations: [...stations.keys()],
    });
    built.value = { ...current, capacityKW };
    setup.capacityKW = capacityKW;
    remember(built.value);
  });
}

async function refreshSite() {
  if (built.value?.capacityKW === null || built.value === undefined) return;
  try {
    siteState.value = await api.site(DEMO_SITE_ID);
  } catch {
    // The site is gone (the CSMS restarted); the panel shows what it last knew.
  }
}

function samplePower() {
  if (stations.size === 0) return;
  const byCharger: Record<string, number> = {};
  for (const station of stations.values()) {
    byCharger[station.id] = station.connectors.reduce((sum, c) => sum + c.powerW, 0);
  }
  samples.value = [...samples.value, { at: Date.now(), byCharger }].slice(-MAX_SAMPLES);
}

const plug = (bay: Bay) => guard(() => api.plug(bay.stationId, bay.connectorId, bay.car.profile));
const unplug = (bay: Bay) => guard(() => api.unplug(bay.stationId, bay.connectorId));
async function tapCard(bay: Bay) {
  await guard(async () => {
    const station = stations.get(bay.stationId);
    const type = station?.ocpp === '1.6' ? undefined : 'ISO14443';
    const { result } = await api.idTag(bay.stationId, bay.connectorId, cardFor(bay.index), type);
    if (result !== 'authorized' && result !== 'stopping') {
      error.value = `${cardFor(bay.index)}: ${result}`;
    }
  });
}
async function appStart(bay: Bay) {
  await guard(async () => {
    const answer = await api.remoteStart(
      bay.stationId,
      { idToken: appUserFor(bay.index), type: 'Central' },
      bay.connectorId,
    );
    if (answer.status !== 'Accepted') error.value = `${answer.action}: ${answer.status}`;
  });
}
/** 2.1: a bank card at the charge point's payment terminal. */
async function payByCard(bay: Bay) {
  await guard(async () => {
    const { result } = await api.payment(bay.stationId, bay.connectorId, { brand: 'Visa' });
    if (result !== 'authorized') error.value = `Payment terminal: ${result}`;
  });
}
const stopAtTerminal = (bay: Bay) =>
  guard(async () => {
    const { result } = await api.stopPayment(bay.stationId, bay.connectorId);
    if (result === 'no-payment') error.value = 'No payment to stop';
  });
/**
 * 2.1: the driver scans the QR code and pays on the web page; the CSMS checks
 * the code, tells the station a web payment started, and starts the session.
 */
async function scanAndPay(bay: Bay) {
  await guard(async () => {
    const { url } = await api.paymentUrl(bay.stationId, bay.connectorId);
    const checked = await api.webPayment(bay.stationId, url, DEMO_WEB_PAYMENT_SECRET);
    if (checked.valid === false) {
      error.value = `QR code: ${checked.reason ?? 'not valid'}`;
      return;
    }
    const answer = await api.remoteStart(
      bay.stationId,
      { idToken: `PSP-${String(bay.index + 1).padStart(4, '0')}`, type: 'DirectPayment' },
      bay.connectorId,
    );
    if (answer.status !== 'Accepted') error.value = `${answer.action}: ${answer.status}`;
  });
}

async function appStop(bay: Bay) {
  await guard(async () => {
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
/** The ways where the driver starts each car: what starts one. */
const STARTERS: Partial<Record<DemoSetup['mode'], (bay: Bay) => Promise<unknown>>> = {
  card: tapCard,
  app: appStart,
  payment: payByCard,
  qr: scanAndPay,
};
const START_ALL_TEXT: Partial<Record<DemoSetup['mode'], string>> = {
  card: 'Tap every card',
  app: 'Start every car in the app',
  payment: 'Pay for every car',
  qr: 'Scan every QR code',
};
const startAll = () => {
  const start = built.value === undefined ? undefined : STARTERS[built.value.mode];
  return start === undefined
    ? Promise.resolve()
    : everyBay((b) => b.view.phase === 'plugged', start);
};

const canStartAll = computed(
  () =>
    built.value !== undefined &&
    STARTERS[built.value.mode] !== undefined &&
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
  waiting: 'Waiting for power',
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
      case 'payment':
        return 'Waiting for a bank card';
      case 'qr':
        return 'Waiting for the QR code to be paid';
      case 'autocharge':
        return 'The car identifies itself';
      default:
        return 'Starting by itself';
    }
  }
  if (bay.view.phase === 'finished') return 'Unplug to free the bay';
  if (bay.view.phase === 'waiting') return 'The site limit leaves it nothing yet';
  if (bay.view.phase === 'full') {
    const since = fullSince.get(bay.key);
    return since === undefined ? 'Full' : `Still in the bay for ${clockText(now.value - since)}`;
  }
  return undefined;
}

const versionLabel = (ocpp: OcppVersion) => (ocpp === '1.6' ? '1.6J' : ocpp);
const portName = (ocpp: OcppVersion) => (ocpp === '1.6' ? 'Connector' : 'EVSE');
const kw = (w: number) => (w / 1000).toFixed(1);
const connectionText = (station: StationSnapshot) =>
  station.connected
    ? station.registration === 'Accepted'
      ? 'online'
      : station.registration
    : 'connecting…';

/** The pedestal runs down the whole charge point: rounded at its top and bottom only. */
function pedestal(index: number, count: number) {
  const top = index === 0 ? 4 : -8;
  const bottom = index === count - 1 ? 108 : 120;
  return { y: top, height: bottom - top };
}

/** The limit slider goes up to every connector at its most (or the limit, if higher). */
const chartMaxW = computed(() =>
  Math.max(siteMaxW.value, (built.value?.capacityKW ?? 0) * 1000, 1000),
);
/** The chart's top: room above the limit and the highest power it shows. */
const chartTopW = computed(() => {
  const peak = samples.value.reduce(
    (most, sample) =>
      Math.max(
        most,
        Object.values(sample.byCharger).reduce((a, b) => a + b, 0),
      ),
    0,
  );
  const capacity = (built.value?.capacityKW ?? 0) * 1000;
  return Math.max(capacity * 1.25, peak * 1.1, 1000);
});
const CHART_W = 260;
const CHART_H = 96;
const CHARGER_COLOURS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2'];
const colourOf = (stationId: string) =>
  CHARGER_COLOURS[chargers.value.findIndex((c) => c.station.id === stationId) % 6] ?? '#6b7280';
const areas = computed(() =>
  stackedAreas(
    samples.value,
    chargers.value.map((c) => c.station.id),
    CHART_W,
    CHART_H,
    chartTopW.value,
  ),
);
const limitY = computed(() => {
  const capacity = (built.value?.capacityKW ?? 0) * 1000;
  return CHART_H - (Math.min(capacity, chartTopW.value) / chartTopW.value) * CHART_H;
});
/** The limit the CSMS gave a connector's session, in W, when it gave one. */
function limitOf(bay: Bay): number | undefined {
  const station = stations.get(bay.stationId);
  return station?.connectors.find((c) => c.connectorId === bay.connectorId)?.limitW;
}
const portMaxOf = (bay: Bay) =>
  chargers.value.find((c) => c.station.id === bay.stationId)?.offeredW ?? DEFAULT_OFFERED_W;
const pct = (w: number, of: number) => `${Math.max(0, Math.min(100, (w / of) * 100))}%`;

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
    case 'payment':
      return 'Hears the card payments and their settlement';
    case 'qr':
      return 'Plays the payment page behind the QR codes, then starts the sessions';
    case 'autocharge':
      return 'Authorizes each car by its EVCCID';
    default:
      return '';
  }
});

/** App and valet need ocpp-mimic's built-in CSMS, which can send the remote starts. */
const needsBuiltin = computed(
  () =>
    (built.value?.mode === 'app' || built.value?.mode === 'valet' || built.value?.mode === 'qr') &&
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
  let ticks = 0;
  clock = setInterval(() => {
    now.value = Date.now();
    ticks += 1;
    if (ticks % 2 === 0) {
      samplePower();
      void refreshSite();
    }
  }, 1000);
  await guard(async () => {
    personas.value = (await api.personas()).personas;
    // Pick up a site built earlier, when its stations are still there.
    const previous = stored();
    const { stations: tagged } = await api.stationSummaries({ tag: DEMO_TAG });
    if (previous === undefined || tagged.length === 0) return;
    built.value = previous;
    if (previous.capacityKW !== null) liveCapacityKW.value = previous.capacityKW;
    const ids = tagged.map((s) => s.id);
    events?.subscribe(ids);
    await load(ids);
    await refreshSite();
  });
});

onUnmounted(() => {
  events?.close();
  clearInterval(clock);
});
</script>

<template>
  <section class="demo">
    <div class="setup" aria-label="Site setup">
      <div class="row">
        <label class="label">
          Site
          <input v-model.trim="setup.site" class="site-name" aria-label="Site name" />
        </label>
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
            :disabled="!modeAvailable(m.id, setup.ocpp)"
            :title="
              modeAvailable(m.id, setup.ocpp) ? m.where : `OCPP ${m.versions?.join(', ')} only`
            "
            @click="setup.mode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <p class="summary">
        {{ mode?.summary }} <span class="where">Used at: {{ mode?.where }}.</span>
      </p>
      <div class="row chargers-row">
        <span class="label">Charge points</span>
        <div v-for="(ports, i) in setup.chargers" :key="i" class="charger-chip">
          <strong>CP-{{ i + 1 }}</strong>
          <div class="segmented small" role="radiogroup" :aria-label="`Ports on CP-${i + 1}`">
            <button
              v-for="p in ['single', 'dual'] as const"
              :key="p"
              role="radio"
              :aria-checked="ports === p"
              :class="{ on: ports === p }"
              @click="setPorts(i, p)"
            >
              {{ p === 'single' ? 'Single' : 'Dual' }}
            </button>
          </div>
          <button
            v-if="setup.chargers.length > 1"
            class="remove"
            :aria-label="`Remove CP-${i + 1}`"
            @click="removeCharger(i)"
          >
            ✕
          </button>
        </div>
        <button v-if="setup.chargers.length < MAX_CHARGERS" @click="addCharger">
          Add a charge point
        </button>
      </div>
      <div class="row">
        <label class="label">
          Battery speed
          <select v-model.number="setup.speed" aria-label="Battery speed">
            <option v-for="s in DEMO_SPEEDS" :key="s" :value="s">
              {{ s === 1 ? 'Real time' : `×${s}` }}
            </option>
          </select>
        </label>
        <label class="label">
          Site capacity
          <input
            v-model.number="setup.capacityKW"
            class="capacity-input"
            type="number"
            min="0"
            step="0.5"
            :disabled="setup.capacityKW === null"
            aria-label="Site capacity in kW"
          />
          kW
        </label>
        <label class="label">
          <input
            type="checkbox"
            :checked="setup.capacityKW === null"
            @change="setup.capacityKW = setup.capacityKW === null ? 22 : null"
          />
          No limit
        </label>
        <label class="label csms-field">
          CSMS
          <input v-model.trim="setup.csmsUrl" spellcheck="false" aria-label="CSMS address" />
        </label>
        <button class="primary" :disabled="busy || setup.csmsUrl === ''" @click="build">
          {{ built ? (changed ? 'Rebuild with these settings' : 'Start again') : 'Build the site' }}
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
        <button v-if="START_ALL_TEXT[built.mode]" :disabled="!canStartAll" @click="startAll">
          {{ START_ALL_TEXT[built.mode] }}
        </button>
        <button :disabled="!bays.some((b) => b.view.plugged)" @click="unplugAll">
          Unplug every car
        </button>
      </div>

      <div class="site">
        <h3 class="area-title" style="grid-column: 1; grid-row: 1">Charging area</h3>
        <h3 class="area-title manager-title" style="grid-row: 1">Site manager</h3>
        <template v-for="(charger, row) in chargers" :key="charger.station.id">
          <article class="charger" :style="{ gridRow: row + 2 }">
            <header>
              <strong>{{ charger.label }}</strong>
              <span class="badge" :class="'v-' + charger.station.ocpp.replace(/\./g, '')">
                {{ versionLabel(charger.station.ocpp) }}
              </span>
              <span class="muted">
                {{ charger.bays.length === 2 ? 'Dual port' : 'Single port' }} ·
                {{ kw(charger.offeredW) }} kW per port
                <template v-if="charger.stationW !== undefined">
                  · {{ kw(charger.stationW) }} kW shared
                </template>
              </span>
              <span class="dot" :class="{ on: charger.station.connected }">
                {{ connectionText(charger.station) }}
              </span>
            </header>
            <div
              v-for="(bay, i) in charger.bays"
              :key="bay.key"
              class="bay-row"
              :class="'phase-' + bay.view.phase"
            >
              <svg
                class="scene"
                viewBox="0 0 280 112"
                role="img"
                :aria-label="`${charger.label} ${portName(charger.station.ocpp)} ${bay.connectorId}: ${PHASE_TEXT[bay.view.phase]}`"
              >
                <rect
                  x="8"
                  :y="pedestal(i, charger.bays.length).y"
                  width="40"
                  :height="pedestal(i, charger.bays.length).height"
                  rx="6"
                  class="pedestal"
                />
                <rect v-if="i === 0" x="16" y="12" width="24" height="14" rx="2" class="screen" />
                <circle cx="28" cy="64" r="10" class="socket" />
                <text x="28" y="68.5" text-anchor="middle" class="socket-label">
                  {{ bay.connectorId }}
                </text>
                <rect x="96" y="8" width="178" height="96" rx="6" class="bay-lines" />
                <path
                  v-if="bay.view.plugged"
                  d="M 38 64 C 70 64, 86 84, 122 80"
                  class="cable"
                  :class="{ flowing: bay.view.phase === 'charging' }"
                />
                <g v-if="bay.view.plugged" class="car" transform="translate(118 40)">
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
                <text v-else x="185" y="60" text-anchor="middle" class="empty-text">Empty bay</text>
              </svg>
              <div class="bay-info">
                <div class="bay-head">
                  <span>{{ portName(charger.station.ocpp) }} {{ bay.connectorId }}</span>
                  <code class="status">{{ bay.view.status }}</code>
                </div>
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
                  <template v-if="bay.view.plugged"> · {{ bay.car.name }}</template>
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
                  <template v-if="built.mode === 'payment'">
                    <button
                      v-if="bay.view.phase === 'plugged'"
                      class="primary"
                      @click="payByCard(bay)"
                    >
                      Pay by card
                    </button>
                    <button v-if="bay.view.transaction" @click="stopAtTerminal(bay)">
                      Stop at the terminal
                    </button>
                  </template>
                  <template v-if="built.mode === 'qr'">
                    <button
                      v-if="bay.view.phase === 'plugged'"
                      class="primary"
                      @click="scanAndPay(bay)"
                    >
                      Scan the QR code and pay
                    </button>
                    <button v-if="bay.view.transaction" @click="appStop(bay)">
                      Stop on the web page
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
          <div class="lane" :style="{ gridRow: row + 2 }" aria-hidden="true">
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
        <aside class="manager" :style="{ gridRow: `2 / span ${chargers.length}` }">
          <header>
            <strong>{{ built.site }}</strong>
            <span class="muted">
              {{ builtMode?.label }} · OCPP {{ versionLabel(built.ocpp) }} ·
              {{ built.speed === 1 ? 'real time' : `batteries ×${built.speed}` }}
            </span>
          </header>
          <div class="metrics">
            <div class="metric">
              <span>Site power</span>
              <strong>
                {{ kw(totals.powerW) }}
                <small v-if="built.capacityKW !== null">/ {{ built.capacityKW }}</small>
                kW
              </strong>
            </div>
            <div class="metric">
              <span>Energy delivered</span>
              <strong>{{ (totals.energyWh / 1000).toFixed(1) }} kWh</strong>
            </div>
            <div class="metric">
              <span>Charging</span>
              <strong>{{ totals.charging }} of {{ bays.length }}</strong>
            </div>
            <div class="metric">
              <span>Full, still parked</span>
              <strong>
                {{ totals.full }}
                <small v-if="longestFullMs !== undefined">
                  · up to {{ clockText(longestFullMs) }}
                </small>
              </strong>
            </div>
          </div>
          <div v-if="built.capacityKW !== null" class="capacity-box">
            <label class="limit-row">
              <span>Site limit</span>
              <strong>{{ liveCapacityKW.toFixed(1) }} kW</strong>
            </label>
            <input
              v-model.number="liveCapacityKW"
              type="range"
              min="0"
              :max="Math.ceil(chartMaxW / 1000)"
              step="0.5"
              aria-label="Site limit in kW"
              @change="applyCapacity"
            />
            <div class="gauge" :title="`${kw(totals.powerW)} of ${built.capacityKW} kW`">
              <span
                class="gauge-fill"
                :class="{ over: totals.powerW > built.capacityKW * 1000 + 50 }"
                :style="{ width: pct(totals.powerW, Math.max(built.capacityKW * 1000, 1)) }"
              />
            </div>
            <span class="muted">
              The CSMS shares it between the sessions with smart charging
              <template v-if="siteState"> · {{ kw(siteState.allocatedW) }} kW given out </template>
            </span>
          </div>
          <h4>Power over time</h4>
          <svg
            class="chart"
            :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
            role="img"
            aria-label="The site's power over time, by charge point, with the site limit"
          >
            <path
              v-for="area in areas"
              :key="area.id"
              :d="area.d"
              :fill="colourOf(area.id)"
              fill-opacity="0.55"
            />
            <line
              v-if="built.capacityKW !== null"
              x1="0"
              :x2="CHART_W"
              :y1="limitY"
              :y2="limitY"
              class="limit-line"
            />
          </svg>
          <div class="legend">
            <span v-for="c in chargers" :key="c.station.id">
              <i :style="{ background: colourOf(c.station.id) }" />{{ c.label }}
            </span>
            <span v-if="built.capacityKW !== null"><i class="limit-key" />Site limit</span>
          </div>
          <h4>Power by connector</h4>
          <ul class="loads">
            <li v-for="bay in bays" :key="bay.key">
              <span class="who"> {{ chargerLabel(bay.stationId) }} · {{ bay.connectorId }} </span>
              <span class="load-bar">
                <span
                  class="load-fill"
                  :class="'phase-' + bay.view.phase"
                  :style="{ width: pct(bay.view.powerW, portMaxOf(bay)) }"
                />
                <span
                  v-if="limitOf(bay) !== undefined"
                  class="limit-mark"
                  :style="{ left: pct(limitOf(bay) ?? 0, portMaxOf(bay)) }"
                />
              </span>
              <span class="kw">
                {{ kw(bay.view.powerW) }}
                <template v-if="limitOf(bay) !== undefined">
                  / {{ kw(limitOf(bay) ?? 0) }}
                </template>
                kW
              </span>
            </li>
          </ul>
          <p class="muted capacity">
            Up to {{ kw(siteMaxW) }} kW if every connector draws its most<template
              v-if="built.capacityKW !== null"
              >; the marks are the limits the CSMS set</template
            >.
          </p>
          <template v-if="siteState && siteState.sent.length > 0">
            <h4>Limits sent</h4>
            <ol class="sent">
              <li v-for="(entry, i) in siteState.sent.slice(0, 6)" :key="i">
                <span class="time">{{ timeOf(entry.at) }}</span>
                {{ chargerLabel(entry.stationId) }} · {{ entry.evseId }} →
                <strong>{{ kw(entry.limitW) }} kW</strong>
                <span class="chip" :class="entry.status === 'Accepted' ? 'good' : 'bad'">
                  {{ entry.status }}
                </span>
              </li>
            </ol>
          </template>
          <p class="csms-line">
            <span class="muted">CSMS</span> <code>{{ built.csmsUrl }}</code>
            <br />
            {{ csmsLine }}
          </p>
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
                {{ chargerLabel(item.stationId) }}
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
      Name the site, choose a version and how sessions start, add its charge points, then build it.
      The stations are real ocpp-mimic stations: every message below goes over the wire to the CSMS.
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
.site-name {
  width: 160px;
}
.csms-field input {
  width: 240px;
  max-width: 60vw;
  font-family: ui-monospace, monospace;
}
.summary {
  margin: -2px 0 0;
  font-size: 13px;
  color: var(--muted);
}
.where {
  font-style: italic;
}
.segmented button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
.segmented.small button {
  padding: 2px 8px;
  font-size: 12px;
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
.charger-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 13px;
}
.charger-chip .remove {
  border: none;
  background: none;
  padding: 0 4px;
  color: var(--muted);
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

/* The site: the charging area on the left, the site manager on the right, the wire between. */
.site {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(90px, 1fr) minmax(240px, 300px);
  gap: 12px 0;
  align-items: stretch;
}
.area-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.manager-title {
  grid-column: 3;
}
.charger {
  grid-column: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 0;
}
.charger header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
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
.bay-row {
  display: grid;
  grid-template-columns: 280px minmax(220px, 1fr);
  gap: 12px;
  align-items: center;
}
.scene {
  width: 280px;
  height: 112px;
  display: block;
}
.pedestal {
  fill: var(--hover);
  stroke: var(--border);
}
.screen {
  fill: var(--v201-bg);
}
.socket {
  fill: var(--bg);
  stroke: var(--ink);
  stroke-width: 2;
}
.socket-label {
  fill: var(--ink);
  font-size: 12px;
  font-weight: 700;
}
.bay-lines {
  fill: none;
  stroke: var(--border);
  stroke-dasharray: 6 5;
  transition: stroke 0.3s;
}
.phase-charging .bay-lines {
  stroke: var(--good);
}
.phase-full .bay-lines {
  stroke: var(--accent);
}
.phase-fault .bay-lines {
  stroke: var(--bad);
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
.bay-info {
  display: grid;
  gap: 5px;
  padding: 6px 0;
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

.manager {
  grid-column: 3;
  align-self: start;
  position: sticky;
  top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: grid;
  gap: 10px;
}
.manager header {
  display: grid;
  gap: 2px;
}
.manager h4 {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.metric {
  display: grid;
  gap: 2px;
  padding: 8px;
  border-radius: 6px;
  background: var(--hover);
}
.metric span {
  font-size: 12px;
  color: var(--muted);
}
.metric strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.metric small {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}
.capacity-input {
  width: 72px;
}
.capacity-box {
  display: grid;
  gap: 6px;
  padding: 8px;
  border-radius: 6px;
  border: 1px dashed var(--border);
}
.limit-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.gauge {
  height: 8px;
  border-radius: 4px;
  background: var(--hover);
  overflow: hidden;
}
.gauge-fill {
  display: block;
  height: 100%;
  background: var(--good);
  transition: width 0.8s ease;
}
.gauge-fill.over {
  background: var(--bad);
}
.chart {
  width: 100%;
  height: auto;
  border-radius: 6px;
  background: var(--hover);
}
.limit-line {
  stroke: var(--bad);
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--muted);
}
.legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border-radius: 2px;
  vertical-align: -1px;
}
.legend i.limit-key {
  height: 0;
  border-top: 2px dashed var(--bad);
  border-radius: 0;
}
.limit-mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: var(--ink);
}
.sent {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 12px;
}
.load-fill.phase-waiting {
  background: var(--warn);
}
.loads {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.loads li {
  display: grid;
  grid-template-columns: 64px 1fr 92px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.load-bar {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--hover);
}
.load-fill {
  border-radius: 4px;
}
.load-fill {
  display: block;
  height: 100%;
  background: var(--good);
  transition: width 0.8s ease;
}
.load-fill.phase-full {
  background: var(--accent);
}
.kw {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.capacity {
  margin: 0;
  font-size: 12px;
}
.csms-line {
  margin: 0;
  font-size: 12px;
}
.csms-line code {
  font-size: 11px;
  word-break: break-all;
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

@media (max-width: 1080px) {
  .site {
    grid-template-columns: 1fr;
  }
  .area-title,
  .manager-title,
  .charger,
  .manager {
    grid-column: 1 !important;
    grid-row: auto !important;
  }
  .manager {
    position: static;
  }
  .lane,
  .manager-title {
    display: none;
  }
}
@media (max-width: 620px) {
  .bay-row {
    grid-template-columns: 1fr;
  }
  .scene {
    width: 100%;
    height: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cable.flowing {
    animation: none;
  }
  .fill,
  .load-fill {
    transition: none;
  }
}
</style>
