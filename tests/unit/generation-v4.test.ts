import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { GenerationProjects } from '../../src/main/storage/workbench-projects'
import { ApiConfigurations } from '../../src/main/storage/api-configurations'
import { SecretStore } from '../../src/main/storage/secrets'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { GenerationQueue } from '../../src/main/generation-jobs'
import { AppError } from '../../src/main/providers/http'
import { initialEntry } from '../../src/shared/workbench-schemas'
import type { AssetStore, AssetRegistration } from '../../src/main/storage/assets-v2'
import type { WorkbenchAsset, GenerationEntry } from '../../src/shared/workbench-types'
import type { MusicAdapter, MusicDraft, ProviderMusicTask } from '../../src/shared/music-types'

let root: string, db: WorkbenchDB, projects: GenerationProjects, queue: GenerationQueue
const cipher = { isEncryptionAvailable: () => true, encryptString: (key: string) => Buffer.from(Buffer.from(key).map(byte => byte ^ 31)), decryptString: (bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 31)).toString() }
beforeEach(async () => { root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v4-generation-')); db = new WorkbenchDB(root); await db.init(); projects = new GenerationProjects(db)
  await db.put('settings', 'current', { version: 5, mediaRoot: root, render: { concurrency: 2, threads: 4, encoder: 'cpu' }, page: 'generation' }) })
afterEach(async () => { await queue?.shutdown(); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const created = new Map<string, MusicDraft>(), assets = new Map<string, WorkbenchAsset>(), rootId = randomUUID()
  const result = (id: string): ProviderMusicTask => ({ id, status: 'succeeded', model: 'fixture', choices: [0, 1].map(index => ({ url: `https://fixture.invalid/${id}/${index}.wav?sig=first`, title: `远端-${index}` })) })
  const create = vi.fn(async (draft: MusicDraft) => { const id = `task-${created.size}`; created.set(id, draft); return result(id) })
  const query = vi.fn(async (_draft: MusicDraft, id: string) => result(id))
  const adapter: MusicAdapter = { create, query, check: vi.fn(async () => ({ message: 'fixture' })) }
  const registry = { get: vi.fn(() => adapter) } as unknown as MusicRegistry
  const images = { generate: vi.fn(async () => ({ url: 'https://fixture.invalid/image.png', model: 'Qwen/Qwen-Image' })), check: vi.fn() }
  const secrets = new SecretStore(root, cipher); await secrets.init()
  const api = new ApiConfigurations(db, secrets, registry, images); await api.init()
  await api.save({ provider: 'reapi', key: 'fixture-reapi-v4' }); await api.save({ provider: 'kie', key: 'fixture-kie-v4' }); await api.save({ provider: 'siliconflow', key: 'fixture-siliconflow-v4' })
  const register = vi.fn(async (input: AssetRegistration) => {
    const asset: WorkbenchAsset = { id: input.id, kind: input.kind, name: input.name, createdAt: input.createdAt, updatedAt: input.createdAt, available: true, origins: [input.origin], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false }
    assets.set(asset.id, asset); return asset
  })
  const assetStore = { managedRootId: async () => rootId, rootDirectory: async () => root, all: async () => [...assets.values()], register } as unknown as AssetStore
  const saveAudio = vi.fn(async ({ assetId }: { assetId: string }) => ({ fileName: `audio/${assetId}.wav`, durationMs: 10000 }))
  const saveImage = vi.fn(async (_url: string, _directory: string, assetId: string) => ({ fileName: `images/${assetId}.png`, width: 1664, height: 928, format: 'png' as const }))
  const errors: string[] = []
  queue = new GenerationQueue({ db, assets: assetStore, apis: api, registry, images, saveAudio, saveImage, prepare: async () => undefined, pollMs: 1, onError: error => errors.push(error) })
  async function entry(projectId: string, prompt: string, provider: 'reapi' | 'kie' = 'reapi'): Promise<GenerationEntry> {
    const value = await projects.add(projectId, 'audio')
    return projects.updateEntry(value.id, 0, { ...initialEntry('audio', provider), mode: 'instrumental', prompt }, {})
  }
  async function imageEntry(projectId: string, prompt: string): Promise<GenerationEntry> {
    const value = await projects.add(projectId, 'image')
    return projects.updateEntry(value.id, 0, { ...initialEntry('image', 'siliconflow'), prompt }, {})
  }
  const selection = (projectId: string, entries: GenerationEntry[]) => ({ projectId, submissionId: randomUUID(), entries: entries.map(({ id, revision }) => ({ id, revision })) })
  return { api, adapter, create, query, register, saveAudio, saveImage, images, assets, created, result, entry, imageEntry, selection, errors }
}

describe('entry-based confirmed serial request queue', () => {
  it('submits distinct prompts once, routes results to A/B, and preserves every returned version', async () => {
    const f = await fixture(), a = await projects.create(), b = await projects.create()
    const ea = await f.entry(a.id, 'A 第一条'), ea2 = await f.entry(a.id, 'A 第二条', 'kie'), eb = await f.entry(b.id, 'B 独立描述')
    const s = f.selection(a.id, [ea, ea2])
    await Promise.all([queue.submit(s), queue.submit(s)])
    await queue.submit(f.selection(b.id, [eb])); await queue.idle()
    expect(f.create).toHaveBeenCalledTimes(3); expect(f.errors).toEqual([])
    expect([...f.created.values()].map(draft => draft.prompt)).toEqual(['A 第一条', 'A 第二条', 'B 独立描述'])
    expect([...f.created.values()].every(draft => draft.count === 1)).toBe(true)
    const requests = db.list('requests')
    expect(requests.every(request => request.status === 'succeeded' && request.outputs?.length === 2 && request.assetIds.length === 2)).toBe(true)
    expect([...f.assets.values()].filter(asset => asset.origins[0].projectId === a.id)).toHaveLength(4)
    expect([...f.assets.values()].filter(asset => asset.origins[0].projectId === b.id)).toHaveLength(2)
    await queue.submit(s); await queue.recover(); await queue.idle(); expect(f.create).toHaveBeenCalledTimes(3)
    const copy = await projects.add(a.id, 'audio', ea.id); expect(copy.requestId).toBeUndefined()
    expect(copy.draft).not.toHaveProperty('count')
  })
  it('retains partial results and recovers only the missing output with refreshed signed URLs', async () => {
    const f = await fixture(), project = await projects.create(), entry = await f.entry(project.id, '恢复测试')
    f.saveAudio.mockRejectedValueOnce(new AppError('保存空间不足'))
    await queue.submit(f.selection(project.id, [entry])); await queue.idle()
    const request = db.list('requests')[0]
    expect(request.status).toBe('failed'); expect(request.assetIds).toHaveLength(1)
    const ids = request.outputs!.map(output => output.id)
    f.query.mockImplementationOnce(async (_draft, id) => ({ ...f.result(id), choices: f.result(id).choices!.map(choice => ({ ...choice, url: choice.url.replace('first', 'second') })).reverse() }))
    await queue.resume(request.id); await queue.idle()
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(1); expect(f.saveAudio).toHaveBeenCalledTimes(3)
    expect(db.get('requests', request.id).outputs!.map(output => output.id)).toEqual(ids)
    expect(db.get('requests', request.id).status).toBe('succeeded'); expect(f.assets.size).toBe(2)
    expect(JSON.stringify(db.list('requests'))).not.toContain('sig=')
  })
  it('never replays an unknown paid create and pauses only its own submission', async () => {
    const f = await fixture(), a = await projects.create(), b = await projects.create()
    const first = await f.entry(a.id, 'unknown'), second = await f.entry(a.id, 'must pause'), other = await f.entry(b.id, 'independent')
    f.create.mockRejectedValueOnce(new AppError('响应超时，受理未知', true))
    await queue.submit(f.selection(a.id, [first, second])); await queue.submit(f.selection(b.id, [other])); await queue.idle()
    const unknown = db.get('requests', db.get('entries', first.id).requestId!)
    expect(unknown.status).toBe('unknown'); expect(db.get('requests', db.get('entries', second.id).requestId!).status).toBe('paused')
    expect(db.get('requests', db.get('entries', other.id).requestId!).status).toBe('succeeded')
    await queue.recover(); await expect(queue.resume(unknown.id)).rejects.toThrow('不能恢复')
    await expect(projects.delete(a.id)).rejects.toThrow('请求')
    await queue.abandon(unknown.id); await queue.stop(a.id); await projects.delete(a.id)
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.assets.size).toBe(2)
  })
  it('retains two result identities even when both resolve to one deduplicated library asset', async () => {
    const f = await fixture(), project = await projects.create(), entry = await f.entry(project.id, 'two identical versions')
    const original = f.register.getMockImplementation()!
    f.register.mockImplementation(async input => f.assets.size ? [...f.assets.values()][0] : original(input))
    await queue.submit(f.selection(project.id, [entry])); await queue.idle()
    const request = db.list('requests')[0]
    expect(request.assetIds).toHaveLength(1); expect(request.outputs).toHaveLength(2)
    expect(request.outputs!.every(output => output.libraryAssetId === request.assetIds[0] && output.status === 'saved')).toBe(true)
    expect(request.outputs![0].id).not.toBe(request.outputs![1].id)
    expect(request.submittedAt).toBeTruthy(); expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('pauses the whole newly confirmed group when requests from different old submissions are resumed together', async () => {
    const f = await fixture(), project = await projects.create()
    const first = await f.entry(project.id, 'old group A first'), laterA = await f.entry(project.id, 'old group A pending')
    const second = await f.entry(project.id, 'old group B first'), laterB = await f.entry(project.id, 'old group B pending')
    f.create.mockRejectedValueOnce(new AppError('first group uncertain', true))
    await queue.submit(f.selection(project.id, [first, laterA])); await queue.idle()
    f.create.mockRejectedValueOnce(new AppError('second group uncertain', true))
    await queue.submit(f.selection(project.id, [second, laterB])); await queue.idle()
    const merged = f.selection(project.id, [laterA, laterB])
    f.create.mockRejectedValueOnce(new AppError('merged group uncertain', true))
    await queue.submit(merged); await queue.idle()
    expect(f.create).toHaveBeenCalledTimes(3)
    const a = db.get('requests', db.get('entries', laterA.id).requestId!), b = db.get('requests', db.get('entries', laterB.id).requestId!)
    expect(a.status).toBe('unknown'); expect(b.status).toBe('paused')
    expect(a.submissionId).toBe(merged.submissionId); expect(b.submissionId).toBe(merged.submissionId)
    expect(db.list('submissions')).toHaveLength(3)
  })

  it('runs image requests while a music request is still polling, keeping each kind serial', async () => {
    const f = await fixture(), project = await projects.create()
    const music = await f.entry(project.id, 'long music'), first = await f.imageEntry(project.id, 'image one'), second = await f.imageEntry(project.id, 'image two')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.create.mockImplementationOnce(async draft => { f.created.set('task-slow', draft); return { id: 'task-slow', status: 'running' } })
    f.query.mockImplementationOnce(async (_draft, id) => { await gate; return f.result(id) })
    let inFlight = 0, peak = 0
    f.images.generate.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--
      return { url: 'https://fixture.invalid/image.png', model: 'Qwen/Qwen-Image' }
    })
    await queue.submit(f.selection(project.id, [music]))
    await queue.submit(f.selection(project.id, [first, second]))
    const request = (entry: GenerationEntry) => db.get('requests', db.get('entries', entry.id).requestId!)
    await vi.waitFor(() => { expect([first, second].map(entry => request(entry).status)).toEqual(['succeeded', 'succeeded']) })
    expect(request(music).status).toBe('running'); expect(queue.busy).toBe(true)
    expect(f.images.generate).toHaveBeenCalledTimes(2); expect(f.saveImage).toHaveBeenCalledTimes(2); expect(peak).toBe(1)
    release(); await queue.idle()
    expect(request(music).status).toBe('succeeded'); expect(queue.busy).toBe(false)
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([])
    expect([...f.assets.values()].map(asset => asset.kind).sort()).toEqual(['audio', 'audio', 'image', 'image'])
  })

  it('binds confirmation to exact revisions and rejects foreign or duplicate entry identities', async () => {
    const f = await fixture(), a = await projects.create(), b = await projects.create(), entry = await f.entry(a.id, 'before')
    const selection = f.selection(a.id, [entry])
    await projects.updateEntry(entry.id, entry.revision, { ...entry.draft, prompt: 'after' }, {})
    await expect(queue.submit(selection)).rejects.toThrow('修改')
    await expect(queue.submit({ ...selection, projectId: b.id })).rejects.toThrow('不属于')
    await expect(queue.submit({ ...selection, entries: [selection.entries[0], selection.entries[0]] })).rejects.toThrow('重复')
    expect(f.create).not.toHaveBeenCalled()
  })
})
