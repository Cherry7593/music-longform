import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { aceStepAddressSchema } from '../../shared/music-schemas'
import type { MusicConnection } from '../../shared/music-types'
import { AppError, malformedResponse, requestBoundedJson, statusError, TransportError } from './http'

const AUDIO_LIMIT = 1024 * 1024 * 1024
export function localBaseURL(connection: MusicConnection): string {
  const parsed = aceStepAddressSchema.safeParse(connection.baseUrl ?? 'http://127.0.0.1:8001')
  if (!parsed.success) throw new AppError('ACE-Step 地址无效，请填写已确认的环回或私有 IP 服务根地址。')
  return parsed.data
}
function authHeaders(connection: MusicConnection): Record<string, string> {
  if (connection.key === undefined) return {}
  if (connection.key.length < 1 || connection.key.length > 4096 || !/^[\x20-\x7E]+$/.test(connection.key)) throw new AppError('ACE-Step 密钥须为 1–4096 个可打印 ASCII 字符，不含控制字符。')
  return { Authorization: `Bearer ${connection.key}` }
}

/** Only an exact audio route and one opaque server path. Never reads the client filesystem. */
export function normalizeLocalAudioURL(connection: MusicConnection, value: string): string {
  const base = localBaseURL(connection)
  try {
    if (value.length > 8192 || /[\\\s\x00-\x1F\x7F]/.test(value) ||
        !(value.startsWith('/v1/audio?') || /^https?:\/\/[^/?#]+\/v1\/audio\?/.test(value))) throw new Error()
    const url = new URL(value, base)
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    const params = [...url.searchParams]
    if (url.origin !== base || url.username || url.password || url.hash || url.pathname !== '/v1/audio' ||
        params.length !== 1 || params[0][0] !== 'path' || !params[0][1] || /[\x00-\x1F\x7F]/.test(params[0][1])) throw new Error()
    return url.href
  } catch { throw new AppError('ACE-Step 返回了不安全的音频地址；只允许原服务的 /v1/audio?path=...。') }
}

/** Direct IP sockets: no DNS gateway, system proxy, redirect following, or TLS override. */
const directLocalFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init?.method ?? 'GET', headers, signal: init?.signal ?? undefined,
      agent: false, maxHeaderSize: 16 * 1024, ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {})
    }, response => {
      clearTimeout(timer)
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const status = response.statusCode ?? 502
      if (status < 200 || status > 599) { response.destroy(); reject(new TransportError('invalid status')); return }
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return }
      const stream = Readable.toWeb(response, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>
      resolve(new Response(stream, { status, headers: responseHeaders }))
    })
    // Header/connection deadline only. The caller's signal continues to own the body afterward.
    const timer = setTimeout(() => request.destroy(new TransportError('timeout')), 30_000)
    request.once('error', () => { clearTimeout(timer); reject(new TransportError('local network')) })
    request.end(typeof init?.body === 'string' ? init.body : undefined)
  })
}

function localStatusError(status: number, data: unknown, create: boolean): AppError {
  if (status === 429) return new AppError('ACE-Step 队列已满或查询过快，请稍后查询；未自动重新生成。')
  if (status === 404 || status === 410) return new AppError('ACE-Step 任务或音频不存在、已过期，请确认原服务仍在运行及 API 端口正确。')
  return statusError(status, data, create)
}

export async function requestLocalJson(fetcher: typeof fetch, connection: MusicConnection, route: '/health' | '/v1/models' | '/release_task' | '/query_result', body?: unknown): Promise<unknown> {
  const base = localBaseURL(connection)
  const headers = authHeaders(connection)
  if (!['/health', '/v1/models', '/release_task', '/query_result'].includes(route)) throw new AppError('不允许调用 ACE-Step 管理或其他接口。')
  const post = route === '/release_task' || route === '/query_result'
  try {
    return await requestBoundedJson(fetcher === fetch ? directLocalFetch : fetcher, base + route, {
      method: post ? 'POST' : 'GET', operation: route === '/release_task' ? 'create' : 'read',
      timeoutMs: route === '/release_task' ? 60_000 : 30_000, body: post ? body : undefined, signal: connection.signal
    }, headers, localStatusError)
  } catch (error) {
    if (error instanceof AppError) {
      if (error.uncertain) throw new AppError('ACE-Step 连接中断或生成响应异常，无法确认是否已受理；请核对原服务，勿重复生成。', true)
      if (error.message === malformedResponse(false).message) throw new AppError('ACE-Step 响应不符合官方 REST API，请确认填写的是 API 端口而非网页端口，并检查服务版本。')
      if (error.message === '连接失败或请求超时，请检查网络后重试。') throw new AppError('ACE-Step 连接失败或超时，请检查服务是否运行、API 端口及 HTTPS 证书后继续查询。')
      throw error
    }
    throw new AppError('ACE-Step 连接失败，请检查服务是否运行、API 端口及 HTTPS 证书。', route === '/release_task')
  }
}

/** Stream-preserving download. No success-finally abort: audio may still be arriving. */
export async function fetchLocalAudio(connection: MusicConnection, url: string): Promise<Response> {
  const target = normalizeLocalAudioURL(connection, url)
  const headers = authHeaders(connection)
  if (connection.signal?.aborted) throw new AppError('音频下载已停止，可稍后恢复。')
  let response: Response
  try {
    response = await directLocalFetch(target, { method: 'GET', headers, signal: connection.signal, redirect: 'error', credentials: 'omit' })
  } catch { throw new AppError('ACE-Step 音频连接失败或已停止，请检查原服务、API 端口及证书后恢复下载。') }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw localStatusError(response.status, undefined, false)
  }
  if (Number(response.headers.get('content-length') ?? 0) > AUDIO_LIMIT) {
    void response.body?.cancel().catch(() => undefined)
    throw new AppError('音频超过 1 GiB 上限，已停止接收。')
  }
  if (!response.body) throw new AppError('ACE-Step 返回了空音频，请查询原任务结果。')
  let size = 0
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength
      if (size > AUDIO_LIMIT) throw new AppError('音频超过 1 GiB 上限，已停止接收。')
      controller.enqueue(chunk)
    }
  }), { signal: connection.signal })
  return new Response(body, { status: response.status, headers: response.headers })
}
