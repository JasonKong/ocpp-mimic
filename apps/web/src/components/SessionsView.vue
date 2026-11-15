<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  FrameRecord,
  ReferenceTariff,
  SessionDetail,
  SessionSummary,
  StationSnapshot,
} from '../api.js';
import { versionInfo } from '../versions.js';
import EnergyPanel from './EnergyPanel.vue';
import PriceCard from './PriceCard.vue';
import SessionHeader from './SessionHeader.vue';
import SessionList from './SessionList.vue';
import VehicleCard from './VehicleCard.vue';
import VersionBadge from './VersionBadge.vue';

/**
 * The Sessions view of a station: its sessions, and the open one with how it
 * started. The panels share the CSMS view / show-truth toggle (R-SRC-1).
 */
const props = defineProps<{
  station: StationSnapshot;
  sessions: SessionSummary[];
  detail?: SessionDetail | undefined;
  selectedN?: number | undefined;
  /** The open session's frames, once loaded. */
  frames?: FrameRecord[] | undefined;
  showTruth: boolean;
  now: number;
  tariff?: ReferenceTariff | undefined;
}>();
const emit = defineEmits<{
  select: [n: number];
  'update:showTruth': [value: boolean];
  'load-frames': [];
  'remote-start': [request: { idToken: string; type?: string; evseId?: number }];
  'save-tariff': [tariff: ReferenceTariff];
}>();

const info = computed(() => versionInfo(props.station.ocpp));
/** The EV plugged in at the session's EVSE, for the truth. */
const evOf = (evseId: number | undefined) =>
  props.station.connectors.find((c) => (c.evseId ?? c.connectorId) === evseId)?.ev;
const evses = computed(() => props.station.connectors.map((c) => c.evseId ?? c.connectorId));

const remote = ref({ idToken: 'APP-USER-1', type: 'Central', evseId: 0 });
function remoteStart() {
  emit('remote-start', {
    idToken: remote.value.idToken,
    ...(info.value.tokenType && { type: remote.value.type }),
    ...(remote.value.evseId > 0 && { evseId: remote.value.evseId }),
  });
}

const openSeq = ref<number | undefined>();
const openFrames = computed(() =>
  openSeq.value === undefined
    ? []
    : (props.frames ?? []).filter((f) => f.seq === openSeq.value || pairOf(f)),
);
/** The answer of the open CALL travels with it. */
function pairOf(frame: FrameRecord): boolean {
  const call = props.frames?.find((f) => f.seq === openSeq.value);
  return call !== undefined && frame.uniqueId === call.uniqueId && frame.seq !== call.seq;
}
function openFrame(seq: number) {
  openSeq.value = seq;
  if (props.frames === undefined) emit('load-frames');
}
</script>

<template>
  <section class="sessions">
    <header>
      <h2>Sessions <VersionBadge :version="station.ocpp" /></h2>
      <div class="view-switch" role="group" aria-label="Which values to show">
        <button :class="{ on: !showTruth }" @click="emit('update:showTruth', false)">
          CSMS view
        </button>
        <button :class="{ on: showTruth }" @click="emit('update:showTruth', true)">
          Show truth
        </button>
      </div>
    </header>

    <form
      v-if="station.csms === 'builtin'"
      class="remote"
      title="Has the built-in CSMS start a session, as a third-party app would through its CSMS"
      @submit.prevent="remoteStart"
    >
      <span class="label">Remote start via the built-in CSMS</span>
      <input v-model="remote.idToken" required :aria-label="info.terms.token" />
      <input v-if="info.tokenType" v-model="remote.type" class="type" aria-label="idToken type" />
      <select v-model.number="remote.evseId" :aria-label="info.terms.evse">
        <option :value="0">any {{ info.terms.evse }}</option>
        <option v-for="id in evses" :key="id" :value="id">{{ info.terms.evse }} {{ id }}</option>
      </select>
      <button class="primary" type="submit">Send</button>
    </form>
    <p v-else-if="station.csms === 'external'" class="hint">
      Remote starts come from the station's CSMS; this station's CSMS is not the built-in one.
    </p>

    <div class="layout">
      <SessionList
        :sessions="sessions"
        :selected-n="selectedN"
        :version="station.ocpp"
        @select="emit('select', $event)"
      />
      <div class="open">
        <template v-if="detail">
          <SessionHeader
            :detail="detail"
            :version="station.ocpp"
            :now="now"
            @open-frame="openFrame"
          />
          <template v-if="detail.session.state !== 'not-started'">
            <EnergyPanel :detail="detail" :show-truth="showTruth" :now="now" />
            <VehicleCard
              :detail="detail"
              :version="station.ocpp"
              :ev="evOf(detail.session.evseId)"
              :show-truth="showTruth"
              @open-frame="openFrame"
            />
            <PriceCard
              :detail="detail"
              :version="station.ocpp"
              :tariff="tariff"
              @save-tariff="emit('save-tariff', $event)"
              @open-frame="openFrame"
            />
          </template>
        </template>
        <p v-else class="hint">{{ sessions.length > 0 ? 'Pick a session.' : '' }}</p>
      </div>
    </div>

    <div v-if="openSeq !== undefined" class="overlay" @click.self="openSeq = undefined">
      <div class="modal">
        <header>
          <strong>Frame {{ openSeq }}</strong>
          <button @click="openSeq = undefined">Close</button>
        </header>
        <p v-if="frames === undefined" class="hint">Loading…</p>
        <pre v-for="frame in openFrames" :key="frame.seq">{{ frame.text }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sessions {
  display: grid;
  gap: 12px;
  min-width: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
h2 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.view-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.view-switch button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 4px 10px;
}
.view-switch button.on {
  background: var(--accent);
  color: var(--accent-ink);
}
.remote {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.remote .label {
  font-size: 13px;
  color: var(--muted);
}
.remote .type {
  width: 7em;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr);
  gap: 16px;
  align-items: start;
}
.layout > * {
  min-width: 0;
}
.open {
  display: grid;
  gap: 16px;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: grid;
  place-items: center;
  z-index: 10;
}
.modal {
  background: var(--bg);
  border-radius: 8px;
  padding: 12px;
  width: min(720px, 92vw);
  max-height: 80vh;
  overflow: auto;
}
pre {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
}
</style>
