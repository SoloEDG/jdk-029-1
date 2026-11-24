export interface TimeRange { start: number; end: number }

export interface LyricLine extends TimeRange {
  id: string
  text: string
}

export interface GuideNote extends TimeRange { midi: number }

export interface PitchPoint {
  time: number
  midi: number | null
}

/**
 * One audio version of a project. Lyric timings always refer to the reference
 * version; the target version is where the alignment is being built.
 */
export interface AudioVersion {
  id: string
  label: string
  fileName: string
  /** Static URL (demo projects); imported projects use `blob` instead. */
  url?: string
  /** Stored audio for imported projects, re-created as an object URL on load. */
  blob?: Blob
  duration: number
  bpm: number | null
  key: string
  cover: string
  notes: GuideNote[]
}

/** A user-confirmed correspondence point. Confirmed anchors are locked. */
export interface Anchor {
  id: string
  /** Lyric-side (reference version) time. */
  source: number
  /** Target-version time. */
  time: number
  confirmed: boolean
  note?: string
}

/**
 * A span with a decided relationship to the target version:
 * `cut` = removed; `linear` = present, only tempo-shifted.
 */
export interface SpanDecision {
  id: string
  start: number
  end: number
  kind: 'cut' | 'linear'
  targetStart?: number
  targetEnd?: number
  confirmed: boolean
  note?: string
}

/** Immutable record of what was published and listened to. */
export interface PublishedSnapshot {
  id: string
  label: string
  createdAt: number
  lines: LyricLine[]
  anchors: Anchor[]
  spans: SpanDecision[]
  /** Resolved target span per line at publish time. */
  targets: Record<string, TimeRange | null>
  /** Plan status per line at publish time. */
  statuses: Record<string, string>
  note: string
}

export interface Project {
  id: string
  title: string
  artist: string
  reference: AudioVersion
  target: AudioVersion
  /** Lyrics with timings on the reference version. */
  lines: LyricLine[]
  anchors: Anchor[]
  spans: SpanDecision[]
  snapshots: PublishedSnapshot[]
  sourceName: string
  updatedAt: number
}

/** A recording. Its lyric text and timing are frozen at record time. */
export interface Take {
  id: string
  projectId: string
  lineId: string
  /** Lyric text captured at record time. */
  lineText: string
  createdAt: number
  audio: Blob
  /** Lyric-side timing at record time. */
  sourceStart: number
  sourceEnd: number
  /** Target-version timing used for playback and pitch scoring. */
  targetStart: number
  targetEnd: number
  /** Published snapshot in force when recorded, if any. */
  snapshotId: string | null
  snapshotLabel: string | null
  pitch: PitchPoint[]
}

export interface PcmFrame {
  inputTime: number
  samples: Float32Array
}
