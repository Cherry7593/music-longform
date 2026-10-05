import { z } from 'zod'
import { musicDraftSchema } from '../../shared/music-schemas'
import { isMurekaProvider } from '../../shared/music-capabilities'
import type { MusicDraft, MusicProviderId } from '../../shared/music-types'
import { AppError, malformedResponse, statusError } from './http'

export const remoteTaskId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
export const remoteTitle = z.string().max(500).nullish()
export const secondsSchema = z.number().finite().nonnegative().max(21_600).nullish()
export const mediaUrl = z.string().min(1).max(8192).refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
  } catch { return false }
})
export const generationFailure = '服务商生成失败，请检查生成参数、模型权限和账户额度；未自动重新生成。'

export function parseResponse<T>(schema: z.ZodType<T>, value: unknown, create = false): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw malformedResponse(create)
  return parsed.data
}
export function parseResultJson(value: string, create = false): unknown {
  if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw malformedResponse(create)
  try { return JSON.parse(value) as unknown } catch { throw malformedResponse(create) }
}
export function validateDraft(draft: MusicDraft, provider: MusicProviderId): MusicDraft {
  if (provider === 'reapi' && draft?.seconds !== undefined && !Number.isInteger(draft.seconds)) throw new AppError('reAPI 请求时长必须为 10–360 的整数秒。')
  const parsed = musicDraftSchema.safeParse(draft)
  if (!parsed.success || parsed.data.provider !== provider || !parsed.data.prompt.trim()) throw new AppError('音乐参数不正确，请填写描述并检查模式、模型、歌词和长度。')
  if (!isMurekaProvider(provider) && !parsed.data.inputMode) throw new AppError('请选择描述生成或自填歌词模式。')
  return parsed.data
}
export function validateTaskId(taskId: string): void {
  if (!remoteTaskId.safeParse(taskId).success) throw new AppError('音乐任务标识不正确，无法查询。')
}
export function titleFor(draft: MusicDraft): string { return draft.title?.trim() || '音乐生成' }
export function milliseconds(seconds: number | null | undefined): number | undefined { return seconds == null ? undefined : Math.round(seconds * 1000) }

/** Only documented numeric envelope codes, never remote messages, escape parsing. */
export function envelopeData(value: unknown, successCode: number, create = false): unknown {
  const envelope = parseResponse(z.object({ code: z.number().int(), data: z.unknown().optional(), error_code: z.string().max(200).optional() }), value, create)
  if (envelope.code !== successCode) {
    if (envelope.code < 400 || envelope.code > 599) throw malformedResponse(create)
    throw statusError(envelope.code, { error_code: envelope.error_code }, create)
  }
  return envelope.data
}
