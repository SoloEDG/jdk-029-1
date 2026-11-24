export type Seconds = number

/**
 * Read an audio file's metadata without keeping it decoded. Falls back to a
 * bare Audio element when Web Audio is unavailable (tests, old browsers).
 */
export function readDuration(src: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio()
    audio.preload = 'metadata'
    const done = () => {
      cleanup()
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0
      audio.removeAttribute('src')
      audio.load()
      duration > 0 ? resolve(duration) : reject(new Error('无法读取音频时长。'))
    }
    const fail = () => {
      cleanup()
      reject(new Error('无法读取音频时长。'))
    }
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', done)
      audio.removeEventListener('error', fail)
    }
    audio.addEventListener('loadedmetadata', done)
    audio.addEventListener('error', fail)
    audio.src = src
  })
}

export async function decode(file: Blob): Promise<{ channels: Float32Array[]; rate: number }> {
  const context = new AudioContext()
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    return {
      channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)),
      rate: buffer.sampleRate,
    }
  } finally {
    void context.close()
  }
}

/** Seekable audio element used by the two-version player. */
export function createPlayer(src: string, onIssue: (message: string) => void) {
  const element = new Audio()
  element.preload = 'metadata'
  element.src = src
  element.addEventListener('error', () => onIssue('无法读取伴奏。'))
  return element
}
