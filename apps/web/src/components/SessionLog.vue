<script setup lang="ts">
import { computed, ref } from 'vue';
import { downloadFile, type FrameRecord, type LogRecord } from '../api.js';
import { formatTime, summarize } from '../format.js';
import {
  actionsOf,
  filterRows,
  isMeterRow,
  logRows,
  NO_FILTER,
  type LogFilter,
  type LogRow,
} from '../session-log.js';
import VersionBadge from './VersionBadge.vue';

/**
 * The session's frames (or the whole station's records) on one timeline:
 * each CALL with its answer and response time, station log lines, filters,
 * the JSONL export, and the link to the energy chart (R-LOG-1 to R-LOG-6).
 */
const props = defineProps<{
  /** The session's frames; undefined while loading. */
  frames?: FrameRecord[] | undefined;
  /** The station's log lines within the session. */
  sessionLogLines: LogRecord[];
  /** The whole station's frames and log lines, for the station scope. */
  stationFrames: FrameRecord[];
  stationLogLines: LogRecord[];
  exportUrl: string;
  exportName: string;
  /** A seq to show as selected (from a click on the chart). */
  selectedSeq?: number | undefined;
}>();
const emit = defineEmits<{ 'select-time': [at: string | undefined]; load: [] }>();

const scope = ref<'session' | 'station'>('session');
const open = ref(true);
const filter = ref<LogFilter>({ ...NO_FILTER, actions: [] });
const raw = ref<LogRow | undefined>();

const rows = computed(() =>
  scope.value === 'session'
    ? logRows(props.frames ?? [], props.sessionLogLines)
    : logRows(props.stationFrames, props.stationLogLines),
);
const visible = computed(() => [...filterRows(rows.value, filter.value)].reverse());
const actions = computed(() => actionsOf(rows.value));

function toggle(action: string) {
  const list = filter.value.actions;
  filter.value.actions = list.includes(action)
    ? list.filter((a) => a !== action)
    : [...list, action];
}
function pick(row: LogRow) {
  emit('select-time', isMeterRow(row) ? row.at : undefined);
}
const arrow = (frame: FrameRecord) =>
  frame.direction === 'cp-to-csms' ? 'CP → CSMS' : 'CSMS → CP';
function answerText(row: LogRow): string {
  const answer = row.answer;
  if (answer === undefined) return '';
  const status = summarize(answer);
  return `${status === '' ? 'answered' : status} · ${row.answerMs ?? 0} ms`;
}
</script>

<template>
  <section class="session-log">
    <header>
      <button class="title" :aria-expanded="open" @click="open = !open">
        {{ open ? '▾' : '▸' }} Log
      </button>
      <div v-if="open" class="controls">
        <div class="switch" role="group" aria-label="Which records">
          <button :class="{ on: scope === 'session' }" @click="scope = 'session'">
            This session
          </button>
          <button :class="{ on: scope === 'station' }" @click="scope = 'station'">
            Whole station
          </button>
        </div>
        <select v-model="filter.direction" aria-label="Direction">
          <option value="all">both directions</option>
          <option value="cp-to-csms">CP → CSMS</option>
          <option value="csms-to-cp">CSMS → CP</option>
        </select>
        <label><input v-model="filter.errorsOnly" type="checkbox" /> errors only</label>
        <label><input v-model="filter.logLines" type="checkbox" /> log lines</label>
        <a
          class="export"
          :href="exportUrl"
          :download="exportName"
          @click.prevent="downloadFile(exportUrl, exportName)"
          title="The session's frames as JSONL, for replay and scenarios"
          >Export JSONL</a
        >
      </div>
    </header>
    <template v-if="open">
      <div v-if="actions.length > 1" class="chips">
        <button
          v-for="action in actions"
          :key="action"
          class="chip"
          :class="{ on: filter.actions.includes(action) }"
          @click="toggle(action)"
        >
          {{ action }}
        </button>
      </div>
      <p v-if="scope === 'session' && frames === undefined" class="hint">
        Loading… <button class="link" @click="emit('load')">reload</button>
      </p>
      <ol class="rows">
        <li
          v-for="row in visible"
          :key="`${row.kind}-${row.seq}`"
          :class="[
            row.kind,
            {
              problem: row.problem,
              selected: row.seq === selectedSeq || row.answer?.seq === selectedSeq,
            },
          ]"
          @click="pick(row)"
        >
          <span class="time">{{ formatTime(row.at).slice(0, 12) }}</span>
          <template v-if="row.kind === 'log'">
            <span class="logline">{{ (row.record as LogRecord).message }}</span>
          </template>
          <template v-else>
            <span class="dir">{{ arrow(row.record as FrameRecord) }}</span>
            <VersionBadge
              v-if="(row.record as FrameRecord).ocpp"
              :version="(row.record as FrameRecord).ocpp!"
              compact
            />
            <span class="action"
              >{{ (row.record as FrameRecord).action ?? '?'
              }}{{ row.kind === 'answer' ? ' answer' : '' }}</span
            >
            <span class="summary">{{ summarize(row.record as FrameRecord) }}</span>
            <span class="answer">{{ answerText(row) }}</span>
            <button class="link" @click.stop="raw = row">JSON</button>
          </template>
        </li>
        <li v-if="visible.length === 0" class="hint">No records.</li>
      </ol>
    </template>

    <div v-if="raw" class="overlay" @click.self="raw = undefined">
      <div class="modal">
        <header>
          <strong>{{ (raw.record as FrameRecord).action }} · {{ raw.seq }}</strong>
          <button @click="raw = undefined">Close</button>
        </header>
        <pre>{{ (raw.record as FrameRecord).text }}</pre>
        <pre v-if="raw.answer">{{ raw.answer.text }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.session-log {
  display: grid;
  gap: 8px;
  min-width: 0;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.title {
  border: none;
  background: none;
  padding: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  font-size: 13px;
}
.switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.switch button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 2px 8px;
}
.switch button.on {
  background: var(--accent);
  color: var(--accent-ink);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  padding: 0 8px;
  border-radius: 10px;
  font-size: 12px;
}
.chip.on {
  background: var(--accent);
  color: var(--accent-ink);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  min-height: 80px;
  overflow: auto;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
}
.rows li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
  cursor: default;
  min-width: 0;
}
.rows li.selected {
  background: var(--selected);
}
.rows li.problem .action {
  color: var(--bad);
}
.rows li.log .logline {
  color: var(--muted);
  font-style: italic;
}
.time,
.dir {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.action {
  font-weight: 600;
  white-space: nowrap;
}
.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.answer {
  color: var(--muted);
  white-space: nowrap;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
}
.export {
  color: var(--accent);
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
}
@media (max-width: 700px) {
  .dir,
  .summary {
    display: none;
  }
}
</style>
