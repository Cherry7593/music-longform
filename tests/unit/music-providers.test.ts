import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MusicAdapter, MusicDraft, MusicProviderId } from '../../src/shared/music-types'
import { defaultMusicDraft } from '../../src/shared/music-capabilities'
import { KieMusicAdapter } from '../../src/main/providers/kie-music'
import { ReapiMusicAdapter } from '../../src/main/providers/reapi-music'
import { SunorMusicAdapter } from '../../src/main/providers/sunor-music'
import { AceStepMusicAdapter } from '../../src/main/providers/acestep-music'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { MurekaProvider } from '../../src/main/providers/mureka'
import { requestJson, safeError } from '../../src/main/providers/http'

const key = 'sk-synthetic-fixture-not-real'
const id = 'task_fixture-123'
const urls = ['https://cdn.example.com/one.mp3', 'https://cdn.example.com/two.m4a']
const connection = { key }
const local = { key: 'x', baseUrl: 'http://localhost:8001' }
const draft = (provider: MusicProviderId, patch: Partial<MusicDraft> = {}): MusicDraft => ({ ...defaultMusicDraft(provider), prompt: '  安静钢琴  ', count: 20, ...patch })
const mockFetch = () => vi.fn<typeof fetch>()
const constructors = { kie: KieMusicAdapter, reapi: ReapiMusicAdapter, sunor: SunorMusicAdapter }
type Cloud = keyof typeof constructors
const creates = {
  kie: { code: 200, data: { taskId: id } },
  reapi: { id, status: 'processing', output: null },
  sunor: { code: 202, data: { task_id: id, status: 'pending' } }
}
function queued(provider: Cloud, state?: string, taskId = id): unknown {
  if (provider === 'kie') return { code: 200, data: { taskId, state: state ?? 'waiting', resultJson: null } }
  if (provider === 'reapi') return { id: taskId, status: state ?? 'processing', output: null }
  return { code: 200, data: { task_id: taskId, status: state ?? 'pending', output: null } }
}
const health = (initialized = false) => ({ code: 200, data: { status: 'ok', service: 'ACE-Step API', version: '1.0', models_initialized: initialized, llm_initialized: false } })
const inventory = (loaded = false, lm = false) => ({ code: 200, data: {
  models: [{ name: 'acestep-v15-turbo', is_default: true, is_loaded: loaded, supported_task_types: ['text2music'] }],
  default_model: 'acestep-v15-turbo', llm_initialized: lm, loaded_lm_model: lm ? 'acestep-5Hz-lm-0.6B' : null
} })
function aceFetch(loaded = false, lm = false) {
  return mockFetch().mockResolvedValueOnce(Response.json(health(loaded))).mockResolvedValueOnce(Response.json(inventory(loaded, lm)))
    .mockResolvedValueOnce(Response.json({ code: 200, data: { task_id: id, status: 'queued' } }))
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('cloud music wire contracts', () => {
  it.each(['kie', 'reapi', 'sunor'] as const)('%s fixes origin, auth and operation shape, ignoring a custom connection URL', async provider => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(creates[provider], { status: provider === 'sunor' ? 202 : 200 }))
    const result = await new constructors[provider](fetcher).create(draft(provider), { ...connection, baseUrl: 'http://127.0.0.1:1' })
    expect(result.id).toBe(id)
    const [url, init] = fetcher.mock.calls[0]
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    const headers = new Headers(init?.headers)
    expect(headers.get(provider === 'sunor' ? 'x-api-key' : 'authorization')).toBe(provider === 'sunor' ? key : `Bearer ${key}`)
    expect(headers.has(provider === 'sunor' ? 'authorization' : 'x-api-key')).toBe(false)
    const body = JSON.parse(init?.body as string)
    if (provider === 'kie') {
      expect(url).toBe('https://api.kie.ai/api/v1/jobs/createTask')
      expect(body).toEqual({ model: 'ai-music-api/generate', input: { custom_mode: true, instrumental: true, model: 'V6', style: '安静钢琴', title: '音乐生成', duration: 180 } })
    } else if (provider === 'reapi') {
      expect(url).toBe('https://reapi.ai/api/v1/audio/generations')
      expect(body).toEqual({ model: 'suno-music', version: 'V6', custom_mode: false, instrumental: true, prompt: '安静钢琴' })
    } else {
      expect(url).toBe('https://sunor.cc/api/v1/task')
      expect(body).toEqual({ model: 'suno', task_type: 'music', audio_format: 'mp3', input: { model_version: 'v6', make_instrumental: true, gpt_description_prompt: '安静钢琴' } })
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['kie', 'reapi', 'sunor'] as const)('%s keeps human lyrics separate from style and description', async provider => {
    const fetcher = mockFetch().mockResolvedValue(Response.json(creates[provider]))
    await new constructors[provider](fetcher).create(draft(provider, { mode: 'song', inputMode: 'lyrics', lyrics: '  [Verse]\n星光  ', title: ' 曲名 ', seconds: 90 }), connection)
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string)
    if (provider === 'kie') expect(body.input).toEqual({ custom_mode: true, instrumental: false, model: 'V6', style: '安静钢琴', title: '曲名', duration: 90, lyrics: '[Verse]\n星光' })
    if (provider === 'reapi') expect(body).toEqual({ model: 'suno-music', version: 'V6', custom_mode: true, instrumental: false, prompt: '[Verse]\n星光', style: '安静钢琴', title: '曲名', duration: 90 })
    if (provider === 'sunor') expect(body.input).toEqual({ model_version: 'v6', make_instrumental: false, prompt: '[Verse]\n星光', tags: '安静钢琴', title: '曲名' })
  })

  it.each(['V6', 'V6_MINI', 'V6_WILD'])('allows documented uppercase version %s only on Kie/reAPI', async model => {
    for (const provider of ['kie', 'reapi'] as const) {
      const fetcher = mockFetch().mockResolvedValue(Response.json(creates[provider]))
      await new constructors[provider](fetcher).create(draft(provider, { model }), connection)
      const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string)
      expect(provider === 'kie' ? body.input.model : body.version).toBe(model)
    }
  })

  it('reAPI custom instrumental omits lyrics and Sunor original omits conversion', async () => {
    const reapi = mockFetch().mockResolvedValue(Response.json(creates.reapi))
    await new ReapiMusicAdapter(reapi).create(draft('reapi', { inputMode: 'lyrics', lyrics: 'must not sing' }), connection)
    expect(JSON.parse(reapi.mock.calls[0][1]?.body as string)).not.toHaveProperty('prompt')
    const sunor = mockFetch().mockResolvedValue(Response.json(creates.sunor))
    await new SunorMusicAdapter(sunor).create(draft('sunor', { inputMode: 'lyrics', outputFormat: 'original', lyrics: 'must not sing' }), connection)
    expect(JSON.parse(sunor.mock.calls[0][1]?.body as string)).toEqual({ model: 'suno', task_type: 'music', input: { model_version: 'v6', make_instrumental: true, tags: '安静钢琴', title: '音乐生成' } })
  })

  it('Kie parses only code 200 and the documented resultJson/resultUrls envelope', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 200, data: { taskId: id, state: 'success', resultJson: JSON.stringify({ resultUrls: urls }) } }))
    expect((await new KieMusicAdapter(fetcher).query(draft('kie'), id, connection)).choices).toEqual(urls.map(url => ({ url })))
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${id}`)
    const bad = mockFetch().mockResolvedValue(Response.json({ code: 505, msg: 'success', data: { taskId: id } }))
    await expect(new KieMusicAdapter(bad).create(draft('kie'), connection)).rejects.toMatchObject({ uncertain: true })
    expect(bad).toHaveBeenCalledTimes(1)
  })

  it('reAPI returns all index-aligned tracks, optional metadata, and seconds as milliseconds', async () => {
    for (const output of [{ audio_urls: urls }, { tracks: urls.map(url => ({ url })) }, { audio_urls: urls, tracks: [{ url: urls[0], id: 'clip-1', title: 'Title', duration: 128.5 }, { url: urls[1] }] }]) {
      const fetcher = mockFetch().mockResolvedValue(Response.json({ id, status: 'completed', output }))
      const result = await new ReapiMusicAdapter(fetcher).query(draft('reapi'), id, connection)
      expect(result.choices?.map(choice => choice.url)).toEqual(urls)
      if ('audio_urls' in output && 'tracks' in output) expect(result.choices?.[0]).toEqual({ url: urls[0], remoteId: 'clip-1', title: 'Title', durationMs: 128500 })
      expect(fetcher.mock.calls[0][0]).toBe(`https://reapi.ai/api/v1/tasks/${id}`)
    }
  })

  it('Sunor parses nested clip metadata without guessing the requested MP3 encoding', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 200, data: { task_id: id, status: 'success', audio_format: 'mp3', output: { result: [{ audio_url: urls[0], id: 'clip-1', title: 'Title', metadata: { duration: 10.25 } }, { audio_url: urls[1] }] } } }))
    expect((await new SunorMusicAdapter(fetcher).query(draft('sunor'), id, connection)).choices).toEqual([{ url: urls[0], remoteId: 'clip-1', title: 'Title', durationMs: 10250 }, { url: urls[1] }])
    expect(fetcher.mock.calls[0][0]).toBe(`https://sunor.cc/api/v1/task/${id}`)
  })

  it('Sunor conversion rejection is actionable and never resubmits original automatically', async () => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 400, error_code: 'audio_format_unavailable', message: key }, { status: 400 }))
    await expect(new SunorMusicAdapter(fetcher).create(draft('sunor'), connection)).rejects.toThrow('原始格式')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['kie', 'reapi', 'sunor'] as const)('%s exposes sanitized task failures and rejects unknown status or mismatched identity', async provider => {
    const failedState = provider === 'kie' ? 'fail' : provider === 'sunor' ? 'failure' : 'failed'
    const failure = queued(provider, failedState)
    const fetcher = mockFetch().mockResolvedValue(Response.json({ ...(failure as object), message: key, error: key }))
    expect(await new constructors[provider](fetcher).query(draft(provider), id, connection)).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(await new constructors[provider](mockFetch().mockResolvedValue(Response.json(failure))).query(draft(provider), id, connection))).not.toContain(key)
    for (const data of [queued(provider, 'unknown'), queued(provider, undefined, 'wrong')]) {
      const bad = mockFetch().mockResolvedValue(Response.json(data))
      await expect(new constructors[provider](bad).query(draft(provider), id, connection)).rejects.toMatchObject({ uncertain: false })
      expect(bad).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['kie', 'reapi', 'sunor'] as const)('%s rejects malformed/oversized successful POSTs as uncertain without retry', async provider => {
    for (const response of [new Response('broken'), Response.json({ task_id: id }), new Response('{}', { headers: { 'content-length': '999999999' } })]) {
      const fetcher = mockFetch().mockResolvedValue(response)
      await expect(new constructors[provider](fetcher).create(draft(provider), connection)).rejects.toMatchObject({ uncertain: true })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['kie', 'reapi', 'sunor'] as const)('%s never retries generation HTTP errors or transport failures', async provider => {
    for (const status of [401, 402, 403, 429, 500, 503, 302]) {
      const fetcher = mockFetch().mockResolvedValue(Response.json({ message: key }, { status }))
      const error = await new constructors[provider](fetcher).create(draft(provider), connection).catch((error: unknown) => error)
      expect(error).toMatchObject({ uncertain: status >= 500 || status === 302 })
      expect(safeError(error)).not.toContain(key)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const fetcher = mockFetch().mockRejectedValue(new Error(key))
    await expect(new constructors[provider](fetcher).create(draft(provider), connection)).rejects.toMatchObject({ uncertain: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['kie', 'reapi', 'sunor'] as const)('%s validates strict input, song lyrics and task ids before network', async provider => {
    const fetcher = mockFetch()
    const adapter: MusicAdapter = new constructors[provider](fetcher)
    for (const patch of [{ prompt: ' ' }, { model: 'V4' }, { count: 0 }, { extra: 'disallowed' }, { prompt: 'x'.repeat(4001) }, { title: 'x'.repeat(81) }, { lyrics: 'x'.repeat(5001) }, { mode: 'song', inputMode: 'lyrics', lyrics: '' }]) {
      await expect(adapter.create(draft(provider, patch as Partial<MusicDraft>), connection)).rejects.toMatchObject({ uncertain: false })
    }
    for (const badId of ['', '../a', 'a?key=secret', 'a/b', 'x'.repeat(201)]) await expect(adapter.query(draft(provider), badId, connection)).rejects.toThrow('标识')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('each balance check is GET, uses the correct auth, and never calls credits cents', async () => {
    const fixtures = { kie: { body: { code: 200, data: 12.5 }, path: 'https://api.kie.ai/api/v1/chat/credit' }, reapi: { body: { balance: 123 }, path: 'https://reapi.ai/api/v1/balance' }, sunor: { body: { code: 200, data: { available: 50, frozen: 10 } }, path: 'https://sunor.cc/api/v1/account/balance' } }
    for (const provider of ['kie', 'reapi', 'sunor'] as const) {
      const fetcher = mockFetch().mockResolvedValue(Response.json(fixtures[provider].body))
      const result = await new constructors[provider](fetcher).check(connection)
      expect(result.message).toContain('积分')
      expect(result).not.toHaveProperty('balanceCents')
      expect(fetcher.mock.calls[0][0]).toBe(fixtures[provider].path)
      expect(fetcher.mock.calls[0][1]?.method).toBe('GET')
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('binds cloud credentials to distinct origins even within the registered set', async () => {
    const fetcher = mockFetch()
    for (const url of ['https://api.kie.ai/api/v1/jobs/createTask', 'http://reapi.ai/api/v1/balance', 'https://reapi.ai.evil.example/api/v1/balance']) {
      await expect(requestJson(fetcher, url, { provider: 'reapi', method: 'POST', key, timeoutMs: 100 })).rejects.toThrow('官方')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('ACE-Step pinned REST contract', () => {
  it('DiT-only allows delayed default init, omits model sentinel, and explicitly disables every lazy LM trigger', async () => {
    const fetcher = aceFetch()
    expect(await new AceStepMusicAdapter(fetcher).create(draft('acestep'), local)).toMatchObject({ id, status: 'queued' })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:8001/health', 'http://127.0.0.1:8001/v1/models', 'http://127.0.0.1:8001/release_task'])
    expect(fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer x')).toBe(true)
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toEqual({ task_type: 'text2music', batch_size: 1, audio_format: 'flac', audio_duration: 180, prompt: '安静钢琴', lyrics: '[Instrumental]', vocal_language: 'en', thinking: false, sample_mode: false, use_format: false, use_cot_caption: false, use_cot_language: false })
  })

  it('sends selected inventory model and independent lyrics in DiT-only song mode without auth when no key', async () => {
    const fetcher = aceFetch(true)
    await new AceStepMusicAdapter(fetcher).create(draft('acestep', { mode: 'song', lyrics: '[Verse]\n歌声', model: 'acestep-v15-turbo', language: 'zh', seconds: 10 }), { baseUrl: local.baseUrl })
    expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true)
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toMatchObject({ lyrics: '[Verse]\n歌声', model: 'acestep-v15-turbo', thinking: false, audio_duration: 10, vocal_language: 'zh' })
  })

  it('requires a ready LM for description or enhancement; never calls init/admin/random sample', async () => {
    for (const patch of [{ inputMode: 'description' as const }, { thinking: true }]) {
      const fetcher = aceFetch()
      await expect(new AceStepMusicAdapter(fetcher).create(draft('acestep', patch), local)).rejects.toThrow('语言模型')
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
    const fetcher = aceFetch(true, true)
    await new AceStepMusicAdapter(fetcher).create(draft('acestep', { mode: 'song', inputMode: 'description' }), local)
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toMatchObject({ sample_query: '安静钢琴', thinking: true, sample_mode: false, lyrics: '' })
  })

  it('rejects unavailable/non-text2music model selection before POST', async () => {
    for (const [selected, model] of [['missing', inventory()], ['acestep-other', { code: 200, data: { ...inventory().data, models: [...inventory().data.models, { name: 'acestep-other', is_loaded: false, is_default: false, supported_task_types: ['text2music'] }] } }], ['default', { code: 200, data: { ...inventory().data, models: [{ ...inventory().data.models[0], supported_task_types: ['cover'] }] } }]] as const) {
      const fetcher = mockFetch().mockResolvedValueOnce(Response.json(health())).mockResolvedValueOnce(Response.json(model))
      await expect(new AceStepMusicAdapter(fetcher).create(draft('acestep', { model: selected }), local)).rejects.toThrow('模型')
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  })

  it('reports inventory/load state without claiming that a health check generated music', async () => {
    const fetcher = aceFetch()
    const status = await new MusicRegistry(undefined, fetcher).getAceStepModels(local)
    expect(status).toMatchObject({ baseUrl: 'http://127.0.0.1:8001', modelsInitialized: false, llmInitialized: false, defaultModel: 'acestep-v15-turbo', models: [{ name: 'acestep-v15-turbo', isDefault: true, isLoaded: false }] })
    expect(status.message).toContain('延迟初始化')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([0, 1, 2] as const)('parses numeric query status %s and double-encoded results', async status => {
    const result = JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fmusic.flac', status: 1, metas: { duration: 10.5 } }])
    const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 200, data: [{ task_id: id, status, result, progress_text: key }] }))
    const task = await new AceStepMusicAdapter(fetcher).query(draft('acestep'), id, local)
    expect(task.status).toBe(status === 0 ? 'running' : status === 1 ? 'succeeded' : 'failed')
    if (status === 1) expect(task.choices).toEqual([{ url: 'http://127.0.0.1:8001/v1/audio?path=%2Ftmp%2Fmusic.flac', durationMs: 10500 }])
    expect(JSON.stringify(task)).not.toContain(key)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ task_id_list: [id] })
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
  })

  it.each(['[]', 'not JSON', JSON.stringify([{ file: 'C:\\Windows\\secret.flac' }]), JSON.stringify([{ file: 'http://127.0.0.1:9000/v1/audio?path=x' }])])('rejects empty, malformed or unsafe successful results: %s', async result => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 200, data: [{ task_id: id, status: 1, result }] }))
    await expect(new AceStepMusicAdapter(fetcher).query(draft('acestep'), id, local)).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown numeric status/mismatched ID and malformed creation without repeating a POST', async () => {
    for (const row of [{ task_id: id, status: 3, result: '[]' }, { task_id: 'different', status: 0, result: '[]' }]) {
      const fetcher = mockFetch().mockResolvedValue(Response.json({ code: 200, data: [row] }))
      await expect(new AceStepMusicAdapter(fetcher).query(draft('acestep'), id, local)).rejects.toMatchObject({ uncertain: false })
    }
    const fetcher = mockFetch().mockResolvedValueOnce(Response.json(health())).mockResolvedValueOnce(Response.json(inventory())).mockResolvedValueOnce(Response.json({ code: 200, data: {} }))
    await expect(new AceStepMusicAdapter(fetcher).create(draft('acestep'), local)).rejects.toMatchObject({ uncertain: true })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})

it('Mureka registry bridge preserves milliseconds and remote IDs without changing its wire request', async () => {
  const fetcher = mockFetch().mockResolvedValue(Response.json({ id, status: 'succeeded', choices: [{ id: 'choice-id', url: urls[0], duration: 123456 }] }))
  const adapter = new MusicRegistry(new MurekaProvider(fetcher)).get('mureka')
  expect((await adapter.create(draft('mureka'), connection)).choices).toEqual([{ remoteId: 'choice-id', url: urls[0], durationMs: 123456 }])
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ model: 'auto', prompt: '安静钢琴', n: 1, stream: false })
})

it.each(['kie', 'reapi', 'sunor'] as const)('%s has a total 60-second creation deadline and never replays a timed-out POST', async provider => {
  vi.useFakeTimers()
  const fetcher = mockFetch().mockImplementation(() => new Promise<Response>(() => undefined))
  const assertion = expect(new constructors[provider](fetcher).create(draft(provider), connection)).rejects.toMatchObject({ uncertain: true })
  await vi.advanceTimersByTimeAsync(60_000)
  await assertion
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([
  ['kie', 'waiting', 'queued'], ['kie', 'queuing', 'queued'], ['kie', 'generating', 'running'],
  ['reapi', 'processing', 'running'], ['sunor', 'pending', 'queued'], ['sunor', 'running', 'running'], ['sunor', 'timeout', 'timeouted']
] as const)('%s maps documented %s status without guessing percentage', async (provider, remote, status) => {
  const fetcher = mockFetch().mockResolvedValue(Response.json(queued(provider, remote)))
  const task = await new constructors[provider](fetcher).query(draft(provider), id, connection)
  expect(task.status).toBe(status)
  expect(task).not.toHaveProperty('percent')
})

it.each(['kie', 'reapi', 'sunor'] as const)('%s rejects empty/over-limit successful results rather than silently dropping tracks', async provider => {
  for (const count of [0, 21]) {
    const values = Array.from({ length: count }, () => urls[0])
    const value = provider === 'kie' ? { code: 200, data: { taskId: id, state: 'success', resultJson: JSON.stringify({ resultUrls: values }) } }
      : provider === 'reapi' ? { id, status: 'completed', output: { audio_urls: values } }
        : { code: 200, data: { task_id: id, status: 'success', output: { result: values.map(audio_url => ({ audio_url })) } } }
    const fetcher = mockFetch().mockResolvedValue(Response.json(value))
    await expect(new constructors[provider](fetcher).query(draft(provider), id, connection)).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  }
})

it('ACE rejects a web UI health response and reports the API-port fix, without creating anything', async () => {
  for (const response of [new Response('<html>Web UI</html>'), Response.json({ code: 200, data: { status: 'ok', service: 'Other UI' } })]) {
    const fetcher = mockFetch().mockResolvedValue(response)
    await expect(new AceStepMusicAdapter(fetcher).check(local)).rejects.toThrow('端口')
    expect(fetcher).toHaveBeenCalledTimes(1)
  }
})
