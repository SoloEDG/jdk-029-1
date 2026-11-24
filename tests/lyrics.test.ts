import { describe, expect, it } from 'vitest'
import { LyricsParseError, parseLrc, parseLrcDetailed, toLrc } from '../src/features/align/lib/lyrics'

describe('LRC import', () => {
  it('parses stamps, sorts them and derives end times', () => {
    const lines = parseLrc('[00:08.00]夜风先到\n[00:10.00]把街灯点亮\n[00:12.50]我数着脚步')
    expect(lines.map(line => line.text)).toEqual(['夜风先到', '把街灯点亮', '我数着脚步'])
    expect(lines[0]!.start).toBe(8)
    expect(lines[0]!.end).toBeCloseTo(9.98, 2)
    expect(lines[2]!.end).toBeGreaterThan(12.5)
  })

  it('expands chorus shorthand with several stamps', () => {
    const lines = parseLrc('[00:24.00][00:40.00]如果星光还在')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.start).toBe(24)
    expect(lines[1]!.start).toBe(40)
    expect(lines[0]!.text).toBe(lines[1]!.text)
  })

  it('honours the offset tag', () => {
    const lines = parseLrc('[offset:500]\n[00:10.00]把街灯点亮')
    expect(lines[0]!.start).toBeCloseTo(9.5, 5)
  })

  it('ignores metadata tags and clamps to the audio duration', () => {
    const report = parseLrcDetailed('[ti:夜航]\n[ar:样例]\n[00:10.00]把街灯点亮', 42)
    expect(report.lines).toHaveLength(1)
    expect(report.lines[0]!.end).toBeLessThanOrEqual(42)
  })

  it('rejects a lyric file without timestamps with a helpful message', () => {
    expect(() => parseLrc('把夜色折进衣袖\n听见远处的海风')).toThrow(LyricsParseError)
    try {
      parseLrc('把夜色折进衣袖')
    } catch (error) {
      expect((error as Error).message).toContain('时间标记')
    }
  })

  it('reports untimed rows mixed into a timed file', () => {
    const report = parseLrcDetailed('[00:10.00]把街灯点亮\n没有时间的行')
    expect(report.skippedUntimed).toBe(1)
    expect(report.lines).toHaveLength(1)
  })

  it('round-trips through toLrc', () => {
    const lines = parseLrc('[00:08.00]夜风先到\n[00:10.00]把街灯点亮')
    const again = parseLrc(toLrc(lines))
    expect(again.map(line => line.text)).toEqual(lines.map(line => line.text))
    expect(again[0]!.start).toBeCloseTo(lines[0]!.start, 2)
  })
})
