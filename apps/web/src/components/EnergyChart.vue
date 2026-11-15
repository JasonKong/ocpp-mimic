<script setup lang="ts">
import { computed } from 'vue';
import type { SessionRecord } from '../api.js';
import { linePath, scaleLinear, sessionSeries, ticks, timeTicks } from '../chart.js';
import { formatTime } from '../format.js';

/**
 * Power and SoC over the session: reported power and the power offered on
 * the left axis (kW), reported SoC on the right (%), and with `showTruth` the
 * EV model's power and SoC dashed beside them (R-NRG-2).
 */
const props = defineProps<{
  session: SessionRecord;
  showTruth: boolean;
  now: number;
  /** A moment to mark (a meter frame picked in the log). */
  highlightAt?: string | undefined;
}>();
const emit = defineEmits<{ 'select-time': [t: number] }>();

const W = 640;
const H = 220;
const M = { top: 12, right: 44, bottom: 26, left: 44 };

const series = computed(() => sessionSeries(props.session, props.now));
const x = computed(() =>
  scaleLinear([series.value.start, series.value.end], [M.left, W - M.right]),
);
const yKw = computed(() => scaleLinear([0, series.value.maxKw], [H - M.bottom, M.top]));
const ySoc = scaleLinear([0, 100], [H - M.bottom, M.top]);
const kwTicks = computed(() => ticks(0, series.value.maxKw, 4));
const tTicks = computed(() => timeTicks(series.value.start, series.value.end, 5));
const path = (points: { t: number; v: number }[], soc = false) =>
  linePath(points, x.value, soc ? ySoc : yKw.value);
const marker = computed(() =>
  props.highlightAt === undefined ? undefined : x.value(Date.parse(props.highlightAt)),
);
/** A click on the chart picks the moment under it (the log shows the nearest meter frame). */
function pick(event: MouseEvent) {
  const svg = event.currentTarget as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  if (box.width === 0) return;
  const px = ((event.clientX - box.left) / box.width) * W;
  const { start, end } = series.value;
  const t = start + ((px - M.left) / (W - M.left - M.right)) * (end - start);
  emit('select-time', Math.min(end, Math.max(start, t)));
}
const empty = computed(
  () => series.value.power.length + series.value.soc.length + series.value.offered.length === 0,
);
</script>

<template>
  <figure class="energy-chart">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="Power and state of charge over time"
      @click="pick"
    >
      <g class="grid">
        <line
          v-for="v in kwTicks"
          :key="`k${v}`"
          :x1="M.left"
          :x2="W - M.right"
          :y1="yKw(v)"
          :y2="yKw(v)"
        />
      </g>
      <g class="axis left">
        <text v-for="v in kwTicks" :key="`kl${v}`" :x="M.left - 6" :y="yKw(v) + 4">{{ v }}</text>
        <text :x="4" :y="M.top + 4" class="unit">kW</text>
      </g>
      <g class="axis right">
        <text
          v-for="v in [0, 25, 50, 75, 100]"
          :key="`s${v}`"
          :x="W - M.right + 6"
          :y="ySoc(v) + 4"
        >
          {{ v }}
        </text>
        <text :x="W - 18" :y="M.top + 4" class="unit">%</text>
      </g>
      <g class="axis bottom">
        <text v-for="t in tTicks" :key="`t${t}`" :x="x(t)" :y="H - 8">
          {{ formatTime(new Date(t).toISOString()).slice(0, 5) }}
        </text>
      </g>
      <path class="offered" :d="path(series.offered)" />
      <path class="power" :d="path(series.power)" />
      <path class="soc" :d="path(series.soc, true)" />
      <template v-if="showTruth">
        <path class="power truth" :d="path(series.truePower)" />
        <path class="soc truth" :d="path(series.trueSoc, true)" />
      </template>
      <line
        v-if="marker !== undefined"
        class="marker"
        :x1="marker"
        :x2="marker"
        :y1="M.top"
        :y2="H - M.bottom"
      />
      <text v-if="empty" :x="W / 2" :y="H / 2" class="empty">No meter values yet</text>
    </svg>
    <figcaption>
      <span class="key power">power</span>
      <span class="key offered">offered</span>
      <span class="key soc">SoC</span>
      <template v-if="showTruth">
        <span class="key truth">dashed: simulator truth</span>
      </template>
    </figcaption>
  </figure>
</template>

<style scoped>
.energy-chart {
  margin: 0;
}
svg {
  width: 100%;
  height: auto;
  display: block;
}
.grid line {
  stroke: var(--border);
  stroke-width: 1;
}
.axis text {
  font-size: 11px;
  fill: var(--muted);
}
.axis.left text {
  text-anchor: end;
}
.axis.left .unit,
.axis.right .unit {
  text-anchor: start;
}
.axis.bottom text {
  text-anchor: middle;
}
path {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
}
.power {
  stroke: var(--accent);
}
.offered {
  stroke: var(--muted);
  stroke-width: 1.5;
  stroke-dasharray: 2 3;
}
.soc {
  stroke: var(--good);
}
.truth {
  stroke-dasharray: 6 4;
  opacity: 0.7;
}
.marker {
  stroke: var(--warn);
  stroke-width: 1.5;
}
svg {
  cursor: crosshair;
}
.empty {
  fill: var(--muted);
  font-size: 13px;
  text-anchor: middle;
}
figcaption {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--muted);
}
.key::before {
  content: '';
  display: inline-block;
  width: 14px;
  height: 0;
  margin-right: 4px;
  vertical-align: middle;
  border-top: 2px solid currentcolor;
}
.key.power::before {
  border-color: var(--accent);
}
.key.offered::before {
  border-top-style: dotted;
}
.key.soc::before {
  border-color: var(--good);
}
.key.truth::before {
  border-top-style: dashed;
}
</style>
