<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectorSnapshot, OcppVersion, SessionDetail } from '../api.js';
import { vehicleRows } from '../vehicle.js';

/**
 * What is known about the EV, item by item: the reported value (or what a
 * third party estimates), its source, whether the version can carry it, and
 * the simulator's truth with show-truth (R-EV-1, R-SRC-1, R-SRC-3).
 */
const props = defineProps<{
  detail: SessionDetail;
  version: OcppVersion;
  ev?: ConnectorSnapshot['ev'] | undefined;
  showTruth: boolean;
}>();
const emit = defineEmits<{ 'open-frame': [seq: number] }>();
const rows = computed(() => vehicleRows(props.detail, props.version, props.ev));
</script>

<template>
  <section class="vehicle-card">
    <h4>Vehicle</h4>
    <table>
      <tbody>
        <tr v-for="row in rows" :key="row.field" :class="row.availability.level">
          <th :title="row.availability.note">{{ row.label }}</th>
          <td>
            <span v-for="(value, i) in row.values" :key="i" class="value">
              <button
                v-if="value.seq !== undefined"
                class="link"
                title="Open the frame it came from"
                @click="emit('open-frame', value.seq)"
              >
                {{ value.text }}
              </button>
              <template v-else>{{ value.text }}</template>
              <span class="src" :class="value.source">{{ value.source }}</span>
            </span>
            <span v-if="row.missing" class="missing">{{ row.missing }}</span>
            <span v-if="showTruth && row.truth" class="truth"> truth {{ row.truth.text }} </span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.vehicle-card {
  display: grid;
  gap: 6px;
  min-width: 0;
}
h4 {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
table {
  border-collapse: collapse;
  font-size: 13px;
  width: 100%;
}
th {
  width: 38%;
  padding: 4px 10px 4px 0;
  text-align: left;
  font-weight: normal;
  color: var(--muted);
  vertical-align: top;
}
td {
  padding: 4px 0;
  vertical-align: top;
}
tr + tr th,
tr + tr td {
  border-top: 1px solid var(--border);
}
tr.no th {
  opacity: 0.7;
}
.value {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
}
.missing {
  color: var(--muted);
  font-style: italic;
}
.truth {
  display: block;
  color: var(--muted);
  font-style: italic;
  font-size: 12px;
}
.src {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: var(--hover);
}
.src.estimate {
  background: var(--warn-bg);
  color: var(--warn);
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
}
</style>
