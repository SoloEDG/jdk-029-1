import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import demo from '../scripts/alignment-fixture.json'
import project from '../src/features/align/model/demo-project.json'
import { analyzeChannels, type Analysis } from '../src/features/align/lib/features'
import { assembleEvidence, findCandidates } from '../src/features/align/lib/match'
import { alignProject } from '../src/features/align/lib/align'
import { moveAnchor, predictStart, tempoDecision, type LineEvidence } from '../src/features/align/lib/mapping'
import type { Anchor, LyricLine } from '../src/shared/document'

/** Minimal 16-bit PCM WAV reader for the generated fixture. */
function readWav(path: string) {
  const buffer = readFileSync(resolve(process.cwd(), path))
  const channels = buffer.readUInt16LE(22)
  const rate = buffer.readUInt32LE(24)
  const data = buffer.readUInt32LE(40)
  const frames = data / (channels * 2)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let index = 0; index < frames; index++) {
    for (let channel = 0; channel < channels; channel++) {
      out[channel]![index] = buffer.readInt16LE(44 + index * channels * 2 + channel * 2) / 32768
    }
  }
  return { channels: out, rate }
}

const reference = analyzeChannels(...Object.values(readWav('public/samples/align-reference.wav')) as [Float32Array[], number])
const target = analyzeChannels(...Object.values(readWav('public/samples/align-rehearsal.wav')) as [Float32Array[], number])
const lines = project.lines as LyricLine[]
const globalRate = target.duration / reference.duration

function anchorsAt(entries: [number, number][]): Anchor[] {
  return entries.map(([source, time], index) => ({ id: `a${index}`, source, time, confirmed: true }))
}

function evidenceFor(anchors: readonly Anchor[]): Record<string, LineEvidence> {
  const rate = globalRate
  const candidateMap = findCandidates(lines, reference, target, rate)
  const seeds = lines.map(line => ({ lineId: line.id, predicted: predictStart(line, anchors, rate) }))
  return assembleEvidence(lines, reference, target, seeds, candidateMap, rate)
}

const baseAnchors = anchorsAt([[8, 10.714286], [24, 27.857143], [40, 45], [48, 53.571429]])

function run(anchors: Anchor[], spans = [] as Parameters<typeof alignProject>[0]['spans']) {
  return alignProject({
    lines,
    anchors,
    spans,
    evidence: evidenceFor(anchors),
    globalRate,
    targetDuration: target.duration,
  })
}

describe('alignment on the generated two-version fixture', () => {
  it('detects the slow-tempo version and maps the verses onto it', () => {
    const result = run(baseAnchors)
    expect(result.rate).toBeCloseTo(1.0714, 2)
    const first = result.plan.find(entry => entry.lineId === 'line-1')!
    expect(first.kind).toBe('known')
    expect(first.target!.start).toBeCloseTo(10.714, 1)
  })

  it('keeps the deleted bridge unplaced until the cut is confirmed', () => {
    const result = run(baseAnchors)
    const bridge = result.plan.filter(entry => entry.source.start >= 32 && entry.source.end <= 40)
    expect(bridge.every(entry => entry.target === null)).toBe(true)
    expect(bridge.every(entry => entry.kind === 'pending')).toBe(true)
    const suspected = result.effectiveSpans.find(span => !span.confirmed)
    expect(suspected).toBeDefined()
    expect(suspected!.start).toBe(32)
    expect(suspected!.end).toBe(40)
  })

  it('leaves no chorus line stretched over the cut and never on the wrong occurrence', () => {
    const result = run(baseAnchors)
    for (const entry of result.plan) {
      if (!entry.target) continue
      const length = entry.target.end - entry.target.start
      expect(length).toBeLessThanOrEqual((entry.source.end - entry.source.start) * result.rate + 0.01)
    }
    const second = result.plan.find(entry => entry.lineId === 'line-17')!
    const first = result.plan.find(entry => entry.lineId === 'line-9')!
    expect(second.target!.start).toBeGreaterThan(first.target!.start)
    expect(second.target!.start).toBeCloseTo(45, 0)
  })

  it('deletes the bridge lines once the cut is confirmed, keeping their words', () => {
    const cut = {
      id: 'cut',
      start: 32,
      end: 40,
      kind: 'cut' as const,
      confirmed: true,
    }
    const result = run(baseAnchors, [cut])
    const deleted = result.plan.filter(entry => entry.kind === 'deleted')
    expect(deleted.map(entry => entry.lineId)).toEqual(['line-13', 'line-14', 'line-15', 'line-16'])
    expect(deleted.every(entry => entry.source.start >= 32)).toBe(true)
    // The lyric objects themselves still carry the words for auditing.
    for (const entry of deleted) {
      expect(lines.find(line => line.id === entry.lineId)!.text.length).toBeGreaterThan(0)
    }
  })

  it('recovers the first chorus to a playable span when the user accepts tempo-only', () => {
    const cut = { id: 'cut', start: 32, end: 40, kind: 'cut' as const, confirmed: true }
    const decision = tempoDecision({
      before: baseAnchors[1]!,
      after: baseAnchors[2]!,
      start: 24,
      end: 40,
      lines: [],
    })
    const result = run(baseAnchors, [cut, decision])
    const first = result.plan.find(entry => entry.lineId === 'line-9')!
    expect(first.kind).toBe('linear')
    expect(first.target!.start).toBeCloseTo(27.857, 1)
  })

  it('moving one anchor keeps the others and their lines fixed', () => {
    const moved = moveAnchor(baseAnchors, 'a2', { time: 45.5 })
    for (const id of ['a0', 'a1', 'a3']) {
      expect(moved.find(anchor => anchor.id === id)).toEqual(baseAnchors.find(anchor => anchor.id === id))
    }
    const before = run(baseAnchors)
    const after = run(moved)
    const early = before.plan.find(entry => entry.lineId === 'line-1')!
    const earlyAfter = after.plan.find(entry => entry.lineId === 'line-1')!
    expect(earlyAfter.target!.start).toBeCloseTo(early.target!.start, 5)
    // The last section's line is bracketed by a3 (unchanged in time) and has no
    // before-anchor inside the moved bracket, so its placement is driven by the
    // same locked anchors and must not drift arbitrarily.
    const late = after.plan.find(entry => entry.lineId === 'line-21')!
    if (late.target) expect(Math.abs(late.target.start - 53.57)).toBeLessThan(0.2)
  })
})

export type { Analysis }
