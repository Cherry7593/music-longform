import { z } from 'zod'
import { keySchema } from '../../shared/schemas'

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

export async function withTimeout<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TransportError('timeout'))
    }, milliseconds)
  })
  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
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
  code: z.union([z.string(), z.number()]).optional(),
  error: z.object({ code: z.string().nullable().optional(), type: z.string().optional() }).optional()
})

function statusError(status: number, data: unknown, post: boolean): AppError {
  const parsed = errorCodeSchema.safeParse(data)
  const code = parsed.success ? String(parsed.data.error?.code ?? parsed.data.error?.type ?? parsed.data.code ?? '') : ''
  const uncertain = post && status >= 500
  if (uncertain) return new AppError('服务暂时异常，无法确认生成是否已受理；请核对服务商后台，勿直接重复生成。', true)
  if (status === 401) return new AppError('API 密钥无效或已失效，请在设置中重新配置。')
  if (status === 402 || ['insufficient_quota', 'insufficient_balance', 'quota_exceeded'].includes(code)) {
    return new AppError('服务商余额或额度不足，请检查账户余额和额度。')
  }
  if (['model_not_found', 'model_not_available', 'model_access_denied', 'unsupported_model', 'invalid_model'].includes(code)) {
    return new AppError('当前账户无权使用所选模型，或模型暂不可用；请检查模型权限。')
  }
  if (status === 403) return new AppError('当前密钥没有访问权限，请检查账户、项目和模型权限。')
  if (status === 429) return new AppError('请求过于频繁或额度受限，请稍后重试并检查额度。')
  if (status >= 500) return new AppError('服务商暂时不可用，请稍后重试。')
  if (status >= 300 && status < 400) return new AppError('服务返回了不安全的跳转，已停止请求。', post)
  return new AppError('服务拒绝了请求，请检查生成参数及账户权限。')
}

export function malformedResponse(post: boolean): AppError {
  return new AppError(post
    ? '生成响应不完整，无法确认是否已受理；请核对服务商后台，勿直接重复生成。'
    : '服务返回的数据格式不正确，请稍后再查询。', post)
}

interface RequestOptions {
  method: 'GET' | 'POST'
  key: string
  timeoutMs: number
  body?: unknown
  maxBytes?: number
}

/** Fixed origins, no redirects, and never more than one billable POST. */
export async function requestJson(fetcher: typeof fetch, url: string, options: RequestOptions): Promise<unknown> {
  const target = new URL(url)
  if (!['https://api.mureka.ai', 'https://api.siliconflow.cn'].includes(target.origin) || target.username || target.password) {
    throw new AppError('不允许访问非官方 API 地址。')
  }
  const key = keySchema.safeParse(options.key)
  if (!key.success) throw new AppError('API 密钥格式不正确，请重新配置。')
  const post = options.method === 'POST'
  const deadline = Date.now() + options.timeoutMs
  for (let attempt = 0; attempt < (post ? 1 : 3); attempt++) {
    try {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new TransportError('timeout')
      const outcome = await withTimeout(remaining, async (signal) => {
        let response: Response
        try {
          response = await fetcher(target.href, {
            method: options.method,
            headers: { Authorization: `Bearer ${key.data}`, Accept: 'application/json', ...(post ? { 'Content-Type': 'application/json' } : {}) },
            body: post ? JSON.stringify(options.body) : undefined,
            redirect: 'error', credentials: 'omit', signal
          })
        } catch {
          throw new TransportError('network')
        }
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined)
          throw new TransportError('timeout')
        }
        if (!response.ok) {
          // Error messages are never copied out; only allowlisted machine codes are examined.
          let details: unknown
          try { details = JSON.parse((await readLimited(response, 64 * 1024, signal)).toString('utf8')) } catch { /* Status is sufficient. */ }
          return { error: statusError(response.status, details, post), retry: response.status === 429 || response.status >= 500 }
        }
        let bytes: Buffer
        try { bytes = await readLimited(response, options.maxBytes ?? 2 * 1024 * 1024, signal) } catch (error) {
          if (error instanceof TransportError) throw error
          throw malformedResponse(post)
        }
        try { return { data: JSON.parse(bytes.toString('utf8')) as unknown } } catch { throw malformedResponse(post) }
      })
      if ('error' in outcome) {
        if (!post && outcome.retry && attempt < 2 && deadline - Date.now() > 300 * (attempt + 1)) {
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
          continue
        }
        throw outcome.error
      }
      return outcome.data
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      if (!post && attempt < 2 && deadline - Date.now() > 300 * (attempt + 1)) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
        continue
      }
      throw new AppError(post
        ? '连接中断或请求超时，无法确认生成是否已受理；请核对服务商后台，勿直接重复生成。'
        : '连接失败或请求超时，请检查网络后重试。', post)
    }
  }
  throw new AppError('服务暂时不可用，请稍后重试。')
}
