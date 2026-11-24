import { describe, expect, it } from 'vitest'
import type { Anchor, LyricLine, SpanDecision, Take } from '../src/shared/document'
import { buildPlan, estimateRate, moveAnchor, tempoDecision } from '../src/features/align/lib/mapping'
import { takeLyricText, takePlaybackRange } from '../src/features/align/lib/archive'
import { parseLrc } from '../src/features/align/lib/lyrics'
import { toLrc } from '../src/features/align/lib/lyrics'

const lines: LyricLine[] = [
  { id: 'a', text: '第一句', start: 10, end: 12 },
  { id: 'b', text: '第二句', start: 12, end: 14 },
  { id: 'c', text: '第三句', start: 14, end: 16 },
  { id: 'd', text: '第四句', start: 16, end: 18 },
]

const anchors: Anchor[] = [
  { id: 'x', source: 10, time: 12, confirmed: true },
  { id: 'y', source: 18, time: 22, confirmed: true },
]

function plan(extra: { anchors?: Anchor[]; spans?: SpanDecision[]; evidence?: Record<string, never> } = {}) {
  return buildPlan(lines, extra.anchors ?? anchors, extra.spans ?? [], {
    globalRate: 1.222,
    targetDuration: 30,
    evidence: extra.evidence ?? {},
  })
}

describe('hard rules', () => {
  it('never places a lyric with no confirmed anchor at all', () => {
    const result = buildPlan(lines, [], [], { globalRate: 1.2, targetDuration: 30 })
    expect(result.every(entry => entry.target === null)).toBe(true)
    expect(result.every(entry => entry.kind === 'unmapped')).toBe(true)
  })

  it('ignores unconfirmed (suggested) anchors', () => {
    const suggested: Anchor[] = [{ id: 's', source: 10, time: 12, confirmed: false }]
    const result = buildPlan(lines, suggested, [], { globalRate: 1.2, targetDuration: 30 })
    expect(result.every(entry => entry.kind === 'unmapped')).toBe(true)
  })

  it('keeps a line inside a confirmed cut deleted and unplaced', () => {
    const cut: SpanDecision = { id: 'cut', start: 12, end: 16, kind: 'cut', confirmed: true }
    const result = plan({ spans: [cut] })
    const deleted = result.filter(entry => entry.kind === 'deleted')
    expect(deleted.map(entry => entry.lineId)).toEqual(['b', 'c'])
    expect(deleted.every(entry => entry.target === null)).toBe(true)
    // The line before the cut still has its confirmed correspondence; the one
    // after the cut has no audio evidence here, so it stays unplaced.
    expect(result.find(entry => entry.lineId === 'a')!.target).not.toBeNull()
    expect(result.find(entry => entry.lineId === 'd')!.kind).toBe('pending')
    expect(result.find(entry => entry.lineId === 'd')!.target).toBeNull()
  })

  it('stretches only when the user confirms tempo-only', () => {
    const linear = tempoDecision({ before: anchors[0]!, after: anchors[1]!, start: 10, end: 18, lines: [] })
    const result = plan({ spans: [linear] })
    const second = result.find(entry => entry.lineId === 'b')!
    expect(second.kind).toBe('linear')
    expect(second.target!.start).toBeCloseTo(12 + 2 * (10 / 8), 2)
    expect(second.target!.end).toBeLessThanOrEqual(22)
  })

  it('a locked line does not move when another anchor moves', () => {
    const before = plan()
    const moved = plan({ anchors: moveAnchor(anchors, 'y', { time: 24 }) })
    const first = before.find(entry => entry.lineId === 'a')!
    const firstAfter = moved.find(entry => entry.lineId === 'a')!
    expect(first.target!.start).toBe(12)
    expect(firstAfter.target!.start).toBe(12)
    expect(firstAfter.locked).toBe(true)
  })

  it('reports a rate from the confirmed anchors', () => {
    expect(estimateRate(anchors, 1)).toBeCloseTo(10 / 8, 5)
  })
})

describe('take replay keeps recording-time context', () => {
  const snapshot = {
    id: 's1',
    label: 'v1',
    createdAt: 1,
    lines: [{ id: 'a', text: '第一句（旧词）', start: 10, end: 12 }],
    anchors,
    spans: [],
    targets: { a: { start: 12, end: 15 } },
    statuses: { a: 'known' },
    note: '',
  }
  const take: Take = {
    id: 't1',
    projectId: 'p',
    lineId: 'a',
    lineText: '第一句',
    createdAt: 2,
    audio: new Blob(['x']),
    sourceStart: 10,
    sourceEnd: 12,
    targetStart: 12,
    targetEnd: 14.5,
    snapshotId: 's1',
    snapshotLabel: 'v1',
    pitch: [],
  }

  it('plays a take where it was actually sung', () => {
    expect(takePlaybackRange(take, snapshot)).toEqual({ start: 12, end: 14.5 })
  })

  it('shows the words from the snapshot the take was recorded under', () => {
    expect(takeLyricText(take, snapshot)).toBe('第一句（旧词）')
  })
})

describe('lyric round-trip keeps offsets on the reference timeline', () => {
  it('round-trips decimals and repeated stamps', () => {
    const text = '[00:08.00]夜风先到\n[00:24.00][00:40.00]如果星光还在'
    const parsed = parseLrc(text)
    expect(parsed.map(line => line.start)).toEqual([8, 24, 40])
    const again = parseLrc(toLrc(parsed))
    expect(again.map(line => line.start)).toEqual([8, 24, 40])
  })
})
