import { z } from 'zod'
import type { MusicAdapter, MusicConnection, MusicDraft, ProviderMusicTask } from '../../shared/music-types'
import { malformedResponse, requestJson } from './http'
import { generationFailure, mediaUrl, milliseconds, parseResponse, remoteTaskId, remoteTitle, secondsSchema, titleFor, validateDraft, validateTaskId } from './music-contract'

const root = 'https://reapi.ai/api/v1'
const trackSchema = z.object({ url: mediaUrl, id: remoteTaskId.nullish(), title: remoteTitle, duration: secondsSchema })
const taskSchema = z.object({
  id: remoteTaskId, status: z.enum(['processing', 'completed', 'failed']),
  output: z.object({ audio_urls: z.array(mediaUrl).max(20).optional(), tracks: z.array(trackSchema).max(20).optional() }).nullish()
})
function parseTask(value: unknown, model: string, create: boolean): ProviderMusicTask {
  const data = parseResponse(taskSchema, value, create)
  const task: ProviderMusicTask = { id: data.id, model, status: data.status === 'completed' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'running' }
  if (data.status === 'failed') task.detail = generationFailure
  if (data.status === 'completed') {
    const output = data.output
    const urls = output?.audio_urls?.length ? output.audio_urls : output?.tracks?.map(track => track.url)
    if (!urls?.length) throw malformedResponse(create)
    // Both arrays are documented as index-aligned; never misattribute a different track's metadata.
    task.choices = urls.map((url, index) => {
      const track = output?.tracks?.[index]
      if (track && track.url !== url) throw malformedResponse(create)
      return { url, ...(track?.id ? { remoteId: track.id } : {}), ...(track?.title ? { title: track.title } : {}),
        ...(track?.duration != null ? { durationMs: milliseconds(track.duration) } : {}) }
    })
    if (output?.tracks && output.tracks.length > urls.length) throw malformedResponse(create)
  }
  return task
}

export class ReapiMusicAdapter implements MusicAdapter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, connection: MusicConnection, body?: unknown): Promise<unknown> {
    return requestJson(this.fetcher, root + path, { provider: 'reapi', key: connection.key ?? '', signal: connection.signal,
      method: body === undefined ? 'GET' : 'POST', body, timeoutMs: body === undefined ? 30_000 : 60_000 })
  }
  async create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask> {
    const input = validateDraft(draft, 'reapi')
    const custom = input.inputMode === 'lyrics'
    const value = await this.request('/audio/generations', connection, {
      model: 'suno-music', version: input.model, custom_mode: custom, instrumental: input.mode === 'instrumental',
      ...(custom ? { style: input.prompt.trim(), title: titleFor(input), duration: input.seconds ?? 180,
        ...(input.mode === 'song' ? { prompt: input.lyrics!.trim() } : {}) } : { prompt: input.prompt.trim() })
    })
    return parseTask(value, input.model, true)
  }
  async query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask> {
    validateDraft(draft, 'reapi'); validateTaskId(taskId)
    const task = parseTask(await this.request(`/tasks/${encodeURIComponent(taskId)}`, connection), draft.model, false)
    if (task.id !== taskId) throw malformedResponse(false)
    return task
  }
  async check(connection: MusicConnection): Promise<{ message: string }> {
    const data = parseResponse(z.object({ balance: z.number().finite().int() }), await this.request('/balance', connection))
    return { message: `reAPI 凭证可用，余额：${data.balance} 积分；未生成音乐，尚未验证模型权限。` }
  }
}
