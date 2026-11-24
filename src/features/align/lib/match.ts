import type { LyricLine, TimeRange } from '../../../shared/document'
import type { CandidatePoint, LineEvidence } from './mapping'
import { chromaAt, cosine, energyAt, template, type Analysis } from './features'

export interface MatchOptions {
  /** Minimum candidate separation, in seconds. */
  separation?: number
  /** How many candidates to keep per line. */
  limit?: number
  /** Relative energy (vs. median) below which a window is treated as silence. */
  silenceRatio?: number
}

/** Score one lyric line at a specific target start. */
export function scoreAt(
  reference: Analysis,
  target: Analysis,
  line: TimeRange,
  targetStart: number,
  rate: number,
) {
  const frames = template(reference, line.start, line.end)
  if (frames.length < 3) return 0
  const length = Math.max(0.35, Math.min(line.end - line.start, 6) * rate)
  let total = 0
  let used = 0
  for (let index = 0; index < frames.length; index++) {
    const time = targetStart + (index / frames.length) * length
    const frame = chromaAt(target, time)
    if (!frame) continue
    total += cosine(frames[index], frame)
    used++
  }
  return used >= 3 ? total / used : 0
}

function medianEnergy(analysis: Analysis) {
  const values: number[] = []
  for (let index = 0; index < analysis.energy.length; index += 5) values.push(analysis.energy[index])
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] || 0
}

/**
 * Search the whole target for spans resembling each lyric line. This is a
 * chroma cross-correlation, deliberately not a tempo loop: repeated sections
 * score almost identically, which is exactly the ambiguity the UI must expose
 * rather than guess away.
 */
export function findCandidates(
  lines: readonly LyricLine[],
  reference: Analysis,
  target: Analysis,
  rate: number,
  options: MatchOptions = {},
): Record<string, CandidatePoint[]> {
  const separation = options.separation ?? 0.9
  const limit = options.limit ?? 5
  const silenceRatio = options.silenceRatio ?? 0.12
  const floor = medianEnergy(target) * silenceRatio
  const step = 0.08
  const out: Record<string, CandidatePoint[]> = {}
  for (const line of lines) {
    const length = Math.max(0.35, (line.end - line.start) * rate)
    const maxStart = Math.max(0, target.duration - Math.min(length, 3))
    const scored: CandidatePoint[] = []
    for (let time = 0; time <= maxStart + 1e-9; time += step) {
      const energy = energyAt(target, time, time + length)
      if (energy < floor) continue
      const score = scoreAt(reference, target, line, time, rate)
      if (score > 0) scored.push({ time, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const candidates: CandidatePoint[] = []
    for (const point of scored) {
      if (candidates.some(chosen => Math.abs(chosen.time - point.time) < separation)) continue
      candidates.push(point)
      if (candidates.length >= limit) break
    }
    out[line.id] = candidates
  }
  return out
}

export interface EvidenceSeed {
  lineId: string
  predicted: number | null
}

/**
 * Combine global candidate lists with the score at the time interpolation
 * predicts. Without a prediction a line has candidates but no anchor proof.
 */
export function assembleEvidence(
  lines: readonly LyricLine[],
  reference: Analysis,
  target: Analysis,
  predictions: readonly EvidenceSeed[],
  candidates: Record<string, CandidatePoint[]>,
  rate: number,
): Record<string, LineEvidence> {
  const out: Record<string, LineEvidence> = {}
  const byId = new Map(predictions.map(entry => [entry.lineId, entry.predicted]))
  for (const line of lines) {
    const predicted = byId.get(line.id) ?? null
    const atPredicted = predicted === null
      ? null
      : scoreAt(reference, target, line, Math.max(0, Math.min(predicted, target.duration - 0.4)), rate)
    out[line.id] = {
      lineId: line.id,
      predicted: predicted ?? 0,
      atPredicted,
      candidates: candidates[line.id] ?? [],
      searched: true,
    }
  }
  return out
}
