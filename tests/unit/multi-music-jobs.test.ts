import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { JobManager, type JobStore } from '../fixtures/v31/main/jobs'
import type { MusicAdapter, MusicProviderId, ProviderMusicTask, MusicConnection } from '../../src/shared/music-types'
import type { Project, Settings } from '../../src/shared/types'
import { DEFAULT_IMAGE, DEFAULT_VIDEO } from '../../src/shared/schemas'
import { defaultMusicDraft } from '../../src/shared/music-capabilities'
import { defaultAceStepSettings, aceStepConnectionId } from '../../src/main/storage/migrations'
import { AppError } from '../../src/main/providers/http'
import { matchMusicResults } from '../../src/main/music-results'

function fixture(provider: MusicProviderId = 'kie') {
  const time = new Date().toISOString()
  let project: Project = { version: 4, id: randomUUID(), name: '隔离队列', directory: 'unused', createdAt: time, updatedAt: time,
    music: { ...defaultMusicDraft(provider), prompt: '安静钢琴' }, image: DEFAULT_IMAGE, video: DEFAULT_VIDEO,
    batches: [], musicJobs: [], imageJobs: [], audio: [], images: [], videoJobs: [] }
  const settings: Settings = { version: 4, projectRoot: 'unused', aceStep: defaultAceStepSettings(), musicDefaults: project.music, imageDefaults: DEFAULT_IMAGE }
  const store: JobStore = { get: async () => structuredClone(project), all: async () => [structuredClone(project)], mutate: async (_id, fn) => {
    const next = structuredClone(project); fn(next); project = next; return structuredClone(next)
  } }
  let result: ProviderMusicTask = { id: 'task1', status: 'succeeded', model: 'fixture-model', choices: [
    { url: 'https://cdn.example.com/one.flac?signature=first', title: '第一首' },
    { url: 'https://cdn.example.com/two.flac?signature=first', title: '第二首' }
  ] }
  const create = vi.fn(async (_draft: unknown, _connection: MusicConnection) => structuredClone(result))
  const query = vi.fn(async () => structuredClone(result))
  const preflight = vi.fn(async () => undefined)
  const adapter: MusicAdapter = { create, query, preflight, check: async () => ({ message: 'test' }) }
  const get = vi.fn((_provider: MusicProviderId) => adapter)
  const keys = { get: vi.fn(() => 'fixture-key'), has: vi.fn(() => false) }
  const saveAudio = vi.fn(async ({ assetId }: { assetId: string }) => ({ fileName: `audio/${assetId}.flac`, durationMs: 10123 }))
  const onError = vi.fn()
  const manager = new JobManager({ projects: store, settings: { get: () => structuredClone(settings) }, music: { create: vi.fn(), query: vi.fn(), check: vi.fn() },
    images: { generate: vi.fn(), check: vi.fn() }, keys, registry: { get }, saveAudio, prepareAudio: async () => undefined, pollIntervalMs: 1, pollLimit: 3, onError })
  return { manager, store, settings, keys, create, query, preflight, get, saveAudio, onError, id: project.id, setResult: (value: ProviderMusicTask) => { result = value }, result: () => structuredClone(result) }
}

describe('multi-provider no duplicate creation and durable outputs', () => {
  it('one invocation retains every returned song and correct provider with local duration', async () => {
    const f = fixture(); await f.manager.startMusic(f.id); await f.manager.idle()
    const p = await f.store.get(f.id)
    expect(f.create).toHaveBeenCalledTimes(1); expect(p.audio).toHaveLength(2)
    expect(p.audio.every(a => a.provider === 'kie' && a.durationMs === 10123 && !a.remoteId)).toBe(true)
    expect(p.musicJobs[0].outputs?.every(output => output.status === 'saved')).toBe(true)
    expect(p.musicJobs[0].status).toBe('succeeded'); expect(f.onError).not.toHaveBeenCalled()
    expect(JSON.stringify(p)).not.toContain('signature=')
  })
  it('recovers only an unsaved result with refreshed signatures using the original provider', async () => {
    const f = fixture('reapi'); f.saveAudio.mockRejectedValueOnce(new AppError('disk-full'))
    await f.manager.startMusic(f.id); await f.manager.idle()
    let p = await f.store.get(f.id)
    expect(p.audio).toHaveLength(1); expect(p.musicJobs[0].error).toContain('已保存 1 / 2')
    const manifest = structuredClone(p.musicJobs[0].outputs)
    await f.store.mutate(f.id, p => { p.music = { ...defaultMusicDraft('sunor'), prompt: '新的选择' } })
    f.setResult({ ...f.result(), choices: f.result().choices!.map(c => ({ ...c, url: c.url.replace('first', 'second') })).reverse() })
    await f.manager.retryMusicJob(f.id, p.musicJobs[0].id); await f.manager.idle()
    p = await f.store.get(f.id)
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(1); expect(f.saveAudio).toHaveBeenCalledTimes(3)
    expect(p.audio).toHaveLength(2); expect(p.audio.every(a => a.provider === 'reapi')).toBe(true)
    expect(p.musicJobs[0].outputs?.map(o => o.id)).toEqual(manifest?.map(o => o.id))
    expect(f.get.mock.calls.every(([provider]) => provider === 'reapi')).toBe(true)
  })
  it('rejects changed ID-less result identity instead of inventing a new track', () => {
    const binding = { provider: 'kie' as const, adapterVersion: 1 as const }
    const original = matchMusicResults(binding, [{ url: 'https://cdn.example.com/a?sig=one' }], undefined, [], 'job')
    const refreshed = matchMusicResults(binding, [{ url: 'https://cdn.example.com/a?sig=two' }], original.map(o => o.output), [], 'job')
    expect(refreshed[0].output).toEqual(original[0].output)
    expect(() => matchMusicResults(binding, [{ url: 'https://cdn.example.com/changed' }], original.map(o => o.output), [], 'job')).toThrow('标识发生变化')
  })
  it('does not submit before preflight succeeds and never retries an uncertain create', async () => {
    const f = fixture(); f.preflight.mockRejectedValueOnce(new AppError('模型未就绪'))
    await expect(f.manager.startMusic(f.id)).rejects.toThrow('模型未就绪'); expect(f.create).not.toHaveBeenCalled()
    f.create.mockRejectedValueOnce(new AppError('timeout', true))
    await f.manager.startMusic(f.id); await f.manager.idle()
    expect(f.create).toHaveBeenCalledTimes(1); expect((await f.store.get(f.id)).musicJobs[0].status).toBe('unknown')
  })
  it('no key is needed for unprotected ACE-Step, and connection changes block original queries', async () => {
    const f = fixture('acestep'); f.saveAudio.mockRejectedValue(new AppError('interrupted download'))
    f.setResult({ id: 'task1', status: 'succeeded', choices: [{ url: '/v1/audio?path=%2Fserver%2F%E4%B8%AD%E6%96%87.flac' }] })
    await f.manager.startMusic(f.id); await f.manager.idle()
    let p = await f.store.get(f.id)
    expect(f.keys.get).not.toHaveBeenCalled(); expect(f.create.mock.calls[0][1]).not.toHaveProperty('key')
    const old = structuredClone(f.settings.aceStep)
    f.settings.aceStep.baseUrl = 'http://127.0.0.1:8002'; f.settings.aceStep.connectionId = aceStepConnectionId(f.settings.aceStep.baseUrl)
    await expect(f.manager.retryMusicJob(f.id, p.musicJobs[0].id)).rejects.toThrow('连接已变更')
    expect(f.query).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(1)
    f.settings.aceStep = old; f.saveAudio.mockResolvedValueOnce({ fileName: `audio/${p.musicJobs[0].outputs![0].assetId}.flac`, durationMs: 10000 })
    await f.manager.retryMusicJob(f.id, p.musicJobs[0].id); await f.manager.idle()
    p = await f.store.get(f.id); expect(p.musicJobs[0].status).toBe('succeeded'); expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('shutdown aborts the owned request without replaying it', async () => {
    const f = fixture('acestep')
    f.create.mockImplementationOnce((_draft, connection) => new Promise((_resolve, reject) => {
      connection.signal!.addEventListener('abort', () => reject(new AppError('aborted', true)), { once: true })
    }))
    await f.manager.startMusic(f.id); await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
    f.manager.shutdown(); await f.manager.idle()
    expect(f.create.mock.calls[0][1].signal?.aborted).toBe(true)
    expect((await f.store.get(f.id)).musicJobs[0].status).toBe('submitting')
    expect(f.query).not.toHaveBeenCalled()
  })
})
