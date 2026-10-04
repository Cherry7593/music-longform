import type { VideoDraft, VideoTimeline } from './types'

/** Pure timeline shared by UI estimates and the probed render pipeline. All times are seconds. */
export function calculateTimeline(draft: VideoDraft, sources: { id: string; durationSeconds: number }[]): VideoTimeline {
  const issues: string[] = []
  const byId = new Map(sources.map(track => [track.id, track.durationSeconds]))
  if (!draft.audioIds.length) issues.push('请至少选择一首音乐')
  if (draft.audioIds.length > 100) issues.push('最多选择 100 首音乐')
  if (new Set(draft.audioIds).size !== draft.audioIds.length) issues.push('同一首音乐不能重复加入')
  const transition = draft.transition === 'cut' ? 0 : draft.transitionSeconds
  const validTransition = Number.isFinite(transition) && transition >= 0 && transition <= 10
  if (!validTransition || (draft.transition !== 'cut' && transition < 0.5)) issues.push('转场时长应为 0.5–10 秒')
  const d = validTransition ? transition : 0
  let cursor = 0
  let rawSeconds = 0
  const tracks = draft.audioIds.map((id, index) => {
    const original = byId.get(id)
    const seconds = original !== undefined && Number.isFinite(original) && original > 0 ? original : 0
    if (!seconds) issues.push(`第 ${index + 1} 首音乐不存在或时长无效，请检查素材`)
    const incoming = index > 0 ? d : 0
    const outgoing = index < draft.audioIds.length - 1 ? d : 0
    if (incoming + outgoing > seconds + 1 / 48000) issues.push(`第 ${index + 1} 首太短，转场区间会重叠；请减少转场时长`)
    if (index && draft.transition === 'crossfade') cursor -= d
    const startSeconds = cursor
    cursor += seconds
    rawSeconds += seconds
    return { id, durationSeconds: seconds, startSeconds, endSeconds: cursor, usedSeconds: 0 }
  })
  const overlapSeconds = draft.transition === 'crossfade' ? Math.max(0, tracks.length - 1) * d : 0
  const availableSeconds = Math.max(0, rawSeconds - overlapSeconds)
  let outputSeconds = availableSeconds
  let missingSeconds = 0
  if (draft.durationMode === 'target') {
    if (!Number.isFinite(draft.targetSeconds) || draft.targetSeconds < 60 || draft.targetSeconds > 21600) issues.push('目标时长应为 1–360 分钟')
    else {
      outputSeconds = draft.targetSeconds
      missingSeconds = Math.max(0, outputSeconds - availableSeconds)
      if (missingSeconds > 1 / 48000) issues.push(`音乐不足目标时长，还差 ${Math.ceil(missingSeconds * 10) / 10} 秒；请补充音乐或使用全部播放模式`)
    }
  }
  if (outputSeconds > 21600 + 1 / 48000) issues.push('成片最长 6 小时，请减少曲目或设置更短目标')
  if (![draft.fadeInSeconds, draft.fadeOutSeconds].every(value => Number.isFinite(value) && value >= 0 && value <= 10)) issues.push('首尾淡化应为 0–10 秒')
  if (draft.fadeInSeconds + draft.fadeOutSeconds > outputSeconds + 1 / 48000) issues.push('首尾淡化区间会重叠，请减少淡化时长')
  if (tracks.length > 1 && d && draft.fadeInSeconds + d > tracks[0].durationSeconds + 1 / 48000) issues.push('第一首太短，开头淡入与连接转场会重叠')
  if (draft.durationMode === 'all' && tracks.length > 1 && d && draft.fadeOutSeconds + d > tracks[tracks.length - 1].durationSeconds + 1 / 48000) issues.push('最后一首太短，结尾淡出与连接转场会重叠')
  for (const track of tracks) track.usedSeconds = Math.max(0, Math.min(track.durationSeconds, outputSeconds - track.startSeconds))
  return { rawSeconds, overlapSeconds, availableSeconds, outputSeconds, missingSeconds, tracks, issues: [...new Set(issues)] }
}
