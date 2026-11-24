<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, ListChecks, Upload } from '@lucide/vue'
import { clockLabel } from '../../../shared/time'
import type { Anchor, Project, PublishedSnapshot, SpanDecision } from '../../../shared/document'
import type { AlignmentResult } from '../lib/align'
import type { PendingSegment } from '../lib/mapping'
import { LANE_COLORS } from '../lib/timeline'

const props = defineProps<{
  project: Project
  alignment: AlignmentResult
  modelFile: string
  busy: string
  pending: PendingSegment[]
  suggestions: Anchor[]
}>()
const emit = defineEmits<{
  publish: [string, string]
  restore: [string]
  openImport: []
  acceptSuggestion: [string]
  rejectSuggestion: [string]
  audition: [number]
  'audition-span': [{ start: number; end: number }]
}>()

const plan = computed(() => props.alignment.plan)
const counts = computed(() => {
  const out: Record<string, number> = {}
  for (const entry of plan.value) out[entry.kind] = (out[entry.kind] ?? 0) + 1
  return out
})
const confirmed = computed(() => props.project.anchors.filter(anchor => anchor.confirmed))
const label: Record<string, string> = {
  known: '已确认', inferred: '推算', linear: '变速', candidate: '候选', pending: '待确认', unmapped: '无映射', deleted: '已删',
}
const unplaced = computed(() => plan.value.filter(entry =>
  entry.kind === 'pending' || entry.kind === 'unmapped' || entry.kind === 'candidate'))
const cutSpans = computed(() => props.alignment.effectiveSpans.filter(span => span.kind === 'cut'))

function publish() {
  const name = `发布 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  const note = props.alignment.effectiveSpans
    .map(span => `${span.kind}:${span.start.toFixed(1)}-${span.end.toFixed(1)}`)
    .join(' ')
  emit('publish', name, note)
}
</script>

<template>
  <section class="status-panel" aria-labelledby="status-title">
    <h2 class="rail-title" id="status-title"><ListChecks :size="17" /> 校对状态</h2>
    <div class="count-grid">
      <span v-for="(tone, kind) in LANE_COLORS" :key="kind" class="count" :style="{ '--tone': tone }">
        <i></i>{{ label[kind] }} <strong class="mono">{{ counts[kind] ?? 0 }}</strong>
      </span>
    </div>
    <p class="mono status-meta">速度 ×{{ alignment.rate.toFixed(3) }} · 对应点 {{ confirmed.length }}</p>

    <div v-if="suggestions.length" class="suggestion-list">
      <p class="block-title">声学建议（未确认，需试听）</p>
      <article v-for="suggestion in suggestions.slice(0, 5)" :key="suggestion.id" class="suggestion">
        <button class="mini-button" @click="emit('audition', suggestion.time)">试听</button>
        <span class="mono">{{ clockLabel(suggestion.source, true) }} → {{ clockLabel(suggestion.time, true) }}</span>
        <button class="mini-button" @click="emit('acceptSuggestion', suggestion.id)">采用</button>
        <button class="mini-button danger" @click="emit('rejectSuggestion', suggestion.id)">忽略</button>
      </article>
    </div>

    <div v-if="pending.length" class="segment-list">
      <p class="block-title">两端有对应点、尚未确认的段落</p>
      <article v-for="segment in pending" :key="`${segment.before.id}-${segment.after.id}`" class="segment">
        <p class="segment-range mono">
          {{ clockLabel(segment.before.source, true) }} – {{ clockLabel(segment.after.source, true) }}
          <span class="segment-target">→ {{ clockLabel(segment.before.time, true) }} – {{ clockLabel(segment.after.time, true) }}</span>
        </p>
        <p class="inline-note">{{ segment.lines.length }} 句未落位，已标记为待确认，不会被拉伸吞掉。</p>
        <div class="decision-row">
          <button class="mini-button" @click="emit('audition', segment.before.time)">听删减前</button>
          <button class="mini-button" @click="emit('audition', segment.after.time - 0.01)">听删减后</button>
          <button class="mini-button" @click="emit('audition-span', { start: segment.before.time, end: segment.after.time })">循环听整段</button>
        </div>
      </article>
    </div>

    <div v-if="unplaced.length" class="unplaced-list">
      <p class="block-title">没有可靠映射的歌词</p>
      <ol>
        <li v-for="entry in unplaced.slice(0, 12)" :key="entry.lineId">
          <span class="mono">{{ clockLabel(entry.source.start, true) }}</span>
          <span class="unplaced-tone" :style="{ '--tone': LANE_COLORS[entry.kind] }">{{ label[entry.kind] }}</span>
          <span class="unplaced-text">{{ project.lines.find(line => line.id === entry.lineId)?.text }}</span>
        </li>
      </ol>
      <p v-if="unplaced.length > 12" class="inline-note">还有 {{ unplaced.length - 12 }} 句…</p>
    </div>

    <div class="publish-block">
      <button class="primary-button" @click="publish"><Upload :size="15" /> 发布校对结果</button>
      <p class="inline-note">发布后仍可继续校对；每次发布都会留下快照。</p>
    </div>

    <div v-if="project.snapshots.length" class="snapshot-list">
      <p class="block-title">已发布快照</p>
      <ol>
        <li v-for="snapshot in project.snapshots.slice().sort((a, b) => b.createdAt - a.createdAt)" :key="snapshot.id">
          <div>
            <strong>{{ snapshot.label }}</strong>
            <small class="mono">{{ snapshot.lines.length }} 句 · {{ snapshot.anchors.filter(a => a.confirmed).length }} 对应点</small>
          </div>
          <button class="mini-button" @click="emit('restore', snapshot.id)">恢复校对</button>
        </li>
      </ol>
    </div>

    <div class="footer-actions">
      <button class="ghost-button" :disabled="Boolean(busy)" @click="emit('openImport')"><ArrowLeftRight :size="15" /> 另导入一组</button>
      <p v-if="busy" class="inline-note">{{ busy }}</p>
    </div>
  </section>
</template>
