<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, type MetricsSummary, type StationSummary } from '../api.js';
import { isCharging } from '../versions.js';

const props = defineProps<{ stations: StationSummary[] }>();

const by = ref<'persona' | 'group'>('persona');
const metrics = ref<MetricsSummary | undefined>();
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    metrics.value = await api.metrics();
  } catch {
    // the overview keeps its last numbers while the engine is away
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 5000);
});
onUnmounted(() => clearInterval(timer));

interface Row {
  name: string;
  stations: number;
  online: number;
  offline: number;
  stopped: number;
  charging: number;
  faulted: number;
}

function row(name: string, stations: StationSummary[]): Row {
  let charging = 0;
  let faulted = 0;
  for (const station of stations) {
    for (const connector of station.connectors) {
      if (isCharging(station.ocpp, connector)) charging++;
      if (connector.status === 'Faulted') faulted++;
    }
  }
  return {
    name,
    stations: stations.length,
    online: stations.filter((s) => s.state === 'connected').length,
    offline: stations.filter((s) => s.state === 'offline' || s.state === 'connecting').length,
    stopped: stations.filter((s) => s.state === 'stopped').length,
    charging,
    faulted,
  };
}

const rows = computed(() => {
  const groups = new Map<string, StationSummary[]>();
  for (const station of props.stations) {
    const key = (by.value === 'persona' ? station.persona : station.group) ?? '(none)';
    groups.set(key, [...(groups.get(key) ?? []), station]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => row(name, list));
});
const total = computed(() => row('All', props.stations));
</script>

<template>
  <section v-if="stations.length > 0" class="overview">
    <header>
      <h2>Fleet</h2>
      <label>
        by
        <select v-model="by">
          <option value="persona">persona</option>
          <option value="group">group</option>
        </select>
      </label>
    </header>
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Stations</th>
          <th>Online</th>
          <th>Offline</th>
          <th>Stopped</th>
          <th>Charging</th>
          <th>Faulted</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows.length > 1 ? [...rows, total] : rows"
          :key="r.name"
          :class="{ total: r === total }"
        >
          <th>{{ r.name }}</th>
          <td>{{ r.stations }}</td>
          <td>{{ r.online }}</td>
          <td :class="{ warn: r.offline > 0 }">{{ r.offline }}</td>
          <td>{{ r.stopped }}</td>
          <td>{{ r.charging }}</td>
          <td :class="{ bad: r.faulted > 0 }">{{ r.faulted }}</td>
        </tr>
      </tbody>
    </table>
    <dl v-if="metrics" class="metrics">
      <div>
        <dt>CSMS latency p50 / p95</dt>
        <dd>{{ metrics.csmsLatency.overall.p50 }} / {{ metrics.csmsLatency.overall.p95 }} ms</dd>
      </div>
      <div>
        <dt>Timeouts</dt>
        <dd :class="{ bad: (metrics.answers.timeout ?? 0) > 0 }">
          {{ metrics.answers.timeout ?? 0 }}
        </dd>
      </div>
      <div>
        <dt>CALLERRORs</dt>
        <dd :class="{ bad: metrics.callErrors.received + metrics.callErrors.sent > 0 }">
          {{ metrics.callErrors.received + metrics.callErrors.sent }}
        </dd>
      </div>
      <div>
        <dt>Connections opened / failed</dt>
        <dd>{{ metrics.connections.opened }} / {{ metrics.connections.failed }}</dd>
      </div>
      <div>
        <dt>Dropped by the CSMS or network</dt>
        <dd
          :class="{
            warn: (metrics.disconnects.remote ?? 0) + (metrics.disconnects.error ?? 0) > 0,
          }"
        >
          {{ (metrics.disconnects.remote ?? 0) + (metrics.disconnects.error ?? 0) }}
        </dd>
      </div>
      <div>
        <dt>Transactions</dt>
        <dd>{{ metrics.transactions.started ?? 0 }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.overview {
  display: grid;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
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
label {
  font-size: 12px;
  color: var(--muted);
}
table {
  border-collapse: collapse;
  font-size: 13px;
  width: 100%;
}
th,
td {
  text-align: right;
  padding: 2px 8px;
}
th:first-child {
  text-align: left;
  font-weight: 600;
}
thead th {
  font-weight: 400;
  color: var(--muted);
  font-size: 12px;
}
tr.total th,
tr.total td {
  border-top: 1px solid var(--border);
  font-weight: 600;
}
.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 4px 0 0;
}
.metrics dt {
  font-size: 12px;
  color: var(--muted);
}
.metrics dd {
  margin: 0;
  font-weight: 600;
}
.warn {
  color: var(--warn);
}
.bad {
  color: var(--bad);
}
</style>
