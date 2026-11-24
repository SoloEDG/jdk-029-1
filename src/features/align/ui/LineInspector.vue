<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Headphones, Mic, Play, Square, Trash2, X } from '@lucide/vue'
import { clockLabel } from '../../../shared/time'
import type { Anchor, LyricLine, SpanDecision, Take } from '../../../shared/document'
import type { LineMapping } from '../lib/mapping'
import { LANE_COLORS } from '../lib/timeline'

const props = defineProps<{
  line: LyricLine
  mapping: LineMapping
  anchors: Anchor[]
  takes: Take[]
  playingId: string | null
  /** Cut spans that overlap this line's bracket. */
  suspectedSpan: SpanDecision | null
  takeText: (take: Take) => string
  takeRange: (take: Take) => { start: number; end: number }
  takeAccuracy: (take: Take) => number | null
  snapshotLabel: (take: Take) => string | null
  recordable: boolean
  loopEnabled: boolean
}>()
const emit = defineEmits<{
  listen: [Take]
  removeTake: [string]
  audition: [number]
  'audition-span': [{ start: number; end: number }]
  choose: [number]
  cut: []
  keepTempo: []
  undoSpan: [string]
  jump: [number]
  removeAnchor: [string]
  toggleAnchor: [string]
  record: []
}>()

const openCandidates = ref(true)
const label: Record<string, string> = {
  known: '已确认', inferred: '按歌速推算', linear: '变速段落', candidate: '待试听候选',
  pending: '待确认删减', unmapped: '无可靠映射', deleted: '已在目标版删减',
}

const candidates = computed(() => {
  const out = props.mapping.candidates.slice()
  if (props.mapping.target) {
    const exists = out.some(point => Math.abs(point.time - props.mapping.target!.start) < 0.2)
    if (!exists) out.unshift({ time: props.mapping.target.start, score: props.mapping.confidence })
  }
  return out.slice(0, 5)
})
</script>

<template>
  <section class="inspector" aria-labelledby="inspector-title">
    <h2 class="rail-title" id="inspector-title"><Headphones :size="17" /> 本句对应</h2>
    <p class="inspector-text">{{ line.text }}</p>
    <div class="inspector-status" :style="{ '--tone': LANE_COLORS[mapping.kind] }">
      <span class="status-chip">{{ label[mapping.kind] }}</span>
      <span v-if="mapping.ambiguous" class="chip-note">对应不唯一</span>
      <span v-if="mapping.warped" class="chip-note">局部速度不同</span>
    </div>
    <p class="inspector-reason">{{ mapping.reason }}</p>

    <dl class="time-pairs">
      <div>
        <dt>歌词（参考版）</dt>
        <dd class="mono">{{ clockLabel(mapping.source.start, true) }}–{{ clockLabel(mapping.source.end, true) }}</dd>
      </div>
      <div>
        <dt>目标版</dt>
        <dd class="mono">
          <template v-if="mapping.target">{{ clockLabel(mapping.target.start, true) }}–{{ clockLabel(mapping.target.end, true) }}</template>
          <template v-else>—</template>
        </dd>
      </div>
    </dl>

    <div v-if="mapping.kind === 'pending' && suspectedSpan" class="decision-block">
      <p>这句在目标版没有找到声音。先听删减区两端，再决定是删减还是仅速度变化。</p>
      <div class="decision-row">
        <button class="ghost-button" @click="emit('audition', suspectedSpan.start)">试听删减前</button>
        <button class="ghost-button" @click="emit('audition', suspectedSpan.end - 0.01)">试听删减后</button>
        <button class="ghost-button" @click="emit('audition-span', { start: mapping.before?.time ?? suspectedSpan.start, end: mapping.after?.time ?? suspectedSpan.end })">整段循环</button>
      </div>
      <div class="decision-row">
        <button class="primary-button" @click="emit('cut')"><Check :size="15" /> 确认这段删减</button>
        <button class="ghost-button" @click="emit('keepTempo')">只是速度变化</button>
      </div>
    </div>

    <div v-if="mapping.kind === 'deleted' && suspectedSpan" class="decision-block">
      <p>这段歌词保留在参考版时间轴上等待核对，不会被放到目标版。确认无误后可以撤销删减标记。</p>
      <button class="ghost-button" @click="emit('undoSpan', suspectedSpan.id)">撤销删减标记</button>
    </div>

    <div v-if="mapping.kind === 'unmapped'" class="decision-block">
      <p>还没有端到端的对应点，这一句在目标版没有可靠位置。先在前一句和后一句各建立一对对应点。</p>
    </div>

    <div v-if="candidates.length" class="candidate-block">
      <button class="block-toggle" :aria-expanded="openCandidates" @click="openCandidates = !openCandidates">
        候选位置（{{ candidates.length }}）<span class="mono">{{ mapping.ambiguous ? '需试听' : '按声学排序' }}</span>
      </button>
      <ol v-if="openCandidates" class="candidate-list">
        <li v-for="(candidate, index) in candidates" :key="`${candidate.time}-${index}`">
          <button class="icon-button" :aria-label="`试听候选 ${index + 1}`" @click="emit('audition', candidate.time)">
            <Play :size="12" fill="currentColor" />
          </button>
          <span class="mono">{{ clockLabel(candidate.time, true) }}</span>
          <span class="candidate-score mono">{{ Math.round(candidate.score * 100) }}%</span>
          <button class="mini-button" @click="emit('choose', candidate.time)">用这个</button>
        </li>
      </ol>
      <p v-if="mapping.ambiguous" class="inline-note">同词段落出现多次，系统不替你选择，请逐个试听。</p>
    </div>

    <div class="anchor-block">
      <p class="block-title">相邻对应点</p>
      <p v-if="!mapping.before && !mapping.after" class="inline-note">还没有对应点：先在两个版本同一位置各按一次「建立对应点」。</p>
      <ul v-else class="anchor-list">
        <li v-if="mapping.before">
          <span class="mono">{{ clockLabel(mapping.before.source, true) }} → {{ clockLabel(mapping.before.time, true) }}</span>
          <span class="anchor-tools">
            <button class="mini-button" @click="emit('jump', mapping.before.time)">听</button>
            <button class="mini-button" :aria-label="mapping.before.confirmed ? '取消锁定' : '锁定'" @click="emit('toggleAnchor', mapping.before.id)">
              {{ mapping.before.confirmed ? '锁定' : '未锁定' }}
            </button>
            <button class="mini-button danger" aria-label="删除对应点" @click="emit('removeAnchor', mapping.before.id)"><X :size="12" /></button>
          </span>
        </li>
        <li v-if="mapping.after">
          <span class="mono">{{ clockLabel(mapping.after.source, true) }} → {{ clockLabel(mapping.after.time, true) }}</span>
          <span class="anchor-tools">
            <button class="mini-button" @click="emit('jump', mapping.after.time)">听</button>
            <button class="mini-button" @click="emit('toggleAnchor', mapping.after.id)">
              {{ mapping.after.confirmed ? '锁定' : '未锁定' }}
            </button>
            <button class="mini-button danger" aria-label="删除对应点" @click="emit('removeAnchor', mapping.after.id)"><X :size="12" /></button>
          </span>
        </li>
      </ul>
    </div>

    <div class="take-block">
      <p class="block-title">本句录音 <span class="mono">{{ takes.length }}</span></p>
      <p v-if="!takes.length" class="inline-note">还没有录音。</p>
      <ol v-else class="take-list">
        <li v-for="(take, index) in takes" :key="take.id">
          <button class="icon-button listen-button" :aria-label="playingId === take.id ? '停止' : '复听录音'"
            @click="emit('listen', take)">
            <Square v-if="playingId === take.id" :size="12" fill="currentColor" /><Play v-else :size="12" fill="currentColor" />
          </button>
          <span class="take-info">
            <strong>{{ takeText(take) }}</strong>
            <small class="mono">
              {{ clockLabel(takeRange(take).start, true) }}–{{ clockLabel(takeRange(take).end, true) }}
              <template v-if="snapshotLabel(take)"> · {{ snapshotLabel(take) }}</template>
            </small>
          </span>
          <span class="take-score mono">{{ takeAccuracy(take) ?? '—' }}<template v-if="takeAccuracy(take) !== null">%</template></span>
          <button class="mini-button danger" aria-label="删除这条录音" @click="emit('removeTake', take.id)"><Trash2 :size="12" /></button>
        </li>
      </ol>
      <button class="record-button" :disabled="!recordable" @click="emit('record')">
        <Mic :size="15" /> 按目标版录这一句
      </button>
      <p v-if="!recordable" class="inline-note">本句还没有确定的目标版位置，先试听并选定再录。</p>
      <p v-else-if="loopEnabled" class="inline-note">录音会从句首开始并自动停止；循环开着时录完继续循环。</p>
      <p class="inline-note">录音按目标版歌时与词保存；发布后继续校对，旧录音仍按录制当时的词与歌时复听。</p>
    </div>
  </section>
</template>
