import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'
import type { GuideNote, PitchPoint, Take, TimeRange } from '../../../shared/document'
import { takePlaybackRange, takeLyricText } from '../lib/archive'
import type { PublishedSnapshot } from '../../../shared/document'

/** Plays a take, either against the target audio or stand-alone. */
export function useTakes(
  project: Ref<{ snapshots: PublishedSnapshot[] }>,
  beforePlay: () => void,
) {
  const takes = shallowRef<Take[]>([])
  const playingId = ref<string | null>(null)
  const position = ref<number | null>(null)
  const issue = ref('')
  const player = new Audio()
  let source: string | null = null
  let current: Take | null = null
  let frame = 0

  function stop() {
    player.pause()
    cancelAnimationFrame(frame)
    if (source) {
      player.removeAttribute('src')
      player.load()
      URL.revokeObjectURL(source)
      source = null
    }
    current = null
    playingId.value = null
    position.value = null
  }

  function tick() {
    if (!current || player.paused) return
    position.value = Math.min(current.targetEnd, current.targetStart + player.currentTime)
    frame = requestAnimationFrame(tick)
  }

  async function listen(take: Take) {
    const replay = playingId.value !== take.id
    stop()
    if (!replay) return
    beforePlay()
    issue.value = ''
    current = take
    playingId.value = take.id
    position.value = take.targetStart
    source = URL.createObjectURL(take.audio)
    const own = source
    player.src = source
    player.currentTime = 0
    try {
      await player.play()
      if (source === own) tick()
    } catch {
      if (source !== own) return
      stop()
      issue.value = '无法播放这条录音。'
    }
  }

  function setTakes(next: Take[]) {
    takes.value = next
    if (playingId.value && !next.some(take => take.id === playingId.value)) stop()
  }

  const visible = (lineId: string | null) =>
    takes.value
      .filter(take => take.lineId === lineId)
      .sort((a, b) => b.createdAt - a.createdAt)

  /** The two most recent takes for a line, used as the A/B pitch comparison. */
  function comparison(lineId: string | null) {
    return visible(lineId).slice(0, 2)
  }

  function snapshotFor(take: Take): PublishedSnapshot | null {
    if (!take.snapshotId) return null
    return project.value.snapshots.find(entry => entry.id === take.snapshotId) ?? null
  }


  /** The range this take was sung against, honouring its published snapshot. */
  function rangeOf(take: Take): TimeRange {
    return takePlaybackRange(take, snapshotFor(take))
  }

  function textOf(take: Take) {
    return takeLyricText(take, snapshotFor(take))
  }

  /**
   * Rescore a take against the guide notes. The lyric-side range is the one
   * captured with the take, so a later re-alignment never re-scores old audio
   * against a different span of the song.
   */
  function accuracy(take: Take, notes: readonly GuideNote[], sourceRange?: TimeRange): number | null {
    const snapshot = snapshotFor(take)
    const lineStillExists = !snapshot || Boolean(snapshot.lines.find(line => line.id === take.lineId))
    if (!lineStillExists) return null
    void sourceRange
    return scorePitch(take.pitch, notes, { start: take.sourceStart, end: take.sourceEnd })
  }

  onBeforeUnmount(() => {
    player.removeEventListener('ended', stop)
    stop()
  })
  player.addEventListener('ended', stop)

  return {
    takes, playingId, position, issue, visible, comparison,
    listen, stop, setTakes, rangeOf, textOf, accuracy, snapshotFor,
  }
}

/**
 * Compare pitch points against guide notes. Points are in lyric-side time;
 * `sourceRange` scopes the comparison to the line, so a take recorded before a
 * re-alignment is still judged against the words it was sung with.
 */
export function scorePitch(points: readonly PitchPoint[], notes: readonly GuideNote[], sourceRange: TimeRange) {
  let valid = 0
  let hits = 0
  for (const point of points) {
    if (point.midi === null) continue
    if (point.time < sourceRange.start || point.time >= sourceRange.end) continue
    const target = notes.find(note => note.start <= point.time && point.time < note.end)
    if (!target) continue
    valid++
    if (Math.abs(point.midi - target.midi) <= 0.5) hits++
  }
  return valid > 0 ? Math.round(hits / valid * 100) : null
}
