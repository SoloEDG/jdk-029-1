import type { Anchor, LyricLine, SpanDecision } from '../../../shared/document'
import {
  buildPlan,
  estimateRate,
  pendingSegments,
  type LineEvidence,
  type LineMapping,
  type PendingSegment,
} from './mapping'

export interface AlignmentInput {
  lines: readonly LyricLine[]
  anchors: readonly Anchor[]
  spans: readonly SpanDecision[]
  evidence: Record<string, LineEvidence>
  globalRate: number
  targetDuration: number
}

export interface AlignmentResult {
  plan: LineMapping[]
  rate: number
  /** Bracket spans that contain unmatched lyrics; auditionable as cuts. */
  pending: PendingSegment[]
  /** Auto-spans synthesised for confirmed cuts, for display. */
  effectiveSpans: SpanDecision[]
}

/**
 * Run the planner and synthesise a *suspected* cut for each pending bracket,
 * narrowed to the run of unmatched lines only. The narrowing matters: two
 * anchors may bracket a whole chorus plus a deleted bridge, and the chorus
 * lines must keep their placements. Only the lines without a match form the
 * suspected cut, so the UI can audition the exact deleted region.
 */
export function alignProject(input: AlignmentInput): AlignmentResult {
  const rate = estimateRate(input.anchors, input.globalRate)
  const plan = buildPlan(input.lines, input.anchors, input.spans, {
    globalRate: rate,
    targetDuration: input.targetDuration,
    evidence: input.evidence,
  })
  const pending = pendingSegments(plan)
  const effectiveSpans = [...input.spans]
  for (const segment of pending) {
    const lines = input.lines.filter(line => segment.lines.includes(line.id))
    if (!lines.length) continue
    const start = Math.min(...lines.map(line => line.start))
    const end = Math.max(...lines.map(line => line.end))
    const exists = effectiveSpans.some(span =>
      span.kind === 'cut' && Math.abs(span.start - start) <= 0.05 && Math.abs(span.end - end) <= 0.05)
    if (exists) continue
    effectiveSpans.push({
      id: `suspected-${segment.before.id}-${segment.after.id}`,
      start,
      end,
      kind: 'cut',
      confirmed: false,
      note: '声学未匹配，疑似删减',
    })
  }
  return { plan, rate, pending, effectiveSpans }
}
