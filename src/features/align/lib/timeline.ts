import type { Anchor, AudioVersion, LyricLine, SpanDecision, TimeRange } from '../../../shared/document'
import type { LineMapping } from '../lib/mapping'

export interface TimelineLine {
  line: LyricLine
  mapping: LineMapping
}

interface DrawOptions {
  width: number
  height: number
  version: 'reference' | 'target'
  duration: number
  lines: TimelineLine[]
  anchors: Anchor[]
  spans: SpanDecision[]
  selectedId: string | null
  /** Hovered or playhead time in the displayed version. */
  cursor: number | null
  hover: number | null
  /** Target span previewed during an audition. */
  ghost: TimeRange | null
  /** Unreliable ranges, expressed in the displayed timeline's own time. */
  unreliable: TimeRange[]
  /** Required in target view: map a reference time onto the target timeline. */
  mapSource?: (source: number) => number
}

const COLORS = {
  paper: '#f1ecdb',
  muted: '#b0b1a1',
  soft: '#989b89',
  gold: '#e5bd70',
  green: '#b8dc9d',
  coral: '#f09982',
  rule: '#3b3e33',
  inset: '#22261e',
  known: '#b8dc9d',
  inferred: '#8fb7a8',
  candidate: '#e5bd70',
  pending: '#f09982',
  deleted: '#7c7f72',
  unmapped: '#6d7064',
  linear: '#9fb6c8',
}

export const LANE_COLORS: Record<string, string> = {
  known: COLORS.known,
  inferred: COLORS.inferred,
  linear: COLORS.linear,
  candidate: COLORS.candidate,
  pending: COLORS.pending,
  deleted: COLORS.deleted,
  unmapped: COLORS.unmapped,
}

export function drawTimeline(canvas: HTMLCanvasElement, options: DrawOptions) {
  const ratio = window.devicePixelRatio || 1
  const { width, height } = options
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  const left = 54
  const right = width - 14
  const duration = Math.max(0.001, options.duration)
  const x = (time: number) => left + Math.max(0, Math.min(duration, time)) / duration * (right - left)

  context.fillStyle = '#20241d'
  context.fillRect(0, 0, width, height)

  // Time ruler.
  const ticks = width < 420 ? 4 : width < 680 ? 6 : 9
  context.font = '10px "IBM Plex Mono", monospace'
  for (let index = 0; index <= ticks; index++) {
    const time = duration * index / ticks
    const px = x(time)
    context.strokeStyle = '#343a30'
    context.beginPath()
    context.moveTo(px, 18)
    context.lineTo(px, height)
    context.stroke()
    const label = `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`
    context.fillStyle = '#a5ac96'
    context.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center'
    context.fillText(label, px, 12)
  }

  const mapSource = options.mapSource ?? ((time: number) => time)
  const display = (source: number) => options.version === 'target' ? mapSource(source) : source

  // Unreliable spans: diagonal hatching.
  for (const range of options.unreliable) {
    const start = x(range.start)
    const end = Math.max(start + 2, x(range.end))
    context.save()
    context.beginPath()
    context.rect(start, 20, end - start, height - 26)
    context.clip()
    context.fillStyle = 'rgba(240, 153, 130, 0.07)'
    context.fillRect(start, 20, end - start, height - 26)
    context.strokeStyle = 'rgba(240, 153, 130, 0.32)'
    context.lineWidth = 1
    for (let offset = -height; offset < end - start + height; offset += 7) {
      context.beginPath()
      context.moveTo(start + offset, height)
      context.lineTo(start + offset + height, 20)
      context.stroke()
    }
    context.restore()
  }

  // Confirmed cut spans.
  for (const span of options.spans.filter(entry => entry.confirmed && entry.kind === 'cut')) {
    const start = x(span.start)
    const end = Math.max(start + 2, x(span.end))
    context.fillStyle = 'rgba(124, 127, 114, 0.16)'
    context.fillRect(start, 22, end - start, height - 30)
    context.strokeStyle = '#5c5f53'
    context.setLineDash([4, 3])
    context.strokeRect(start, 22, end - start, height - 30)
    context.setLineDash([])
  }

  // Lyrics, one lane each.
  const laneTop = 26
  const laneBottom = height - 26
  const laneHeight = (laneBottom - laneTop) / Math.max(1, options.lines.length)
  const rowHeight = Math.max(3, Math.min(11, laneHeight - 2))

  for (let index = 0; index < options.lines.length; index++) {
    const entry = options.lines[index]
    const laneY = laneTop + index * laneHeight
    const selected = entry.line.id === options.selectedId
    if (selected) {
      context.fillStyle = 'rgba(229, 189, 112, 0.09)'
      context.fillRect(left, laneY, right - left, laneHeight)
    }
    const sourceColor = statusColor(entry.mapping.kind)
    const sourceStart = x(display(entry.line.start))
    const sourceEnd = Math.max(sourceStart + 2, x(display(entry.line.end)))

    if (options.version === 'reference') {
      // The lyric's own occurrence on the version it was transcribed against.
      context.fillStyle = hexAlpha(sourceColor, selected ? 0.9 : 0.55)
      context.beginPath()
      context.roundRect(sourceStart, laneY + laneHeight / 2 - rowHeight / 2, sourceEnd - sourceStart, rowHeight, 3)
      context.fill()
    } else {
      if (entry.mapping.kind === 'deleted') {
        // A cut line: mark where it would have been, never a span.
        context.strokeStyle = hexAlpha(COLORS.pending, 0.9)
        context.lineWidth = 1.5
        const mid = laneY + laneHeight / 2
        const markX = x(display(entry.line.start))
        context.beginPath()
        context.moveTo(markX - 3.5, mid - 3.5)
        context.lineTo(markX + 3.5, mid + 3.5)
        context.moveTo(markX + 3.5, mid - 3.5)
        context.lineTo(markX - 3.5, mid + 3.5)
        context.stroke()
      } else if (entry.mapping.target) {
        const targetStart = x(entry.mapping.target.start)
        const targetEnd = Math.max(targetStart + 2, x(entry.mapping.target.end))
        context.fillStyle = hexAlpha(sourceColor, selected ? 1 : 0.82)
        context.beginPath()
        context.roundRect(targetStart, laneY + laneHeight / 2 - rowHeight / 2, targetEnd - targetStart, rowHeight, 3)
        context.fill()
        if (entry.mapping.ambiguous) {
          context.strokeStyle = COLORS.gold
          context.lineWidth = 1
          context.beginPath()
          context.roundRect(targetStart - 1, laneY + laneHeight / 2 - rowHeight / 2 - 1, targetEnd - targetStart + 2, rowHeight + 2, 4)
          context.stroke()
        }
        // Thin tether from the lyric's mapped source time to its target time.
        if (Math.abs(targetStart - sourceStart) > 3) {
          context.strokeStyle = hexAlpha(sourceColor, 0.22)
          context.lineWidth = 1
          context.beginPath()
          context.moveTo(sourceStart, laneY + laneHeight / 2 + rowHeight / 2)
          context.lineTo(targetStart, laneY + laneHeight / 2 + rowHeight / 2)
          context.stroke()
        }
      } else if (entry.mapping.kind === 'pending' || entry.mapping.kind === 'unmapped') {
        context.strokeStyle = hexAlpha(COLORS.pending, 0.7)
        context.lineWidth = 1
        context.beginPath()
        const mid = laneY + laneHeight / 2
        context.moveTo(sourceStart - 1, mid)
        context.lineTo(sourceStart + 7, mid)
        context.stroke()
      }
    }

    if (entry.line.id === options.selectedId) {
      context.strokeStyle = COLORS.gold
      context.lineWidth = 1
      context.strokeRect(sourceStart - 1.5, laneY + 1, Math.max(4, sourceEnd - sourceStart + 3), laneHeight - 2)
    }
  }

  // Anchors.
  for (const anchor of options.anchors) {
    const time = options.version === 'target' ? anchor.time : anchor.source
    const px = x(time)
    context.strokeStyle = anchor.confirmed ? COLORS.gold : hexAlpha(COLORS.gold, 0.4)
    context.lineWidth = anchor.confirmed ? 1.5 : 1
    context.setLineDash(anchor.confirmed ? [] : [3, 3])
    context.beginPath()
    context.moveTo(px, 18)
    context.lineTo(px, height - 6)
    context.stroke()
    context.setLineDash([])
    context.fillStyle = anchor.confirmed ? COLORS.gold : hexAlpha(COLORS.gold, 0.55)
    context.beginPath()
    context.moveTo(px, 18)
    context.lineTo(px - 4.5, 11)
    context.lineTo(px + 4.5, 11)
    context.closePath()
    context.fill()
  }

  // Ghost preview (auditioning a candidate or a cut).
  if (options.ghost) {
    const start = x(options.ghost.start)
    const end = Math.max(start + 2, x(options.ghost.end))
    context.fillStyle = 'rgba(229, 189, 112, 0.3)'
    context.fillRect(start, 22, end - start, height - 30)
  }

  // Playhead.
  const cursor = options.hover ?? options.cursor
  if (cursor !== null && Number.isFinite(cursor)) {
    context.strokeStyle = options.hover !== null ? 'rgba(246, 237, 219, 0.55)' : '#f6eddb'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(x(cursor), 16)
    context.lineTo(x(cursor), height - 2)
    context.stroke()
  }
}

function statusColor(kind: string) {
  return LANE_COLORS[kind] ?? COLORS.soft
}

export function hexAlpha(hex: string, alpha: number) {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Canvas hit-testing: which lane and version time is under (x, y)? */
export function hitTest(
  x: number,
  y: number,
  width: number,
  height: number,
  duration: number,
  count: number,
): { index: number; time: number } | null {
  const left = 54
  const right = width - 14
  if (x < left || x > right) return null
  const laneTop = 26
  const laneBottom = height - 26
  if (y < laneTop - 4 || y > laneBottom + 4) return null
  const laneHeight = (laneBottom - laneTop) / Math.max(1, count)
  const index = Math.max(0, Math.min(count - 1, Math.floor((y - laneTop) / laneHeight)))
  const time = Math.max(0, Math.min(duration, (x - left) / (right - left) * duration))
  return { index, time }
}
