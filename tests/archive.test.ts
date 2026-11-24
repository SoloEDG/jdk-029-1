import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Anchor, LyricLine, Project, Take } from '../src/shared/document'
import {
  deleteTake, publishSnapshot, readProject, readTakes, snapshotFor, takeLyricText,
  takePlaybackRange, writeProject, writeTake,
} from '../src/features/align/lib/archive'
import { alignProject } from '../src/features/align/lib/align'
import type { LineEvidence } from '../src/features/align/lib/mapping'

const lines: LyricLine[] = [
  { id: 'l1', text: '如果星光还在', start: 24, end: 26 },
  { id: 'l2', text: '就让它慢慢落', start: 26, end: 28 },
]
const anchors: Anchor[] = [
  { id: 'a', source: 24, time: 27.857, confirmed: true },
  { id: 'b', source: 28, time: 32.1, confirmed: true },
]

function evidence(points: { start: number; time: number }[]): Record<string, LineEvidence> {
  return Object.fromEntries(points.map(({ start, time }) => {
    const line = lines.find(entry => entry.start === start)!
    return [line.id, {
      lineId: line.id,
      predicted: time,
      atPredicted: 0.97,
      candidates: [{ time, score: 0.97 }],
      searched: true,
    }]
  }))
}

function project(): Project {
  return {
    id: 'p1',
    title: '测试',
    artist: '',
    reference: { id: 'r', label: 'ref', fileName: 'ref.wav', url: '/ref.wav', duration: 52, bpm: 120, key: '', cover: '', notes: [] },
    target: { id: 't', label: 'tgt', fileName: 'tgt.wav', url: '/tgt.wav', duration: 58, bpm: 112, key: '', cover: '', notes: [] },
    lines: lines.map(line => ({ ...line })),
    anchors: anchors.map(anchor => ({ ...anchor })),
    spans: [],
    snapshots: [],
    sourceName: 'x.lrc',
    updatedAt: 1,
  }
}

function take(id: string, overrides: Partial<Take> = {}): Take {
  return {
    id,
    projectId: 'p1',
    lineId: 'l1',
    lineText: '如果星光还在',
    createdAt: 100,
    audio: new Blob(['abc'], { type: 'audio/wav' }),
    sourceStart: 24,
    sourceEnd: 26,
    targetStart: 27.857,
    targetEnd: 30,
    snapshotId: null,
    snapshotLabel: null,
    pitch: [],
    ...overrides,
  }
}

describe('project archive', () => {
  beforeEach(async () => {
    await writeProject(project())
  })

  it('round-trips a project', async () => {
    const stored = await readProject('p1')
    expect(stored?.lines).toHaveLength(2)
    expect(stored?.anchors[0]?.time).toBeCloseTo(27.857, 3)
  })

  it('stores and reads takes per project', async () => {
    await writeTake(take('t1'))
    await writeTake(take('t2', { lineId: 'l2' }))
    await writeTake({ ...take('t3'), projectId: 'other' })
    const stored = await readTakes('p1')
    expect(stored.map(entry => entry.id).sort()).toEqual(['t1', 't2'])
    await deleteTake('t1')
    expect((await readTakes('p1')).map(entry => entry.id)).toEqual(['t2'])
  })
})

describe('published snapshots', () => {
  it('freezes targets and statuses at publish time', () => {
    const current = project()
    const plan = alignProject({
      lines, anchors, spans: [], globalRate: 1.1, targetDuration: 58,
      evidence: evidence([{ start: 24, time: 27.857 }, { start: 26, time: 30 }]),
    }).plan
    const snapshot = publishSnapshot(current, plan, 'v1', 'first')
    expect(snapshot.lines.map(line => line.text)).toEqual(['如果星光还在', '就让它慢慢落'])
    expect(snapshot.statuses.l1).toBe('known')
    expect(snapshot.targets.l1!.start).toBeCloseTo(27.857, 2)
    // Later edits to the working project must not mutate the snapshot.
    current.lines[0]!.text = '改过的词'
    current.anchors[0]!.time = 40
    expect(snapshot.lines[0]!.text).toBe('如果星光还在')
    expect(snapshot.targets.l1!.start).toBeCloseTo(27.857, 2)
  })

  it('replays an old take with its recorded timing and words', () => {
    const current = project()
    const plan = alignProject({
      lines, anchors, spans: [], globalRate: 1.1, targetDuration: 58,
      evidence: evidence([{ start: 24, time: 27.857 }, { start: 26, time: 30 }]),
    }).plan
    const snapshot = publishSnapshot(current, plan, 'v1', '')
    const recorded = take('t1', {
      targetStart: 27.857,
      targetEnd: 30,
      snapshotId: snapshot.id,
      lineText: '如果星光还在',
    })
    // The working alignment moves on and the lyric text changes.
    const later = project()
    later.snapshots = [snapshot]
    later.lines[0]!.text = '新的词'
    later.anchors[0]!.time = 30
    const stored = snapshotFor(later, recorded.snapshotId)
    expect(stored).not.toBeNull()
    expect(takePlaybackRange(recorded, stored)).toEqual({ start: 27.857, end: 30 })
    expect(takeLyricText(recorded, stored)).toBe('如果星光还在')
  })
})
