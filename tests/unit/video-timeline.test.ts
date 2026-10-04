import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_VIDEO, videoDraftSchema } from '../../src/shared/schemas'
import { calculateTimeline } from '../../src/shared/video-timeline'
import type { VideoDraft } from '../../src/shared/types'
function timeline(lengths: number[], patch: Partial<VideoDraft> = {}) {
  const sources = lengths.map(durationSeconds => ({ id: randomUUID(), durationSeconds }))
  const draft: VideoDraft = { ...DEFAULT_VIDEO, durationMode: 'all', audioIds: sources.map(s => s.id), ...patch }
  return calculateTimeline(draft, sources)
}
describe('video timeline', () => {
  it('subtracts overlap and reports exactly the remaining 33 seconds of a one-hour playlist', () => {
    const result = timeline(Array(12).fill(300), { durationMode: 'target' })
    expect(result.rawSeconds).toBe(3600)
    expect(result.overlapSeconds).toBe(33)
    expect(result.availableSeconds).toBe(3567)
    expect(result.missingSeconds).toBe(33)
    expect(result.issues.join()).toContain('补充音乐')
  })
  it.each(['cut', 'fade'] as const)('%s preserves playlist length with no implicit gap', transition => {
    const result = timeline([10, 20, 30], { transition })
    expect(result.availableSeconds).toBe(60)
    expect(result.tracks.map(t => t.startSeconds)).toEqual([0, 10, 30])
    expect(result.issues).toEqual([])
  })
  it('crossfade uses adjacent overlap, not repeated music', () => {
    const result = timeline([10, 20, 30])
    expect(result.availableSeconds).toBe(54)
    expect(result.tracks.map(t => t.startSeconds)).toEqual([0, 7, 24])
    expect(result.issues).toEqual([])
  })
  it('one track has no inter-track transition', () => {
    const result = timeline([90])
    expect(result.availableSeconds).toBe(90)
    expect(result.overlapSeconds).toBe(0)
  })
  it('marks truncated and unused later tracks in target mode', () => {
    const result = timeline([40, 40, 40], { durationMode: 'target', targetSeconds: 60 })
    expect(result.tracks.map(t => t.usedSeconds)).toEqual([40, 23, 0])
    expect(result.outputSeconds).toBe(60)
    expect(result.issues).toEqual([])
  })
  it('exact target is allowed and too short middle tracks are rejected', () => {
    expect(timeline([33, 30], { durationMode: 'target', targetSeconds: 60 }).issues).toEqual([])
    expect(timeline([15, 5, 15]).issues.join()).toContain('第 2 首太短')
  })
  it('handles empty, zero and nonfinite tracks without NaN statistics', () => {
    expect(timeline([]).issues.join()).toContain('至少选择')
    const result = timeline([Infinity, NaN, 0])
    expect(Number.isFinite(result.availableSeconds)).toBe(true)
    expect(result.issues.join()).toContain('时长无效')
  })
  it('validates duration bounds and fades independently', () => {
    expect(timeline([100], { durationMode: 'target', targetSeconds: 59 }).issues.join()).toContain('1–360')
    expect(timeline([21601]).issues.join()).toContain('6 小时')
    expect(timeline([2]).issues.join()).toContain('淡化区间')
    expect(timeline([4, 10]).issues.join()).toContain('开头淡入')
  })
  it('does not silently trim oversized lists or allow duplicate sources', () => {
    expect(timeline(Array(101).fill(30)).issues.join()).toContain('100')
    const id = randomUUID()
    const draft = { ...DEFAULT_VIDEO, audioIds: [id, id] }
    expect(videoDraftSchema.safeParse(draft).success).toBe(false)
    expect(calculateTimeline(draft, [{ id, durationSeconds: 300 }]).issues.join()).toContain('重复')
  })
})
