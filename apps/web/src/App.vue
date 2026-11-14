<script setup lang="ts">
import { onMounted, ref } from 'vue';

interface Health {
  status: string;
  version: string;
  ocpp: string[];
}

const health = ref<Health | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health.value = (await res.json()) as Health;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <main class="page">
    <h1>ocpp-mimic</h1>
    <p v-if="health">
      Engine {{ health.version }} online · protocols: {{ health.ocpp.join(', ') }}
    </p>
    <p v-else-if="error" class="error">
      Cannot reach the engine ({{ error }}). Start it with <code>pnpm serve</code>.
    </p>
    <p v-else>Connecting to the engine…</p>
  </main>
</template>

<style scoped>
.page {
  font-family: system-ui, sans-serif;
  max-width: 720px;
  margin: 48px auto;
  padding: 0 16px;
}

.error {
  color: #b42318;
}
</style>
