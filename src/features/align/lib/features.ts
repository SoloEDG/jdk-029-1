/** Lightweight audio analysis shared by the browser and the node tests. */

export interface Analysis {
  /** Frames per second. */
  frameRate: number
  /** Normalised 12-bin chroma per frame. */
  chroma: Float32Array[]
  /** RMS per frame, used to reject silent candidates. */
  energy: Float32Array
  duration: number
}

export interface AnalyzeOptions {
  frameSize?: number
  hopSize?: number
}

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** Downmix to mono at most `maxRate` samples per second. */
export function toMono(channels: readonly Float32Array[], sampleRate: number, maxRate = 16000) {
  const length = channels[0]?.length ?? 0
  const mono = new Float32Array(length)
  for (const channel of channels) {
    for (let index = 0; index < length; index++) mono[index] += channel[index] / channels.length
  }
  if (sampleRate <= maxRate) return { samples: mono, rate: sampleRate }
  const ratio = sampleRate / maxRate
  const out = new Float32Array(Math.floor(length / ratio))
  for (let index = 0; index < out.length; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let cursor = start; cursor < end; cursor++) sum += mono[cursor]
    out[index] = end > start ? sum / (end - start) : 0
  }
  return { samples: out, rate: maxRate }
}

/** In-place radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float32Array, im: Float32Array) {
  const size = re.length
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1
    for (; reversed & bit; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index < reversed) {
      ;[re[index], re[reversed]] = [re[reversed], re[index]]
      ;[im[index], im[reversed]] = [im[reversed], im[index]]
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const half = width >> 1
    const angle = -2 * Math.PI / width
    for (let start = 0; start < size; start += width) {
      for (let offset = 0; offset < half; offset++) {
        const cos = Math.cos(angle * offset)
        const sin = Math.sin(angle * offset)
        const even = start + offset
        const odd = even + half
        const tre = re[odd] * cos - im[odd] * sin
        const tim = re[odd] * sin + im[odd] * cos
        re[odd] = re[even] - tre
        im[odd] = im[even] - tim
        re[even] += tre
        im[even] += tim
      }
    }
  }
}

/** Frequency of a spectral bin, given the analysis sample rate. */
export function binFrequency(bin: number, size: number, rate: number) {
  return bin * rate / size
}

/** Pitch class 0..11 of a frequency, or -1 outside the musical band. */
export function pitchClass(frequency: number) {
  if (frequency < 55 || frequency > 2200) return -1
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440))
  return ((midi % 12) + 12) % 12
}

export function noteLabel(pitch: number) {
  return PITCH_CLASSES[((pitch % 12) + 12) % 12]
}

/**
 * Compute chroma + energy. Audio is treated as a sequence of overlapping
 * Hann windows; chroma is L2-normalised so loudness differences between
 * versions do not dominate the similarity.
 */
export function analyzeChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: AnalyzeOptions = {},
): Analysis {
  const { samples, rate } = toMono(channels, sampleRate)
  const frameSize = options.frameSize ?? 2048
  const hopSize = options.hopSize ?? 800
  const window = new Float32Array(frameSize)
  for (let index = 0; index < frameSize; index++) {
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (frameSize - 1))
  }
  const bins = frameSize / 2
  const binClass = new Int8Array(bins)
  for (let bin = 1; bin < bins; bin++) {
    binClass[bin] = pitchClass(binFrequency(bin, frameSize, rate))
  }
  const chroma: Float32Array[] = []
  const energy: number[] = []
  const re = new Float32Array(frameSize)
  const im = new Float32Array(frameSize)
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let power = 0
    for (let index = 0; index < frameSize; index++) {
      const value = samples[start + index] * window[index]
      re[index] = value
      im[index] = 0
      power += value * value
    }
    fft(re, im)
    const frame = new Float32Array(12)
    for (let bin = 1; bin < bins; bin++) {
      const klass = binClass[bin]
      if (klass < 0) continue
      const magnitude = Math.hypot(re[bin], im[bin])
      frame[klass] += magnitude * magnitude
    }
    let norm = 0
    for (let index = 0; index < 12; index++) {
      frame[index] = Math.sqrt(frame[index])
      norm += frame[index] * frame[index]
    }
    norm = Math.sqrt(norm)
    if (norm > 1e-9) for (let index = 0; index < 12; index++) frame[index] /= norm
    chroma.push(frame)
    energy.push(Math.sqrt(power / frameSize))
  }
  return {
    frameRate: rate / hopSize,
    chroma,
    energy: Float32Array.from(energy),
    duration: samples.length / rate,
  }
}

/** Average chroma over a time span (used as a matching template). */
export function template(analysis: Analysis, start: number, end: number): Float32Array[] {
  const frames: Float32Array[] = []
  const first = Math.max(0, Math.round(start * analysis.frameRate))
  const last = Math.min(analysis.chroma.length, Math.round(end * analysis.frameRate))
  for (let index = first; index < last; index++) {
    const frame = analysis.chroma[index]
    const copy = new Float32Array(12)
    let norm = 0
    for (let bin = 0; bin < 12; bin++) {
      copy[bin] = frame[bin]
      norm += frame[bin] * frame[bin]
    }
    norm = Math.sqrt(norm)
    if (norm > 1e-6) for (let bin = 0; bin < 12; bin++) copy[bin] /= norm
    frames.push(copy)
  }
  return frames
}

export function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0
  for (let index = 0; index < 12; index++) dot += a[index] * b[index]
  return dot
}

/** Linear interpolation of a chroma frame at an arbitrary time. */
export function chromaAt(analysis: Analysis, time: number): Float32Array | null {
  const position = time * analysis.frameRate - 0.5
  if (position < 0 || position > analysis.chroma.length - 1) return null
  const left = Math.floor(position)
  const right = Math.min(analysis.chroma.length - 1, left + 1)
  const mix = position - left
  const a = analysis.chroma[left]
  const b = analysis.chroma[right]
  const out = new Float32Array(12)
  for (let index = 0; index < 12; index++) out[index] = a[index] * (1 - mix) + b[index] * mix
  return out
}

/** Mean energy over a window, used for silence rejection. */
export function energyAt(analysis: Analysis, start: number, end: number) {
  const first = Math.max(0, Math.round(start * analysis.frameRate))
  const last = Math.min(analysis.energy.length, Math.round(end * analysis.frameRate))
  if (last <= first) return 0
  let sum = 0
  for (let index = first; index < last; index++) sum += analysis.energy[index]
  return sum / (last - first)
}
