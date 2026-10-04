import type { BatchAssetSnapshot, BatchGroup, BatchGroupInput, BatchOptions, BatchRequest } from './library-types'
import type { VideoDraft } from './types'
import { batchRequestSchema } from './batch-schemas'
import { calculateTimeline } from './video-timeline'

const EPSILON = 1 / 48000
export function batchDraft(options: BatchOptions, group: BatchGroupInput): VideoDraft {
  return { initialized: true, audioIds: [...group.audioIds], imageId: group.imageId, durationMode: 'all', targetSeconds: options.minimumSeconds,
    transition: options.transition, transitionSeconds: options.transitionSeconds, fadeInSeconds: options.fadeInSeconds,
    fadeOutSeconds: options.fadeOutSeconds, normalize: options.normalize, fit: options.fit }
}
export interface GroupResult { groups: BatchGroup[]; issues: string[]; reason?: 'invalid' | 'insufficient' | 'search-exhausted' }

/** Also used for manual transfers; never silently adds, drops or duplicates a selected track. */
export function validateGroups(request: BatchRequest, assets: BatchAssetSnapshot[], input: BatchGroupInput[]): GroupResult {
  const issues: string[] = []
  if (!batchRequestSchema.safeParse(request).success) return { groups: [], issues: ['批量参数不正确，请检查素材数量和最短时长。'], reason: 'invalid' }
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  if (byId.size !== assets.length) issues.push('素材快照标识重复')
  const audio = request.audioIds.map(id => byId.get(id))
  if (audio.some(a => !a || a.kind !== 'audio' || !Number.isFinite(a.durationSeconds) || a.durationSeconds! <= 0 || a.durationSeconds! > 21600)) issues.push('音乐缺失或真实时长无效')
  const hashes = audio.filter(a => a?.sha256).map(a => a!.sha256.toLowerCase())
  if (new Set(hashes).size !== hashes.length) issues.push('所选音乐包含内容完全相同的文件，请取消重复素材')
  if (request.imageIds.some(id => byId.get(id)?.kind !== 'image')) issues.push('图片素材缺失')
  if (input.length !== request.imageIds.length || input.some((g, i) => g.imageId !== request.imageIds[i])) issues.push('每张所选图片必须且只能对应一个视频')
  const assigned = input.flatMap(g => g.audioIds)
  const selected = new Set(request.audioIds)
  if (assigned.length !== selected.size || new Set(assigned).size !== assigned.length || assigned.some(id => !selected.has(id))) issues.push('所选音乐必须全部分配一次，不能遗漏或重复')
  const sources = audio.filter((a): a is BatchAssetSnapshot => !!a).map(a => ({ id: a.id, durationSeconds: a.durationSeconds ?? 0 }))
  const groups = input.map((group, index) => {
    const timeline = calculateTimeline(batchDraft(request, group), sources)
    const problems = [...timeline.issues]
    if (timeline.outputSeconds + EPSILON < request.minimumSeconds) problems.push(`不足最短时长，还差 ${Math.ceil(request.minimumSeconds - timeline.outputSeconds)} 秒`)
    if (problems.length) issues.push(`视频 ${index + 1}：${problems.join('；')}`)
    return { imageId: group.imageId, audioIds: [...group.audioIds], durationSeconds: timeline.outputSeconds, issues: problems }
  })
  return { groups, issues: [...new Set(issues)], ...(issues.length ? { reason: 'invalid' as const } : {}) }
}

/** Bounded deterministic LPT + local move/swap repair + small-instance branch search. */
export function planGroups(request: BatchRequest, assets: BatchAssetSnapshot[]): GroupResult {
  if (!batchRequestSchema.safeParse(request).success) return { groups: [], issues: ['批量参数不正确，请检查素材数量和最短时长。'], reason: 'invalid' }
  const byId = new Map(assets.map(a => [a.id, a]))
  const count = request.imageIds.length
  const empty = request.imageIds.map(imageId => ({ imageId, audioIds: [] as string[] }))
  if (request.audioIds.some(id => byId.get(id)?.kind !== 'audio' || !Number.isFinite(byId.get(id)?.durationSeconds) || byId.get(id)!.durationSeconds! <= 0)) {
    return { groups: [], issues: ['音乐缺失或真实时长无效'], reason: 'invalid' }
  }
  const sourceOrder = new Map(request.audioIds.map((id, i) => [id, i]))
  const duration = (id: string): number => byId.get(id)!.durationSeconds!
  const overlap = request.transition === 'crossfade' ? request.transitionSeconds : 0
  const seconds = (ids: string[]): number => ids.reduce((sum, id) => sum + duration(id), 0) - Math.max(0, ids.length - 1) * overlap
  const ordered = [...request.audioIds].sort((a, b) => duration(b) - duration(a) || sourceOrder.get(a)! - sourceOrder.get(b)!)
  const bins = empty.map(() => [] as string[])
  for (const id of ordered) {
    const choices = bins.map((ids, index) => ({ index, length: ids.length, seconds: seconds(ids) }))
    const fitting = choices.filter(item => item.length < 100 && item.seconds + duration(id) - (item.length ? overlap : 0) <= 21600 + EPSILON)
    const best = (fitting.length ? fitting : choices).sort((a, b) => a.seconds - b.seconds || a.length - b.length || a.index - b.index)[0]
    bins[best.index].push(id)
  }
  const raw = request.audioIds.reduce((sum, id) => sum + duration(id), 0)
  const total = raw - Math.max(0, request.audioIds.length - count) * overlap
  const necessaryIssue = request.audioIds.length < count ? '音乐数量少于图片数量，无法为每条视频分配音乐'
    : request.audioIds.length > count * 100 ? '选曲数量超过每个视频 100 首的容量，请减少音乐或增加图片'
    : total + EPSILON < count * request.minimumSeconds ? `音乐总时长不足，扣除转场后还差 ${Math.ceil(count * request.minimumSeconds - total)} 秒`
    : total > count * 21600 + EPSILON ? '音乐总时长超过每个视频 6 小时的容量，请减少音乐或增加图片' : undefined
  const result = (groups: string[][]): GroupResult => validateGroups(request, assets, groups.map((ids, i) => ({
    imageId: request.imageIds[i], audioIds: [...ids].sort((a, b) => sourceOrder.get(a)! - sourceOrder.get(b)!)
  })))
  let bestResult = result(bins)
  if (!bestResult.issues.length) return bestResult
  if (necessaryIssue) return { ...bestResult, issues: [necessaryIssue, ...bestResult.issues], reason: total + EPSILON < count * request.minimumSeconds ? 'insufficient' : 'invalid' }
  // Repair by decreasing an explicit penalty. A hard candidate budget bounds even 10,000 selections.
  const cost = (ids: string[]): number => {
    const s = seconds(ids)
    const timeline = calculateTimeline(batchDraft(request, { imageId: request.imageIds[0], audioIds: ids }), ids.map(id => ({ id, durationSeconds: duration(id) })))
    return Math.max(0, request.minimumSeconds - s) ** 2 + Math.max(0, s - 21600) ** 2
      + timeline.issues.length * 1e10 + s * s * 1e-9
  }
  let budget = 20000
  for (let pass = 0; pass < 30 && budget > 0; pass++) {
    let improved = false
    const costs = bins.map(cost)
    outer: for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) {
      if (a === b) continue
      for (let i = 0; i < bins[a].length && budget > 0; i++) {
        const left = bins[a].filter((_, n) => n !== i)
        if (left.length && bins[b].length < 100) {
          budget--
          const right = [...bins[b], bins[a][i]]
          if (cost(left) + cost(right) < costs[a] + costs[b] - 1e-7) { bins[a] = left; bins[b] = right; improved = true; break outer }
        }
        for (let j = 0; j < bins[b].length && budget > 0; j++) {
          budget--
          const x = [...bins[a]]; const y = [...bins[b]]
          ;[x[i], y[j]] = [y[j], x[i]]
          if (cost(x) + cost(y) < costs[a] + costs[b] - 1e-7) { bins[a] = x; bins[b] = y; improved = true; break outer }
        }
      }
    }
    bestResult = result(bins)
    if (!bestResult.issues.length) return bestResult
    if (!improved) break
  }
  if (ordered.length <= 24 && count <= 6) {
    let nodes = 30000
    const candidates = empty.map(() => [] as string[])
    const loads = empty.map(() => 0)
    let found: GroupResult | undefined
    const search = (index: number): void => {
      if (--nodes < 0 || found) return
      if (index === ordered.length) { const checked = result(candidates); if (!checked.issues.length) found = checked; return }
      const id = ordered[index]
      const tried = new Set<string>()
      for (const n of loads.map((load, n) => ({ load, n })).sort((a, b) => a.load - b.load || a.n - b.n).map(x => x.n)) {
        // Identical member duration sequences have symmetric feasibility, not merely equal totals.
        const signature = candidates[n].map(duration).join(',')
        if (tried.has(signature)) continue
        tried.add(signature)
        const next = loads[n] + duration(id) - (candidates[n].length ? overlap : 0)
        if (next > 21600 + EPSILON || candidates[n].length >= 100) continue
        const before = loads[n]; loads[n] = next; candidates[n].push(id)
        search(index + 1)
        candidates[n].pop(); loads[n] = before
        if (found || nodes < 0) break
      }
    }
    search(0)
    if (found) return found
  }
  return { ...bestResult, reason: 'search-exhausted', issues: ['未在计算预算内找到全部达标的整首分组，可手动调组、减少图片或调整最短时长；不代表总时长必然不足。', ...bestResult.issues] }
}
