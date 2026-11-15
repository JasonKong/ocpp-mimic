<script setup lang="ts">
import { computed } from 'vue';
import type { RecordEntry } from '../api.js';
import { formatTime, transactionEvents } from '../format.js';

const props = defineProps<{ entries: RecordEntry[] }>();

/** The latest 50 TransactionEvents the station sent, newest first. */
const rows = computed(() => transactionEvents(props.entries).slice(-50).reverse());
</script>

<template>
  <section class="transactions">
    <h3>Transaction events</h3>
    <p v-if="rows.length === 0" class="empty">No TransactionEvent sent yet.</p>
    <table v-else>
      <thead>
        <tr>
          <th>Time</th>
          <th>EVSE</th>
          <th>Transaction</th>
          <th>seqNo</th>
          <th>Event</th>
          <th>Trigger</th>
          <th>Charging state</th>
          <th>Stopped</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.seq" :class="{ offline: row.offline }">
          <td>{{ formatTime(row.at) }}</td>
          <td>{{ row.evseId ?? '—' }}</td>
          <td :title="row.transactionId">{{ row.transactionId.slice(0, 8) }}</td>
          <td>{{ row.seqNo }}</td>
          <td>{{ row.eventType }}<template v-if="row.offline"> (offline)</template></td>
          <td>{{ row.triggerReason }}</td>
          <td>{{ row.chargingState ?? '' }}</td>
          <td>{{ row.stoppedReason ?? '' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.transactions {
  display: grid;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 14px;
}
.empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
table {
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  text-align: left;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
}
th {
  color: var(--muted);
  font-weight: 500;
}
.offline td {
  color: var(--warn);
}
</style>
