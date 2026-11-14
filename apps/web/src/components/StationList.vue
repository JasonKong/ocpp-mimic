<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { NewStation, PersonaInfo, StationSnapshot } from '../api.js';

const props = defineProps<{
  stations: StationSnapshot[];
  personas: PersonaInfo[];
  selectedId: string | undefined;
}>();
const emit = defineEmits<{
  select: [id: string];
  create: [station: NewStation];
}>();

const showForm = ref(false);
const form = reactive({
  id: '',
  persona: '',
  csmsUrl: localStorageGet('ocpp-mimic.csmsUrl') ?? 'ws://localhost:9000/ocpp',
  password: '',
});

function localStorageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function submit() {
  const persona = form.persona || props.personas[0]?.id || '';
  try {
    localStorage.setItem('ocpp-mimic.csmsUrl', form.csmsUrl);
  } catch {
    // remembering the URL is only a convenience
  }
  emit('create', {
    id: form.id.trim(),
    persona,
    csmsUrl: form.csmsUrl.trim(),
    ...(form.password !== '' && { password: form.password }),
  });
  form.id = '';
  showForm.value = false;
}

function statusClass(station: StationSnapshot): string {
  if (!station.running) return 'muted';
  if (station.registration === 'Accepted') return 'good';
  if (station.transport === 'offline' || station.transport === 'half-open') return 'warn';
  return 'pending';
}
</script>

<template>
  <aside class="stations">
    <header>
      <h2>Charge points</h2>
      <button class="primary" @click="showForm = !showForm">
        {{ showForm ? 'Cancel' : 'Add' }}
      </button>
    </header>

    <form v-if="showForm" class="create" @submit.prevent="submit">
      <label>
        Charge point id
        <input v-model="form.id" required placeholder="SIM-001" />
      </label>
      <label>
        Persona
        <select v-model="form.persona">
          <option v-for="persona in personas" :key="persona.id" :value="persona.id">
            {{ persona.id }}
          </option>
        </select>
      </label>
      <label>
        CSMS URL
        <input v-model="form.csmsUrl" required placeholder="ws://localhost:9000/ocpp" />
      </label>
      <label>
        Password (optional)
        <input v-model="form.password" type="password" autocomplete="off" />
      </label>
      <button class="primary" type="submit">Create and start</button>
    </form>

    <p v-if="stations.length === 0 && !showForm" class="empty">
      No charge points yet. Add one to connect it to a CSMS.
    </p>

    <ul>
      <li
        v-for="station in stations"
        :key="station.id"
        :class="{ selected: station.id === selectedId }"
        @click="emit('select', station.id)"
      >
        <span class="dot" :class="statusClass(station)" />
        <span class="name">{{ station.id }}</span>
        <span class="meta">{{ station.running ? station.registration : 'Stopped' }}</span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.stations {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.create {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
li:hover {
  background: var(--hover);
}
li.selected {
  background: var(--selected);
}
.name {
  font-weight: 600;
  flex: 1;
}
.meta {
  font-size: 12px;
  color: var(--muted);
}
.empty {
  color: var(--muted);
  font-size: 13px;
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
.dot.warn {
  background: var(--warn);
}
.dot.pending {
  background: var(--accent);
}
</style>
