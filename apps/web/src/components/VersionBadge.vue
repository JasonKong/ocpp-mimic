<script setup lang="ts">
import { computed } from 'vue';
import type { OcppVersion } from '../api.js';
import { versionInfo } from '../versions.js';

/** The OCPP version as a coloured badge: `OCPP 2.0.1`, or `2.0.1` when compact. */
const props = defineProps<{ version: OcppVersion; compact?: boolean }>();
const info = computed(() => versionInfo(props.version));
</script>

<template>
  <span class="version-badge" :class="info.tone" :title="info.label">{{
    compact ? info.version : info.label
  }}</span>
</template>

<style scoped>
.version-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
}
.v16 {
  color: var(--v16);
  background: var(--v16-bg);
}
.v201 {
  color: var(--v201);
  background: var(--v201-bg);
}
</style>
