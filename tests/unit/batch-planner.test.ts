import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { batchDraft, planGroups, validateGroups } from '../../src/shared/batch-planner'
import { DEFAULT_BATCH_OPTIONS } from '../../src/shared/batch-schemas'
import type { BatchAssetSnapshot, BatchRequest } from '../../src/shared/library-types'

function fixture(seconds: number[], images = 3, minimumSeconds = 3600) {
  const assets: BatchAssetSnapshot[] = seconds.map((durationSeconds, i) => ({ id: randomUUID(), name: `曲目${i}`, kind: 'audio', bytes: 100, sha256: i.toString(16).padStart(64, '0'), durationSeconds }))
  for (let i = 0; i < images; i++) assets.push({ id: randomUUID(), name: `图片${i}`, kind: 'image', bytes: 100, sha256: (10000 + i).toString(16).padStart(64, '0') })
  const request: BatchRequest = { ...DEFAULT_BATCH_OPTIONS, name: '自动分组', minimumSeconds, audioIds: assets.filter(a => a.kind === 'audio').map(a => a.id), imageIds: assets.filter(a => a.kind === 'image').map(a => a.id) }
  return { assets, request }
}
describe('whole-song batch planning', () => {
  it('assigns all 60 distinct tracks exactly once to three 3643-second videos', () => {
    const f = fixture(Array(60).fill(185))
    const result = planGroups(f.request, f.assets)
    expect(result.issues).toEqual([])
    expect(result.groups.map(g => g.durationSeconds)).toEqual([3643, 3643, 3643])
    expect(result.groups.map(g => g.audioIds.length)).toEqual([20, 20, 20])
    expect(new Set(result.groups.flatMap(g => g.audioIds))).toEqual(new Set(f.request.audioIds))
    expect(planGroups(f.request, f.assets)).toEqual(result)
    for (const group of result.groups) {
      expect(group.audioIds.map(id => f.request.audioIds.indexOf(id))).toEqual(group.audioIds.map(id => f.request.audioIds.indexOf(id)).sort((a, b) => a - b))
      expect(batchDraft(f.request, group)).toMatchObject({ durationMode: 'all', targetSeconds: 3600 })
    }
  })
  it.each(['cut', 'fade', 'crossfade'] as const)('uses actual %s duration rules and an adjustable minimum', transition => {
    const f = fixture([35, 35, 35, 35], 2, 60)
    f.request.transition = transition
    const result = planGroups(f.request, f.assets)
    expect(result.issues).toEqual([])
    expect(result.groups.map(g => g.durationSeconds)).toEqual(transition === 'crossfade' ? [67, 67] : [70, 70])
  })
  it('does not infer hours from song count or pad an insufficient playlist', () => {
    const f = fixture(Array(60).fill(180))
    const result = planGroups(f.request, f.assets)
    expect(result.reason).toBe('insufficient')
    expect(result.issues[0]).toContain('171 秒')
    expect(result.groups.every(g => g.durationSeconds < 3600)).toBe(true)
  })
  it('accepts exact minimum but not a rounded-looking shortage', () => {
    const f = fixture([33, 30], 1, 60)
    expect(planGroups(f.request, f.assets).issues).toEqual([])
    f.assets[1].durationSeconds = 29.99
    expect(planGroups(f.request, f.assets).reason).toBe('insufficient')
  })
  it('does not claim an impossible whole-song partition means total duration is insufficient', () => {
    const f = fixture([70, 70, 70], 2, 100)
    const result = planGroups(f.request, f.assets)
    expect(result.reason).toBe('search-exhausted')
    expect(result.groups.flatMap(g => g.audioIds)).toHaveLength(3)
  })
  it('balances unequal durations rather than giving each group the same track count', () => {
    const f = fixture([100, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 2, 60)
    f.request.transition = 'cut'
    const result = planGroups(f.request, f.assets)
    expect(result.issues).toEqual([])
    expect(result.groups.map(g => g.audioIds.length).sort((a, b) => a - b)).toEqual([1, 10])
  })
  it('rejects duplicate content even when IDs differ', () => {
    const f = fixture([65, 65], 2, 60); f.assets[1].sha256 = f.assets[0].sha256
    expect(planGroups(f.request, f.assets).issues.join()).toContain('完全相同')
  })
  it('manual transfer must not omit, duplicate or import unselected songs', () => {
    const f = fixture([35, 35, 35, 35], 2, 60)
    const result = planGroups(f.request, f.assets)
    const groups = structuredClone(result.groups)
    groups[1].audioIds.push(groups[0].audioIds[0])
    expect(validateGroups(f.request, f.assets, groups).issues.join()).toContain('遗漏或重复')
    groups[0].audioIds.shift()
    expect(validateGroups(f.request, f.assets, groups).issues.join()).toContain('不足最短')
    groups[0].audioIds.push(randomUUID())
    expect(validateGroups(f.request, f.assets, groups).issues.join()).toContain('遗漏或重复')
  })
  it('manual playback reordering is preserved and images cannot be silently substituted', () => {
    const f = fixture([35, 40, 45, 50], 2, 60)
    const groups = planGroups(f.request, f.assets).groups
    groups[0].audioIds.reverse()
    expect(validateGroups(f.request, f.assets, groups).groups[0].audioIds).toEqual(groups[0].audioIds)
    groups[1].imageId = groups[0].imageId
    expect(validateGroups(f.request, f.assets, groups).issues.join()).toContain('每张')
  })
  it('keeps all selected excess music and rejects >100 songs in a single output', () => {
    const f = fixture(Array(101).fill(10), 1, 60)
    expect(planGroups(f.request, f.assets).issues.join()).toContain('100 首')
    expect(planGroups(f.request, f.assets).groups.flatMap(g => g.audioIds)).toHaveLength(101)
    const excess = fixture([200, 200], 1, 60)
    expect(planGroups(excess.request, excess.assets).groups[0].durationSeconds).toBe(397)
  })
  it('allows more than 100 songs across videos and enforces six hours per video', () => {
    const f = fixture(Array(120).fill(65), 2, 60)
    expect(planGroups(f.request, f.assets).issues).toEqual([])
    const maximum = fixture([21600], 1, 21600)
    expect(planGroups(maximum.request, maximum.assets).issues).toEqual([])
    maximum.assets[0].durationSeconds = 21601
    expect(planGroups(maximum.request, maximum.assets).issues.length).toBeGreaterThan(0)
  })
  it('detects short track crossfade collisions', () => {
    const f = fixture([90, 1, 1], 1, 60)
    expect(planGroups(f.request, f.assets).issues.join()).toContain('转场')
  })
  it.each([0, 59, 21601, NaN, Infinity])('rejects minimum %s', minimum => {
    const f = fixture([100], 1, minimum)
    expect(planGroups(f.request, f.assets).reason).toBe('invalid')
  })
  it('does not mutate request or asset metadata', () => {
    const f = fixture([80, 60, 35, 30], 2, 60)
    const before = structuredClone(f)
    planGroups(f.request, f.assets)
    expect(f).toEqual(before)
  })
})
