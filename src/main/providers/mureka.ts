import { z } from 'zod'
import { musicDraftSchema } from '../../shared/schemas'
import type { CredentialCheck, MusicDraft, MusicMode, MusicProvider, RemoteMusicTask } from '../../shared/types'
import { AppError, malformedResponse, requestJson } from './http'

const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/)
const taskSchema = z.object({
  id: taskIdSchema,
  model: z.string().min(1).max(200).optional(),
  status: z.enum(['preparing', 'queued', 'running', 'streaming', 'succeeded', 'failed', 'timeouted', 'cancelled']),
  failed_reason: z.string().max(8192).optional(),
  choices: z.array(z.object({
    id: taskIdSchema,
    url: z.url().max(8192),
    duration: z.number().finite().nonnegative()
  })).max(20).optional()
})

function parseTask(value: unknown, post: boolean): RemoteMusicTask {
  const task = taskSchema.safeParse(value)
  if (!task.success) throw malformedResponse(post)
  // A remote error may echo a prompt, key or internal diagnostics: never persist it.
  if (task.data.failed_reason !== undefined) task.data.failed_reason = '服务商生成失败，请检查账户额度和生成参数。'
  return task.data
}

export class MurekaProvider implements MusicProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async create(draft: MusicDraft, key: string): Promise<RemoteMusicTask> {
    const parsed = musicDraftSchema.safeParse(draft)
    if (!parsed.success || !parsed.data.prompt.trim()) throw new AppError('音乐参数不正确，请填写提示词并检查长度、模式和模型。')
    const input = parsed.data
    const song = input.mode === 'song'
    const data = await requestJson(this.fetcher, `https://api.mureka.ai/v1/${song ? 'song/easy-generate' : 'instrumental/generate'}`, {
      method: 'POST', key, timeoutMs: 60_000,
      body: { model: input.model, prompt: input.prompt.trim(), ...(song && input.styles.length ? { styles: input.styles } : {}), n: 1, stream: false }
    })
    return parseTask(data, true)
  }

  async query(mode: MusicMode, taskId: string, key: string): Promise<RemoteMusicTask> {
    if (!z.enum(['instrumental', 'song']).safeParse(mode).success || !taskIdSchema.safeParse(taskId).success) {
      throw new AppError('音乐任务标识或模式不正确，无法查询。')
    }
    const data = await requestJson(this.fetcher, `https://api.mureka.ai/v1/${mode}/query/${encodeURIComponent(taskId)}`, { method: 'GET', key, timeoutMs: 30_000 })
    const task = parseTask(data, false)
    if (task.id !== taskId) throw malformedResponse(false)
    return task
  }

  async check(key: string): Promise<CredentialCheck> {
    const data = await requestJson(this.fetcher, 'https://api.mureka.ai/v1/account/billing', { method: 'GET', key, timeoutMs: 20_000 })
    const billing = z.object({ balance: z.number().finite().int() }).safeParse(data)
    if (!billing.success) throw malformedResponse(false)
    return { message: 'Mureka 凭证可用，余额已查询（单位：分）。', balanceCents: billing.data.balance }
  }
}
