#!/usr/bin/env python3
"""Build the two-version alignment fixture.

Version A ("studio", 120 BPM) is what the lyric timings were transcribed
against. Version B ("rehearsal", 112 BPM) has:

- a one-bar pickup (the head grows by four beats),
- the first chorus repeated once,
- the bridge between the choruses cut.

The bridge has its own lyric lines, so version B has lyric lines that exist
only on version A. The chorus is sung twice in both versions with identical
words, and version B has an extra copy, so a matcher must not send the second
occurrence of the words back to the first chorus.
"""
from __future__ import annotations

import json
import math
import random
import struct
import sys
import wave
from pathlib import Path

RATE = 16000
ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "public" / "samples"
PROJECT_JSON = ROOT / "src" / "features" / "align" / "model" / "demo-project.json"
FIXTURE_JSON = ROOT / "scripts" / "alignment-fixture.json"

A_BPM = 120.0
B_BPM = 112.0
BAR_BEATS = 4

PROGRESSION = [
    (48, [60, 64, 67]),
    (45, [57, 60, 64]),
    (53, [57, 60, 65]),
    (55, [59, 62, 67]),
]
BRIDGE_CHORDS = [
    (57, [57, 60, 64]),
    (53, [53, 57, 60]),
    (55, [55, 59, 62]),
    (52, [52, 55, 59]),
]
MELODY = {
    "verseA": [72, 74, 76, 72, 69, 72, 74, 76],
    "verseB": [74, 76, 77, 74, 72, 69, 72, 74],
    "chorus": [79, 76, 74, 72, 74, 76, 79, 81],
    "bridge": [64, 62, 60, 57, 60, 62, 64, 67],
    "outro": [76, 74, 72, 67],
}
MELODY_OFFSETS = [0.0, 2.0]

# name, bars, melody, chords
SECTIONS_A = [
    ("intro", 4, None, PROGRESSION),
    ("verse1", 4, "verseA", PROGRESSION),
    ("verse2", 4, "verseB", PROGRESSION),
    ("chorus1", 4, "chorus", PROGRESSION),
    ("bridge", 4, "bridge", BRIDGE_CHORDS),
    ("chorus2", 4, "chorus", PROGRESSION),
    ("outro", 2, "outro", PROGRESSION),
]
SECTIONS_B = [
    ("pickup", 1, None, PROGRESSION),
    ("intro", 4, None, PROGRESSION),
    ("verse1", 4, "verseA", PROGRESSION),
    ("verse2", 4, "verseB", PROGRESSION),
    ("chorus1", 4, "chorus", PROGRESSION),
    ("chorus1_repeat", 4, "chorus", PROGRESSION),
    ("chorus2", 4, "chorus", PROGRESSION),
    ("outro", 2, "outro", PROGRESSION),
]

LINES = [
    ("夜风先到", 8.0, 10.0, "verseA"),
    ("把街灯点亮", 10.0, 12.0, "verseA"),
    ("我数着脚步", 12.0, 14.0, "verseA"),
    ("走进旧时光", 14.0, 16.0, "verseA"),
    ("云从山后来", 16.0, 18.0, "verseB"),
    ("带着雨的消息", 18.0, 20.0, "verseB"),
    ("你说别回头", 20.0, 22.0, "verseB"),
    ("路会自己亮起", 22.0, 24.0, "verseB"),
    ("如果星光还在", 24.0, 26.0, "chorus"),
    ("就让它慢慢落", 26.0, 28.0, "chorus"),
    ("我会记得这夜", 28.0, 30.0, "chorus"),
    ("和你的沉默", 30.0, 32.0, "chorus"),
    ("桥段的风", 32.0, 34.0, "bridge"),
    ("吹散了承诺", 34.0, 36.0, "bridge"),
    ("等潮汐退去", 36.0, 38.0, "bridge"),
    ("我再向你走", 38.0, 40.0, "bridge"),
    ("如果星光还在", 40.0, 42.0, "chorus"),
    ("就让它慢慢落", 42.0, 44.0, "chorus"),
    ("我会记得这夜", 44.0, 46.0, "chorus"),
    ("和你的沉默", 46.0, 48.0, "chorus"),
    ("天快亮了", 48.0, 50.0, "outro"),
    ("我们先别说", 50.0, 52.0, "outro"),
]


def hz(midi: int) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def envelope(length: int, attack: float = 0.01, release: float = 0.08):
    out = []
    for i in range(length):
        t = i / RATE
        a = min(1.0, t / attack) if attack > 0 else 1.0
        r = min(1.0, (length / RATE - t) / release) if release > 0 else 1.0
        out.append(max(0.0, min(a, r)))
    return out


def tone(midi: int, duration: float, gain: float, harmonics=(1.0, 0.5, 0.25), vibrato=0.0):
    length = max(1, int(duration * RATE))
    freq = hz(midi)
    env = envelope(length)
    out = []
    for i in range(length):
        t = i / RATE
        f = freq * (1.0 + vibrato * math.sin(2 * math.pi * 5.2 * t))
        value = 0.0
        for n, amp in enumerate(harmonics, start=1):
            value += amp * math.sin(2 * math.pi * f * n * t)
        out.append(gain * env[i] * value)
    return out


def chord(root: int, tones, duration: float, gain: float):
    out = [0.0] * max(1, int(duration * RATE))
    for index, midi in enumerate(tones):
        partial = tone(midi + (0 if index else -12), duration, gain)
        for i, value in enumerate(partial):
            out[i] += value
    return out


def click(accent: bool, gain: float):
    length = int(0.05 * RATE)
    freq = 1600 if accent else 1100
    return [gain * math.sin(2 * math.pi * freq * i / RATE) * math.exp(-i / (RATE * 0.012)) for i in range(length)]


def mix_into(samples, start: int, part) -> None:
    for i, value in enumerate(part):
        if 0 <= start + i < len(samples):
            samples[start + i] += value


def build(sections, bpm: float):
    beat = 60.0 / bpm
    samples = []
    for name, bars, melody_id, chords in sections:
        for bar in range(bars):
            bar_start = len(samples)
            bar_len = int(round(beat * BAR_BEATS * RATE))
            samples.extend([0.0] * bar_len)
            root, tones = chords[bar % len(chords)]
            mix_into(samples, bar_start, chord(root, tones, beat * BAR_BEATS, 0.07))
            for beat_index in range(BAR_BEATS):
                hit = click(beat_index == 0, 0.05)
                mix_into(samples, bar_start + int(round(beat_index * beat * RATE)), hit)
            if melody_id:
                notes = MELODY[melody_id]
                for slot, offset_beats in enumerate(MELODY_OFFSETS):
                    midi = notes[(bar * 2 + slot) % len(notes)]
                    start = bar_start + int(round(offset_beats * beat * RATE))
                    mix_into(samples, start, tone(midi, beat * 1.7, 0.16, vibrato=0.004))
    return samples


def write(path: Path, samples, gain: float):
    peak = max(1e-9, max(abs(value) for value in samples))
    scale = gain / peak
    frames = bytearray()
    for value in samples:
        packed = struct.pack("<h", int(max(-1.0, min(1.0, value * scale)) * 32767))
        frames.extend(packed)
        frames.extend(packed)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(bytes(frames))


def section_times(sections, bpm):
    beat = 60.0 / bpm
    cursor = 0.0
    out = []
    for name, bars, melody_id, _ in sections:
        length = bars * BAR_BEATS * beat
        out.append({"name": name, "start": round(cursor, 6), "end": round(cursor + length, 6), "melody": melody_id})
        cursor += length
    return out, round(cursor, 6)


def guide_notes(bpm: float, span: float = 2.0):
    """One lead note per half-bar, mirroring the audio fixture's melody."""
    beat = 60.0 / bpm
    notes = []
    for line_text, start, end, melody_id in LINES:
        melody = MELODY[melody_id]
        offset = int(round(start / (beat * BAR_BEATS))) * 2
        for slot in range(4):
            midi = melody[(offset + slot) % len(melody)]
            note_start = start + slot * beat
            notes.append({"start": round(note_start, 6), "end": round(note_start + beat * 0.85, 6), "midi": midi})
    return notes


def main() -> int:
    SAMPLES.mkdir(parents=True, exist_ok=True)
    PROJECT_JSON.parent.mkdir(parents=True, exist_ok=True)
    a = build(SECTIONS_A, A_BPM)
    b = build(SECTIONS_B, B_BPM)
    rng = random.Random(20261124)
    for samples in (a, b):
        for i in range(len(samples)):
            samples[i] += rng.uniform(-0.0015, 0.0015)
    write(SAMPLES / "align-reference.wav", a, 0.8)
    write(SAMPLES / "align-rehearsal.wav", b, 0.8)

    sections_a, duration_a = section_times(SECTIONS_A, A_BPM)
    sections_b, duration_b = section_times(SECTIONS_B, B_BPM)

    project = {
        "id": "night-flight",
        "title": "夜航 · 双版小样",
        "artist": "对齐样例",
        "sourceName": "夜航 歌词.lrc",
        "reference": {
            "id": "studio",
            "label": "录音室版",
            "fileName": "align-reference.wav",
            "url": "/samples/align-reference.wav",
            "duration": duration_a,
            "bpm": A_BPM,
            "key": "C 大调",
            "cover": "/media/tide.jpg",
            "notes": guide_notes(A_BPM),
        },
        "target": {
            "id": "rehearsal",
            "label": "排练版",
            "fileName": "align-rehearsal.wav",
            "url": "/samples/align-rehearsal.wav",
            "duration": duration_b,
            "bpm": B_BPM,
            "key": "C 大调",
            "cover": "/media/dawn.jpg",
            "notes": [],
        },
        "lines": [
            {"id": f"line-{index + 1}", "text": text, "start": start, "end": end}
            for index, (text, start, end, _) in enumerate(LINES)
        ],
        "anchors": [],
        "spans": [],
        "snapshots": [],
        "updatedAt": 0,
    }
    PROJECT_JSON.write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    FIXTURE_JSON.write_text(json.dumps({
        "reference": {"bpm": A_BPM, "sections": sections_a, "duration": duration_a},
        "target": {"bpm": B_BPM, "sections": sections_b, "duration": duration_b},
        "deletedLineIds": [f"line-{i + 13}" for i in range(4)],
        "repeatedLineIds": [f"line-{i + 9}" for i in range(4)] + [f"line-{i + 17}" for i in range(4)],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for entry in sections_a:
        print("A", entry)
    for entry in sections_b:
        print("B", entry)
    print("deleted lyric ids:", [f"line-{i + 13}" for i in range(4)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
