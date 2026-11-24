<script setup lang="ts">
import { Activity } from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { GuideNote, PitchPoint, TimeRange } from '../../../shared/document'
import { drawPitch } from '../../pitch/lib/plot'

const props = defineProps<{
  notes: GuideNote[]
  position: number
  range: TimeRange
  latest: string | null
  live: PitchPoint[]
  takeA: PitchPoint[]
  takeB: PitchPoint[]
  /** Target-version times for the two comparison takes. */
  shiftA: number
  shiftB: number
  /** True when the displayed range is an unreliable mapping. */
  unreliable: boolean
}>()
const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())
watchEffect(() => {
  const { width, height } = size.value
  if (!canvas.value || width < 80 || height < 80) return
  drawPitch(canvas.value, width, height, {
    notes: props.notes,
    range: props.range,
    position: props.position,
    unreliable: props.unreliable,
    traces: [
      { points: shift(props.takeA, props.shiftA), color: '#85cbd5' },
      { points: shift(props.takeB, props.shiftB), color: '#ec9fa9' },
      { points: props.live, color: '#b8dc9d' },
    ],
  })
})

/**
 * Stored pitch points are on the lyric timeline. Shift the whole trace by the
 * line's target-minus-source offset so it overlays the target-version graph.
 * (Pitch is compared by note, not by absolute time, so a small local tempo
 * difference inside one line does not need an extra warp here.)
 */
function shift(points: PitchPoint[], delta: number): PitchPoint[] {
  if (!delta) return points
  return points.map(point => ({ ...point, time: point.time + delta }))
}
</script>

<template>
  <section class="pitch-panel" aria-labelledby="pitch-title">
    <div class="pitch-heading">
      <h2 id="pitch-title" class="panel-heading"><Activity :size="17" /> 音高轨迹</h2>
      <div class="pitch-legends">
        <span><i class="legend reference"></i>参考音</span><span><i class="legend live"></i>我的声音</span>
        <span v-if="takeA.length"><i class="legend a"></i>A</span><span v-if="takeB.length"><i class="legend b"></i>B</span>
        <span v-if="unreliable" class="legend-warn">映射不可靠</span>
      </div>
    </div>
    <canvas ref="canvas" class="pitch-canvas" role="img"
      :aria-label="`参考音与录音音高轨迹，当前音高 ${latest ?? '未检测到'}`"></canvas>
    <div class="pitch-footer"><span>当前音高 <strong class="mono">{{ latest ?? '—' }}</strong></span><span>目标版时间</span></div>
  </section>
</template>
