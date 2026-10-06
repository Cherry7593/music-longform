import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultMusicDraft, INSTRUMENTAL_MODELS, SONG_MODELS, MUREKA_ORIGINS, musicModels, musicPromptLimit } from '../../src/shared/music-capabilities'
import { musicBindingSchema, musicDraftSchema } from '../../src/shared/music-schemas'
import { apiInputSchema, initialEntry, musicInput, requestSchema } from '../../src/shared/workbench-schemas'
import { providerKeySchema } from '../../src/shared/schemas'
import type { MusicDraft } from '../../src/shared/music-types'
import type { GenerationEntry, GenerationRequest, WorkbenchAsset } from '../../src/shared/workbench-types'
import { MurekaProvider } from '../../src/main/providers/mureka'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { requestJson } from '../../src/main/providers/http'
import { ApiConfigurations } from '../../src/main/storage/api-configurations'
import { SecretStore } from '../../src/main/storage/secrets'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { GenerationProjects } from '../../src/main/storage/workbench-projects'
import { GenerationQueue } from '../../src/main/generation-jobs'
import type { AssetRegistration, AssetStore } from '../../src/main/storage/assets-v2'

type Site = keyof typeof MUREKA_ORIGINS
const keys = { mureka: 'fixture-international-only', 'mureka-cn': 'cn.x' }
const draft = (provider: Site, patch: Partial<MusicDraft> = {}): MusicDraft => ({ ...defaultMusicDraft(provider), prompt: '  安静的中文民谣  ', mode: 'song', ...patch })
const cipher = { isEncryptionAvailable: () => true, encryptString: (key: string) => Buffer.from(Buffer.from(key).map(n => n ^ 77)), decryptString: (bytes: Buffer) => Buffer.from(bytes.map(n => n ^ 77)).toString() }
const roots: string[] = [], queues: GenerationQueue[] = []
const temp = async () => { const root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v401-mureka-')); roots.push(root); return root }
afterEach(async () => { for (const queue of queues.splice(0)) await queue.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('Mureka two independent official sites', () => {
  it.each(['mureka', 'mureka-cn'] as const)('%s sends one song/instrumental POST with only supported fields and its own key', async site => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'task-1', status: 'preparing' }))
    const adapter = new MusicRegistry(undefined, fetcher).get(site)
    for (const mode of ['song', 'instrumental'] as const) {
      const input = draft(site, { mode, count: 20, styles: ['pop'], title: '本地曲名', lyrics: '保留而不发送', seconds: 600 })
      await adapter.create(input, { key: keys[site], baseUrl: MUREKA_ORIGINS[site === 'mureka' ? 'mureka-cn' : 'mureka'] })
      const [url, init] = fetcher.mock.calls.at(-1)!
      expect(url).toBe(`${MUREKA_ORIGINS[site]}/v1/${mode === 'song' ? 'song/easy-generate' : 'instrumental/generate'}`)
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${keys[site]}`)
      expect(JSON.parse(init?.body as string)).toEqual({ model: 'auto', prompt: '安静的中文民谣', ...(mode === 'song' ? { styles: ['pop'] } : {}), n: 1, stream: false })
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['preparing', 'queued', 'running', 'streaming', 'reviewing', 'succeeded', 'failed', 'timeouted', 'cancelled'])('domestic status %s is parsed without new creation and all results retain milliseconds', async status => {
    const choices = [0, 1, 2].map(n => ({ id: `clip-${n}`, url: `https://cdn.example.com/${n}.mp3`, duration: 10000 + n }))
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'task-1', status, failed_reason: keys['mureka-cn'], detail: keys['mureka-cn'], choices, model: 'mureka-9.5' }))
    const result = await new MusicRegistry(undefined, fetcher).get('mureka-cn').query(draft('mureka-cn'), 'task-1', { key: keys['mureka-cn'] })
    expect(result.status).toBe(status === 'reviewing' ? 'running' : status)
    if (status === 'reviewing') expect(result.detail).toContain('审核中')
    expect(result.choices).toEqual(choices.map(c => ({ remoteId: c.id, url: c.url, durationMs: c.duration })))
    expect(JSON.stringify(result)).not.toContain(keys['mureka-cn'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.mureka.cn/v1/song/query/task-1')
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET')
  })

  it.each(['mureka', 'mureka-cn'] as const)('%s instrumental query and billing are read-only and bound to that site', async site => {
    const fetcher = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/billing') ? { account_id: 2, balance: 1200 } : { id: 'same-id', status: 'queued' }))
    const adapter = new MusicRegistry(undefined, fetcher).get(site)
    await adapter.query(draft(site, { mode: 'instrumental' }), 'same-id', { key: keys[site] })
    expect(await adapter.check({ key: keys[site] })).toMatchObject({ balanceCents: 1200, message: expect.stringContaining('未创建生成任务') })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${MUREKA_ORIGINS[site]}/v1/instrumental/query/same-id`, `${MUREKA_ORIGINS[site]}/v1/account/billing`])
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET' && new Headers(init.headers).get('authorization') === `Bearer ${keys[site]}`)).toBe(true)
  })

  it('rejects cross-site origins, mismatched snapshots and unsafe task IDs before any request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const registry = new MusicRegistry(undefined, fetcher)
    for (const site of ['mureka', 'mureka-cn'] as const) {
      const other = site === 'mureka' ? 'mureka-cn' : 'mureka'
      await expect(registry.get(site).create(draft(other), { key: keys[site] })).rejects.toThrow()
      await expect(registry.get(site).query(draft(other), 'same-id', { key: keys[site] })).rejects.toThrow('站点')
      for (const url of [`${MUREKA_ORIGINS[other]}/v1/account/billing`, 'https://api.mureka.cn.evil.example/v1/account/billing', 'http://api.mureka.cn/v1/account/billing']) {
        await expect(requestJson(fetcher, url, { provider: site, method: 'GET', key: keys[site], timeoutMs: 20 })).rejects.toThrow('官方')
      }
      await expect(registry.get(site).query(draft(site), '../task?key=x', { key: keys[site] })).rejects.toThrow('标识')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 503, 302])('domestic HTTP %i never retries a create or fails over to international', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ message: keys['mureka-cn'] }, { status }))
    await expect(new MurekaProvider(fetcher, 'mureka-cn').create(draft('mureka-cn'), keys['mureka-cn'])).rejects.toMatchObject({ uncertain: status >= 500 || status === 302 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toMatch(/^https:\/\/api\.mureka\.cn\//)
  })

  it('unknown/malformed create and mismatched query identity never become cross-site retries', async () => {
    for (const response of [Response.json({ id: 'a', status: 'undocumented' }), new Response('{broken')]) {
      const fetcher = vi.fn<typeof fetch>(async () => response)
      await expect(new MurekaProvider(fetcher, 'mureka-cn').create(draft('mureka-cn'), keys['mureka-cn'])).rejects.toMatchObject({ uncertain: true })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const failed = vi.fn<typeof fetch>(async () => { throw new Error('lost response') })
    await expect(new MurekaProvider(failed, 'mureka-cn').create(draft('mureka-cn'), keys['mureka-cn'])).rejects.toMatchObject({ uncertain: true })
    expect(failed).toHaveBeenCalledTimes(1)
    const mismatch = vi.fn<typeof fetch>(async () => Response.json({ id: 'other', status: 'succeeded' }))
    await expect(new MurekaProvider(mismatch, 'mureka-cn').query('song', 'original', keys['mureka-cn'])).rejects.toMatchObject({ uncertain: false })
    expect(mismatch).toHaveBeenCalledTimes(1)
  })

  it('uses the documented domestic models, limits and strict provider fields without changing old defaults', () => {
    const input = musicInput({ ...initialEntry('audio', 'mureka-cn'), prompt: '民谣' })
    expect(input).toMatchObject({ provider: 'mureka-cn', mode: 'song', model: 'auto', count: 1 })
    expect(musicModels(input)).toEqual(SONG_MODELS); expect(musicPromptLimit(input)).toBe(2000)
    for (const model of SONG_MODELS) expect(musicDraftSchema.safeParse({ ...input, model }).success).toBe(true)
    for (const model of INSTRUMENTAL_MODELS) expect(musicDraftSchema.safeParse({ ...input, model, mode: 'instrumental' }).success).toBe(true)
    for (const patch of [{ model: 'mureka-future' }, { prompt: 'x'.repeat(2001) }, { mode: 'instrumental', prompt: 'x'.repeat(1025) }, { mode: 'instrumental', model: 'mureka-o2' }, { inputMode: 'lyrics' }, { provider: 'mureka-other' }, { extra: true }]) expect(musicDraftSchema.safeParse({ ...input, ...patch }).success).toBe(false)
    expect(defaultMusicDraft().provider).toBe('mureka')
    expect(musicBindingSchema.safeParse({ provider: 'mureka-cn', adapterVersion: 1, local: { baseUrl: 'http://127.0.0.1:8001', connectionId: randomUUID() } }).success).toBe(false)
  })

  it('accepts opaque domestic keys including short and punctuation tokens, but not whitespace/control characters', () => {
    for (const key of ['x', 'cn.token+/=_-', 'a'.repeat(4096)]) expect(apiInputSchema.safeParse({ provider: 'mureka-cn', key }).success).toBe(true)
    for (const key of ['', 'x y', 'x\ny', '\r\nheader:x', '密钥', 'x'.repeat(4097)]) expect(apiInputSchema.safeParse({ provider: 'mureka-cn', key }).success).toBe(false)
    expect(providerKeySchema('mureka').safeParse('x').success).toBe(false)
    expect(apiInputSchema.safeParse({ provider: 'mureka-unknown', key: 'fixture-key' }).success).toBe(false)
  })
})

describe('existing data and original-site recovery', () => {
  it('reads V3 ciphertext/V4 config unchanged and adding, clearing, deleting CN never rewrites the international ciphertext', async () => {
    const root = await temp(), secretPath = path.join(root, 'secrets.json')
    const encrypted = cipher.encryptString(keys.mureka).toString('base64')
    const oldBytes = JSON.stringify({ version: 3, keys: { mureka: encrypted, siliconflow: cipher.encryptString('fixture-images').toString('base64') } }, null, 4) + '\n'
    await writeFile(secretPath, oldBytes)
    const db = new WorkbenchDB(root); await db.init()
    const now = new Date().toISOString(), record = { version: 1 as const, provider: 'mureka' as const, kind: 'audio' as const, createdAt: now, updatedAt: now }
    await db.put('apis', 'mureka', record)
    const secret = new SecretStore(root, cipher); await secret.init()
    expect(await readFile(secretPath, 'utf8')).toBe(oldBytes)
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ balance: 100 }))
    const apis = new ApiConfigurations(db, secret, new MusicRegistry(undefined, fetcher), { generate: vi.fn(), check: vi.fn() }); await apis.init()
    expect(apis.list()).toEqual([{ ...record, hasKey: true }])
    await apis.save({ provider: 'mureka-cn', key: keys['mureka-cn'] }); await apis.save({ provider: 'mureka-cn' })
    expect(apis.list()).toHaveLength(2); expect(secret.encryptedSnapshot().keys.mureka).toBe(encrypted)
    expect(db.get('apis', 'mureka')).toEqual(record)
    for (const site of ['mureka', 'mureka-cn'] as const) await apis.test({ provider: site })
    expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).origin, new Headers(init?.headers).get('authorization')])).toEqual([
      [MUREKA_ORIGINS.mureka, `Bearer ${keys.mureka}`], [MUREKA_ORIGINS['mureka-cn'], `Bearer ${keys['mureka-cn']}`]
    ])
    expect(fetcher.mock.calls.every(([,init]) => init?.method === 'GET')).toBe(true)
    await apis.save({ provider: 'mureka-cn', clearKey: true })
    expect(() => apis.connection(apis.binding('mureka-cn'))).toThrow('密钥')
    expect(apis.connection(apis.binding('mureka')).key).toBe(keys.mureka)
    await apis.delete('mureka-cn'); expect(secret.encryptedSnapshot().keys.mureka).toBe(encrypted)
    const reopened = new SecretStore(root, cipher); await reopened.init(); expect(reopened.get('mureka')).toBe(keys.mureka)
    expect(reopened.has('mureka-cn')).toBe(false)
  })

  it('keeps same remote IDs separated across sites, waits through review, resumes after restart and saves all versions without another POST', async () => {
    const root = await temp(), assets = new Map<string, WorkbenchAsset>(), rootId = randomUUID()
    const store = { managedRootId: async () => rootId, rootDirectory: async () => root, all: async () => [...assets.values()], register: async (input: AssetRegistration) => {
      const value: WorkbenchAsset = { id: input.id, kind: input.kind, name: input.name, available: true, createdAt: input.createdAt, updatedAt: input.createdAt, origins: [input.origin], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false }; assets.set(value.id, value); return value
    } } as unknown as AssetStore
    let recovering = false
    const polls = new Map<string, number>()
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url)), site = target.hostname === 'api.mureka.cn' ? 'mureka-cn' : 'mureka'
      expect(target.origin).toBe(MUREKA_ORIGINS[site]); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${keys[site]}`)
      if (init?.method === 'POST') return Response.json({ id: 'shared-remote-id', status: 'reviewing' })
      if (!recovering) return Response.json({}, { status: 401 })
      const count = (polls.get(site) ?? 0) + 1; polls.set(site, count)
      return Response.json(count === 1 ? { id: 'shared-remote-id', status: 'reviewing' } : { id: 'shared-remote-id', status: 'succeeded', model: 'mureka-9.5', choices: [0, 1, 2].map(index => ({ id: `clip-${index}`, url: `https://cdn.example.com/${site}/${index}.mp3`, duration: 999000 })) })
    })
    const saveAudio = vi.fn(async ({ assetId }: { assetId: string }) => ({ fileName: `audio/${assetId}.flac`, durationMs: 12345 }))
    const stages: GenerationRequest[] = []
    async function open() {
      const db = new WorkbenchDB(root); await db.init()
      const secrets = new SecretStore(root, cipher); await secrets.init()
      const registry = new MusicRegistry(undefined, fetcher), images = { generate: vi.fn(), check: vi.fn() }
      const apis = new ApiConfigurations(db, secrets, registry, images); await apis.init()
      db.onChanged = () => { stages.push(...db.list('requests')) }
      const queue = new GenerationQueue({ db, assets: store, apis, registry, images, saveAudio, pollMs: 1, prepare: async () => undefined })
      queues.push(queue); return { db, secrets, apis, queue, projects: new GenerationProjects(db) }
    }
    const f = await open()
    await f.db.put('settings', 'current', { version: 5, page: 'generation', mediaRoot: root, render: { concurrency: 2, threads: 4, encoder: 'auto' } })
    const entries: GenerationEntry[] = []
    for (const site of ['mureka', 'mureka-cn'] as const) {
      await f.apis.save({ provider: site, key: keys[site] })
      const project = await f.projects.create(), e = await f.projects.add(project.id, 'audio')
      const entry = await f.projects.updateEntry(e.id, 0, { ...initialEntry('audio', site), mode: site === 'mureka' ? 'song' : 'instrumental', prompt: `${site}描述` }, {}); entries.push(entry)
      await f.queue.submit({ projectId: project.id, submissionId: randomUUID(), entries: [{ id: entry.id, revision: entry.revision }] })
      await f.queue.idle()
    }
    const requests = f.db.list('requests')
    expect(requests.every(r => r.status === 'failed' && r.recoverable && r.taskId === 'shared-remote-id')).toBe(true)
    expect(stages.some(r => r.status === 'running' && r.detail?.includes('审核中'))).toBe(true)
    expect(requests.every(r => requestSchema.safeParse(r).success)).toBe(true)
    const bytes = await readFile(path.join(root, 'secrets.json'))
    await f.queue.shutdown(); recovering = true
    const next = await open(); await next.queue.recover()
    expect(await readFile(path.join(root, 'secrets.json'))).toEqual(bytes)
    expect(next.db.list('requests').map(r => r.id).sort()).toEqual(requests.map(r => r.id).sort())
    // A different displayed project/provider draft must not rebind either submitted request.
    await next.db.update('settings', 'current', value => { value.lastGenerationId = entries[1].projectId })
    for (const r of requests) { await next.queue.resume(r.id); await next.queue.idle() }
    expect(fetcher.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(2)
    expect(next.db.list('requests').every(r => r.status === 'succeeded' && r.outputs?.length === 3 && r.assetIds.length === 3)).toBe(true)
    expect(saveAudio).toHaveBeenCalledTimes(6)
    expect([...assets.values()].filter(a => a.origins[0].provider === 'mureka-cn')).toHaveLength(3)
    expect([...assets.values()].filter(a => a.origins[0].provider === 'mureka')).toHaveLength(3)
    const queries = fetcher.mock.calls.filter(([, init]) => init?.method === 'GET').map(([url]) => String(url))
    expect(queries.every(url => url === 'https://api.mureka.ai/v1/song/query/shared-remote-id' || url === 'https://api.mureka.cn/v1/instrumental/query/shared-remote-id')).toBe(true)
    await next.queue.recover(); await next.queue.idle(); expect(fetcher.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(2)
  })
})
