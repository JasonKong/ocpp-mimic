<script setup lang="ts">
import { computed, ref } from 'vue';
import { downloadFile, type FrameRecord, type RecordEntry } from '../api.js';
import { formatTime, messageTypeLabel, summarize } from '../format.js';
import VersionBadge from './VersionBadge.vue';

const props = defineProps<{ entries: RecordEntry[]; stationId?: string | undefined }>();

const include = ref<string[]>([]);
const exclude = ref<string[]>(['Heartbeat']);
const showLogs = ref(true);
const open = ref<FrameRecord | undefined>();

const actions = computed(() =>
  [
    ...new Set(props.entries.flatMap((e) => (e.kind === 'frame' && e.action ? [e.action] : []))),
  ].sort(),
);

const visible = computed(() =>
  props.entries.filter((entry) => {
    if (entry.kind === 'log') return showLogs.value;
    const action = entry.action ?? '';
    if (include.value.length > 0 && !include.value.includes(action)) return false;
    return !exclude.value.includes(action);
  }),
);

function toggle(which: 'include' | 'exclude', action: string) {
  const list = which === 'include' ? include : exclude;
  list.value = list.value.includes(action)
    ? list.value.filter((a) => a !== action)
    : [...list.value, action];
}

function pretty(record: FrameRecord): string {
  return JSON.stringify(record.payload ?? record.text, null, 2);
}
</script>

<template>
  <section class="message-log">
    <header>
      <h2>Messages</h2>
      <label class="check"><input v-model="showLogs" type="checkbox" /> log lines</label>
      <a
        v-if="stationId"
        class="export"
        :href="`/api/stations/${encodeURIComponent(stationId)}/messages?format=jsonl`"
        :download="`${stationId}.jsonl`"
        title="The station's frames as a JSONL log, for import, replay and calibration"
        @click.prevent="
          downloadFile(
            `/api/stations/${encodeURIComponent(stationId)}/messages?format=jsonl`,
            `${stationId}.jsonl`,
          )
        "
        >Export JSONL</a
      >
    </header>
    <div class="filters">
      <span class="label">Only</span>
      <button
        v-for="action in actions"
        :key="`in-${action}`"
        class="chip"
        :class="{ on: include.includes(action) }"
        @click="toggle('include', action)"
      >
        {{ action }}
      </button>
    </div>
    <div class="filters">
      <span class="label">Hide</span>
      <button
        v-for="action in actions"
        :key="`ex-${action}`"
        class="chip"
        :class="{ on: exclude.includes(action) }"
        @click="toggle('exclude', action)"
      >
        {{ action }}
      </button>
    </div>

    <ol class="entries">
      <li v-for="entry in [...visible].reverse()" :key="entry.seq" :class="entry.kind">
        <span class="time">{{ formatTime(entry.at) }}</span>
        <template v-if="entry.kind === 'frame'">
          <span class="direction" :title="entry.direction">
            {{ entry.direction === 'cp-to-csms' ? 'CP → CSMS' : 'CSMS → CP' }}
          </span>
          <span class="type" :class="`t${entry.messageType ?? 0}`">{{
            messageTypeLabel(entry)
          }}</span>
          <VersionBadge v-if="entry.ocpp" :version="entry.ocpp" compact />
          <span class="action">{{ entry.action ?? '?' }}</span>
          <span
            v-if="entry.injected"
            class="injected"
            :title="`Fault injection: ${entry.injected}${entry.dropped ? ' (never reached the other side)' : ''}`"
            >{{ entry.dropped ? 'dropped' : 'injected' }}: {{ entry.injected }}</span
          >
          <span
            v-if="entry.schemaErrors"
            class="schema"
            :title="`Breaks the official OCA schema:\n${entry.schemaErrors.join('\n')}`"
            >OCA schema</span
          >
          <span class="summary">{{ summarize(entry) }}</span>
          <button class="link" @click="open = entry">Raw</button>
        </template>
        <span v-else class="summary">{{ entry.message }}</span>
      </li>
    </ol>

    <div v-if="open" class="overlay" @click.self="open = undefined">
      <div class="modal">
        <header>
          <strong>{{ open.action }} · {{ messageTypeLabel(open) }} · {{ open.uniqueId }}</strong>
          <button @click="open = undefined">Close</button>
        </header>
        <ul v-if="open.schemaErrors" class="schema-errors">
          <li v-for="problem in open.schemaErrors" :key="problem">{{ problem }}</li>
        </ul>
        <pre>{{ pretty(open) }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.message-log {
  display: grid;
  gap: 8px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h2 {
  margin: 0;
  font-size: 15px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.label {
  font-size: 12px;
  color: var(--muted);
  width: 36px;
}
.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}
.chip.on {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: var(--accent);
}
.check {
  font-size: 12px;
  color: var(--muted);
  margin-left: auto;
}
.export {
  font-size: 12px;
  margin-left: 12px;
}
.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
li.log {
  color: var(--muted);
}
.time {
  color: var(--muted);
}
.direction {
  width: 80px;
  color: var(--muted);
}
.type {
  width: 52px;
  font-weight: 600;
}
.type.t3 {
  color: var(--good);
}
.type.t4,
.type.t5,
.type.t0 {
  color: var(--bad);
}
.action {
  width: 170px;
  font-weight: 600;
}
.schema {
  color: var(--bad);
  font-weight: 600;
}
.injected {
  color: var(--warn);
  font-weight: 600;
}
.schema-errors {
  margin: 0;
  padding: 8px 8px 8px 24px;
  color: var(--bad);
  font-size: 12px;
}
.schema-errors li {
  display: list-item;
  border: none;
  padding: 0;
  white-space: normal;
}
.summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.link {
  border: none;
  background: none;
  text-decoration: underline;
  padding: 0;
  font-size: 12px;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: grid;
  place-items: center;
  padding: 24px;
}
.modal {
  background: var(--bg);
  border-radius: 10px;
  width: min(800px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 8px;
}
pre {
  overflow: auto;
  margin: 0;
  font-size: 12px;
}
</style>
