<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { AudioLines, Mic, Square, Upload } from '@lucide/vue'
import type { PitchPoint, PublishedSnapshot, Take, TimeRange } from '../../../shared/document'
import { clockLabel, mapTime } from '../../../shared/time'
import { useAlignment, type ImportFiles } from '../model/useAlignment'
import { usePlayer } from '../model/usePlayer'
import { useCapture } from '../model/useCapture'
import { useTakes } from '../model/useTakes'
import { usePitch } from '../../pitch'
import { tempoDecision, unreliableRanges } from '../lib/mapping'
import ImportDialog from './ImportDialog.vue'
import AlignTimeline from './AlignTimeline.vue'
import AlignTransport from './AlignTransport.vue'
import LineList from './LineList.vue'
import LineInspector from './LineInspector.vue'
import StatusPanel from './StatusPanel.vue'
import AlignPitchPanel from './AlignPitchPanel.vue'

const align = useAlignment()
const {
  project, selected, selectedId, activeId, issue, notice, busy, progress,
  rate, alignment, rows, takeList, takesFor, versionUrl, snapshotFor, select,
  addCorrespondence, moveAnchorPoint, setAnchorConfirmed, removeAnchor,
  chooseCandidate, decideSpan, undecideSpan, publish, restoreSnapshot,
  saveTake, loadProject, importProject, abortImport, reloadTakes,
  openSuggestions, acceptSuggestion, rejectSuggestion, removeTake,
} = align

const showImport = ref(false)
const ghost = ref<TimeRange | null>(null)
const lastSnapshot = ref<PublishedSnapshot | null>(null)
const audioIssue = ref('')
/** First half of a correspondence: a lyric-side time picked on the reference. */
const pairSource = ref<number | null>(null)
/** Loop is opt-in: selecting a line must not silently put playback on repeat. */
const loopEnabled = ref(false)
const alternate = ref(false)
const alternateSide = ref<'reference' | 'target'>('reference')
let alternateTimer = 0

const referenceSource = computed(() => ({ ...project.value.reference, url: versionUrl(project.value.reference) }))
const targetSource = computed(() => ({ ...project.value.target, url: versionUrl(project.value.target) }))

const pitch = usePitch()
const player = usePlayer(referenceSource, targetSource, {
  beforeMove: () => { if (capture.status.value === 'recording') void capture.stop(player.readTime()) },
})

const takes = useTakes(project, () => player.pause())
const capture = useCapture({
  onFrame: pitch.receive,
  position: () => player.position.value,
  onComplete: async result => {
    await saveTake({
      id: crypto.randomUUID(),
      projectId: project.value.id,
      lineId: result.lineId,
      lineText: result.lineText,
      createdAt: Date.now(),
      audio: result.audio,
      sourceStart: result.source.start,
      sourceEnd: result.source.end,
      targetStart: result.target.start,
      targetEnd: result.target.end,
      snapshotId: result.snapshotId,
      snapshotLabel: result.snapshotLabel,
      pitch: pitch.slice(result.source),
    })
  },
})

onMounted(async () => {
  await loadProject()
  lastSnapshot.value = align.sortedSnapshots.value[0] ?? null
})

watch(takeList, list => takes.setTakes(list), { immediate: true })
watch(player.issue, message => { if (message) audioIssue.value = message })

const selectedMapping = computed(() =>
  selected.value ? alignment.value.plan.find(entry => entry.lineId === selected.value!.id) ?? null : null)

const targetRange = computed<TimeRange | null>(() => {
  const mapping = selectedMapping.value
  if (!mapping) return null
  if (mapping.target) return mapping.target
  if (mapping.before && mapping.after) return { start: mapping.before.time, end: mapping.after.time }
  return null
})

const displayRange = computed<TimeRange>(() => {
  if (player.version.value === 'target') {
    return targetRange.value ?? { start: 0, end: project.value.target.duration }
  }
  return selected.value ?? { start: 0, end: project.value.reference.duration }
})

const shiftedNotes = computed(() => {
  const notes = project.value.reference.notes
  if (player.version.value === 'reference') return notes
  return notes.map(note => {
    const start = mapTime(note.start, project.value.anchors, rate.value)
    return {
      ...note,
      start,
      end: Math.max(start + 0.05, mapTime(note.end, project.value.anchors, rate.value)),
    }
  })
})

/** Only a line with a settled placement can be looped or recorded. */
const recordable = computed(() => {
  const mapping = selectedMapping.value
  if (!mapping?.target) return false
  return mapping.kind === 'known' || mapping.kind === 'inferred' || mapping.kind === 'linear'
})

const suspectedSpan = computed(() => {
  const mapping = selectedMapping.value
  if (!mapping) return null
  return alignment.value.effectiveSpans.find(span =>
    span.start < mapping.source.end - 0.001 && span.end > mapping.source.start + 0.001) ?? null
})

const confirmedCount = computed(() => project.value.anchors.filter(anchor => anchor.confirmed).length)
const unreliable = computed(() => {
  if (player.version.value === 'reference') return unreliableRanges(alignment.value.plan)
  // Without a single confirmed correspondence, target times are not meaningful.
  if (!confirmedCount.value) return []
  return unreliableRanges(alignment.value.plan).map(range => ({
    start: mapTime(range.start, project.value.anchors, rate.value),
    end: mapTime(range.end, project.value.anchors, rate.value),
  }))
})

/** Reference → target time mapper used by the target-view timeline. */
function mapSource(source: number) {
  return mapTime(source, project.value.anchors, rate.value)
}

const latest = computed(() => capture.status.value === 'recording' ? pitch.latest.value : null)
const live = computed(() => capture.status.value === 'recording' ? pitch.points.value : [])

const comparison = computed(() => selected.value ? takes.comparison(selected.value.id) : [])
const takeA = computed<PitchPoint[]>(() => comparison.value[0]?.pitch ?? [])
const takeB = computed<PitchPoint[]>(() => comparison.value[1]?.pitch ?? [])

/** Offset that maps a take's lyric-side pitch time onto the displayed timeline. */
function traceShift(take: Take | null) {
  if (!take || player.version.value === 'reference') return 0
  return mapTime(take.sourceStart, project.value.anchors, rate.value) - take.sourceStart
}

function takeAccuracy(take: Take) {
  const line = project.value.lines.find(entry => entry.id === take.lineId)
  if (line) return takes.accuracy(take, project.value.reference.notes, line)
  return takes.accuracy(take, project.value.reference.notes, { start: take.sourceStart, end: take.sourceEnd })
}

function nearestSourceLine(sourceTime: number): string | null {
  let best: string | null = null
  let gap = 0.65
  for (const line of project.value.lines) {
    const delta = Math.abs(line.start - sourceTime)
    if (delta <= gap) { gap = delta; best = line.id }
  }
  return best
}

function selectLine(id: string) {
  if (capture.status.value === 'recording' && id !== selectedId.value) stopRecording()
  select(id)
  takes.stop()
  const mapping = alignment.value.plan.find(entry => entry.lineId === id)
  if (!mapping) return
  if (player.version.value === 'target') {
    player.seek(mapping.target?.start ?? mapping.before?.time ?? 0)
  } else {
    player.seek(mapping.source.start)
  }
  applyLoop(mapping)
}

/** Refresh the loop window after a selection/version change, if looping is on. */
function applyLoop(mapping = selectedMapping.value) {
  if (!loopEnabled.value || !mapping) { player.setLoop(null); return }
  if (player.version.value === 'target') {
    player.setLoop(mapping.target ? { ...mapping.target } : null)
  } else {
    player.setLoop({ ...mapping.source })
  }
}

function adjacent(direction: -1 | 1) {
  const index = project.value.lines.findIndex(line => line.id === selectedId.value)
  const next = project.value.lines[Math.max(0, Math.min(project.value.lines.length - 1, index + direction))]
  if (next) selectLine(next.id)
}

function seek(time: number) {
  takes.stop()
  player.pause()
  if (player.version.value === 'target') {
    const id = nearestSourceLine(player.reverseMapTime(time, project.value.anchors, rate.value))
    if (id) select(id)
  } else {
    const id = nearestSourceLine(time)
    if (id) select(id)
  }
  player.seek(time)
}

function addAnchorAt(time: number) {
  if (player.version.value === 'target') {
    const source = player.reverseMapTime(time, project.value.anchors, rate.value)
    addCorrespondence(source, time)
    const id = nearestSourceLine(source)
    if (id) select(id)
  } else {
    addCorrespondence(time, player.reverseMapTime(time, project.value.anchors, rate.value))
  }
}

/**
 * Two-step correspondence: pick the spot on the reference version, then the
 * same spot on the target version. Both versions are auditioned in between, so
 * the pair is a heard confirmation rather than a guess. If anchors already
 * exist, a one-step mark on the target still works (it reverse-maps).
 */
function markHere() {
  if (player.version.value === 'reference') {
    // Step 1: remember the heard reference position, then let the user hear
    // the target at the mapped spot before committing the pair.
    pairSource.value = player.position.value
    const id = nearestSourceLine(player.position.value)
    if (id) select(id)
    loopEnabled.value = false
    player.setLoop(null)
    switchVersion(1)
    player.seek(mapTime(player.position.value, project.value.anchors, rate.value))
    return
  }
  if (pairSource.value !== null) {
    // Step 2: the target position is heard; commit the pair.
    addCorrespondence(pairSource.value, player.position.value)
    pairSource.value = null
    return
  }
  // No pending half-pair: treat this as a target-side correction of the
  // selected line's existing correspondence.
  addCorrespondence(player.reverseMapTime(player.position.value, project.value.anchors, rate.value), player.position.value)
}

/** Play the same lyric on both versions back to back, optionally on repeat. */
function startAlternate() {
  const line = selected.value
  if (!line) return
  if (capture.status.value === 'recording') stopRecording()
  alternate.value = true
  alternateSide.value = 'reference'
  loopEnabled.value = false
  ghost.value = null
  player.setLoop(null)
  player.switchVersion('reference', project.value.anchors, rate.value)
  player.seek(line.start)
  void player.play()
}

function stopAlternate() {
  alternate.value = false
  clearTimeout(alternateTimer)
  player.pause()
  player.setLoop(null)
}

function toggleAlternate() {
  if (alternate.value) stopAlternate()
  else startAlternate()
}

// Highlight the lyric currently sounding on the target timeline.
watch(() => player.position.value, position => {
  if (player.version.value !== 'target') { activeId.value = null; return }
  const hit = alignment.value.plan.find(entry =>
    entry.target && entry.target.start <= position && position < entry.target.end)
  activeId.value = hit?.lineId ?? null
})

// While recording, follow the live pitch on the line being recorded even if the
// user moves around the timeline.
watch([() => capture.status.value, () => pitch.points.value.length], () => {
  if (capture.status.value === 'recording' && selectedId.value && activeId.value !== selectedId.value) {
    activeId.value = selectedId.value
  }
})

// Selecting a different line while recording must end the take cleanly rather
// than moving the microphone window under the singer. `selectLine` is used by
// every selection path, so the guard lives there too.
watch(selectedId, (next, previous) => {
  if (capture.status.value === 'recording' && next !== previous) stopRecording()
})

watch(() => player.position.value, position => {
  if (!alternate.value || !selected.value) return
  const mapping = selectedMapping.value
  if (!mapping) return
  if (alternateSide.value === 'reference') {
    if (position >= mapping.source.end - 0.03) {
      alternateSide.value = 'target'
      player.pause()
      player.switchVersion('target', project.value.anchors, rate.value)
      const start = mapping.target?.start ?? mapping.before?.time ?? 0
      player.seek(start)
      void player.play()
    }
  } else {
    const end = mapping.target?.end ?? mapping.after?.time ?? null
    if (end !== null && position >= end - 0.03) {
      player.pause()
      if (!alternate.value) return
      alternateTimer = window.setTimeout(() => {
        if (!alternate.value) return
        alternateSide.value = 'reference'
        player.switchVersion('reference', project.value.anchors, rate.value)
        player.seek(selected.value?.start ?? 0)
        void player.play()
      }, 450)
    }
  }
})

function togglePlay() {
  if (alternate.value) stopAlternate()
  if (capture.status.value === 'recording') {
    stopRecording()
    return
  }
  if (player.playing.value) player.pause()
  else void player.play()
}

function toggleLoop() {
  loopEnabled.value = !loopEnabled.value
  if (loopEnabled.value && selected.value) {
    // Restart from the line when enabling loop.
    selectLine(selected.value.id)
  } else {
    player.setLoop(null)
  }
}

function switchVersion(index: number) {
  if (alternate.value) stopAlternate()
  player.switchVersion(index === 1 ? 'target' : 'reference', project.value.anchors, rate.value)
  applyLoop()
}

function audition(time: number, span: TimeRange | null = null) {
  takes.stop()
  if (alternate.value) stopAlternate()
  ghost.value = span
  if (player.version.value !== 'target') switchVersion(1)
  player.setLoop(null)
  player.seek(Math.max(0, time))
  void player.play()
}

function auditionCut(span: TimeRange) {
  takes.stop()
  if (alternate.value) stopAlternate()
  ghost.value = span
  loopEnabled.value = true
  if (player.version.value !== 'target') switchVersion(1)
  player.setLoop({ start: span.start, end: span.end })
  player.seek(span.start)
  void player.play()
}

function choose(time: number) {
  const line = selected.value
  if (!line) return
  chooseCandidate(line.id, time)
  ghost.value = null
}

function markCut() {
  const mapping = selectedMapping.value
  const span = suspectedSpan.value
  if (!mapping || !span) return
  decideSpan({ ...span, kind: 'cut', confirmed: true, note: '用户确认删减' })
  ghost.value = null
}

function markKeepTempo() {
  const mapping = selectedMapping.value
  if (!mapping?.before || !mapping.after) return
  // The whole bracket is tempo-only; this also covers the neighbouring lines
  // that have no acoustic match of their own.
  decideSpan(tempoDecision({
    before: mapping.before,
    after: mapping.after,
    start: mapping.before.source,
    end: mapping.after.source,
    lines: [],
  }))
  ghost.value = null
}

function onPublish(label: string, note: string) {
  lastSnapshot.value = publish(label, note)
}

function startRecording() {
  const line = selected.value
  const mapping = selectedMapping.value
  if (!line || !mapping?.target || !recordable.value) return
  takes.stop()
  stopAlternate()
  player.pause()
  pitch.clear()
  if (player.version.value !== 'target') switchVersion(1)
  const target = { ...mapping.target }
  void capture.start({
    source: { start: line.start, end: line.end },
    target,
    lineId: line.id,
    lineText: line.text,
    snapshotId: lastSnapshot.value?.id ?? null,
    snapshotLabel: lastSnapshot.value?.label ?? null,
  }, async () => {
    loopEnabled.value = true
    player.setLoop({ start: target.start, end: target.end })
    player.seek(target.start)
    const started = await player.play()
    if (started) activeId.value = line.id
    return started
  })
}

function stopRecording() {
  void capture.stop(player.readTime())
  player.pause()
  if (loopEnabled.value) applyLoop()
}

function listen(take: Take) {
  loopEnabled.value = false
  player.setLoop(null)
  player.pause()
  void takes.listen(take)
}

function openImport() {
  player.pause()
  takes.stop()
  showImport.value = true
}

async function handleImport(files: ImportFiles) {
  player.pause()
  takes.stop()
  const ok = await importProject(files)
  if (!ok) return
  showImport.value = false
  player.seek(0)
  lastSnapshot.value = null
  await reloadTakes()
}

function restore(id: string) {
  restoreSnapshot(id)
  player.pause()
  takes.stop()
}

function toggleAnchor(id: string) {
  const anchor = project.value.anchors.find(entry => entry.id === id)
  if (anchor) setAnchorConfirmed(id, !anchor.confirmed)
}
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <span class="brand-mark"><AudioLines :size="22" /></span>
      <div class="brand-name"><strong>夜航对齐台</strong><span>NIGHT ALIGNMENT</span></div>
      <div class="header-song">
        <h1>{{ project.title }}</h1>
        <p class="mono">
          <span>参 {{ project.reference.label }} · {{ clockLabel(project.reference.duration) }}</span>
          <span>标 {{ project.target.label }} · {{ clockLabel(project.target.duration) }}</span>
          <span>{{ project.sourceName }}</span>
        </p>
      </div>
      <button class="ghost-button header-import" @click="openImport"><Upload :size="15" /> 导入</button>
    </div>
  </header>
  <main class="workspace">
    <aside class="left-rail">
      <LineList :rows="rows" :selected-id="selectedId" :active-id="activeId"
        :version="player.version.value" @select="selectLine" />
    </aside>
    <div class="workbench">
      <p v-if="player.version.value === 'target' && !confirmedCount" class="notice hint" role="status">
        目标版还没有对应点。在参考版按「在参考版选对应点」，再到目标版同一位置按「在目标版选同一点」。
      </p>
      <AlignTimeline :lines="rows" :anchors="project.anchors" :spans="alignment.effectiveSpans"
        :unreliable="unreliable" :selected-id="selectedId" :version="player.version.value"
        :duration="player.duration.value" :cursor="player.position.value" :ghost="ghost"
        :mapping="mapSource"
        @select-line="selectLine" @seek="seek" @add-anchor="addAnchorAt"
        @move-anchor="(id: string, time: number) => moveAnchorPoint(id, { time })"
        @move-source="(id: string, time: number) => moveAnchorPoint(id, { source: time })" />
      <AlignPitchPanel v-if="selected" :notes="shiftedNotes" :position="player.position.value" :range="displayRange"
        :latest="latest" :live="live" :take-a="takeA" :take-b="takeB"
        :shift-a="traceShift(comparison[0] ?? null)" :shift-b="traceShift(comparison[1] ?? null)"
        :unreliable="selectedMapping?.kind === 'unmapped' || selectedMapping?.kind === 'pending'" />
      <AlignTransport :version="player.version.value" :reference-label="project.reference.label"
        :target-label="project.target.label" :position="player.position.value" :duration="player.duration.value"
        :playing="player.playing.value" :loop-active="loopEnabled" :volume="player.volume.value"
        :issue="player.issue.value || audioIssue" :anchors="project.anchors"
        :pair-source="pairSource" :alternating="alternate"
        @toggle="togglePlay" @previous="adjacent(-1)" @next="adjacent(1)" @loop="toggleLoop"
        @seek="seek" @volume="player.setVolume" @switch-version="switchVersion"
        @mark="markHere" @alternate="toggleAlternate"
        @jump="(time: number) => { player.pause(); player.seek(time) }" />
      <section class="capture-strip" aria-label="录音">
        <div class="capture-label">
          <strong>{{ capture.status.value === 'recording' ? '录音中' : capture.status.value === 'saving' ? '保存中' : capture.status.value === 'requesting' ? '等待麦克风' : '对照录音' }}</strong>
          <small>{{ selected?.text ?? '先选一句' }}</small>
        </div>
        <div class="level-meter" role="meter" aria-valuemin="0" aria-valuemax="100"
          :aria-valuenow="Math.round(capture.level.value * 100)">
          <i v-for="step in 16" :key="step" :class="{ lit: capture.level.value * 16 >= step }"></i>
        </div>
        <button v-if="capture.status.value !== 'recording'" class="record-button"
          :disabled="!recordable || capture.status.value === 'saving' || capture.status.value === 'requesting'"
          @click="startRecording">
          <Mic :size="16" /> 按目标版录这一句
        </button>
        <button v-else class="record-button recording" @click="stopRecording">
          <Square :size="15" fill="currentColor" /> 停止并保存
        </button>
        <button v-if="capture.status.value === 'requesting'" class="ghost-button" @click="capture.cancel()">取消</button>
        <p v-if="capture.issue.value" role="alert" class="inline-error">{{ capture.issue.value }}</p>
      </section>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="issue" class="notice error" role="alert">{{ issue }}</p>
    </div>
    <aside class="right-rail">
      <LineInspector v-if="selected && selectedMapping" :line="selected" :mapping="selectedMapping"
        :anchors="project.anchors" :takes="takesFor(selected.id)" :playing-id="takes.playingId.value"
        :suspected-span="suspectedSpan"
        :take-text="take => takes.textOf(take)" :take-range="take => takes.rangeOf(take)"
        :take-accuracy="takeAccuracy" :snapshot-label="take => snapshotFor(take.snapshotId)?.label ?? take.snapshotLabel"
        :recordable="recordable" :loop-enabled="loopEnabled"
        @listen="listen" @remove-take="removeTake" @audition="audition" @choose="choose"
        @cut="markCut" @keep-tempo="markKeepTempo"
        @audition-span="auditionCut"
        @undo-span="undecideSpan" @jump="(time: number) => { player.pause(); player.seek(time) }"
        @remove-anchor="removeAnchor" @toggle-anchor="toggleAnchor" @record="startRecording" />
      <StatusPanel :project="project" :alignment="alignment" :busy="busy" :pending="alignment.pending"
        :model-file="project.sourceName" :suggestions="openSuggestions"
        @publish="onPublish" @restore="restore" @open-import="openImport"
        @accept-suggestion="acceptSuggestion" @reject-suggestion="rejectSuggestion"
        @audition="(time: number) => audition(time)" @audition-span="auditionCut" />
    </aside>
  </main>
  <ImportDialog v-if="showImport" :busy="busy" :progress="progress" :issue="issue"
    @submit="handleImport" @cancel="showImport = false" @abort="abortImport" />
</template>
