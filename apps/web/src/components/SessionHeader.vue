<script setup lang="ts">
import { computed } from 'vue';
import type { OcppVersion, SessionDetail } from '../api.js';
import { formatTime } from '../format.js';
import {
  failureText,
  formatDuration,
  SOURCE_HINTS,
  SOURCE_LABELS,
  STATE_LABELS,
  sessionDuration,
  stateTone,
  stepDelay,
  stepLabel,
} from '../sessions.js';
import { evseLabel, versionInfo } from '../versions.js';

/** How a session started: its source, token and remote start id, and the start timeline. */
const props = defineProps<{ detail: SessionDetail; version: OcppVersion; now: number }>();
const emit = defineEmits<{ 'open-frame': [seq: number] }>();

const session = computed(() => props.detail.session);
const info = computed(() => versionInfo(props.version));
const duration = computed(() => sessionDuration(session.value, props.now));
</script>

<template>
  <section class="session-header">
    <header>
      <h3>
        Session #{{ session.n }}
        <span class="source" :class="session.source" :title="SOURCE_HINTS[session.source]">{{
          SOURCE_LABELS[session.source]
        }}</span>
        <span class="state" :class="stateTone(session.state)">{{
          STATE_LABELS[session.state]
        }}</span>
      </h3>
      <dl>
        <div v-if="session.evseId !== undefined">
          <dt>{{ info.terms.evse }}</dt>
          <dd>{{ evseLabel(version, session.evseId, session.connectorId ?? 1) }}</dd>
        </div>
        <div>
          <dt>{{ info.terms.token }}</dt>
          <dd>
            <code>{{ session.idToken?.idToken ?? '—' }}</code>
            <span v-if="info.tokenType && session.idToken?.type" class="muted">
              ({{ session.idToken.type }})</span
            >
          </dd>
        </div>
        <div v-if="info.remoteStartId">
          <dt>remoteStartId</dt>
          <dd>
            {{
              session.remoteStartId ?? (session.source === 'remote' ? '—' : 'not a remote start')
            }}
          </dd>
        </div>
        <div v-if="session.transactionId !== undefined">
          <dt>Transaction</dt>
          <dd :title="String(session.transactionId)">
            {{ String(session.transactionId).slice(0, 12) }}
          </dd>
        </div>
        <div>
          <dt>{{ session.startedAt ? 'Started' : 'Requested' }}</dt>
          <dd>{{ formatTime(session.startedAt ?? session.requestedAt) }}</dd>
        </div>
        <div v-if="duration !== undefined">
          <dt>Duration</dt>
          <dd>{{ formatDuration(duration) }}</dd>
        </div>
        <div v-if="session.stopReason">
          <dt>Stopped</dt>
          <dd>{{ session.stopReason }}</dd>
        </div>
      </dl>
      <p v-if="session.failure" class="failure" role="status">{{ failureText(session.failure) }}</p>
    </header>

    <h4>Start timeline</h4>
    <ol class="timeline">
      <li v-for="step in session.timeline" :key="step.seq" :class="`t${step.messageType}`">
        <span class="time">{{ formatTime(step.at) }}</span>
        <span class="delay">{{ stepDelay(step) }}</span>
        <span class="label">{{ stepLabel(step) }}</span>
        <span class="status">{{ step.status ?? '' }}</span>
        <button class="link" @click="emit('open-frame', step.seq)">frame</button>
      </li>
      <li v-if="session.timeline.length === 0" class="empty">No start messages recorded.</li>
    </ol>
  </section>
</template>

<style scoped>
.session-header {
  display: grid;
  gap: 10px;
  min-width: 0;
}
h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
h4 {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
}
.source,
.state {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: var(--hover);
}
.source.remote {
  color: var(--accent);
  background: var(--selected);
}
.state.good {
  color: var(--good);
  background: var(--good-bg);
}
.state.bad {
  color: var(--bad);
  background: var(--bad-bg);
}
.state.pending {
  color: var(--warn);
  background: var(--warn-bg);
}
dl {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 8px 0 0;
}
dt {
  font-size: 11px;
  color: var(--muted);
}
dd {
  margin: 0;
  font-size: 13px;
}
.muted {
  color: var(--muted);
}
.failure {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bad-bg);
  color: var(--bad);
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}
.timeline li {
  display: grid;
  grid-template-columns: 6.5em 4.5em minmax(0, 1fr) auto auto;
  gap: 8px;
  padding: 3px 0;
  border-left: 2px solid var(--border);
  padding-left: 10px;
}
.timeline li.t4 .status {
  color: var(--bad);
}
.timeline li.empty {
  display: block;
  color: var(--muted);
}
.time,
.delay {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.status {
  font-weight: 600;
}
@media (max-width: 600px) {
  .timeline li {
    grid-template-columns: 4.5em minmax(0, 1fr) auto auto;
  }
  .timeline .time {
    display: none;
  }
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
}
</style>
