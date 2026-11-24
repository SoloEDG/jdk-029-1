import { onBeforeUnmount, ref } from 'vue'
import type { PcmFrame, TimeRange } from '../../../shared/document'
import { openInput } from '../../capture/lib/input'
import { toWave } from '../../capture/lib/wave'

export interface CaptureTarget {
  /** Lyric-side span of the line. */
  source: TimeRange
  /** Target-version span being sung. */
  target: TimeRange
  lineId: string
  lineText: string
  snapshotId: string | null
  snapshotLabel: string | null
}

export interface CapturedAudio {
  audio: Blob
  /** Captured target-version span, clipped to `target`. */
  target: TimeRange
  source: TimeRange
  lineId: string
  lineText: string
  snapshotId: string | null
  snapshotLabel: string | null
}

interface CaptureEvents {
  /** Pitch sample, timestamped on the lyric-side timeline. */
  onFrame: (sourceTime: number, samples: Float32Array, rate: number) => void
  onComplete: (result: CapturedAudio) => Promise<void>
  /** Current target-version time. */
  position: () => number
}

type Input = Awaited<ReturnType<typeof openInput>>
type Active = CaptureTarget & {
  inputStart: number
  captureStart: number
  frames: PcmFrame[]
  /** Frames are ignored until playback has actually reached the target span. */
  armed: boolean
}

/**
 * Microphone capture tied to the target-version clock. Recording begins when
 * playback reaches the line's target start, so the stored take aligns with the
 * target audio. Pitch points are stamped on the lyric timeline so the score
 * graph stays comparable across re-alignment.
 */
export function useCapture(events: CaptureEvents) {
  const status = ref<'idle' | 'requesting' | 'recording' | 'saving'>('idle')
  const issue = ref('')
  const level = ref(0)
  let input: Input | null = null
  let active: Active | null = null
  let request = 0

  function receive(frame: PcmFrame) {
    if (!active || !input || !active.armed) return
    const time = active.captureStart + frame.inputTime - active.inputStart
    const end = time + frame.samples.length / input.sampleRate
    if (end <= active.target.start || time >= active.target.end) return
    active.frames.push(frame)
    if (status.value !== 'recording') return
    const rms = Math.sqrt(frame.samples.reduce((sum, value) => sum + value * value, 0) / frame.samples.length)
    level.value = Math.min(1, rms * 4)
    const midpoint = (time + end) / 2
    if (midpoint >= active.target.start && midpoint < active.target.end) {
      const source = active.source.start + (midpoint - active.target.start)
      events.onFrame(Math.min(active.source.end, source), frame.samples, input.sampleRate)
    }
  }

  async function start(target: CaptureTarget, preparePlayback: () => Promise<boolean>) {
    if (status.value !== 'idle') return
    const token = ++request
    status.value = 'requesting'
    issue.value = ''
    try {
      const stream = await openInput(receive, () => {
        issue.value = '麦克风已断开。'
        if (status.value === 'requesting') cancel()
        else void stop(events.position())
      })
      if (token !== request) { stream.close(); return }
      input = stream
      active = {
        ...target,
        inputStart: stream.clock(),
        captureStart: target.target.start,
        frames: [],
        armed: false,
      }
      if (!await preparePlayback() || token !== request) {
        active = null
        if (input === stream) cancel()
        return
      }
      // Playback was seeked to the target start and is running; only now do
      // incoming frames belong to the take.
      active.inputStart = stream.clock()
      active.captureStart = target.target.start
      active.armed = true
      status.value = 'recording'
    } catch (error) {
      if (token !== request) return
      cancel()
      issue.value = error instanceof DOMException && error.name === 'NotAllowedError'
        ? '麦克风权限未开启。'
        : '无法开启麦克风，请检查设备和访问权限。'
    }
  }

  function cancel() {
    if (status.value !== 'requesting' && status.value !== 'recording') return
    request++
    input?.close()
    input = null
    active = null
    level.value = 0
    status.value = 'idle'
  }

  async function stop(position: number) {
    if (status.value !== 'recording' || !active || !input) return
    status.value = 'saving'
    const capture = active
    const stream = input
    const end = Math.max(capture.captureStart, Math.min(position, capture.target.end))
    const duration = end - capture.captureStart
    try {
      await stream.flush()
      if (duration < 0.2 || !capture.frames.length) {
        issue.value = '录音少于 0.2 秒，未保存。'
        return
      }
      const audio = toWave(capture.frames, capture.inputStart, duration, stream.sampleRate)
      const elapsedSource = duration / Math.max(0.2, capture.target.end - capture.target.start) * (capture.source.end - capture.source.start)
      await events.onComplete({
        audio,
        target: { start: capture.captureStart, end },
        source: { start: capture.source.start, end: Math.min(capture.source.end, capture.source.start + elapsedSource) },
        lineId: capture.lineId,
        lineText: capture.lineText,
        snapshotId: capture.snapshotId,
        snapshotLabel: capture.snapshotLabel,
      })
    } catch {
      issue.value = '录音未能保存。'
    } finally {
      stream.close()
      if (input === stream) input = null
      active = null
      level.value = 0
      status.value = 'idle'
    }
  }

  onBeforeUnmount(() => {
    request++
    if (status.value !== 'saving') input?.close()
    input = null
  })
  return { status, issue, level, start, stop, cancel }
}
