import { describe, expect, it } from 'vitest'
import fixture from '../scripts/alignment-fixture.json'
import demo from '../src/features/align/model/demo-project.json'
import type { Anchor, LyricLine, SpanDecision } from '../src/shared/document'
import {
  buildPlan,
  estimateRate,
  moveAnchor,
  pendingSegments,
  resolveCollisions,
  sanitizeAnchors,
} from '../src/features/align/lib/mapping'

const lines = demo.lines as LyricLine[]
const reference = demo.reference
const target = demo.target
const globalRate = target.duration / reference.duration

function anchor(source: number, time: number, id = `anchor-${source}`): Anchor {
  return { id, source, time, confirmed: true }
}

function statuses(plan: ReturnType<typeof buildPlan>) {
  return Object.fromEntries(plan.map(entry => [entry.lineId, entry.kind]))
}

describe('fixture', () => {
  it('has the expected asymmetry', () => {
    expect(fixture.reference.sections.map(s => s.name)).toContain('bridge')
    expect(fixture.target.sections.map(s => s.name)).not.toContain('bridge')
    expect(fixture.target.sections.filter(s => s.melody === 'chorus')).toHaveLength(3)
    expect(fixture.target.sections[0].name).toBe('pickup')
    expect(lines).toHaveLength(22)
  })
})

describe('without evidence', () => {
  it('does not invent placements anywhere', () => {
    const plan = buildPlan(lines, [], [], { globalRate, targetDuration: target.duration })
    expect(plan.every(entry => entry.kind === 'unmapped')).toBe(true)
    expect(plan.every(entry => entry.target === null)).toBe(true)
  })
})

describe('deleted bridge', () => {
  const bridge = fixture.deletedLineIds
  it('keeps the bridge lyrics as deleted when the cut is confirmed', () => {
    const spans: SpanDecision[] = [{
      id: 'cut-bridge',
      start: fixture.reference.sections.find(s => s.name === 'bridge')!.start,
      end: fixture.reference.sections.find(s => s.name === 'bridge')!.end,
      kind: 'cut',
      confirmed: true,
    }]
    const anchors = [anchor(8, 10.714286), anchor(24, 27.857143), anchor(40, 45), anchor(48, 53.571429)]
    const plan = buildPlan(lines, anchors, spans, { globalRate, targetDuration: target.duration })
    for (const id of bridge) {
      const entry = plan.find(item => item.lineId === id)!
      expect(entry.kind).toBe('deleted')
      expect(entry.target).toBeNull()
      expect(entry.source.start).toBeGreaterThanOrEqual(32)
    }
  })

  it('never stretches an unconfirmed bridge across the gap, even with audio evidence', () => {
    const anchors = [anchor(8, 10.714286), anchor(24, 27.857143), anchor(40, 45), anchor(48, 53.571429)]
    const rate = estimateRate(anchors, globalRate)
    const evidence: Record<string, { lineId: string; predicted: number; atPredicted: number; candidates: { time: number; score: number }[]; searched: boolean }> = {}
    for (const line of lines) {
      const predicted = 10.714286 + (line.start - 8) * rate
      const inBridge = line.start >= 32 && line.end <= 40
      evidence[line.id] = {
        lineId: line.id,
        predicted,
        atPredicted: 0.1,
        candidates: inBridge ? [{ time: predicted - 4, score: 0.4 }] : [{ time: predicted, score: 0.97 }],
        searched: true,
      }
    }
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration, evidence })
    const bridgePlan = plan.filter(entry => bridge.includes(entry.lineId))
    expect(bridgePlan.every(entry => entry.target === null)).toBe(true)
    expect(bridgePlan.every(entry => entry.kind === 'pending')).toBe(true)
    // Only the bridge span is pending; the two chorus sections are audited.
    const segments = pendingSegments(plan)
    expect(segments).toHaveLength(1)
    expect(segments[0].start).toBe(24)
    expect(segments[0].end).toBe(40)
    expect(segments[0].lines.sort()).toEqual([...bridge].sort())
  })
})

describe('repeated chorus', () => {
  it('keeps the second chorus at its own position and demotes a duplicate onto the first', () => {
    const anchors = [anchor(8, 10.714286), anchor(24, 27.857143), anchor(40, 45), anchor(48, 53.571429)]
    const rate = estimateRate(anchors, globalRate)
    expect(rate).toBeCloseTo(1.0714, 2)
    const exact = (time: number) => [{ time, score: 0.97 }]
    const evidence = Object.fromEntries(
      lines.map(line => {
        const predicted = 10.714286 + (line.start - 8) * rate
        return [line.id, {
          lineId: line.id,
          predicted,
          atPredicted: 0.97,
          candidates: exact(predicted),
          searched: true,
        }]
      }),
    )
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration, evidence })
    const first = plan.find(entry => entry.lineId === 'line-9')!
    const second = plan.find(entry => entry.lineId === 'line-17')!
    expect(first.kind).toBe('known')
    expect(first.target!.start).toBeCloseTo(27.857, 1)
    expect(second.target!.start).toBeCloseTo(45, 1)
    expect(second.target!.start).toBeGreaterThan(first.target!.start)
  })

  it('marks a repeated line as ambiguous but keeps it ordered when the copies tie', () => {
    const anchors = [anchor(7.5, 10.2), anchor(23.5, 27.4), anchor(39.5, 44.6), anchor(47.5, 53.1)]
    const rate = estimateRate(anchors, globalRate)
    const predictedFor = (start: number) => 10.2 + (start - 7.5) * rate
    const evidence: Record<string, { lineId: string; predicted: number; atPredicted: number; candidates: { time: number; score: number }[]; searched: boolean }> = {}
    for (const line of lines) {
      const predicted = predictedFor(line.start)
      evidence[line.id] = {
        lineId: line.id,
        predicted,
        atPredicted: 0.97,
        candidates: [
          { time: predicted, score: 0.985 },
          { time: predicted + 8.57, score: 0.98 },
        ],
        searched: true,
      }
    }
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration, evidence })
    const first = plan.find(entry => entry.lineId === 'line-9')!
    const second = plan.find(entry => entry.lineId === 'line-17')!
    expect(first.ambiguous).toBe(true)
    expect(first.target!.start).toBeCloseTo(predictedFor(24), 1)
    expect(second.target!.start).toBeCloseTo(predictedFor(40), 1)
  })

  it('demotes a line whose acoustics drag it onto an earlier occurrence', () => {
    const anchors = [anchor(7.5, 10.2), anchor(39.5, 44.6), anchor(47.5, 53.1)]
    const dup = (time: number, score: number) => ({ time, score })
    const evidence = {
      'line-17': {
        lineId: 'line-17',
        predicted: 44.4,
        atPredicted: 0.62,
        candidates: [dup(31.5, 0.97), dup(48.4, 0.95)],
        searched: true,
      },
    }
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration, evidence })
    const second = plan.find(entry => entry.lineId === 'line-17')!
    expect(second.kind).toBe('candidate')
    expect(second.ambiguous).toBe(true)
    expect(second.candidates.length).toBeGreaterThan(1)
    // It is offered as a candidate, but never occupies the earlier spot.
    expect(second.target).toBeNull()
  })

  it('collision guard demotes a later line sharing a target span', () => {
    const plan = buildPlan(lines, [], [], { globalRate, targetDuration: target.duration }).map((entry, index) => ({
      ...entry,
      kind: (index === 10 || index === 18 ? 'inferred' : 'unmapped') as typeof entry.kind,
      target: index === 10 || index === 18 ? { start: 27.857, end: 29.857 } : null,
    }))
    const guarded = resolveCollisions(plan)
    expect(guarded[10]!.collision).toBe(false)
    expect(guarded[18]!.collision).toBe(true)
    expect(guarded[18]!.kind).toBe('candidate')
    expect(guarded[18]!.target).toBeNull()
  })
})

describe('anchors', () => {
  const anchors = [
    anchor(8, 10.714286, 'a'),
    anchor(24, 27.857143, 'b'),
    anchor(40, 45, 'c'),
    anchor(48, 53.571429, 'd'),
  ]

  it('moves one anchor without disturbing the locked others', () => {
    const moved = moveAnchor(anchors, 'b', { time: 28.2 })
    const kept = moved.filter(entry => entry.id !== 'b')
    expect(kept).toEqual(anchors.filter(entry => entry.id !== 'b'))
    const withEvidence = (list: Anchor[]) => {
      const rate = estimateRate(list, globalRate)
      const evidence: Record<string, { lineId: string; predicted: number; atPredicted: number; candidates: { time: number; score: number }[]; searched: boolean }> = {}
      for (const line of lines) {
        // Evidence is pinned to the truth, independent of the moved anchor.
        const truth = 10.714286 + (line.start - 8) * globalRate
        evidence[line.id] = { lineId: line.id, predicted: truth, atPredicted: 0.97, candidates: [{ time: truth, score: 0.97 }], searched: true }
      }
      void rate
      return buildPlan(lines, list, [], { globalRate, targetDuration: target.duration, evidence })
    }
    const before = withEvidence(anchors)
    const after = withEvidence(moved)
    // A line before the moved anchor maps exactly the same.
    expect(after[0].target!.start).toBeCloseTo(before[0].target!.start, 6)
    expect(after[3].target!.start).toBeCloseTo(before[3].target!.start, 6)
    // The locked anchors are untouched objects with unchanged times.
    for (const id of ['a', 'c', 'd']) {
      const keptAnchor = moved.find(entry => entry.id === id)!
      const original = anchors.find(entry => entry.id === id)!
      expect(keptAnchor).toEqual(original)
    }
    expect(moved[1]).toEqual({ ...anchors[1], time: 28.2 })
  })

  it('drops impossible anchors during sanitising', () => {
    const messy = [...anchors, anchor(30, 20, 'backwards'), { ...anchor(44, 49, 'unconfirmed'), confirmed: false }]
    const clean = sanitizeAnchors(messy)
    expect(clean.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reports pending spans where two anchors bracket missing material', () => {
    const rate = estimateRate(anchors, globalRate)
    const evidence: Record<string, { lineId: string; predicted: number; atPredicted: number; candidates: { time: number; score: number }[]; searched: boolean }> = {}
    for (const line of lines) {
      const predicted = 10.714286 + (line.start - 8) * rate
      const inBridge = line.start >= 32 && line.end <= 40
      evidence[line.id] = {
        lineId: line.id,
        predicted,
        atPredicted: inBridge ? 0.1 : 0.97,
        candidates: inBridge ? [] : [{ time: predicted, score: 0.97 }],
        searched: true,
      }
    }
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration, evidence })
    const segments = pendingSegments(plan)
    expect(segments.length).toBe(1)
    expect(segments[0].before.id).toBe('b')
    expect(segments[0].after.id).toBe('c')
  })
})

describe('pickup at the head', () => {
  it('offers a pickup-shifted start as a candidate and never places it silently', () => {
    const anchors = [anchor(9.5, 12.5), anchor(23.5, 27.4)]
    const plan = buildPlan(lines, anchors, [], { globalRate, targetDuration: target.duration })
    const first = plan.find(entry => entry.lineId === 'line-1')!
    expect(first.kind).toBe('unmapped')
    expect(first.target).toBeNull()
    // Predicted backwards from the first anchor, including the pickup shift.
    expect(first.candidates[0]!.time).toBeCloseTo(12.5 - 1.5 * globalRate, 1)
    expect(statuses(plan)['line-1']).toBe('unmapped')
    // Everything between the two anchors has no audio proof yet.
    expect(statuses(plan)['line-2']).toBe('pending')
    expect(plan.find(entry => entry.lineId === 'line-2')!.target).toBeNull()
    // The open-ended tail is never guessed either.
    expect(statuses(plan)['line-17']).toBe('unmapped')
    expect(pendingSegments(plan)).toHaveLength(1)
  })

  it('places the pickup section only after the user adds the head correspondence', () => {
    const withPickup = [anchor(2, 4.2), anchor(23.5, 27.4)]
    const evidence: Record<string, { lineId: string; predicted: number; atPredicted: number; candidates: { time: number; score: number }[]; searched: boolean }> = {}
    for (const line of lines) {
      const predicted = 4.2 + (line.start - 2) * globalRate
      evidence[line.id] = { lineId: line.id, predicted, atPredicted: 0.97, candidates: [{ time: predicted, score: 0.97 }], searched: true }
    }
    const plan = buildPlan(lines, withPickup, [], { globalRate, targetDuration: target.duration, evidence })
    const first = plan.find(entry => entry.lineId === 'line-1')!
    expect(first.kind).toBe('known')
    expect(first.target!.start).toBeCloseTo(4.2 + 6 * globalRate, 1)
  })
})
