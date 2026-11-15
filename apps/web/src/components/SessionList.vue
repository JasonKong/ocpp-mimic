<script setup lang="ts">
import type { OcppVersion, SessionSummary } from '../api.js';
import { formatEnergy, formatTime } from '../format.js';
import { SOURCE_HINTS, SOURCE_LABELS, STATE_LABELS, stateTone } from '../sessions.js';
import { versionInfo } from '../versions.js';

/** A station's sessions, newest first, with their start source and energy. */
defineProps<{ sessions: SessionSummary[]; selectedN?: number | undefined; version: OcppVersion }>();
const emit = defineEmits<{ select: [n: number] }>();
</script>

<template>
  <ol class="session-list">
    <li v-if="sessions.length === 0" class="empty">No sessions yet.</li>
    <li
      v-for="s in sessions"
      :key="s.n"
      :class="{ selected: s.n === selectedN }"
      @click="emit('select', s.n)"
    >
      <span class="dot" :class="stateTone(s.state)" :title="STATE_LABELS[s.state]" />
      <div class="main">
        <span class="n">#{{ s.n }}</span>
        <span class="source" :class="s.source" :title="SOURCE_HINTS[s.source]">{{
          SOURCE_LABELS[s.source]
        }}</span>
        <span class="what" :class="{ failed: s.state === 'not-started' }">{{
          s.state === 'not-started'
            ? (s.failure?.reason ?? 'not started')
            : formatEnergy(s.energyWh)
        }}</span>
      </div>
      <div class="sub">
        {{ s.evseId === undefined ? '—' : `${versionInfo(version).terms.evse} ${s.evseId}` }} ·
        <code>{{ s.idToken?.idToken ?? '—' }}</code> · {{ formatTime(s.requestedAt) }}
      </div>
    </li>
  </ol>
</template>

<style scoped>
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 480px;
  overflow-y: auto;
}
li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  align-items: center;
  column-gap: 8px;
  row-gap: 2px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
li:last-child {
  border-bottom: none;
}
li:hover {
  background: var(--hover);
}
li.selected {
  background: var(--selected);
}
li.empty {
  display: block;
  color: var(--muted);
  cursor: default;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.good {
  background: var(--good);
}
.dot.bad {
  background: var(--bad);
}
.dot.pending {
  background: var(--warn);
}
.main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.what {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.what.failed {
  color: var(--bad);
}
.sub {
  grid-column: 2;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.n {
  color: var(--muted);
}
.source {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--hover);
}
.source.remote {
  color: var(--accent);
  background: var(--selected);
}
</style>
