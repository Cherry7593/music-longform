import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultMusicDraft } from '../../src/shared/music-capabilities'
import { fetchLocalAudio, localBaseURL, normalizeLocalAudioURL, requestLocalJson } from '../../src/main/providers/local-http'
import { requestJson, retryDelay, safeError } from '../../src/main/providers/http'
import { AceStepMusicAdapter } from '../../src/main/providers/acestep-music'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { MurekaProvider } from '../../src/main/providers/mureka'

const local = { baseUrl: 'http://localhost:8001', key: 'x' }
const key = 'sk-synthetic-unit-test-key'
const servers: Server[] = []
const mockFetch = () => vi.fn<typeof fetch>()
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener failed')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
})

describe('restricted local origin and audio locator', () => {
  it('canonicalizes localhost, permits only the shared local address policy', () => {
    expect(localBaseURL(local)).toBe('http://127.0.0.1:8001')
    for (const baseUrl of ['http://127.0.0.1:8001', 'https://192.168.1.5:8001', 'http://10.1.2.3', 'http://172.16.2.3', 'http://[::1]:8001', 'http://[fd00::1]:8001']) expect(localBaseURL({ baseUrl })).toBe(new URL(baseUrl).origin)
  })
  it.each(['https://example.com', 'http://169.254.169.254', 'http://8.8.8.8', 'http://172.32.0.1', 'http://192.168.1.255', 'http://127.0.0.1/path', 'http://127.0.0.1?key=x', 'http://127.0.0.1#path', 'http://user:pass@127.0.0.1', 'file:///tmp/audio', 'http://127.1', 'http://2130706433', 'http://[fe80::1]', 'http://127.0.0.1:0'])('rejects unsafe service root %s without network', async baseUrl => {
    const fetcher = mockFetch()
    await expect(requestLocalJson(fetcher, { baseUrl }, '/health')).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('accepts exact same-origin audio paths with percent-encoded Chinese server paths', () => {
    const path = encodeURIComponent('C:\\server\\音频.flac')
    expect(normalizeLocalAudioURL(local, `/v1/audio?path=${path}`)).toBe(`http://127.0.0.1:8001/v1/audio?path=${path}`)
    expect(normalizeLocalAudioURL(local, `http://localhost:8001/v1/audio?path=${path}`)).toBe(`http://127.0.0.1:8001/v1/audio?path=${path}`)
  })
  it.each(['C:\\server\\secret.flac', 'file:///etc/passwd', '/tmp/secret', '//evil.example/v1/audio?path=x', 'http://127.0.0.1:9000/v1/audio?path=x', 'https://evil.example/v1/audio?path=x', 'http://user:pass@127.0.0.1:8001/v1/audio?path=x', '/v1/audio?path=x&key=y', '/v1/audio?path=x&path=y', '/v1/audio?path=', '/v1/audio?path=x#fragment', '/v1/audio/?path=x', '/v1/admin?path=x', '/other/../v1/audio?path=x', '/v1/audio?path=%00', '/v1/audio?path=x\n'])('rejects unsafe audio locator %s', url => {
    expect(() => normalizeLocalAudioURL(local, url)).toThrow('音频地址')
  })
  it.each([undefined, 'x', 'test key', 'x'.repeat(4096)])('local key validates independently of cloud key length', async key => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ ok: true }))
    await requestLocalJson(fetcher, { ...local, key }, '/health')
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
    expect(headers.get('authorization')).toBe(key === undefined ? null : `Bearer ${key}`)
  })
  it.each(['', 'x'.repeat(4097), 'x\nkey', '中文', '\t', '\u007F'])('rejects invalid local keys before connecting', async key => {
    const fetcher = mockFetch()
    await expect(requestLocalJson(fetcher, { ...local, key }, '/health')).rejects.toThrow('密钥')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cannot call model-init, filesystem or other admin routes', async () => {
    const fetcher = mockFetch()
    await expect(requestLocalJson(fetcher, local, '/v1/init' as '/health', {})).rejects.toThrow('管理')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('operation-aware retries and cancellation', () => {
  it('retries read-only ACE query POST with Retry-After but sends generation POST only once', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json({ code: 200, data: [] }))
    const pending = requestLocalJson(fetcher, local, '/query_result', { task_id_list: ['id'] })
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(600)
    expect(await pending).toEqual({ code: 200, data: [] })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true)
    const generation = mockFetch().mockResolvedValue(Response.json({}, { status: 503 }))
    await expect(requestLocalJson(generation, local, '/release_task', {})).rejects.toMatchObject({ uncertain: true })
    expect(generation).toHaveBeenCalledTimes(1)
  })
  it('honors HTTP-date Retry-After and refuses to retry earlier when the deadline is shorter', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
    expect(retryDelay('Sun, 04 Oct 2026 12:00:05 GMT', 0)).toBe(5000)
    const fetcher = mockFetch().mockResolvedValue(Response.json({}, { status: 429, headers: { 'retry-after': '3600' } }))
    await expect(requestJson(fetcher, 'https://reapi.ai/api/v1/balance', { provider: 'reapi', method: 'GET', key, timeoutMs: 1000 })).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('aborts retry waits immediately and never retries after shutdown', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetcher = mockFetch().mockResolvedValue(Response.json({}, { status: 429, headers: { 'retry-after': '10' } }))
    const assertion = expect(requestLocalJson(fetcher, { ...local, signal: controller.signal }, '/query_result', {})).rejects.toThrow('停止')
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await assertion
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('pre-aborted creation is known not sent; in-flight aborted creation is uncertain', async () => {
    const cancelled = new AbortController(); cancelled.abort()
    const unused = mockFetch()
    await expect(requestLocalJson(unused, { ...local, signal: cancelled.signal }, '/release_task', {})).rejects.toMatchObject({ uncertain: false })
    expect(unused).not.toHaveBeenCalled()
    const controller = new AbortController()
    const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
    const assertion = expect(requestLocalJson(fetcher, { ...local, signal: controller.signal }, '/release_task', {})).rejects.toMatchObject({ uncertain: true })
    controller.abort()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('bounds local POST/query response time and body bytes even with an abort-ignoring injected fetch', async () => {
    vi.useFakeTimers()
    for (const route of ['/query_result', '/release_task'] as const) {
      const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
      const assertion = expect(requestLocalJson(fetcher, local, route, {})).rejects.toMatchObject({ uncertain: route === '/release_task' })
      await vi.advanceTimersByTimeAsync(route === '/release_task' ? 60_000 : 30_000)
      await assertion
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const oversized = mockFetch().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    await expect(requestLocalJson(oversized, local, '/release_task', {})).rejects.toMatchObject({ uncertain: true })
    expect(oversized).toHaveBeenCalledTimes(1)
  })
  it('caps repeated local read failures at three, sanitizes errors, and never retries malformed JSON or 401', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockRejectedValue(new Error(key))
    const failure = requestLocalJson(fetcher, local, '/query_result', {}).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(safeError(await failure)).not.toContain(key)
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const response of [new Response('not json'), Response.json({ detail: key }, { status: 401 })]) {
      const malformed = mockFetch().mockResolvedValue(response)
      await expect(requestLocalJson(malformed, local, '/query_result', {})).rejects.toMatchObject({ uncertain: false })
      expect(malformed).toHaveBeenCalledTimes(1)
    }
  })
  it('forwards shutdown abort through the unchanged Mureka bridge', async () => {
    const controller = new AbortController()
    const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
    const registry = new MusicRegistry(new MurekaProvider(fetcher))
    const assertion = expect(registry.get('mureka').create({ ...defaultMusicDraft(), prompt: 'piano' }, { key, signal: controller.signal })).rejects.toMatchObject({ uncertain: true })
    controller.abort()
    await assertion
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('real TCP local transport (synthetic protocol, NOT model inference)', () => {
  it('carries auth through health/models/create/query/download; response body remains readable after headers', async () => {
    const seen: string[] = []
    const bytes = Buffer.from('fLaCsynthetic-stream-test-only')
    const serverPath = 'C:\\server\\中文音频.flac'
    const baseUrl = await serve((req, res) => {
      seen.push(`${req.method} ${new URL(req.url!, 'http://localhost').pathname}`)
      if (req.headers.authorization !== 'Bearer x') { res.writeHead(401).end(); return }
      const json = (data: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 200, data })) }
      if (req.url === '/health') json({ status: 'ok', service: 'ACE-Step API', models_initialized: false })
      else if (req.url === '/v1/models') json({ models: [{ name: 'acestep-v15-turbo', is_default: true, is_loaded: false, supported_task_types: ['text2music'] }], default_model: 'acestep-v15-turbo', llm_initialized: false })
      else if (req.url === '/release_task') {
        let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
          expect(JSON.parse(body)).toMatchObject({ thinking: false, use_cot_caption: false, use_cot_language: false, batch_size: 1 })
          json({ task_id: 'tcp-task', status: 'queued' })
        })
      } else if (req.url === '/query_result') json([{ task_id: 'tcp-task', status: 1, result: JSON.stringify([{ file: `/v1/audio?path=${encodeURIComponent(serverPath)}`, metas: { duration: 10 } }]) }])
      else if (new URL(req.url!, 'http://localhost').pathname === '/v1/audio') {
        expect(new URL(req.url!, 'http://localhost').searchParams.get('path')).toBe(serverPath)
        res.writeHead(200, { 'content-type': 'audio/flac' }); res.write(bytes.subarray(0, 4))
        setTimeout(() => res.end(bytes.subarray(4)), 40)
      } else res.writeHead(404).end()
    })
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
    const adapter = new AceStepMusicAdapter()
    const connection = { baseUrl, key: 'x', signal: new AbortController().signal }
    const draft = { ...defaultMusicDraft('acestep'), prompt: 'synthetic TCP test', seconds: 10 }
    const task = await adapter.create(draft, connection)
    const complete = await adapter.query(draft, task.id, connection)
    const response = await fetchLocalAudio(connection, complete.choices![0].url)
    expect(response.body).not.toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(seen).toEqual(['GET /health', 'GET /v1/models', 'POST /release_task', 'POST /query_result', 'GET /v1/audio'])
  })
  it('the caller signal aborts a hanging audio body AFTER successful response headers', async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'audio/flac' }); res.write('fLaC') })
    const controller = new AbortController()
    const response = await fetchLocalAudio({ baseUrl, signal: controller.signal }, '/v1/audio?path=x')
    const reading = expect(response.arrayBuffer()).rejects.toThrow()
    controller.abort()
    await reading
  })
  it('does not forward credentials through redirects, including same-origin redirects', async () => {
    const stolen = vi.fn()
    const evil = await serve((req, res) => { stolen(req.headers.authorization); res.end('unexpected') })
    for (const location of [`${evil}/v1/audio?path=x`, '/v1/audio?path=other']) {
      let hits = 0
      const baseUrl = await serve((_req, res) => { hits++; res.writeHead(302, { location }).end() })
      await expect(fetchLocalAudio({ baseUrl, key: 'x' }, '/v1/audio?path=x')).rejects.toThrow('跳转')
      expect(hits).toBe(1); expect(stolen).not.toHaveBeenCalled()
    }
  })
  it.each([401, 403, 404, 410])('rejects HTTP %s audio responses without leaking server text', async status => {
    const baseUrl = await serve((_req, res) => { res.writeHead(status).end(key) })
    const error = await fetchLocalAudio({ baseUrl }, '/v1/audio?path=x').catch((error: unknown) => error)
    expect(safeError(error)).not.toContain(key)
    expect(error).toMatchObject({ uncertain: false })
  })
  it('rejects oversized audio from headers without reading it into memory', async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(200, { 'content-length': String(1024 * 1024 * 1024 + 1) }); res.flushHeaders() })
    await expect(fetchLocalAudio({ baseUrl }, '/v1/audio?path=x')).rejects.toThrow('1 GiB')
  })
})
