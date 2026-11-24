<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { Anchor, SpanDecision } from '../../../shared/document'
import { hitTest, drawTimeline, type TimelineLine } from '../lib/timeline'

const props = defineProps<{
  lines: TimelineLine[]
  anchors: Anchor[]
  spans: SpanDecision[]
  unreliable: { start: number; end: number }[]
  selectedId: string | null
  version: 'reference' | 'target'
  duration: number
  cursor: number
  ghost: { start: number; end: number } | null
  mapping?: (source: number) => number
}>()
const emit = defineEmits<{
  selectLine: [string]
  seek: [number]
  addAnchor: [number]
  moveAnchor: [string, number]
  moveSource: [string, number]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
const hover = ref<number | null>(null)
const dragging = ref<{ id: string; kind: 'anchor' } | null>(null)
let observer: ResizeObserver | undefined

const height = computed(() => Math.max(64, props.lines.length * 15 + 38))

const nearestAnchor = (time: number) => {
  let best: Anchor | null = null
  let bestGap = 0.35
  for (const anchor of props.anchors) {
    if (!anchor.confirmed) continue
    const anchorTime = props.version === 'target' ? anchor.time : anchor.source
    const gap = Math.abs(anchorTime - time)
    if (gap <= bestGap) { bestGap = gap; best = anchor }
  }
  return best
}

function locate(event: PointerEvent) {
  const element = canvas.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  return { x, y, rect, hit: hitTest(x, y, size.value.width, height.value, props.duration, props.lines.length) }
}

function onPointerMove(event: PointerEvent) {
  const spot = locate(event)
  if (!spot) return
  hover.value = spot.hit?.time ?? null
  if (dragging.value) {
    const anchor = props.anchors.find(entry => entry.id === dragging.value!.id)
    if (anchor && spot.hit) {
      if (props.version === 'target') emit('moveAnchor', anchor.id, Math.max(0, spot.hit.time))
      else emit('moveSource', anchor.id, Math.max(0, spot.hit.time))
    }
  }
}

function onPointerDown(event: PointerEvent) {
  const spot = locate(event)
  if (!spot?.hit) return
  const anchor = nearestAnchor(spot.hit.time)
  if (anchor) {
    dragging.value = { id: anchor.id, kind: 'anchor' }
    canvas.value?.setPointerCapture(event.pointerId)
    return
  }
}

function onPointerUp(event: PointerEvent) {
  const spot = locate(event)
  if (!spot?.hit) { dragging.value = null; return }
  if (dragging.value) { dragging.value = null; return }
  const anchor = nearestAnchor(spot.hit.time)
  if (anchor) {
    emit('seek', props.version === 'target' ? anchor.time : anchor.source)
    return
  }
  const entry = props.lines[spot.hit.index]
  if (entry) emit('selectLine', entry.line.id)
  emit('seek', spot.hit.time)
}

function onDoubleClick(event: MouseEvent) {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  const hit = hitTest(x, y, size.value.width, height.value, props.duration, props.lines.length)
  if (!hit) return
  if (!nearestAnchor(hit.time)) emit('addAnchor', hit.time)
}

onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())

watchEffect(() => {
  const { width } = size.value
  if (!canvas.value || width < 60) return
  drawTimeline(canvas.value, {
    width,
    height: height.value,
    version: props.version,
    duration: props.duration,
    lines: props.lines,
    anchors: props.anchors,
    spans: props.spans,
    selectedId: props.selectedId,
    cursor: props.cursor,
    hover: hover.value,
    ghost: props.ghost,
    unreliable: props.unreliable,
    mapSource: props.mapping,
  })
})
</script>

<template>
  <section class="timeline" aria-label="双版时间轴">
    <canvas ref="canvas" class="timeline-canvas" :style="{ height: `${height}px` }" role="img"
      :aria-label="`${version === 'reference' ? '参考版' : '目标版'}时间轴，${lines.length} 句歌词`"
      @pointermove="onPointerMove" @pointerdown="onPointerDown" @pointerup="onPointerUp"
      @pointerleave="hover = null" @dblclick="onDoubleClick"></canvas>
    <p class="timeline-hint">单击定位并选句 · 双击空白处加对应点 · 拖动对应点微调（其它对应点保持锁定）</p>
  </section>
</template>
