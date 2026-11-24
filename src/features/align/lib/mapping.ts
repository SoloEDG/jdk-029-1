import type { Anchor, LyricLine, SpanDecision, TimeRange } from '../../../shared/document'

export interface CandidatePoint {
  time: number
  score: number
}

/**
 * Acoustic evidence for one lyric line, produced by the fingerprint matcher.
 * `atPredicted` is the similarity at the time interpolation predicts;
 * `candidates` are alternative starts that scored above zero, best first.
 */
export interface LineEvidence {
  lineId: string
  predicted: number
  atPredicted: number | null
  candidates: CandidatePoint[]
  searched: boolean
}

export type PlanKind = 'known' | 'inferred' | 'linear' | 'candidate' | 'pending' | 'unmapped' | 'deleted'

export interface LineMapping {
  lineId: string
  kind: PlanKind
  /** Mapped target span; null when the system refuses to place the line. */
  target: TimeRange | null
  /** Auditionable target starts, best first. */
  candidates: CandidatePoint[]
  /** True when two or more candidates are acoustically near-identical. */
  ambiguous: boolean
  /** True when the line was demoted because another line already owns that spot. */
  collision: boolean
  confidence: number
  reason: string
  /** Confirmed anchors that bracket this line; they are locked during edits. */
  before: Anchor | null
  after: Anchor | null
  /** True when the local tempo differs from the global one. */
  warped: boolean
  /** Source span of the line. */
  source: TimeRange
  /** True when the line's start sits exactly on a confirmed anchor. */
  locked: boolean
}

export interface PlanOptions {
  /** Target seconds per source second when only tempo differs. */
  globalRate: number
  targetDuration: number
  /** Accepted deviation from the global rate before a span is suspicious. */
  rateTolerance?: number
  /** Similarity needed to trust the interpolated spot. */
  scoreFloor?: number
  /** Similarity needed to treat a different spot as a moved line. */
  alternativeFloor?: number
  /** Candidates whose scores differ by less than this are ambiguous. */
  ambiguityMargin?: number
  /** Ambiguous candidates must be at least this far apart (seconds). */
  ambiguitySeparation?: number
  /** Search radius around the linear prediction for "same spot" evidence. */
  nearWindow?: number
  /** Acoustic evidence keyed by lyric line id. */
  evidence?: Record<string, LineEvidence>
}

const EPS = 1e-6

export function confirmedAnchors(anchors: readonly Anchor[]): Anchor[] {
  return anchors
    .filter(anchor => anchor.confirmed)
    .slice()
    .sort((a, b) => a.source - b.source || a.time - b.time)
}

/** Keep only anchors that are consistent with a monotonic source→target map. */
export function sanitizeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const sorted = confirmedAnchors(anchors)
  const out: Anchor[] = []
  let lastTime = -Infinity
  for (const anchor of sorted) {
    if (anchor.time < lastTime - EPS) continue
    out.push(anchor)
    lastTime = anchor.time
  }
  return out
}

export function estimateRate(anchors: readonly Anchor[], fallback: number): number {
  const sorted = sanitizeAnchors(anchors)
  const rates: number[] = []
  for (let index = 1; index < sorted.length; index++) {
    const before = sorted[index - 1]
    const after = sorted[index]
    const sourceGap = after.source - before.source
    const timeGap = after.time - before.time
    if (sourceGap < 2 || timeGap <= 0) continue
    const rate = timeGap / sourceGap
    if (rate > 0.25 && rate < 4) rates.push(rate)
  }
  if (!rates.length) return fallback
  rates.sort((a, b) => a - b)
  return rates[Math.floor(rates.length / 2)]
}

export function bracketingAnchors(
  line: TimeRange,
  anchors: readonly Anchor[],
): { before: Anchor | null; after: Anchor | null } {
  const sorted = sanitizeAnchors(anchors)
  let before: Anchor | null = null
  let after: Anchor | null = null
  for (const anchor of sorted) {
    if (anchor.source <= line.start + EPS) before = anchor
    else if (!after) after = anchor
  }
  return { before, after }
}

/** Linear prediction from the nearest confirmed anchors, ignoring audio. */
export function predictStart(line: TimeRange, anchors: readonly Anchor[], globalRate: number): number | null {
  const sorted = sanitizeAnchors(anchors)
  if (!sorted.length) return null
  const { before, after } = bracketingAnchors(line, sorted)
  if (before && after && after.source > before.source + EPS) {
    const rate = (after.time - before.time) / (after.source - before.source)
    if (rate > 0.25 && rate < 4) return before.time + (line.start - before.source) * rate
  }
  if (before) return before.time + (line.start - before.source) * globalRate
  if (after) return Math.max(0, after.time - (after.source - line.start) * globalRate)
  return null
}

function clampSpan(start: number, line: TimeRange, rate: number, limit: number): TimeRange {
  const length = Math.max(0, line.end - line.start) * rate
  const safeStart = Math.max(0, Math.min(start, Math.max(0, limit - 0.05)))
  return { start: safeStart, end: Math.min(limit, safeStart + Math.max(0.05, length)) }
}

function trustedCandidates(proof: LineEvidence | undefined, floor: number) {
  return (proof?.candidates ?? [])
    .filter(point => point.score >= floor)
    .slice()
    .sort((a, b) => b.score - a.score)
}

function pickAmbiguity(candidates: CandidatePoint[], margin: number, separation: number) {
  const top = candidates[0]
  const rival = top && candidates.find(point => Math.abs(point.time - top.time) >= separation)
  return { ambiguous: Boolean(rival && top.score - rival.score <= margin), rival }
}

/** Distinct-sounding candidates; repeats that sit on the same material count once. */
function alternativeCandidates(candidates: CandidatePoint[], separation: number) {
  const out: CandidatePoint[] = []
  for (const point of candidates) {
    if (out.some(chosen => Math.abs(chosen.time - point.time) < separation)) continue
    out.push(point)
  }
  return out
}

/**
 * Core planner. Deterministic and audio-optional.
 *
 * Safety rules:
 * - A line inside a confirmed cut is `deleted` (kept for checking, never placed).
 * - A line inside a confirmed "same content, different time" span is `linear`.
 * - Between two confirmed anchors, a line is only placed when the acoustics
 *   agree with the interpolated spot. A tempo-consistent but acoustically
 *   missing line is `pending` — never stretched across the gap.
 * - If the acoustics point elsewhere, the line becomes `candidate`; the user
 *   audits it. Open-ended spans never get a silent linear guess.
 * - Candidates are auditions, not placements: they never occupy a target span.
 *   Repeated material produces several near-equal candidates plus the
 *   `ambiguous` flag, and the order / collision guards stop a later occurrence
 *   from ever resolving onto an earlier one.
 */
export function buildPlan(
  lines: readonly LyricLine[],
  anchors: readonly Anchor[],
  spans: readonly SpanDecision[],
  options: PlanOptions,
): LineMapping[] {
  const rateTolerance = options.rateTolerance ?? 0.09
  const scoreFloor = options.scoreFloor ?? 0.85
  const alternativeFloor = options.alternativeFloor ?? 0.9
  const ambiguityMargin = options.ambiguityMargin ?? 0.03
  const ambiguitySeparation = options.ambiguitySeparation ?? 0.8
  const nearWindow = options.nearWindow ?? 0.65
  const duration = options.targetDuration
  // Only confirmed correspondences participate. Unconfirmed acoustic
  // suggestions and half-finished pairs must never move a lyric.
  const sortedAnchors = sanitizeAnchors(anchors)
  const decisions = spans.filter(entry => entry.confirmed)

  const mappings = lines.map<LineMapping>(line => {
    const source = { start: line.start, end: line.end }
    // Prefer the most specific decision (smallest containing span) so a
    // narrower user decision about one line wins over a wider bracket one.
    const decision = decisions
      .filter(entry => line.start >= entry.start - EPS && line.end <= entry.end + EPS)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
    if (decision?.kind === 'cut') {
      return {
        lineId: line.id,
        kind: 'deleted',
        target: null,
        candidates: [],
        ambiguous: false,
        collision: false,
        confidence: 1,
        reason: '所在段落已在目标版删减，歌词保留待核对',
        before: null,
        after: null,
        warped: false,
        source,
        locked: false,
      }
    }
    if (decision?.kind === 'linear' && decision.targetStart !== undefined && decision.targetEnd !== undefined) {
      const localRate = (decision.targetEnd - decision.targetStart) / (decision.end - decision.start)
      const projected = decision.targetStart + (line.start - decision.start) * localRate
      return {
        lineId: line.id,
        kind: 'linear',
        target: clampSpan(projected, line, localRate, Math.min(duration, decision.targetEnd)),
        candidates: [],
        ambiguous: false,
        collision: false,
        confidence: 1,
        reason: '已确认本段内容不变，仅速度不同',
        before: null,
        after: null,
        warped: Math.abs(localRate / options.globalRate - 1) > 0.01,
        source,
        locked: false,
      }
    }

    const { before, after } = bracketingAnchors(line, sortedAnchors)
    const proof = options.evidence?.[line.id]
    const trusted = trustedCandidates(proof, scoreFloor)
    const allCandidates = (proof?.candidates ?? []).slice().sort((a, b) => b.score - a.score)
    const anchored = Boolean(before && Math.abs(before.source - line.start) <= EPS)
    const twoSided = Boolean(
      before && after && after.source > before.source + EPS && after.time >= before.time - EPS,
    )

    // A line starting exactly on a confirmed anchor is locked to it: the user
    // already established this correspondence, and moving another anchor must
    // not shift it.
    if (anchored && before) {
      const localRate = twoSided && after
        ? (after.time - before.time) / (after.source - before.source)
        : options.globalRate
      const limit = twoSided && after ? Math.min(duration, after.time) : duration
      return {
        lineId: line.id,
        kind: 'known',
        target: clampSpan(before.time, line, localRate, limit),
        candidates: allCandidates,
        ambiguous: false,
        collision: false,
        confidence: 1,
        reason: '已确认的对应点',
        before,
        after,
        warped: false,
        source,
        locked: true,
      }
    }

    if (twoSided && before && after) {
      const localRate = (after.time - before.time) / (after.source - before.source)
      const globalDeviation = Math.abs(localRate / options.globalRate - 1)
      const consistent = globalDeviation <= rateTolerance
      const warped = globalDeviation > 0.01
      const predicted = Math.max(
        before.time,
        Math.min(after.time, before.time + (line.start - before.source) * localRate),
      )
      const limit = Math.min(duration, after.time)
      const span = clampSpan(predicted, line, localRate, limit)
      const atPredicted = proof?.searched ? proof.atPredicted : null
      const inBracket = trusted.filter(point =>
        point.time >= before.time - nearWindow && point.time <= after.time + nearWindow)
      const near = inBracket.find(point => Math.abs(point.time - predicted) <= nearWindow)
      const strong = inBracket.filter(point => point.score >= alternativeFloor)
      const alternative = strong.find(point => Math.abs(point.time - predicted) > nearWindow)
      const predictedScore = Math.max(atPredicted ?? 0, near?.score ?? 0)
      // Ambiguity is judged on every strong acoustic candidate, including
      // repeats outside the bracket: that is what the listener must audit.
      const distinct = alternativeCandidates(
        allCandidates.filter(point => point.score >= alternativeFloor),
        ambiguitySeparation,
      )
      const ambiguity = pickAmbiguity(distinct, ambiguityMargin, ambiguitySeparation)
      const base = {
        lineId: line.id,
        candidates: allCandidates,
        before,
        after,
        warped,
        source,
        locked: anchored,
        collision: false,
      }

      if (!proof?.searched) {
        // No acoustics yet. Even a tempo-consistent bracket proves nothing:
        // the same words may have been cut, replaced, or moved. Refuse to place
        // the line until audio confirms the predicted spot or the user accepts
        // a "same content, different tempo" decision for the span.
        return {
          ...base,
          kind: 'pending',
          target: null,
          ambiguous: false,
          confidence: 0,
          reason: '尚未比对音频，无法确认这一段是否只是速度变化',
        }
      }

      if (predictedScore >= scoreFloor) {
        const time = near ? near.time : predicted
        const kind: PlanKind = predictedScore >= 0.9 || near ? 'known' : 'inferred'
        return {
          ...base,
          kind,
          target: clampSpan(time, line, localRate, limit),
          ambiguous: ambiguity.ambiguous,
          confidence: predictedScore,
          reason: ambiguity.ambiguous
            ? '同词段落出现多次，已按顺序保留本位，可试听其它候选'
            : near
              ? '声学匹配落在推算位置附近'
              : consistent
                ? '按前后对应点与整体歌速推算'
                : '按前后对应点与局部歌速推算',
        }
      }

      if (alternative) {
        const lead = strong[0]
        return {
          ...base,
          kind: 'candidate',
          // An audition, not a placement: nothing is occupied until chosen.
          target: null,
          ambiguous: ambiguity.ambiguous,
          confidence: Math.max(0, Math.min(1, lead.score - (strong[1]?.score ?? 0))),
          reason: ambiguity.ambiguous
            ? '重复段落：多个位置声学相近，需试听后选定'
            : '推算位置声学不符，另一处匹配较好，需试听确认',
        }
      }

      return {
        ...base,
        kind: 'pending',
        target: null,
        ambiguous: false,
        confidence: 0,
        reason: consistent
          ? '两端有对应点，但此句在目标版没有声学匹配，疑似删减/替换，待确认'
          : '两端对应点的时长与整体歌速不一致，疑似删减，待确认',
      }
    }

    // Open-ended: no two-sided proof, so nothing is reliable. Without any
    // confirmed anchor there is no correspondence at all; show candidates for
    // audition but never a placement.
    if (proof?.searched && trusted.length && sortedAnchors.length) {
      const top = trusted[0]
      const distinct = alternativeCandidates(trusted, ambiguitySeparation)
      const ambiguity = pickAmbiguity(distinct, ambiguityMargin, ambiguitySeparation)
      return {
        lineId: line.id,
        kind: 'candidate',
        target: null,
        candidates: trusted,
        ambiguous: ambiguity.ambiguous,
        collision: false,
        confidence: Math.max(0, Math.min(1, top.score - (trusted[1]?.score ?? 0))),
        reason: ambiguity.ambiguous
          ? '缺少两端对应点，且多个位置声学相近，需试听'
          : '缺少两端对应点，仅有一处声学候选，需试听',
        before,
        after,
        warped: false,
        source,
        locked: anchored,
      }
    }

    const suggestion = predictStart(line, sortedAnchors, options.globalRate)
    return {
      lineId: line.id,
      kind: 'unmapped',
      target: null,
      candidates: suggestion === null ? [] : [{ time: suggestion, score: 0 }],
      ambiguous: false,
      collision: false,
      confidence: 0,
      reason: before || after
        ? '只有一端有对应点，无法可靠推算'
        : '尚未建立对应点，无法映射到目标版',
      before,
      after,
      warped: false,
      source,
      locked: anchored,
    }
  })

  return enforceOrder(resolveCollisions(mappings))
}

function overlapRatio(a: TimeRange, b: TimeRange) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  const shorter = Math.min(a.end - a.start, b.end - b.start)
  return shorter > 0 ? overlap / shorter : 0
}

/**
 * Two different lyrics must not resolve onto the same target span. When they
 * do, the later source line is demoted to an auditionable candidate unless it
 * is anchored, in which case the earlier unanchored line is demoted instead.
 */
export function resolveCollisions(mappings: LineMapping[]): LineMapping[] {
  for (let index = 0; index < mappings.length; index++) {
    for (let other = index + 1; other < mappings.length; other++) {
      const a = mappings[index]
      const b = mappings[other]
      if (!a.target || !b.target) continue
      if (!isPlaced(a) || !isPlaced(b)) continue
      if (overlapRatio(a.target, b.target) < 0.5) continue
      const victim = b.locked && !a.locked ? a : b
      if (victim.locked) continue
      demote(victim, '与另一句的目标位置重叠：重复的同词段落可能被吸到前一遍，需试听选定')
    }
  }
  return mappings
}

/**
 * Target times must be monotonic in lyric order. If a line resolves before a
 * previously placed line, it is demoted; this is the guard that keeps the
 * second chorus from being pulled onto the first one.
 */
export function enforceOrder(mappings: LineMapping[]): LineMapping[] {
  let previous: TimeRange | null = null
  for (const mapping of mappings) {
    if (!mapping.target || !isPlaced(mapping)) continue
    if (previous && mapping.target.start < previous.start - 0.2) {
      demote(mapping, '目标位置早于上一句：重复段落可能把后一遍吸到前一遍，需试听选定')
      continue
    }
    previous = mapping.target
  }
  return mappings
}

/** True only for a committed placement; candidates are auditions. */
export function isPlaced(mapping: LineMapping) {
  if (mapping.collision || mapping.kind === 'candidate') return false
  return mapping.kind === 'known' || mapping.kind === 'inferred' || mapping.kind === 'linear'
}

function demote(mapping: LineMapping, reason: string) {
  if (mapping.collision) return
  if (!mapping.candidates.length && mapping.target) {
    mapping.candidates = [{ time: mapping.target.start, score: 0 }]
  }
  mapping.kind = 'candidate'
  mapping.ambiguous = true
  mapping.collision = true
  mapping.confidence = 0
  mapping.reason = reason
  // The disputed spot is offered for audition, never occupied: a later chorus
  // must not sit on top of the earlier one while the user decides.
  mapping.target = null
}

export interface PendingSegment {
  before: Anchor
  after: Anchor
  start: number
  end: number
  lines: string[]
}

/** Spans bracketed by confirmed anchors that contain lines with no placement. */
export function pendingSegments(plan: readonly LineMapping[]): PendingSegment[] {
  const out: PendingSegment[] = []
  const seen = new Map<string, PendingSegment>()
  for (const line of plan) {
    if (line.kind !== 'pending' || !line.before || !line.after) continue
    const key = `${line.before.id}:${line.after.id}`
    let segment = seen.get(key)
    if (!segment) {
      segment = {
        before: line.before,
        after: line.after,
        start: line.before.source,
        end: line.after.source,
        lines: [],
      }
      seen.set(key, segment)
      out.push(segment)
    }
    segment.lines.push(line.lineId)
  }
  return out
}

/** Source ranges the timeline should hatch as "no reliable mapping". */
export function unreliableRanges(plan: readonly LineMapping[]): TimeRange[] {
  return plan
    .filter(line => line.kind === 'pending' || line.kind === 'unmapped' || (line.kind === 'candidate' && line.ambiguous))
    .map(line => line.source)
    .sort((a, b) => a.start - b.start)
}

/**
 * Move one confirmed anchor. Every other anchor is returned untouched (in both
 * source and time), so all other correspondences keep resolving as before.
 */
export function moveAnchor(
  anchors: readonly Anchor[],
  id: string,
  patch: Partial<Pick<Anchor, 'source' | 'time'>>,
): Anchor[] {
  return anchors.map(anchor => (anchor.id === id ? { ...anchor, ...patch } : { ...anchor }))
}

export function addAnchor(anchors: readonly Anchor[], anchor: Anchor): Anchor[] {
  return [...anchors, anchor].sort((a, b) => a.source - b.source || a.time - b.time)
}

/**
 * Create the decision that says "this whole bracket is present, only the
 * tempo differs". Used by the "只是速度变化" action when the user has heard
 * both ends of a pending span.
 */
export function tempoDecision(
  segment: PendingSegment,
  id = `linear-${segment.before.id}-${segment.after.id}`,
): SpanDecision {
  return {
    id,
    start: segment.start,
    end: segment.end,
    kind: 'linear',
    targetStart: segment.before.time,
    targetEnd: segment.after.time,
    confirmed: true,
    note: '用户确认整段内容不变，仅速度不同',
  }
}
