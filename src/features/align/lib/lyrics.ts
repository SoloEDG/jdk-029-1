import type { LyricLine } from '../../../shared/document'

export class LyricsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LyricsParseError'
  }
}

const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g
const OFFSET_TAG = /^\[offset:\s*(-?\d+)\s*\]$/i
const META_TAG = /^\[(ti|ar|al|by|re|ve|length|tool|encoding):[^\]]*\]$/i

interface Draft {
  start: number
  text: string
  order: number
}

/**
 * Parse an LRC file whose timestamps belong to the reference audio.
 *
 * Multiple stamps per line are supported (chorus shorthand). Metadata tags are
 * ignored except `[offset:ms]`, which shifts every stamp (LRC convention:
 * positive offset means the lyric should appear earlier, so we subtract).
 * Untimed lyric rows are rejected because they cannot be placed on either
 * version, but a file that mixes timed and untimed rows is accepted and the
 * untimed rows are counted in the returned report.
 */
export function parseLrc(text: string, duration?: number): LyricLine[] {
  return parseLrcDetailed(text, duration).lines
}

export interface LrcReport {
  lines: LyricLine[]
  skippedUntimed: number
  offset: number
}

export function parseLrcDetailed(text: string, duration?: number): LrcReport {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!source.trim()) throw new LyricsParseError('歌词文件是空的。')
  const drafts: Draft[] = []
  let offset = 0
  let order = 0
  let skippedUntimed = 0
  for (const raw of source.split('\n')) {
    const row = raw.trim()
    if (!row) continue
    const offsetMatch = row.match(OFFSET_TAG)
    if (offsetMatch) {
      offset = Number(offsetMatch[1]) / 1000
      continue
    }
    if (META_TAG.test(row)) continue
    STAMP.lastIndex = 0
    const stamps = [...row.matchAll(STAMP)]
    const lyric = row.replace(STAMP, '').trim()
    if (!stamps.length) {
      skippedUntimed++
      continue
    }
    if (!lyric) continue
    for (const stamp of stamps) {
      const minutes = Number(stamp[1])
      const seconds = Number(stamp[2].replace(':', '.'))
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue
      const time = Math.max(0, minutes * 60 + seconds - offset)
      drafts.push({ start: time, text: lyric, order: order++ })
    }
  }
  if (!drafts.length) {
    throw new LyricsParseError(
      skippedUntimed
        ? '歌词没有时间标记。请导入带 [mm:ss.xx] 标记的 LRC，时间需对应参考版音频。'
        : '没有找到可用的歌词行。',
    )
  }
  drafts.sort((a, b) => a.start - b.start || a.order - b.order)
  const merged: Draft[] = []
  for (const draft of drafts) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.start - draft.start) <= 0.01) {
      last.text = `${last.text} ${draft.text}`.trim()
    } else {
      merged.push({ ...draft })
    }
  }
  const limit = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY
  const lines = merged.map((draft, index) => {
    const next = merged[index + 1]
    const natural = next ? next.start : draft.start + Math.min(6, Math.max(1.5, draft.text.length * 0.35))
    const end = Math.max(draft.start + 0.3, Math.min(next ? next.start - 0.02 : natural, limit))
    return {
      id: `line-${index + 1}-${Math.round(draft.start * 1000)}`,
      text: draft.text,
      start: round(draft.start),
      end: round(Math.max(draft.start + 0.3, end)),
    }
  })
  return { lines, skippedUntimed, offset }
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

/** Serialize back to LRC (used by tests and export). */
export function toLrc(lines: readonly LyricLine[]): string {
  return lines
    .map(line => {
      const minutes = Math.floor(line.start / 60)
      const seconds = line.start - minutes * 60
      return `[${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}]${line.text}`
    })
    .join('\n')
}
