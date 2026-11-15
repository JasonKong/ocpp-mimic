<script setup lang="ts">
import { computed } from 'vue';
import type { SessionDetail } from '../api.js';
import { formatEnergy, formatPower, formatTime } from '../format.js';
import { energyFigures, formatDuration } from '../sessions.js';
import EnergyChart from './EnergyChart.vue';

/**
 * Energy, power, SoC and time of the open session, the time to its target as
 * a third party would estimate it (and the simulator's truth beside it), and
 * the chart (R-NRG-1 to R-NRG-5).
 */
const props = defineProps<{
  detail: SessionDetail;
  showTruth: boolean;
  now: number;
  highlightAt?: string | undefined;
}>();
const emit = defineEmits<{ 'select-time': [t: number] }>();
const f = computed(() => energyFigures(props.detail, props.now));
const finished = computed(() => props.detail.session.state === 'finished');
const fmtTime = (iso: string) => formatTime(iso).slice(0, 5);
</script>

<template>
  <section class="energy-panel">
    <h4>Energy</h4>
    <div class="figures">
      <div class="figure">
        <span class="label">Delivered <span class="src reported">reported</span></span>
        <span class="value">{{ formatEnergy(f.energyWh) }}</span>
      </div>
      <div class="figure">
        <span class="label">Power <span class="src reported">reported</span></span>
        <span class="value">{{ f.powerW === undefined ? '—' : formatPower(f.powerW) }}</span>
        <span v-if="showTruth && f.truePowerW !== undefined" class="truth"
          >truth {{ formatPower(f.truePowerW) }}</span
        >
      </div>
      <div class="figure">
        <span class="label">SoC <span class="src reported">reported</span></span>
        <span class="value">{{ f.socPercent === undefined ? '—' : `${f.socPercent} %` }}</span>
        <span v-if="f.socPercent === undefined" class="note">not reported</span>
        <span v-if="showTruth && f.trueSocPercent !== undefined" class="truth"
          >truth {{ f.trueSocPercent.toFixed(1) }} %</span
        >
      </div>
      <div class="figure">
        <span class="label">Charging / suspended</span>
        <span class="value">{{ formatDuration(f.chargingMs) }}</span>
        <span class="note">suspended {{ formatDuration(f.suspendedMs) }}</span>
      </div>
    </div>

    <div v-if="!finished" class="eta" :class="{ off: showTruth && f.off }">
      <span class="label"
        >To {{ f.targetSoc }} %
        <span class="muted"
          >({{ f.targetFrom === 'chargingNeeds' ? 'the EV says' : 'assumed' }})</span
        >
        <span class="src estimate">estimate</span></span
      >
      <span v-if="f.etaAt" class="value"
        >{{ fmtTime(f.etaAt) }} · in {{ formatDuration(f.leftMs ?? 0) }}</span
      >
      <span v-else class="value muted">cannot estimate: {{ f.reason }}</span>
      <span v-if="showTruth && f.trueEtaAt" class="truth"
        >truth {{ fmtTime(f.trueEtaAt) }} · in {{ formatDuration(f.trueLeftMs ?? 0) }}</span
      >
      <span v-if="showTruth && f.off" class="warning" role="status"
        >the estimate is off by {{ formatDuration(f.gapMs ?? 0) }}</span
      >
      <span v-if="f.departureTime" class="note"
        >departure {{ fmtTime(f.departureTime) }}:
        {{
          f.reachesTargetBeforeDeparture
            ? 'reaches the target in time'
            : 'will not reach the target'
        }}</span
      >
    </div>

    <dl v-if="finished" class="summary">
      <div>
        <dt>Total</dt>
        <dd>{{ formatEnergy(f.energyWh) }}</dd>
      </div>
      <div v-if="f.peakPowerW !== undefined">
        <dt>Peak power</dt>
        <dd>{{ formatPower(f.peakPowerW) }}</dd>
      </div>
      <div v-if="f.startSocPercent !== undefined">
        <dt>SoC</dt>
        <dd>{{ f.startSocPercent }} % → {{ f.endSocPercent }} %</dd>
      </div>
      <div v-if="detail.session.stopReason">
        <dt>Stop reason</dt>
        <dd>{{ detail.session.stopReason }}</dd>
      </div>
    </dl>

    <table v-if="f.phases" class="phases">
      <thead>
        <tr>
          <th />
          <th v-for="p in f.phases" :key="p.phase">{{ p.phase }}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>Current</th>
          <td v-for="p in f.phases" :key="p.phase">
            {{ p.currentA === undefined ? '—' : `${p.currentA.toFixed(1)} A` }}
          </td>
        </tr>
        <tr>
          <th>Voltage</th>
          <td v-for="p in f.phases" :key="p.phase">
            {{ p.voltageV === undefined ? '—' : `${p.voltageV.toFixed(0)} V` }}
          </td>
        </tr>
      </tbody>
    </table>

    <EnergyChart
      :session="detail.session"
      :show-truth="showTruth"
      :now="now"
      :highlight-at="highlightAt"
      @select-time="emit('select-time', $event)"
    />
  </section>
</template>

<style scoped>
.energy-panel {
  display: grid;
  gap: 10px;
  min-width: 0;
}
h4 {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.figure,
.eta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.eta.off {
  border-color: var(--warn);
}
.label {
  font-size: 11px;
  color: var(--muted);
}
.value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.eta .value {
  font-size: 16px;
}
.note,
.truth {
  font-size: 12px;
  color: var(--muted);
}
.truth {
  font-style: italic;
}
.muted {
  color: var(--muted);
}
.warning {
  font-size: 12px;
  color: var(--warn);
}
.src {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.src.reported {
  background: var(--hover);
}
.src.estimate {
  background: var(--warn-bg);
  color: var(--warn);
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0;
}
dt {
  font-size: 11px;
  color: var(--muted);
}
dd {
  margin: 0;
}
.phases {
  border-collapse: collapse;
  font-size: 13px;
}
.phases th,
.phases td {
  padding: 2px 10px 2px 0;
  text-align: left;
}
.phases thead th,
.phases tbody th {
  color: var(--muted);
  font-weight: normal;
}
</style>
