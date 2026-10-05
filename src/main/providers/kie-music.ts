import { z } from 'zod'
import type { MusicAdapter, MusicConnection, MusicDraft, ProviderMusicTask } from '../../shared/music-types'
import { malformedResponse, requestJson } from './http'
import { envelopeData, generationFailure, mediaUrl, parseResponse, parseResultJson, remoteTaskId, titleFor, validateDraft, validateTaskId } from './music-contract'

const root = 'https://api.kie.ai/api/v1'
const recordSchema = z.object({
  taskId: remoteTaskId,
  state: z.enum(['waiting', 'queuing', 'generating', 'success', 'fail']),
  resultJson: z.string().max(1024 * 1024).nullish()
})
const states = { waiting: 'queued', queuing: 'queued', generating: 'running', success: 'succeeded', fail: 'failed' } as const

export class KieMusicAdapter implements MusicAdapter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, connection: MusicConnection, body?: unknown): Promise<unknown> {
    return requestJson(this.fetcher, root + path, { provider: 'kie', key: connection.key ?? '', signal: connection.signal,
      method: body === undefined ? 'GET' : 'POST', body, timeoutMs: body === undefined ? 30_000 : 60_000 })
  }
  async create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask> {
    const input = validateDraft(draft, 'kie')
    const value = await this.request('/jobs/createTask', connection, {
      model: 'ai-music-api/generate', input: {
        custom_mode: true, instrumental: input.mode === 'instrumental', model: input.model,
        style: input.prompt.trim(), title: titleFor(input), duration: input.seconds ?? 180,
        ...(input.mode === 'song' ? { lyrics: input.lyrics!.trim() } : {})
      }
    })
    const data = parseResponse(z.object({ taskId: remoteTaskId }), envelopeData(value, 200, true), true)
    return { id: data.taskId, model: input.model, status: 'queued' }
  }
  async query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask> {
    validateDraft(draft, 'kie'); validateTaskId(taskId)
    const value = await this.request(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, connection)
    const data = parseResponse(recordSchema, envelopeData(value, 200))
    if (data.taskId !== taskId) throw malformedResponse(false)
    const task: ProviderMusicTask = { id: taskId, model: draft.model, status: states[data.state] }
    if (data.state === 'fail') task.detail = generationFailure
    if (data.state === 'success') {
      if (!data.resultJson) throw malformedResponse(false)
      const result = parseResponse(z.object({ resultUrls: z.array(mediaUrl).min(1).max(20) }), parseResultJson(data.resultJson))
      task.choices = result.resultUrls.map(url => ({ url }))
    }
    return task
  }
  async check(connection: MusicConnection): Promise<{ message: string }> {
    const credits = parseResponse(z.number().finite().nonnegative(), envelopeData(await this.request('/chat/credit', connection), 200))
    return { message: `Kie.ai 凭证可用，可用积分：${credits}；未生成音乐，尚未验证模型权限。` }
  }
}
