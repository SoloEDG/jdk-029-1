import { computed, ref, shallowRef, watch } from 'vue'
import type {
  Anchor, AudioVersion, Project, PublishedSnapshot, SpanDecision, Take, TimeRange,
} from '../../../shared/document'
import { alignProject, type AlignmentResult } from '../lib/align'
import { readProject, readTakes, writeProject, writeTake, deleteTake } from '../lib/archive'
import { analyzeChannels, type Analysis } from '../lib/features'
import { parseLrcDetailed } from '../lib/lyrics'
import {
  addAnchor, estimateRate, moveAnchor, predictStart, type CandidatePoint, type LineEvidence,
} from '../lib/mapping'
import { assembleEvidence, findCandidates } from '../lib/match'
import { suggestAnchors } from '../lib/suggest'
import { decode, readDuration } from '../lib/media'
import demoProject from '../model/demo-project.json'

export type Role = 'reference' | 'target'

export interface ImportFiles {
  reference: File
  target: File
  lyrics: File
  title?: string
  artist?: string
}

function cloneProject(raw: unknown): Project {
  return structuredClone(raw) as Project
}

function objectUrl(version: AudioVersion): string {
  if (version.blob) return URL.createObjectURL(version.blob)
  return version.url ?? ''
}

const ACTIVE_KEY = 'night-session-align:active-project'

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

function writeActiveId(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    // Storage may be unavailable in private mode; the project still works.
  }
}

export function useAlignment() {
  const project = shallowRef<Project>(cloneProject(demoProject))
  const evidence = shallowRef<Record<string, LineEvidence>>({})
  const suggestions = shallowRef<Anchor[]>([])
  const analyses = shallowRef<{ reference: Analysis; target: Analysis } | null>(null)
  /** Anchor-independent acoustic candidates; only re-searched after import. */
  const candidateCache = shallowRef<Record<string, CandidatePoint[]>>({})
  let importToken = 0
  const urlCache = ref<Record<string, string>>({})
  const selectedId = ref(project.value.lines[0]?.id ?? '')
  const activeId = ref<string | null>(null)
  const takes = shallowRef<Take[]>([])
  const issue = ref('')
  const notice = ref('')
  const busy = ref('')
  const progress = ref(0)
  const hydrated = ref(false)

  const selected = computed(() => project.value.lines.find(line => line.id === selectedId.value) ?? null)
  const globalRate = computed(() => {
    const { reference, target } = project.value
    return reference.duration > 0 && target.duration > 0 ? target.duration / reference.duration : 1
  })
  const rate = computed(() => estimateRate(project.value.anchors, globalRate.value))
  const alignment = computed<AlignmentResult>(() => alignProject({
    lines: project.value.lines,
    anchors: project.value.anchors,
    spans: project.value.spans,
    evidence: evidence.value,
    globalRate: globalRate.value,
    targetDuration: project.value.target.duration,
  }))
  const planById = computed(() => new Map(alignment.value.plan.map(entry => [entry.lineId, entry])))
  const rows = computed(() => project.value.lines.map(line => ({
    line,
    mapping: planById.value.get(line.id)!,
  })).filter(row => row.mapping))
  const snapshotFor = (id: string | null | undefined) =>
    id ? project.value.snapshots.find(entry => entry.id === id) ?? null : null
  const sortedSnapshots = computed(() =>
    project.value.snapshots.slice().sort((a, b) => b.createdAt - a.createdAt))
  const confirms = computed(() => project.value.anchors.filter(anchor => anchor.confirmed))
  const takeList = computed(() =>
    takes.value.filter(take => take.projectId === project.value.id)
      .sort((a, b) => b.createdAt - a.createdAt))
  const takesFor = (lineId: string | null) =>
    lineId ? takeList.value.filter(take => take.lineId === lineId) : []

  function versionUrl(version: AudioVersion) {
    return version.url ?? urlCache.value[version.id] ?? ''
  }

  function hydrateUrls() {
    const next: Record<string, string> = {}
    for (const version of [project.value.reference, project.value.target]) {
      if (version.blob) {
        const existing = urlCache.value[version.id]
        next[version.id] = existing ?? objectUrl(version)
      }
    }
    urlCache.value = { ...urlCache.value, ...next }
  }

  function select(id: string) {
    selectedId.value = id
  }

  // ---- analysis -----------------------------------------------------------

  /**
   * Search the target once per import. Candidate times do not depend on the
   * anchors, so moving a correspondence only re-scores the predictions.
   */
  function searchCandidates() {
    const current = analyses.value
    if (!current) { candidateCache.value = {}; evidence.value = {}; suggestions.value = []; return }
    candidateCache.value = findCandidates(
      project.value.lines, current.reference, current.target, globalRate.value,
    )
    runMatcher()
  }

  function runMatcher() {
    const current = analyses.value
    if (!current) { evidence.value = {}; suggestions.value = []; return }
    const lines = project.value.lines
    const seeds = lines.map(line => ({
      lineId: line.id,
      predicted: predictStart(line, project.value.anchors, rate.value),
    }))
    evidence.value = assembleEvidence(
      lines, current.reference, current.target, seeds, candidateCache.value, rate.value,
    )
    suggestions.value = suggestAnchors(lines, evidence.value)
      .filter(suggestion => !project.value.anchors.some(anchor =>
        Math.abs(anchor.source - suggestion.source) < 0.05))
  }

  /** Suggestions still worth showing (not yet accepted). */
  const openSuggestions = computed(() => suggestions.value.filter(suggestion =>
    !project.value.anchors.some(anchor => Math.abs(anchor.source - suggestion.source) < 0.05)))

  // ---- anchors ------------------------------------------------------------

  function addCorrespondence(source: number, target: number, confirmed = true) {
    const existing = project.value.anchors.find(anchor => Math.abs(anchor.source - source) < 1e-3)
    if (existing) {
      commit({
        anchors: project.value.anchors.map(anchor =>
          anchor.id === existing.id ? { ...anchor, time: target, confirmed } : anchor),
      })
      return
    }
    commit({
      anchors: addAnchor(project.value.anchors, {
        id: `anchor-${Date.now()}-${Math.round(source * 1000)}`,
        source: round(source),
        time: round(target),
        confirmed,
      }),
    })
  }

  function moveAnchorPoint(id: string, patch: Partial<Pick<Anchor, 'source' | 'time'>>) {
    commit({ anchors: moveAnchor(project.value.anchors, id, patch) })
  }

  function setAnchorConfirmed(id: string, confirmed: boolean) {
    commit({
      anchors: project.value.anchors.map(anchor =>
        anchor.id === id ? { ...anchor, confirmed } : anchor),
    })
  }

  function removeAnchor(id: string) {
    commit({ anchors: project.value.anchors.filter(anchor => anchor.id !== id) })
  }

  function acceptSuggestion(id: string) {
    const suggestion = suggestions.value.find(entry => entry.id === id)
    if (!suggestion) return
    commit({
      anchors: addAnchor(project.value.anchors, { ...suggestion, confirmed: true }),
    })
    // Accepting replaces the pending suggestion with a confirmed anchor.
    suggestions.value = suggestions.value.filter(entry => entry.id !== id)
  }

  function rejectSuggestion(id: string) {
    suggestions.value = suggestions.value.filter(entry => entry.id !== id)
  }

  /**
   * Choose one of a line's auditioned candidates: this pins the line to that
   * target time by turning the candidate into a confirmed correspondence.
   */
  function chooseCandidate(lineId: string, time: number) {
    const line = project.value.lines.find(entry => entry.id === lineId)
    if (!line) return
    addCorrespondence(line.start, time)
  }

  // ---- spans --------------------------------------------------------------

  function decideSpan(span: SpanDecision) {
    const id = span.id.startsWith('suspected') ? span.id : `span-${Date.now()}`
    commit({
      spans: [...project.value.spans.filter(entry => entry.id !== id && entry.id !== span.id), {
        ...span,
        id,
        confirmed: true,
      }],
    })
  }

  function undecideSpan(id: string) {
    commit({ spans: project.value.spans.filter(entry => entry.id !== id) })
  }

  // ---- publishing ---------------------------------------------------------

  function publish(label: string, note: string): PublishedSnapshot {
    const plan = alignment.value.plan
    const snapshot: PublishedSnapshot = {
      id: `snapshot-${Date.now()}`,
      label: label.trim() || `版本 ${project.value.snapshots.length + 1}`,
      createdAt: Date.now(),
      lines: project.value.lines.map(line => ({ ...line })),
      anchors: project.value.anchors.map(anchor => ({ ...anchor })),
      spans: project.value.spans.map(span => ({ ...span })),
      targets: {},
      statuses: {},
      note,
    }
    for (const mapping of plan) {
      snapshot.targets[mapping.lineId] = mapping.target ? { start: mapping.target.start, end: mapping.target.end } : null
      snapshot.statuses[mapping.lineId] = mapping.kind
    }
    commit({ snapshots: [...project.value.snapshots, snapshot] })
    notice.value = `已发布「${snapshot.label}」，之后仍可继续校对；旧录音会按录制时的词与歌时复听。`
    return snapshot
  }

  function restoreSnapshot(id: string) {
    const snapshot = snapshotFor(id)
    if (!snapshot) return
    commit({
      lines: snapshot.lines.map(line => ({ ...line })),
      anchors: snapshot.anchors.map(anchor => ({ ...anchor })),
      spans: snapshot.spans.map(span => ({ ...span })),
    })
    selectedId.value = snapshot.lines[0]?.id ?? selectedId.value
    notice.value = `已恢复「${snapshot.label}」的歌词与对应点；已发布的快照仍保留。`
  }

  // ---- takes --------------------------------------------------------------

  async function saveTake(take: Take) {
    await writeTake(take)
    takes.value = [take, ...takes.value.filter(entry => entry.id !== take.id)]
  }

  async function removeTake(id: string) {
    await deleteTake(id)
    takes.value = takes.value.filter(entry => entry.id !== id)
  }

  // ---- persistence --------------------------------------------------------

  let saveTimer = 0
  function scheduleSave() {
    if (!hydrated.value) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { void persist() }, 300)
  }

  async function persist() {
    try {
      await writeProject(project.value)
      writeActiveId(project.value.id)
    } catch {
      issue.value = '工程保存失败，请重试。'
    }
  }

  function commit(patch: Partial<Project>) {
    project.value = { ...project.value, ...patch, updatedAt: Date.now() }
    scheduleSave()
  }

  async function loadProject(id?: string) {
    const wanted = id ?? readActiveId() ?? project.value.id
    try {
      const stored = await readProject(wanted)
      if (stored) {
        project.value = stored
        hydrateUrls()
        selectedId.value = stored.lines[0]?.id ?? ''
      } else if (wanted === project.value.id) {
        // First run with the built-in demo: persist it so edits survive reload.
        await persist()
      }
    } catch {
      issue.value = '无法读取已保存的工程。'
    }
    hydrated.value = true
    await reloadTakes()
    // Acoustic evidence lives outside the project record; re-derive it from the
    // stored (or bundled) audio so a reopened project keeps its placements.
    if (!analyses.value) await rebuildAnalyses()
  }

  async function loadSource(version: AudioVersion): Promise<Blob | null> {
    if (version.blob) return version.blob
    if (!version.url) return null
    try {
      const response = await fetch(version.url)
      if (!response.ok) return null
      return await response.blob()
    } catch {
      return null
    }
  }

  async function rebuildAnalyses() {
    const { reference, target } = project.value
    if (analyses.value) return
    if (!reference.blob && !reference.url) return
    if (!target.blob && !target.url) return
    try {
      busy.value = '正在恢复音频比对…'
      const [referenceBlob, targetBlob] = await Promise.all([
        loadSource(reference),
        loadSource(target),
      ])
      if (!referenceBlob || !targetBlob) return
      const [referenceDecoded, targetDecoded] = await Promise.all([
        decode(referenceBlob),
        decode(targetBlob),
      ])
      analyses.value = {
        reference: analyzeChannels(referenceDecoded.channels, referenceDecoded.rate),
        target: analyzeChannels(targetDecoded.channels, targetDecoded.rate),
      }
      searchCandidates()
    } catch {
      issue.value = '无法恢复音频比对；对应点仍保留，映射结果按歌速推算。'
    } finally {
      busy.value = ''
    }
  }

  async function reloadTakes() {
    try {
      const stored = await readTakes(project.value.id)
      takes.value = stored
    } catch {
      issue.value = '无法读取本机录音。'
    }
  }

  // ---- full import --------------------------------------------------------

  async function importProject(files: ImportFiles): Promise<boolean> {
    issue.value = ''
    notice.value = ''
    progress.value = 0
    const importId = ++importToken
    // Everything is validated and analysed before the working project is
    // touched, so an aborted import never leaves a half-imported state behind.
    try {
      busy.value = '正在读取两版音频…'
      const [referenceDuration, targetDuration] = await Promise.all([
        durationOf(files.reference, 'reference'),
        durationOf(files.target, 'target'),
      ])
      busy.value = '正在解析歌词…'
      const lyricsText = await files.lyrics.text()
      const report = parseLrcDetailed(lyricsText, referenceDuration)
      if (!report.lines.length) throw new Error('歌词没有可用的时间标记。')

      busy.value = '正在分析参考版…'
      progress.value = 0.1
      const referenceDecoded = await decode(files.reference)
      if (importId !== importToken) return false
      const referenceAnalysis = analyzeChannels(referenceDecoded.channels, referenceDecoded.rate)
      if (importId !== importToken) return false
      progress.value = 0.5
      busy.value = '正在分析目标版…'
      const targetDecoded = await decode(files.target)
      if (importId !== importToken) return false
      const targetAnalysis = analyzeChannels(targetDecoded.channels, targetDecoded.rate)
      if (importId !== importToken) return false
      progress.value = 0.85

      const stamp = Date.now()
      const next: Project = {
        id: `project-${stamp}`,
        title: files.title?.trim() || trimExtension(files.reference.name),
        artist: files.artist?.trim() || '本机工程',
        reference: {
          id: `ref-${stamp}`,
          label: trimExtension(files.reference.name),
          fileName: files.reference.name,
          blob: files.reference,
          duration: referenceDuration,
          bpm: null,
          key: '',
          cover: '',
          notes: [],
        },
        target: {
          id: `tgt-${stamp}`,
          label: trimExtension(files.target.name),
          fileName: files.target.name,
          blob: files.target,
          duration: targetDuration,
          bpm: null,
          key: '',
          cover: '',
          notes: [],
        },
        lines: report.lines,
        anchors: [],
        spans: [],
        snapshots: [],
        sourceName: files.lyrics.name,
        updatedAt: stamp,
      }

      // Commit: swap in the finished project and its analyses atomically.
      analyses.value = { reference: referenceAnalysis, target: targetAnalysis }
      project.value = next
      writeActiveId(next.id)
      evidence.value = {}
      suggestions.value = []
      selectedId.value = report.lines[0]?.id ?? ''
      hydrateUrls()
      busy.value = '正在比对两版音频…'
      searchCandidates()
      progress.value = 1
      busy.value = ''
      notice.value = report.skippedUntimed
        ? `已导入 ${report.lines.length} 句歌词；忽略 ${report.skippedUntimed} 行没有时间标记的内容。请交替试听两版，确认对应点。`
        : `已导入 ${report.lines.length} 句歌词与两版音频。请交替试听两版，确认对应点。`
      await persist()
      await reloadTakes()
      return true
    } catch (error) {
      busy.value = ''
      progress.value = 0
      issue.value = error instanceof Error ? error.message : '导入失败，请检查文件。'
      return false
    }
  }

  function abortImport() {
    importToken++
    busy.value = ''
    progress.value = 0
  }

  async function durationOf(file: File, role: Role) {
    const objectUrl = URL.createObjectURL(file)
    try {
      const duration = await readDuration(objectUrl)
      if (!duration || duration < 0.5) throw new Error(`${role === 'reference' ? '参考版' : '目标版'}音频时长异常。`)
      return duration
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  watch(project, hydrateUrls, { deep: false })
  watch([() => project.value.anchors, () => project.value.spans], runMatcher)

  return {
    project, analyses, candidateCache, evidence, suggestions, selectedId, selected, activeId, takes, issue, notice,
    busy, progress, hydrated, rate, globalRate, alignment, planById, rows,
    sortedSnapshots, confirms, takeList, takesFor, snapshotFor, versionUrl, openSuggestions,
    select, runMatcher, searchCandidates, addCorrespondence, moveAnchorPoint,
    setAnchorConfirmed, removeAnchor, acceptSuggestion, rejectSuggestion, chooseCandidate,
    decideSpan, undecideSpan, publish, restoreSnapshot, saveTake, removeTake,
    loadProject, reloadTakes, importProject, abortImport, persist,
  }
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

function trimExtension(name: string) {
  return name.replace(/\.[^.]+$/, '')
}
