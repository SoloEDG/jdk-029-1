<script setup lang="ts">
import { computed } from 'vue'
import { ListMusic } from '@lucide/vue'
import { clockLabel } from '../../../shared/time'
import { LANE_COLORS } from '../lib/timeline'
import type { AlignmentResult } from '../lib/align'

const props = defineProps<{
  rows: { line: { id: string; text: string; start: number; end: number }; mapping: AlignmentResult['plan'][number] }[]
  selectedId: string | null
  activeId: string | null
  version: 'reference' | 'target'
}>()
const emit = defineEmits<{ select: [string] }>()

const label: Record<string, string> = {
  known: '已定',
  inferred: '推算',
  linear: '变速',
  candidate: '待试听',
  pending: '待确认',
  unmapped: '无映射',
  deleted: '已删',
}

const targetTime = computed((): Record<string, number | null> => {
  const out: Record<string, number | null> = {}
  for (const row of props.rows) out[row.line.id] = row.mapping.target?.start ?? null
  return out
})
</script>

<template>
  <section class="phrase-list" aria-labelledby="phrases-heading">
    <h2 class="rail-title" id="phrases-heading">
      <ListMusic :size="17" /> 歌词映射 <span class="mono">{{ rows.length }}</span>
    </h2>
    <ol>
      <li v-for="(row, index) in rows" :key="row.line.id">
        <button class="phrase" :class="{ chosen: selectedId === row.line.id, sounding: activeId === row.line.id }"
          :aria-pressed="selectedId === row.line.id" @click="emit('select', row.line.id)">
          <span class="phrase-index mono">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="phrase-text">
            <span class="phrase-copy">{{ row.line.text }}</span>
            <span class="phrase-tags">
              <span class="mapping-chip" :style="{ '--tone': LANE_COLORS[row.mapping.kind] }">{{ label[row.mapping.kind] }}</span>
              <span v-if="row.mapping.ambiguous" class="chip-note">多候选</span>
              <span v-if="row.mapping.collision" class="chip-note">重叠</span>
            </span>
          </span>
          <span class="phrase-time mono">
            {{ clockLabel(row.line.start, true) }}
            <template v-if="version === 'target' && row.mapping.target">
              → {{ clockLabel(row.mapping.target.start, true) }}
            </template>
          </span>
        </button>
      </li>
    </ol>
  </section>
</template>
