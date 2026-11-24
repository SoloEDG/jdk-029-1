<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowLeftRight, ChevronsLeft, ChevronsRight, Pause, Play, Repeat2, SkipBack, SkipForward, Volume2, VolumeX,
} from '@lucide/vue'
import { clockLabel } from '../../../shared/time'
import type { Anchor } from '../../../shared/document'

const props = defineProps<{
  version: 'reference' | 'target'
  referenceLabel: string
  targetLabel: string
  position: number
  duration: number
  playing: boolean
  loopActive: boolean
  volume: number
  issue: string
  anchors: Anchor[]
  pairSource: number | null
  alternating: boolean
}>()
const emit = defineEmits<{
  toggle: []
  previous: []
  next: []
  loop: []
  seek: [number]
  volume: [number]
  switchVersion: [number]
  mark: []
  alternate: []
  jump: [number]
}>()

const sorted = computed(() => props.anchors.slice().sort((a, b) => a.time - b.time))
function jump(direction: -1 | 1) {
  const time = props.version === 'target' ? props.position : props.position
  const list = props.version === 'target'
    ? sorted.value.map(anchor => anchor.time)
    : sorted.value.map(anchor => anchor.source).sort((a, b) => a - b)
  const next = direction > 0
    ? list.find(value => value > time + 0.05)
    : list.slice().reverse().find(value => value < time - 0.05)
  if (next !== undefined) emit('jump', next)
  else if (direction > 0) emit('next')
  else emit('previous')
}
</script>

<template>
  <section class="transport" aria-label="双版试听">
    <div class="version-switch" role="group" aria-label="音频版本">
      <button :class="{ on: version === 'reference' }" :aria-pressed="version === 'reference'"
        @click="emit('switchVersion', 0)"><span class="tag">参</span>{{ referenceLabel }}</button>
      <button :class="{ on: version === 'target' }" :aria-pressed="version === 'target'"
        @click="emit('switchVersion', 1)"><span class="tag">标</span>{{ targetLabel }}</button>
    </div>
    <div class="transport-controls">
      <button class="icon-button" aria-label="上一句" title="上一句" @click="emit('previous')"><SkipBack :size="17" /></button>
      <button class="icon-button" aria-label="上一个对应点" title="上一个对应点" @click="jump(-1)"><ChevronsLeft :size="17" /></button>
      <button class="play-button" :aria-label="playing ? '暂停' : '播放'" @click="emit('toggle')">
        <Pause v-if="playing" :size="19" fill="currentColor" /><Play v-else :size="19" fill="currentColor" />
      </button>
      <button class="icon-button" aria-label="下一个对应点" title="下一个对应点" @click="jump(1)"><ChevronsRight :size="17" /></button>
      <button class="icon-button" aria-label="下一句" title="下一句" @click="emit('next')"><SkipForward :size="17" /></button>
    </div>
    <div class="scrubber">
      <span class="mono">{{ clockLabel(position, true) }}</span>
      <input aria-label="播放进度" type="range" min="0" :max="duration" step="0.01" :value="position"
        :style="{ '--fill': `${100 * position / Math.max(0.01, duration)}%` }"
        @input="emit('seek', Number(($event.target as HTMLInputElement).value))" />
      <span class="mono subdued">{{ clockLabel(duration, true) }}</span>
    </div>
    <button class="loop-button" :class="{ enabled: loopActive }" :aria-pressed="loopActive" @click="emit('loop')">
      <Repeat2 :size="17" /> <span>{{ loopActive ? '循环校对中' : '循环本句' }}</span>
    </button>
    <button class="mark-button" :class="{ armed: pairSource !== null }" :aria-pressed="pairSource !== null" @click="emit('mark')">
      <ArrowLeftRight :size="16" />
      <template v-if="pairSource === null">在参考版选对应点</template>
      <template v-else>在目标版选同一点</template>
    </button>
    <button class="loop-button" :class="{ enabled: alternating }" :aria-pressed="alternating" @click="emit('alternate')">
      {{ alternating ? '停止交替' : '交替试听本句' }}
    </button>
    <div class="volume-control">
      <button class="icon-button" :aria-label="volume ? '静音' : '恢复音量'" @click="emit('volume', volume ? 0 : 0.7)">
        <Volume2 v-if="volume" :size="18" /><VolumeX v-else :size="18" />
      </button>
      <input aria-label="音量" type="range" min="0" max="1" step="0.01" :value="volume"
        :style="{ '--fill': `${100 * volume}%` }" @input="emit('volume', Number(($event.target as HTMLInputElement).value))" />
    </div>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
  </section>
</template>
