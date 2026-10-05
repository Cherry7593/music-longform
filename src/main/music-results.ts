import { createHash, randomUUID } from 'node:crypto'
import type { AudioAsset } from '../shared/types'
import type { MusicBinding, MusicOutput, ProviderMusicChoice } from '../shared/music-types'
import { AppError } from './providers/http'

export function resultLocator(choice: ProviderMusicChoice, binding: MusicBinding): string {
  let url: URL
  try { url = new URL(choice.url, binding.local?.baseUrl) } catch { throw new AppError('音乐结果地址无效，请重新查询原任务。') }
  const stable = `${url.origin}${url.pathname}${binding.provider === 'acestep' ? `?path=${url.searchParams.get('path') ?? ''}` : ''}`
  return createHash('sha256').update(stable).digest('hex')
}
/** Never use an expiring signed query string or a fabricated remote ID as the persisted result identity. */
export function matchMusicResults(binding: MusicBinding, choices: ProviderMusicChoice[], previous: MusicOutput[] | undefined, existing: AudioAsset[], jobId: string): { output: MusicOutput; choice: ProviderMusicChoice }[] {
  if (!choices.length || choices.length > 20) throw new AppError('任务成功但音频结果为空或数量超限，请查询原任务，不要重新生成。')
  const keyed = choices.map((choice, index) => ({ choice, index, locator: resultLocator(choice, binding) }))
  const identities = keyed.map(({ choice, locator }) => choice.remoteId ? `remote:${choice.remoteId}` : `local:${locator}`)
  if (new Set(identities).size !== identities.length) throw new AppError('服务返回了无法区分的重复音频结果，请核对原任务。')
  if (previous) {
    if (previous.length !== choices.length) throw new AppError('原任务的结果数量发生变化，已保留成功素材；请核对服务，不会重复生成。')
    const used = new Set<number>()
    return previous.map(output => {
      const match = keyed.find(({ choice, locator, index }) => !used.has(index) && (output.remoteId ? choice.remoteId === output.remoteId : !choice.remoteId && locator === output.locator))
      if (!match) throw new AppError('原任务的音频标识发生变化，无法安全匹配剩余结果；已保存素材未受影响。')
      used.add(match.index)
      return { output: structuredClone(output), choice: match.choice }
    })
  }
  return keyed.map(({ choice, index, locator }) => {
    const saved = choice.remoteId ? existing.find(asset => asset.jobId === jobId && asset.remoteId === choice.remoteId) : undefined
    return {
      output: {
        id: saved?.resultId ?? randomUUID(), assetId: saved?.id ?? randomUUID(), index, locator,
        ...(choice.remoteId ? { remoteId: choice.remoteId } : {}), ...(choice.title ? { title: choice.title } : {}),
        status: saved ? 'saved' as const : 'pending' as const
      }, choice
    }
  })
}
