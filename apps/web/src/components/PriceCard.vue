<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { OcppVersion, ReferenceTariff, SessionDetail } from '../api.js';
import { formatTime } from '../format.js';
import { formatMoney, formToTariff, tariffToForm, type TariffForm } from '../tariff.js';
import { versionInfo } from '../versions.js';

/**
 * What the session costs: the CSMS's cost as it sent it (totalCost,
 * CostUpdated), and next to it the reference price from the reported values,
 * item by item, to check the CSMS's or a third party's billing (R-PRICE-1 to
 * R-PRICE-3). The reference tariff is edited here (one per engine).
 */
const props = defineProps<{
  detail: SessionDetail;
  version: OcppVersion;
  tariff?: ReferenceTariff | undefined;
}>();
const emit = defineEmits<{
  'save-tariff': [tariff: ReferenceTariff];
  'open-frame': [seq: number];
}>();

const PART_LABELS = {
  fixedFee: 'Session fee',
  energy: 'Energy',
  chargingTime: 'Charging time',
  idleTime: 'Idle time',
} as const;

const price = computed(() => props.detail.price);
const costs = computed(() => props.detail.session.costs);
/** 2.1: what the station worked out itself (costDetails). */
const stationCost = computed(() => props.detail.session.stationCost);
const latestCost = computed(() => costs.value.at(-1));
/** Compared once the session is over: a running cost lags the CSMS's last message. */
const finished = computed(() => props.detail.session.state === 'finished');
const difference = computed(() =>
  latestCost.value === undefined || !finished.value
    ? undefined
    : latestCost.value.totalCost - price.value.inclTax,
);
const info = computed(() => versionInfo(props.version));

const editing = ref(false);
const form = ref<TariffForm | undefined>();
const problem = ref<string | undefined>();
watch(
  () => props.tariff,
  (tariff) => {
    if (tariff !== undefined && !editing.value) form.value = tariffToForm(tariff);
  },
  { immediate: true },
);
function save() {
  if (form.value === undefined) return;
  const result = formToTariff(form.value);
  if ('problem' in result) {
    problem.value = result.problem;
    return;
  }
  problem.value = undefined;
  editing.value = false;
  emit('save-tariff', result.tariff);
}
</script>

<template>
  <section class="price-card">
    <header>
      <h4>Price</h4>
      <button class="link" @click="editing = !editing">
        {{ editing ? 'Close the tariff' : 'Edit the reference tariff' }}
      </button>
    </header>

    <form v-if="editing && form" class="tariff" @submit.prevent="save">
      <label>Currency <input v-model="form.currency" maxlength="3" class="short" /></label>
      <label>Session fee <input v-model="form.fixedFee" inputmode="decimal" /></label>
      <label>Per kWh <input v-model="form.priceKwh" inputmode="decimal" /></label>
      <label
        >Off-peak per kWh <input v-model="form.offPeakKwh" inputmode="decimal" /> from
        <input
          v-model="form.offPeakFrom"
          class="short"
          placeholder="21:00"
          aria-label="Off-peak from" />
        to
        <input v-model="form.offPeakTo" class="short" placeholder="07:00" aria-label="Off-peak to"
      /></label>
      <label>Per charging minute <input v-model="form.chargingMinute" inputmode="decimal" /></label>
      <label>Idle fee per minute <input v-model="form.idleMinute" inputmode="decimal" /></label>
      <label
        >Tax <input v-model="form.taxName" class="short" aria-label="Tax name" />
        <input
          v-model="form.taxPercent"
          inputmode="decimal"
          class="short"
          aria-label="Tax percent"
        />
        %</label
      >
      <label>Minimum <input v-model="form.minCost" inputmode="decimal" /></label>
      <label>Maximum <input v-model="form.maxCost" inputmode="decimal" /></label>
      <p class="hint">
        Prices before tax; an empty field leaves that part out. It is a 2.1 TariffType; the off-peak
        hours are the station's local time (UTC for 1.6) and become a time-of-day condition on the
        energy price.
      </p>
      <p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      <button class="primary" type="submit">Save the tariff</button>
    </form>

    <div class="costs">
      <div class="figure">
        <span class="label">CSMS cost <span class="src reported">reported</span></span>
        <span class="value">{{
          latestCost === undefined ? '—' : formatMoney(latestCost.totalCost, price.currency)
        }}</span>
        <span v-if="latestCost" class="note"
          >{{ latestCost.from }} at {{ formatTime(latestCost.at).slice(0, 8) }}</span
        >
        <span v-else class="note">{{
          info.totalCost ? 'the CSMS sent no cost' : `OCPP ${version} has no cost messages`
        }}</span>
      </div>
      <div v-if="stationCost" class="figure">
        <span class="label">Station cost <span class="src reported">reported</span></span>
        <span class="value">{{
          formatMoney(stationCost.totalCost, stationCost.currency ?? price.currency)
        }}</span>
        <span class="note"
          >costDetails, {{ stationCost.final ? 'final' : 'running' }}
          {{
            stationCost.typeOfCost === undefined || stationCost.typeOfCost === 'NormalCost'
              ? ''
              : `(${stationCost.typeOfCost})`
          }}
          at
          {{ formatTime(stationCost.at).slice(0, 8) }}
          <button class="link" @click="emit('open-frame', stationCost.seq)">frame</button></span
        >
      </div>
      <div class="figure">
        <span class="label">Reference price <span class="src estimate">estimate</span></span>
        <span class="value">{{ formatMoney(price.inclTax, price.currency) }}</span>
        <span class="note"
          >{{ formatMoney(price.exclTax, price.currency) }} + tax
          {{ formatMoney(price.tax, price.currency) }}</span
        >
      </div>
    </div>
    <p
      v-if="difference !== undefined"
      class="compare"
      :class="{ off: Math.abs(difference) >= 0.005 }"
      role="status"
    >
      {{
        Math.abs(difference) < 0.005
          ? 'The CSMS cost matches the reference price.'
          : `The CSMS cost is ${formatMoney(Math.abs(difference), price.currency)} ${difference > 0 ? 'above' : 'below'} the reference price.`
      }}
    </p>

    <p v-if="latestCost !== undefined && !finished" class="hint">
      The CSMS cost and the reference price are compared when the session ends; while it runs the
      CSMS cost is as of its last message.
    </p>

    <table v-if="price.items.length > 0" class="items">
      <thead>
        <tr>
          <th>Item</th>
          <th>Quantity</th>
          <th>Unit price</th>
          <th>Before tax</th>
          <th>Tax</th>
          <th>Frames</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(item, index) in price.items" :key="`${item.part}-${index}`">
          <td>
            {{ PART_LABELS[item.part] }}
            <span v-if="item.conditions?.startTimeOfDay" class="muted"
              >{{ item.conditions.startTimeOfDay }}–{{
                item.conditions.endTimeOfDay ?? '24:00'
              }}</span
            >
          </td>
          <td>{{ item.unit === 'session' ? '1' : `${item.quantity} ${item.unit}` }}</td>
          <td>{{ item.unitPrice }}</td>
          <td>{{ item.exclTax.toFixed(2) }}</td>
          <td>{{ item.tax.toFixed(2) }}</td>
          <td>
            <button
              v-for="seq in item.frames"
              :key="seq"
              class="link"
              @click="emit('open-frame', seq)"
            >
              #{{ seq }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="price.adjusted" class="hint">
      The total was
      {{ price.adjusted === 'minCost' ? 'raised to the minimum' : 'lowered to the maximum' }}.
    </p>

    <details v-if="costs.length > 1" class="history">
      <summary>{{ costs.length }} cost updates from the CSMS</summary>
      <ol>
        <li v-for="cost in [...costs].reverse()" :key="cost.seq">
          {{ formatTime(cost.at).slice(0, 8) }} · {{ cost.from }} ·
          {{ formatMoney(cost.totalCost, price.currency) }}
        </li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.price-card {
  display: grid;
  gap: 10px;
  min-width: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h4 {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.costs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.figure {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.label {
  font-size: 11px;
  color: var(--muted);
}
.value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.note,
.hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}
.compare {
  margin: 0;
  font-size: 13px;
  color: var(--good);
}
.compare.off {
  color: var(--warn);
}
.src {
  margin-left: 4px;
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
.items {
  border-collapse: collapse;
  font-size: 13px;
  width: 100%;
}
.items th,
.items td {
  padding: 3px 8px 3px 0;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.items thead th {
  color: var(--muted);
  font-weight: normal;
  font-size: 12px;
}
.tariff {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.tariff label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--muted);
}
.tariff .short {
  width: 5em;
}
.tariff .hint,
.tariff .problem,
.tariff button {
  grid-column: 1 / -1;
}
.problem {
  margin: 0;
  color: var(--bad);
  font-size: 13px;
}
.link {
  border: none;
  background: none;
  padding: 0 4px 0 0;
  color: var(--accent);
  cursor: pointer;
}
.history ol {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
}
</style>
