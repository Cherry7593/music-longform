import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE, DEFAULT_MUSIC } from '../../src/shared/schemas'
import type { ImageDraft, MusicDraft } from '../../src/shared/types'
import { AppError, requestJson, safeError } from '../../src/main/providers/http'
import { MurekaProvider } from '../../src/main/providers/mureka'
import { SiliconFlowImagesProvider } from '../../src/main/providers/siliconflow-images'

const key = 'sk-unit-test-not-a-real-key'
const task = { id: '12345678901234567890', model: 'mureka-9.5', status: 'queued' }
const music = (): MusicDraft => ({ ...DEFAULT_MUSIC, styles: [], prompt: '  安静的钢琴  ', count: 20 })
const image = (): ImageDraft => ({ ...DEFAULT_IMAGE, prompt: '  海边日落  ' })
const imageURL = 'https://cdn.example.com/generated.jpg?signature=fixture'
const mockFetch = () => vi.fn<typeof fetch>()

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('MurekaProvider', () => {
  it('submits exactly one instrumental with trimmed prompt and the fixed official endpoint', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(task))
    expect(await new MurekaProvider(fetcher).create(music(), key)).toEqual(task)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.mureka.ai/v1/instrumental/generate')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'auto', prompt: '安静的钢琴', n: 1, stream: false })
  })

  it('uses easy-generate for songs and only includes supplied styles', async () => {
    const fetcher = mockFetch().mockImplementation(async () => Response.json(task))
    const provider = new MurekaProvider(fetcher)
    await provider.create({ ...music(), mode: 'song', model: 'mureka-o2', styles: ['jazz', 'pop'] }, key)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.mureka.ai/v1/song/easy-generate')
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ model: 'mureka-o2', prompt: '安静的钢琴', styles: ['jazz', 'pop'], n: 1, stream: false })
    await provider.create({ ...music(), mode: 'song' }, key)
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).not.toHaveProperty('styles')
  })

  it.each([
    { prompt: '   ' }, { prompt: 'x'.repeat(1025) }, { model: 'mureka-o2' }, { count: 0 }, { count: 21 },
    { styles: ['unsupported'] }, { model: 'unknown' }, { prompt: 'x'.repeat(2001), mode: 'song' }, { extra: 'not allowed' }
  ])('rejects invalid music parameters before contacting the provider: %j', async (patch) => {
    const fetcher = mockFetch()
    await expect(new MurekaProvider(fetcher).create({ ...music(), ...patch } as MusicDraft, key)).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allows a 2000-character song prompt and rejects an invalid API key locally', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(task))
    const provider = new MurekaProvider(fetcher)
    await provider.create({ ...music(), mode: 'song', prompt: 'x'.repeat(2000) }, key)
    await expect(provider.create(music(), 'bad\nkey')).rejects.toThrow('密钥')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['preparing', 'queued', 'running', 'streaming', 'succeeded', 'failed', 'timeouted', 'cancelled'])('validates query status %s and preserves milliseconds', async (status) => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ ...task, status, failed_reason: `diagnostic ${key}`, choices: [{ id: '123_abc-5', url: 'https://cdn.example.com/audio.mp3', duration: 123456 }] }))
    const result = await new MurekaProvider(fetcher).query('song', task.id, key)
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.mureka.ai/v1/song/query/${task.id}`)
    expect(result.status).toBe(status)
    expect(result.choices?.[0].duration).toBe(123456)
    expect(result.failed_reason).not.toContain(key)
  })

  it.each(['../secret', '123?secret', 'a/b', '', 'x'.repeat(151)])('rejects unsafe task id %s without requesting', async (id) => {
    const fetcher = mockFetch()
    await expect(new MurekaProvider(fetcher).query('instrumental', id, key)).rejects.toThrow('标识')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([{ id: '123' }, { ...task, id: 123 }, { ...task, status: 'new-status' }, { ...task, choices: [{ id: 'a', url: 'bad', duration: -1 }] }])('treats malformed successful create JSON as uncertain: %j', async (body) => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(body))
    await expect(new MurekaProvider(fetcher).create(music(), key)).rejects.toMatchObject({ uncertain: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not retry invalid JSON or oversized successful POST responses', async () => {
    for (const response of [new Response('<html>'), new Response('{}', { headers: { 'content-length': '99999999' } })]) {
      const fetcher = mockFetch().mockResolvedValue(response)
      await expect(new MurekaProvider(fetcher).create(music(), key)).rejects.toMatchObject({ uncertain: true })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([500, 503, 504])('never retries HTTP %s during creation', async (status) => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ message: key }, { status }))
    const error = await new MurekaProvider(fetcher).create(music(), key).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ uncertain: true })
    expect(safeError(error)).not.toContain(key)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never retries POST transport failures or forwards credentials on redirects', async () => {
    for (const fetcher of [mockFetch().mockRejectedValue(new TypeError(key)), mockFetch().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/key' } }))]) {
      await expect(new MurekaProvider(fetcher).create(music(), key)).rejects.toMatchObject({ uncertain: true })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
    }
  })

  it('enforces the 60-second POST deadline even when an injected fetch ignores abort', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
    const assertion = expect(new MurekaProvider(fetcher).create(music(), key)).rejects.toMatchObject({ uncertain: true })
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it.each([
    [401, {}, '密钥'], [403, {}, '权限'], [402, {}, '余额'], [429, {}, '频繁'],
    [400, { error: { code: 'insufficient_quota', message: key } }, '额度'],
    [400, { error: { code: 'model_not_found', message: key } }, '模型']
  ] as const)('maps HTTP %s to a safe Chinese error without a POST retry', async (status, body, text) => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(body, { status }))
    const error = await new MurekaProvider(fetcher).create(music(), key).catch((error: unknown) => error)
    expect(error).toMatchObject({ uncertain: false })
    expect(safeError(error)).toContain(text)
    expect(safeError(error)).not.toContain(key)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries GET 429/5xx at most three times and returns cents unchanged', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockResolvedValueOnce(Response.json({}, { status: 429 }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json({ balance: 12345 }))
    const result = new MurekaProvider(fetcher).check(key)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ balanceCents: 12345 })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([url, init]) => url === 'https://api.mureka.ai/v1/account/billing' && init?.method === 'GET')).toBe(true)
  })

  it('caps network GET retries at three and sanitizes failures', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockRejectedValue(new Error(key))
    const assertion = expect(new MurekaProvider(fetcher).query('instrumental', task.id, key)).rejects.toMatchObject({ uncertain: false })
    await vi.runAllTimersAsync()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not retry GET 401, malformed JSON, or mismatched task IDs', async () => {
    for (const response of [Response.json({}, { status: 401 }), new Response('broken'), Response.json({ ...task, id: 'different' })]) {
      const fetcher = mockFetch().mockResolvedValue(response)
      await expect(new MurekaProvider(fetcher).query('instrumental', task.id, key)).rejects.toMatchObject({ uncertain: false })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([['check', 20_000], ['query', 30_000]] as const)('bounds %s by its total read-only deadline', async (method, timeout) => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
    const provider = new MurekaProvider(fetcher)
    const assertion = expect(method === 'check' ? provider.check(key) : provider.query('song', task.id, key)).rejects.toMatchObject({ uncertain: false })
    await vi.advanceTimersByTimeAsync(timeout)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('SiliconFlowImagesProvider', () => {
  it('sends one Qwen image request with only supported fields and preserves default watermark', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ images: [{ url: imageURL }] }))
    expect(await new SiliconFlowImagesProvider(fetcher).generate(image(), key)).toEqual({ url: imageURL, model: DEFAULT_IMAGE.model })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/images/generations')
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ model: 'Qwen/Qwen-Image', prompt: '海边日落', image_size: '1664x928', num_inference_steps: 50, cfg: 4 })
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
  })

  it.each([true, false])('checks model list read-only, availability=%s, without claiming generation permissions', async available => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ data: [{ id: available ? 'Qwen/Qwen-Image' : 'other-model' }] }))
    const result = await new SiliconFlowImagesProvider(fetcher).check(key)
    expect(result.message).toContain('未生成图片')
    expect(result.message).toContain(available ? '尚未验证' : '未包含')
    expect(fetcher.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/models?type=image&sub_type=text-to-image')
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([{ prompt: ' ' }, { model: 'gpt-image-2.5-flare' }, { size: '1536x864' }, { quality: 'high' }, { format: 'png' }, { batch_size: 2 }])('rejects unsupported and old OpenAI inputs %j', async patch => {
    const fetcher = mockFetch()
    await expect(new SiliconFlowImagesProvider(fetcher).generate({ ...image(), ...patch } as ImageDraft, key)).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([{}, { images: [] }, { data: [{ b64_json: 'ignored' }] }, { images: [{ url: 'bad url' }] }, { images: [{ url: imageURL }, { url: imageURL }] }])('does not replay malformed successful image responses %j', async body => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(body))
    await expect(new SiliconFlowImagesProvider(fetcher).generate(image(), key)).rejects.toMatchObject({ uncertain: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([401, 402, 403, 429, 500, 503, 504])('maps HTTP %s without leaking raw messages or replaying the POST', async status => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ message: key }, { status }))
    const failure = await new SiliconFlowImagesProvider(fetcher).generate(image(), key).catch((error: unknown) => error)
    expect(failure).toMatchObject({ uncertain: status >= 500 })
    expect(safeError(failure)).not.toContain(key)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not forward credentials on redirects or repeat a disconnected POST', async () => {
    for (const fetcher of [mockFetch().mockRejectedValue(new Error(key)), mockFetch().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/key' } }))]) {
      await expect(new SiliconFlowImagesProvider(fetcher).generate(image(), key)).rejects.toMatchObject({ uncertain: true })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
    }
  })

  it('never replays an image POST and enforces its 300-second deadline', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
    const assertion = expect(new SiliconFlowImagesProvider(fetcher).generate(image(), key)).rejects.toMatchObject({ uncertain: true })
    await vi.advanceTimersByTimeAsync(300_000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('cancels hanging bodies and refuses oversized response JSON', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetcher = mockFetch().mockResolvedValue(new Response(new ReadableStream({ cancel })))
    const assertion = expect(new SiliconFlowImagesProvider(fetcher).generate(image(), key)).rejects.toMatchObject({ uncertain: true })
    await vi.advanceTimersByTimeAsync(300_000)
    await assertion
    expect(cancel).toHaveBeenCalledTimes(1)
    const oversized = mockFetch().mockResolvedValue(new Response('{}', { headers: { 'content-length': '99999999' } }))
    await expect(new SiliconFlowImagesProvider(oversized).generate(image(), key)).rejects.toMatchObject({ uncertain: true })
    expect(oversized).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed or unauthorized model checks and invalid key format', async () => {
    for (const value of [new Response('{}'), Response.json({ data: [{}] }), new Response(null, { status: 401 })]) {
      const fetcher = mockFetch().mockResolvedValue(value)
      await expect(new SiliconFlowImagesProvider(fetcher).check(key)).rejects.toMatchObject({ uncertain: false })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const fetcher = mockFetch()
    await expect(new SiliconFlowImagesProvider(fetcher).generate(image(), 'bad\nkey')).rejects.toThrow('密钥')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects the removed OpenAI origin and custom proxies before sending any credentials', async () => {
    const fetcher = mockFetch()
    for (const url of ['https://api.openai.com/v1/images/generations', 'https://proxy.example.com/v1/images/generations', 'https://user:pass@api.siliconflow.cn/v1/models']) {
      await expect(requestJson(fetcher, url, { method: 'GET', key, timeoutMs: 100 })).rejects.toThrow('官方')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})

it('safeError never exposes arbitrary errors, headers, keys, or Zod diagnostics', () => {
  for (const error of [new Error(`Authorization Bearer ${key}`), { message: key }, key, undefined]) {
    expect(safeError(error)).not.toContain(key)
    expect(safeError(error)).toContain('操作失败')
  }
  expect(safeError(new AppError('已停止请求。'))).toBe('已停止请求。')
})
