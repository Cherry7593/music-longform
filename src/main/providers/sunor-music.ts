import { z } from 'zod'
import type { MusicAdapter, MusicConnection, MusicDraft, ProviderMusicTask } from '../../shared/music-types'
import { malformedResponse, requestJson } from './http'
import { envelopeData, generationFailure, mediaUrl, milliseconds, parseResponse, remoteTaskId, remoteTitle, secondsSchema, titleFor, validateDraft, validateTaskId } from './music-contract'

const root = 'https://sunor.cc/api/v1'
const clipSchema = z.object({
  audio_url: mediaUrl, id: remoteTaskId.nullish(), title: remoteTitle,
  metadata: z.object({ duration: secondsSchema }).nullish()
})
const querySchema = z.object({
  task_id: remoteTaskId, status: z.enum(['pending', 'running', 'success', 'failure', 'timeout']),
  output: z.object({ result: z.array(clipSchema).max(20).nullish() }).nullish()
})
const states = { pending: 'queued', running: 'running', success: 'succeeded', failure: 'failed', timeout: 'timeouted' } as const

export class SunorMusicAdapter implements MusicAdapter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, connection: MusicConnection, body?: unknown): Promise<unknown> {
    return requestJson(this.fetcher, root + path, { provider: 'sunor', key: connection.key ?? '', signal: connection.signal,
      method: body === undefined ? 'GET' : 'POST', body, timeoutMs: body === undefined ? 30_000 : 60_000 })
  }
  async create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask> {
    const input = validateDraft(draft, 'sunor')
    const value = await this.request('/task', connection, {
      model: 'suno', task_type: 'music', ...(input.outputFormat === 'original' ? {} : { audio_format: 'mp3' }),
      input: { model_version: 'v6', make_instrumental: input.mode === 'instrumental',
        ...(input.inputMode === 'description' ? { gpt_description_prompt: input.prompt.trim() } : {
          tags: input.prompt.trim(), title: titleFor(input), ...(input.mode === 'song' ? { prompt: input.lyrics!.trim() } : {})
        }) }
    })
    const data = parseResponse(z.object({ task_id: remoteTaskId, status: z.literal('pending').optional() }), envelopeData(value, 202, true), true)
    return { id: data.task_id, model: input.model, status: 'queued' }
  }
  async query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask> {
    validateDraft(draft, 'sunor'); validateTaskId(taskId)
    const data = parseResponse(querySchema, envelopeData(await this.request(`/task/${encodeURIComponent(taskId)}`, connection), 200))
    if (data.task_id !== taskId) throw malformedResponse(false)
    const task: ProviderMusicTask = { id: taskId, model: draft.model, status: states[data.status] }
    if (data.status === 'failure') task.detail = generationFailure
    if (data.status === 'timeout') task.detail = '平台生成超时，请核对原任务；未自动重新生成。'
    if (data.status === 'success') {
      if (!data.output?.result?.length) throw malformedResponse(false)
      task.choices = data.output.result.map(clip => ({ url: clip.audio_url,
        ...(clip.id ? { remoteId: clip.id } : {}), ...(clip.title ? { title: clip.title } : {}),
        ...(clip.metadata?.duration != null ? { durationMs: milliseconds(clip.metadata.duration) } : {}) }))
    }
    return task
  }
  async check(connection: MusicConnection): Promise<{ message: string }> {
    const balance = parseResponse(z.object({ available: z.number().finite().nonnegative(), frozen: z.number().finite().nonnegative() }), envelopeData(await this.request('/account/balance', connection), 200))
    return { message: `Sunor 凭证可用，可用积分：${balance.available}，冻结积分：${balance.frozen}；未生成音乐，尚未验证模型权限。` }
  }
}
