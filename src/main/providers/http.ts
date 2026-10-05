import { z } from 'zod'
import { keySchema, providerKeySchema } from '../../shared/schemas'
import { MUREKA_ORIGINS } from '../../shared/music-capabilities'

/** Only application-authored, non-secret messages belong in this error. */
export class AppError extends Error {
  constructor(message: string, readonly uncertain = false) {
    super(message)
    this.name = 'AppError'
  }
}

export function safeError(error: unknown): string {
  return error instanceof AppError ? error.message : '操作失败，请检查网络、存储权限或稍后重试。'
}

export class TransportError extends Error {}

export async function withTimeout<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => undefined
  const timeout = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new TransportError('aborted')) }
    if (parent?.aborted) { abort(); return }
    parent?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, milliseconds)
  })
  try {
    if (parent?.aborted) return await timeout
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export async function readLimited(response: Response, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    void response.body?.cancel().catch(() => undefined)
    throw new AppError('服务返回的数据过大，已停止接收。')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = (): void => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw new TransportError('timeout')
    while (true) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new TransportError('timeout')
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new AppError('服务返回的数据过大，已停止接收。')
      if (chunks.length >= 65536) throw new AppError('服务返回的数据分片过多，已停止接收。')
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    if (error instanceof AppError) throw error
    throw new TransportError('read')
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

const errorCodeSchema = z.object({
  code: z.union([z.string().max(200), z.number()]).optional(),
  error_code: z.string().max(200).optional(),
  error: z.object({ code: z.union([z.string().max(200), z.number()]).nullable().optional(), type: z.string().max(200).optional() }).optional()
})

export function statusError(status: number, data: unknown, post: boolean): AppError {
  const parsed = errorCodeSchema.safeParse(data)
  const code = parsed.success ? String(parsed.data.error_code ?? parsed.data.error?.code ?? parsed.data.error?.type ?? parsed.data.code ?? '') : ''
  const uncertain = post && status >= 500
  if (uncertain) return new AppError('服务暂时异常，无法确认生成是否已受理；请核对服务商后台，勿直接重复生成。', true)
  if (status === 401) return new AppError('API 密钥无效或已失效，请在设置中重新配置。')
  if (['audio_format_unavailable', 'invalid_audio_format'].includes(code)) return new AppError('平台暂不支持 MP3 转换，请改选原始格式并重新确认生成；本次未自动重发。')
  if (status === 402 || ['insufficient_quota', 'insufficient_balance', 'quota_exceeded'].includes(code)) {
    return new AppError('服务商余额或额度不足，请检查账户余额和额度。')
  }
  if (['model_not_found', 'model_not_available', 'model_access_denied', 'unsupported_model', 'invalid_model'].includes(code)) {
    return new AppError('当前账户无权使用所选模型，或模型暂不可用；请检查模型权限。')
  }
  if (status === 403) return new AppError('当前密钥没有访问权限，请检查账户、项目和模型权限。')
  if (status === 429) return new AppError('请求过于频繁或额度受限，请稍后重试并检查额度。')
  if (status === 404 || status === 410) return new AppError('任务或音频不存在、已过期，请核对原服务与任务记录。')
  if (status >= 500) return new AppError('服务商暂时不可用，请稍后重试。')
  if (status >= 300 && status < 400) return new AppError('服务返回了不安全的跳转，已停止请求。', post)
  return new AppError('服务拒绝了请求，请检查生成参数及账户权限。')
}

export function malformedResponse(post: boolean): AppError {
  return new AppError(post
    ? '生成响应不完整，无法确认是否已受理；请核对服务商后台，勿直接重复生成。'
    : '服务返回的数据格式不正确，请稍后再查询。', post)
}

export type RequestOperation = 'create' | 'read'
export interface JsonRequestOptions {
  method: 'GET' | 'POST'
  timeoutMs: number
  body?: unknown
  maxBytes?: number
  operation?: RequestOperation
  signal?: AbortSignal
}
export type CloudProvider = 'mureka' | 'mureka-cn' | 'siliconflow' | 'kie' | 'reapi' | 'sunor'
const origins: Record<CloudProvider, string> = {
  ...MUREKA_ORIGINS, siliconflow: 'https://api.siliconflow.cn',
  kie: 'https://api.kie.ai', reapi: 'https://reapi.ai', sunor: 'https://sunor.cc'
}
interface RequestOptions extends JsonRequestOptions { key: string; provider?: CloudProvider }

/** Retry-After is a minimum delay, never clamped down to an earlier retry. */
export function retryDelay(value: string | null, attempt: number): number {
  const fallback = 300 * (attempt + 1)
  if (!value || value.length > 100) return fallback
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(milliseconds) ? Math.max(fallback, milliseconds) : fallback
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new TransportError('aborted')
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new TransportError('aborted')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Internal bounded JSON engine; callers must validate origin, route and auth first. */
export async function requestBoundedJson(fetcher: typeof fetch, url: string, options: JsonRequestOptions, headers: Record<string, string>, failure = statusError): Promise<unknown> {
  if (options.signal?.aborted) throw new AppError('请求已停止，未发送新请求。')
  const create = options.operation === 'create' || (options.method === 'POST' && options.operation !== 'read')
  const deadline = Date.now() + options.timeoutMs
  for (let attempt = 0; attempt < (create ? 1 : 3); attempt++) {
    try {
      const remaining = deadline - Date.now()
      if (remaining <= 0 || options.signal?.aborted) throw new TransportError('aborted')
      const outcome = await withTimeout(remaining, async (signal) => {
        let response: Response
        try {
          response = await fetcher(url, {
            method: options.method,
            headers: { ...headers, Accept: 'application/json', ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            body: options.method === 'POST' ? JSON.stringify(options.body) : undefined,
            redirect: 'error', credentials: 'omit', signal
          })
        } catch { throw new TransportError('network') }
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined)
          throw new TransportError('aborted')
        }
        if (!response.ok) {
          let details: unknown
          try { details = JSON.parse((await readLimited(response, 64 * 1024, signal)).toString('utf8')) } catch { /* Never expose remote text. */ }
          return { error: failure(response.status, details, create), retry: response.status === 429 || response.status >= 500, delay: retryDelay(response.headers.get('retry-after'), attempt) }
        }
        let bytes: Buffer
        try { bytes = await readLimited(response, options.maxBytes ?? 2 * 1024 * 1024, signal) } catch (error) {
          if (error instanceof TransportError) throw error
          throw malformedResponse(create)
        }
        try { return { data: JSON.parse(bytes.toString('utf8')) as unknown } } catch { throw malformedResponse(create) }
      }, options.signal)
      if ('error' in outcome) {
        if (!create && outcome.retry && attempt < 2 && deadline - Date.now() > outcome.delay) {
          await abortableDelay(outcome.delay, options.signal)
          continue
        }
        throw outcome.error
      }
      return outcome.data
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      if (!create && !options.signal?.aborted && attempt < 2 && deadline - Date.now() > 300 * (attempt + 1)) {
        try { await abortableDelay(300 * (attempt + 1), options.signal) } catch { throw new AppError('请求已停止，可稍后继续查询原任务。') }
        continue
      }
      throw new AppError(create
        ? '连接中断或请求超时，无法确认生成是否已受理；请核对服务商后台，勿直接重复生成。'
        : options.signal?.aborted ? '请求已停止，可稍后继续查询原任务。' : '连接失败或请求超时，请检查网络后重试。', create)
    }
  }
  throw new AppError('服务暂时不可用，请稍后重试。')
}

/** Provider-bound origins/auth; generation POSTs can never opt into retries. */
export async function requestJson(fetcher: typeof fetch, url: string, options: RequestOptions): Promise<unknown> {
  let target: URL
  try { target = new URL(url) } catch { throw new AppError('不允许访问非官方 API 地址。') }
  const allowed = options.provider ? [origins[options.provider]] : [origins.mureka, origins.siliconflow]
  if (!allowed.includes(target.origin) || target.username || target.password || target.hash) throw new AppError('不允许访问非官方 API 地址。')
  const key = (options.provider ? providerKeySchema(options.provider) : keySchema).safeParse(options.key)
  if (!key.success) throw new AppError('API 密钥格式不正确，请重新配置。')
  const headers: Record<string, string> = options.provider === 'sunor' ? { 'x-api-key': key.data } : { Authorization: `Bearer ${key.data}` }
  return requestBoundedJson(fetcher, target.href, { ...options, operation: options.method === 'POST' ? 'create' : 'read' }, headers)
}
