<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  ID_TOKEN_TYPES,
  type Behaviour,
  type ConnectorSnapshot,
  type FaultInfo,
  type PersonaInfo,
  type StationSnapshot,
} from '../api.js';
import { formatEnergy, formatPower, statusTone } from '../format.js';
import { evseLabel, versionInfo } from '../versions.js';
import VersionBadge from './VersionBadge.vue';

const props = defineProps<{
  station: StationSnapshot;
  persona: PersonaInfo | undefined;
}>();
const emit = defineEmits<{
  action: [name: string, connectorId?: number, value?: unknown];
}>();

const idTags = reactive<Record<number, string>>({});
/** The IdToken type of the next card, per connector (2.0.1 only). */
const tokenTypes = reactive<Record<number, string>>({});
const info = computed(() => versionInfo(props.station.ocpp));
/** Tokens of this version have a type (2.0.1). */
const typedTokens = computed(() => info.value.tokenType);

/** 2.0.1: EVSE n holds connector 1; 1.6: connector n. */
function title(connector: ConnectorSnapshot): string {
  return evseLabel(props.station.ocpp, connector.evseId ?? connector.connectorId);
}

/** What the EV and the EVSE are doing: the 2.0.1 charging state, or the 1.6 status. */
const stateOf = (connector: ConnectorSnapshot) => connector.chargingState ?? connector.status;

function transaction(connector: ConnectorSnapshot): string {
  if (connector.transactionId === undefined) return '—';
  const id = String(connector.transactionId);
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
const faults = reactive<Record<number, number>>({});
/** EV picked for the next plug-in, per connector; '' plugs in without an EV (fixed power). */
const evChoice = reactive<Record<number, string>>({});

const evNames = (): string[] => Object.keys(props.persona?.evs ?? {});

function plugIn(connector: ConnectorSnapshot) {
  const ev = evChoice[connector.connectorId] ?? '';
  emit('action', 'plug', connector.connectorId, ev === '' ? undefined : ev);
}

const faultCatalogue = (): FaultInfo[] =>
  props.persona?.faults.length
    ? props.persona.faults
    : [{ name: 'Other error', errorCode: 'OtherError' }];

function presentCard(connector: ConnectorSnapshot) {
  const idTag = idTags[connector.connectorId] || connector.idTag || 'TAG-001';
  emit('action', 'idTag', connector.connectorId, {
    idTag,
    ...(typedTokens.value && { type: tokenTypes[connector.connectorId] ?? 'ISO14443' }),
  });
}

function raiseFault(connector: ConnectorSnapshot) {
  const fault = faultCatalogue()[faults[connector.connectorId] ?? 0];
  if (fault !== undefined) emit('action', 'fault', connector.connectorId, fault);
}

function setMultiplier(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value) && value > 0) emit('action', 'energyMultiplier', undefined, value);
}

function toggle(name: keyof Behaviour, event: Event) {
  emit('action', 'behaviour', undefined, { [name]: (event.target as HTMLInputElement).checked });
}

/** Fault injections offered in the UI, with example parameters (`key=value`, space-separated). */
const INJECTIONS = [
  { type: 'powerLoss', label: 'Power loss', example: 'off=10s' },
  { type: 'meterRollback', label: 'Meter rollback', example: 'wh=1000 connector=1' },
  { type: 'meterReset', label: 'Meter reset', example: 'connector=1' },
  { type: 'clockDrift', label: 'Clock drift', example: 'ms=-60000' },
  { type: 'badTimestamp', label: 'Malformed timestamp', example: 'count=1' },
  { type: 'latency', label: 'Latency', example: 'ms=2000 direction=both for=1m' },
  { type: 'drop', label: 'Drop frames', example: 'direction=sent count=1' },
  { type: 'flap', label: 'Flapping connection', example: 'down=5s up=10s times=3' },
  { type: 'noAnswer', label: 'Ignore CSMS calls', example: 'action=RemoteStartTransaction' },
  { type: 'callError', label: 'CALLERROR answers', example: 'errorCode=InternalError' },
  { type: 'malformedJson', label: 'Malformed JSON', example: 'count=1' },
  { type: 'reconnectStorm', label: 'Reconnect storm (all)', example: '' },
] as const;
const injectType = ref<string>(INJECTIONS[0].type);
const injectParams = ref<string>(INJECTIONS[0].example);
const injectExample = computed(
  () => INJECTIONS.find((i) => i.type === injectType.value)?.example ?? '',
);

function pickInjection(event: Event) {
  injectType.value = (event.target as HTMLSelectElement).value;
  injectParams.value = injectExample.value;
}

function inject() {
  const parameters: Record<string, string | number> = {};
  for (const pair of injectParams.value.split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = pair.split('=');
    const value = rest.join('=');
    if (key === undefined || key === '') continue;
    parameters[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  emit('action', 'inject', undefined, { type: injectType.value, ...parameters });
}
</script>

<template>
  <section class="detail">
    <header>
      <div>
        <h2>{{ station.id }}</h2>
        <p class="meta">
          <span
            v-if="station.energyMultiplier !== 1"
            class="badge"
            title="Energy and SoC advance faster than real time; timestamps stay real"
            >energy ×{{ station.energyMultiplier }}</span
          >
          <VersionBadge :version="station.ocpp" />
          {{ station.persona }} · {{ station.csmsUrl }} · connection {{ station.transport }} ·
          {{ station.registration }}
          <span v-if="station.queuedMessages > 0"> · {{ station.queuedMessages }} queued</span>
          <span
            v-for="r in station.reservations.filter((x) => x.connectorId === 0)"
            :key="r.reservationId"
          >
            · reserved for {{ r.idTag }} until {{ r.expiryDate.slice(11, 16) }}</span
          >
          <span v-if="station.localList.size > 0">
            · local list v{{ station.localList.version }} ({{ station.localList.size }})</span
          >
        </p>
      </div>
      <div class="buttons">
        <button v-if="station.running" @click="emit('action', 'stop')">Stop</button>
        <button v-else class="primary" @click="emit('action', 'start')">Start</button>
        <button
          v-if="station.transport === 'open'"
          @click="emit('action', 'offline', undefined, 'clean')"
        >
          Go offline
        </button>
        <button
          v-if="station.transport === 'open'"
          @click="emit('action', 'offline', undefined, 'half-open')"
        >
          Half-open
        </button>
        <button
          v-if="station.transport === 'offline' || station.transport === 'half-open'"
          class="primary"
          @click="emit('action', 'online')"
        >
          Back online
        </button>
        <button class="danger" @click="emit('action', 'delete')">Delete</button>
      </div>
    </header>

    <p v-if="station.injections && station.injections.length > 0" class="injections">
      Fault injections:
      <span v-for="active in station.injections" :key="active.id" class="injection">
        {{ active.injection.type
        }}<template v-if="active.remaining !== undefined"> ×{{ active.remaining }}</template
        ><template v-if="active.until"> until {{ active.until.slice(11, 19) }}</template>
      </span>
      <button class="link" @click="emit('action', 'clearInjections')">Clear</button>
    </p>

    <div class="inject">
      <label>
        Inject
        <select :value="injectType" @change="pickInjection">
          <option v-for="option in INJECTIONS" :key="option.type" :value="option.type">
            {{ option.label }}
          </option>
        </select>
      </label>
      <input v-model="injectParams" :placeholder="injectExample" aria-label="Parameters" />
      <button @click="inject">Inject</button>
    </div>

    <div class="switches">
      <label>
        <input
          type="checkbox"
          :checked="station.behaviour.refuseRemoteStart"
          @change="toggle('refuseRemoteStart', $event)"
        />
        Refuse remote starts
      </label>
      <label>
        <input
          type="checkbox"
          :checked="station.behaviour.cableLock"
          @change="toggle('cableLock', $event)"
        />
        Lock the cable while charging
      </label>
      <label title="Energy and SoC advance this many times faster; timestamps stay real">
        Energy ×
        <input
          :key="station.energyMultiplier"
          class="multiplier"
          type="number"
          min="0.1"
          step="any"
          :value="station.energyMultiplier"
          @change="setMultiplier($event)"
        />
      </label>
    </div>

    <div class="connectors">
      <article
        v-for="connector in station.connectors"
        :key="connector.connectorId"
        class="connector"
      >
        <div class="top">
          <h3>{{ title(connector) }}</h3>
          <span>
            <span v-if="connector.locked" class="status muted" title="The cable is locked">
              Locked
            </span>
            <span class="status" :class="statusTone(connector.status)">{{ connector.status }}</span>
            <span
              v-if="connector.chargingState !== undefined && connector.chargingState !== 'Idle'"
              class="status"
              :class="statusTone(connector.chargingState)"
              title="Charging state"
              >{{ connector.chargingState }}</span
            >
          </span>
        </div>
        <dl>
          <div>
            <dt>Energy</dt>
            <dd>{{ formatEnergy(connector.energyWh) }}</dd>
          </div>
          <div>
            <dt>Power</dt>
            <dd>{{ formatPower(connector.powerW) }}</dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd
              :title="
                connector.transactionId === undefined ? undefined : String(connector.transactionId)
              "
            >
              {{ transaction(connector) }}
            </dd>
          </div>
          <div>
            <dt>Error</dt>
            <dd>{{ connector.errorCode }}</dd>
          </div>
          <div
            v-for="r in station.reservations.filter((x) => x.connectorId === connector.connectorId)"
            :key="r.reservationId"
          >
            <dt>Reserved for</dt>
            <dd>{{ r.idTag }} until {{ r.expiryDate.slice(11, 16) }}</dd>
          </div>
          <div v-if="connector.limitW !== undefined">
            <dt>Limit</dt>
            <dd>{{ formatPower(connector.limitW) }}</dd>
          </div>
          <div v-if="connector.ev">
            <dt>EV</dt>
            <dd>
              {{ connector.ev.name ?? 'custom' }} · {{ connector.ev.profile.capacityKWh }} kWh
            </dd>
          </div>
          <div v-if="connector.ev">
            <dt>SoC</dt>
            <dd>{{ Math.floor(connector.ev.soc) }} %</dd>
          </div>
        </dl>

        <div class="row">
          <template v-if="!connector.plugged">
            <select
              v-if="evNames().length > 0"
              :value="evChoice[connector.connectorId] ?? ''"
              title="EV to plug in"
              @change="evChoice[connector.connectorId] = ($event.target as HTMLSelectElement).value"
            >
              <option value="">No EV (fixed power)</option>
              <option v-for="name in evNames()" :key="name" :value="name">{{ name }}</option>
            </select>
            <button class="primary" @click="plugIn(connector)">Plug in</button>
          </template>
          <button
            v-else
            :disabled="connector.locked"
            :title="connector.locked ? 'The cable is locked' : undefined"
            @click="emit('action', 'unplug', connector.connectorId)"
          >
            Unplug
          </button>
          <input
            v-model="idTags[connector.connectorId]"
            placeholder="TAG-001"
            class="tag"
            :title="info.terms.token"
            :aria-label="info.terms.token"
          />
          <select
            v-if="typedTokens"
            :value="tokenTypes[connector.connectorId] ?? 'ISO14443'"
            title="IdToken type"
            aria-label="IdToken type"
            @change="tokenTypes[connector.connectorId] = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="type in ID_TOKEN_TYPES" :key="type" :value="type">{{ type }}</option>
          </select>
          <button @click="presentCard(connector)">
            {{ connector.transactionId !== undefined ? 'Present card (stop)' : 'Present card' }}
          </button>
        </div>
        <div class="row">
          <button
            v-if="stateOf(connector) === 'SuspendedEV'"
            @click="emit('action', 'evResume', connector.connectorId)"
          >
            EV resumes
          </button>
          <button
            v-else
            :disabled="connector.transactionId === undefined"
            @click="emit('action', 'evSuspend', connector.connectorId)"
          >
            EV pauses / full
          </button>
          <template v-if="connector.status === 'Faulted'">
            <button class="primary" @click="emit('action', 'clearFault', connector.connectorId)">
              Clear fault
            </button>
          </template>
          <template v-else>
            <select
              :value="faults[connector.connectorId] ?? 0"
              @change="
                faults[connector.connectorId] = Number(($event.target as HTMLSelectElement).value)
              "
            >
              <option v-for="(fault, index) in faultCatalogue()" :key="index" :value="index">
                {{ fault.name ?? fault.errorCode }}
              </option>
            </select>
            <button class="danger" @click="raiseFault(connector)">Raise fault</button>
          </template>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.detail {
  display: grid;
  gap: 16px;
}
header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
}
.meta {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.injections {
  margin: 0;
  padding: 6px 10px;
  background: var(--warn-bg);
  color: var(--warn);
  border-radius: 6px;
}
.injection {
  margin-left: 6px;
  font-weight: 600;
}
.inject {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.inject input {
  flex: 1;
  min-width: 160px;
}
.switches {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
}
.badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--warn, #b45309);
  color: #fff;
  font-weight: 600;
}
.multiplier {
  width: 64px;
}
.switches label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.buttons,
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.connectors {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.connector {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: grid;
  gap: 10px;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h3 {
  margin: 0;
  font-size: 14px;
}
dl {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 0;
}
dt {
  font-size: 11px;
  color: var(--muted);
}
dd {
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.tag {
  width: 96px;
}
.status {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--hover);
}
.status.good {
  background: var(--good-bg);
  color: var(--good);
}
.status.warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.status.bad {
  background: var(--bad-bg);
  color: var(--bad);
}
.status + .status {
  margin-left: 6px;
}
.status.muted {
  color: var(--muted);
}
</style>
