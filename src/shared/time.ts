import type { TimeRange } from './document'
import type { Anchor } from './document'

export function clockLabel(seconds: number, decimal = false) {
  const tenths = Math.floor(Math.max(0, seconds) * 10 + 0.000001)
  const full = Math.floor(tenths / 10)
  const minutes = String(Math.floor(full / 60)).padStart(2, '0')
  const whole = String(full % 60).padStart(2, '0')
  return `${minutes}:${whole}${decimal ? `.${tenths % 10}` : ''}`
}

export function within(range: TimeRange, seconds: number) {
  return range.start <= seconds && seconds < range.end
}

/** Extend a time near a boundary to the neighbouring span (inclusive ends). */
export function contains(range: TimeRange, seconds: number) {
  return range.start <= seconds + 0.001 && seconds <= range.end + 0.001
}

export function sortedAnchors(anchors: readonly Anchor[]): Anchor[] {
  return anchors
    .filter(anchor => anchor.confirmed)
    .slice()
    .sort((a, b) => a.source - b.source || a.time - b.time)
}

/** Map a source time to the target version using confirmed anchors. */
export function mapTime(source: number, anchors: readonly Anchor[], fallbackRate: number): number {
  const sorted = sortedAnchors(anchors)
  if (!sorted.length) return source * fallbackRate
  let before: Anchor | null = null
  let after: Anchor | null = null
  for (const anchor of sorted) {
    if (anchor.source <= source + 1e-6) before = anchor
    else if (!after) after = anchor
  }
  if (before && after && after.source > before.source) {
    const rate = (after.time - before.time) / (after.source - before.source)
    return before.time + (source - before.source) * rate
  }
  if (before) return before.time + (source - before.source) * fallbackRate
  if (after) return Math.max(0, after.time - (after.source - source) * fallbackRate)
  return source * fallbackRate
}

export function mapRange(range: TimeRange, anchors: readonly Anchor[], fallbackRate: number): TimeRange {
  const start = mapTime(range.start, anchors, fallbackRate)
  const end = Math.max(start, mapTime(range.end, anchors, fallbackRate))
  return { start, end }
}

export function nearestAnchor(anchors: readonly Anchor[], side: 'source' | 'time', time: number, window: number) {
  let best: Anchor | null = null
  let distance = window
  for (const anchor of anchors) {
    if (!anchor.confirmed) continue
    const delta = Math.abs(anchor[side] - time)
    if (delta <= distance) {
      distance = delta
      best = anchor
    }
  }
  return best
}
