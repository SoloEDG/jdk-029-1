import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { Anchor, AudioVersion, TimeRange } from '../../../shared/document'
import { mapTime } from '../../../shared/time'

export interface PlayerEvents {
  /** Called before any seek/pause; finish an in-flight capture here. */
  beforeMove: () => void
}

function resolveSrc(version: AudioVersion) {
  return version.url ?? ''
}

/**
 * Two synchronised audio elements. The reference version anchors the lyrics;
 * the target version is where practice happens. Switching versions keeps the
 * lyric offset stable by mapping the current time through the confirmed
 * correspondences.
 */
export function usePlayer(reference: Ref<AudioVersion>, target: Ref<AudioVersion>, events: PlayerEvents) {
  const version = ref<'reference' | 'target'>('reference')
  const position = ref(0)
  const playing = ref(false)
  const loop = shallowRef<TimeRange | null>(null)
  const volume = ref(0.7)
  const issue = ref('')
  const elements = {
    reference: new Audio(resolveSrc(reference.value)),
    target: new Audio(resolveSrc(target.value)),
  }
  for (const element of Object.values(elements)) {
    element.preload = 'metadata'
    element.volume = volume.value
  }
  let frame = 0
  let operation = 0

  function current() { return elements[version.value] }

  function sync() {
    const element = current()
    if (element.seeking) return
    const next = element.currentTime
    const range = loop.value
    if (range && !element.paused && next >= range.end) {
      element.currentTime = range.start
      position.value = range.start
      return
    }
    position.value = next
  }

  function tick() {
    sync()
    if (!current().paused) frame = requestAnimationFrame(tick)
  }

  function readTime() { return current().currentTime }

  function seek(seconds: number) {
    const duration = version.value === 'target' ? target.value.duration : reference.value.duration
    const time = Math.max(0, Math.min(seconds, duration))
    events.beforeMove()
    current().currentTime = time
    position.value = time
  }

  function pause() {
    operation++
    const element = current()
    element.pause()
    playing.value = false
    cancelAnimationFrame(frame)
    sync()
  }

  async function play() {
    if (playing.value) return true
    const token = ++operation
    issue.value = ''
    const element = current()
    const range = loop.value
    if (range && (element.currentTime < range.start || element.currentTime >= range.end)) {
      element.currentTime = range.start
      position.value = range.start
    } else if (element.ended) {
      element.currentTime = 0
    }
    try {
      await element.play()
      if (token !== operation) return false
      playing.value = true
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
      return true
    } catch {
      if (token === operation) issue.value = '伴奏播放失败，请重试。'
      return false
    }
  }

  function pauseOther() {
    for (const key of ['reference', 'target'] as const) {
      if (key === version.value) continue
      elements[key].pause()
    }
  }

  function switchVersion(next: 'reference' | 'target', anchors: readonly Anchor[], rate: number) {
    if (next === version.value) return
    const wasPlaying = playing.value
    const sourceTime = version.value === 'reference' ? position.value : reverseMapTime(position.value, anchors, rate)
    events.beforeMove()
    pauseOther()
    current().pause()
    cancelAnimationFrame(frame)
    version.value = next
    const mapped = next === 'reference' ? sourceTime : mapTime(sourceTime, anchors, rate)
    const duration = next === 'target' ? target.value.duration : reference.value.duration
    const clamped = Math.max(0, Math.min(mapped, duration))
    current().currentTime = clamped
    position.value = clamped
    if (wasPlaying) void play()
  }

  /** Reverse-map a target time to the lyric-side timeline. */
  function reverseMapTime(time: number, anchors: readonly Anchor[], rate: number): number {
    const sorted = anchors.filter(anchor => anchor.confirmed).slice().sort((a, b) => a.time - b.time)
    if (!sorted.length) return time / rate
    let before: Anchor | null = null
    let after: Anchor | null = null
    for (const anchor of sorted) {
      if (anchor.time <= time + 1e-6) before = anchor
      else if (!after) after = anchor
    }
    if (before && after && after.time > before.time) {
      const localRate = (after.time - before.time) / (after.source - before.source)
      return before.source + (time - before.time) / localRate
    }
    if (before) return before.source + (time - before.time) / rate
    if (after) return Math.max(0, after.source - (after.time - time) / rate)
    return time / rate
  }

  function setVolume(next: number) {
    volume.value = Math.min(1, Math.max(0, next))
    for (const element of Object.values(elements)) element.volume = volume.value
  }

  function setLoop(range: TimeRange | null) { loop.value = range }

  /**
   * Swap audio only when a source URL actually changed. The workbench passes
   * fresh version objects whenever the project is edited, and reloading the
   * media on every anchor tweak would stop playback and jump to the start.
   */
  function replaceVersions() {
    const next = { reference: resolveSrc(reference.value), target: resolveSrc(target.value) }
    // Compare resolved absolute URLs: the `src` property normalises relative
    // paths, so compare against the resolved form of the incoming URL too.
    const absolute = (url: string) => {
      try { return url ? new URL(url, location.href).href : '' } catch { return url }
    }
    const changed = (Object.keys(elements) as ('reference' | 'target')[])
      .filter(key => elements[key].src !== absolute(next[key]))
    if (!changed.length) return
    pause()
    for (const key of changed) {
      elements[key].src = next[key]
      elements[key].load()
    }
    if (changed.includes(version.value)) {
      position.value = 0
      loop.value = null
    }
  }

  const duration = computed(() => version.value === 'target' ? target.value.duration : reference.value.duration)

  function handleEnded() { pause() }
  function handleError() {
    pause()
    issue.value = '无法读取伴奏。'
  }
  for (const element of Object.values(elements)) {
    element.addEventListener('ended', handleEnded)
    element.addEventListener('error', handleError)
  }

  watch(
    [() => resolveSrc(reference.value), () => resolveSrc(target.value)],
    replaceVersions,
  )

  onBeforeUnmount(() => {
    pause()
    for (const element of Object.values(elements)) {
      element.removeEventListener('ended', handleEnded)
      element.removeEventListener('error', handleError)
      element.removeAttribute('src')
      element.load()
    }
  })

  return {
    version, position, playing, loop, volume, issue, duration,
    readTime, seek, play, pause, switchVersion, reverseMapTime, setVolume, setLoop,
  }
}
