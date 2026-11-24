<script setup lang="ts">
import { ref } from 'vue'
import { FileAudio, FileText, Upload } from '@lucide/vue'
import type { ImportFiles } from '../model/useAlignment'

const props = defineProps<{ busy: string; progress: number; issue: string }>()
const emit = defineEmits<{ submit: [ImportFiles]; cancel: []; abort: [] }>()

const reference = ref<File | null>(null)
const target = ref<File | null>(null)
const lyrics = ref<File | null>(null)
const title = ref('')
const artist = ref('')

function pick(event: Event, which: 'reference' | 'target' | 'lyrics') {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  if (which === 'reference') reference.value = file
  else if (which === 'target') target.value = file
  else lyrics.value = file
}

function submit() {
  if (!reference.value || !target.value || !lyrics.value) return
  emit('submit', {
    reference: reference.value,
    target: target.value,
    lyrics: lyrics.value,
    title: title.value,
    artist: artist.value,
  })
}
</script>

<template>
  <div class="dialog-backdrop" role="presentation" @click.self="!props.busy && emit('cancel')">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <h2 id="import-title">导入歌词与两版音频</h2>
      <p class="dialog-hint">
        歌词时间以「参考版」为准；「目标版」是现在要练的伴奏。两版可以速度不同、片头不同、段落不同。
      </p>
      <div class="import-grid">
        <label class="file-slot" :class="{ chosen: reference }">
          <FileAudio :size="18" /><strong>参考版音频</strong>
          <span class="mono">{{ reference?.name ?? '选择文件' }}</span>
          <input type="file" accept="audio/*" :disabled="Boolean(busy)" @change="pick($event, 'reference')" />
        </label>
        <label class="file-slot" :class="{ chosen: target }">
          <FileAudio :size="18" /><strong>目标版音频</strong>
          <span class="mono">{{ target?.name ?? '选择文件' }}</span>
          <input type="file" accept="audio/*" :disabled="Boolean(busy)" @change="pick($event, 'target')" />
        </label>
        <label class="file-slot" :class="{ chosen: lyrics }">
          <FileText :size="18" /><strong>歌词 LRC</strong>
          <span class="mono">{{ lyrics?.name ?? '选择文件' }}</span>
          <input type="file" accept=".lrc,.txt,text/plain" :disabled="Boolean(busy)" @change="pick($event, 'lyrics')" />
        </label>
      </div>
      <div class="import-meta">
        <label>标题<input v-model="title" type="text" placeholder="默认取文件名" :disabled="Boolean(busy)" /></label>
        <label>歌手<input v-model="artist" type="text" placeholder="可留空" :disabled="Boolean(busy)" /></label>
      </div>
      <div v-if="props.busy" class="import-progress" role="status">
        <span>{{ props.busy }}</span>
        <progress :value="props.progress" max="1"></progress>
      </div>
      <p v-if="props.issue" class="inline-error" role="alert">{{ props.issue }}</p>
      <div class="dialog-actions">
        <button v-if="props.busy" type="button" class="ghost-button" @click="emit('abort')">中止导入</button>
        <button v-else type="button" class="ghost-button" @click="emit('cancel')">取消</button>
        <button type="button" class="primary-button" :disabled="Boolean(busy) || !reference || !target || !lyrics" @click="submit">
          <Upload :size="16" /> 导入并比对
        </button>
      </div>
    </section>
  </div>
</template>
