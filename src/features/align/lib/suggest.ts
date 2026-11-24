import type { Anchor, LyricLine } from '../../../shared/document'
import type { LineEvidence } from './mapping'

export interface SuggestOptions {
  /** Minimum acoustic score for an anchor suggestion. */
  minScore?: number
  /** Minimum lead over the next distinct occurrence. */
  minMargin?: number
  /** Minimum spacing between suggested source times. */
  spacing?: number
  limit?: number
}

/**
 * Propose correspondence points from unambiguous acoustic matches. Repeats
 * (choruses) deliberately produce no suggestion: they must be auditioned by
 * the user. Suggestions are unconfirmed, so the planner never uses them until
 * the user accepts them.
 */
export function suggestAnchors(
  lines: readonly LyricLine[],
  evidence: Record<string, LineEvidence>,
  options: SuggestOptions = {},
): Anchor[] {
  const minScore = options.minScore ?? 0.93
  const minMargin = options.minMargin ?? 0.06
  const spacing = options.spacing ?? 3
  const limit = options.limit ?? 6
  const out: Anchor[] = []
  let lastSource = -Infinity
  let lastTime = -Infinity
  for (const line of lines) {
    if (line.start - lastSource < spacing) continue
    const candidates = (evidence[line.id]?.candidates ?? [])
      .slice()
      .sort((a, b) => b.score - a.score)
    const top = candidates[0]
    if (!top || top.score < minScore) continue
    const rival = candidates.find(point => Math.abs(point.time - top.time) >= 1)
    const margin = top.score - (rival?.score ?? 0)
    if (margin < minMargin) continue
    if (top.time <= lastTime + 1) continue
    out.push({
      id: `suggest-${line.id}-${Math.round(top.time * 1000)}`,
      source: line.start,
      time: round(top.time),
      confirmed: false,
      note: '声学建议，待试听确认',
    })
    lastSource = line.start
    lastTime = top.time
    if (out.length >= limit) break
  }
  return out
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}
