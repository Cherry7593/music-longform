import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_IMAGE, DEFAULT_VIDEO } from '../../src/shared/schemas'
import { defaultMusicDraft } from '../../src/shared/music-capabilities'
import { aceStepConfigurationSchema, legacyMusicDraftSchema, musicDraftSchema, normalizedAceStepURL } from '../../src/shared/music-schemas'
import { defaultAceStepSettings, migrateProject, migrateSettings } from '../../src/main/storage/migrations'
import { SettingsStore } from '../fixtures/v31/main/storage/settings'
import { SecretStore } from '../../src/main/storage/secrets'
import { projectSchema } from '../../src/main/storage/validation'
import { dataCandidates } from '../../src/main/storage/data-directory'

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v31-state-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const legacyMusic = { prompt: '原始音乐', mode: 'instrumental' as const, model: 'mureka-9.5', count: 1, styles: ['jazz'] }
const cipher = () => ({ isEncryptionAvailable: () => true, encryptString: vi.fn((key: string) => Buffer.from(Buffer.from(key).map(byte => byte ^ 0x67))), decryptString: vi.fn((bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 0x67)).toString()) })

describe('V3.1 data compatibility and per-provider identity', () => {
  it('upgrades a V3 project without changing media, video receipts or generation history values', async () => {
    const id = randomUUID(), batchId = randomUUID(), jobId = randomUUID(), assetId = randomUUID(), createdAt = new Date().toISOString()
    const old = { version: 3, id, name: 'V3 项目', directory: root, createdAt, updatedAt: createdAt,
      music: legacyMusic, image: DEFAULT_IMAGE, batches: [{ id: batchId, total: 1, createdAt, state: 'paused' }],
      musicJobs: [{ id: jobId, batchId, index: 0, createdAt, status: 'running', snapshot: legacyMusic, taskId: 'original-task', recoverable: true }],
      audio: [{ id: assetId, jobId, taskId: 'original-task', remoteId: 'original-song', title: '原音乐', fileName: `audio/${assetId}.mp3`, durationMs: 123456, createdAt, prompt: '历史提示词', model: 'mureka-9.5', mode: 'instrumental', kept: true }],
      imageJobs: [], images: [], video: DEFAULT_VIDEO, videoJobs: [] }
    const file = path.join(root, 'project.json'), bytes = Buffer.from(JSON.stringify(old))
    await writeFile(file, bytes)
    const next = await migrateProject(file, old, root, id)
    expect(next.version).toBe(4)
    expect(next.music).toEqual({ ...old.music, provider: 'mureka' })
    expect(next.musicJobs[0]).toEqual({ ...old.musicJobs[0], snapshot: { ...legacyMusic, provider: 'mureka' }, binding: { provider: 'mureka', adapterVersion: 1 } })
    expect(next.audio).toEqual(old.audio.map(asset => ({ ...asset, provider: 'mureka' })))
    expect(next.video).toEqual(old.video)
    const backup = (await readdir(root)).find(name => name.startsWith('project.json.v3-'))!
    expect(await readFile(path.join(root, backup))).toEqual(bytes)
    expect(await migrateProject(file, next, root, id)).toEqual(next)
    expect((await readdir(root)).filter(name => name.endsWith('.bak'))).toHaveLength(1)
    expect(projectSchema.safeParse({ ...next, musicJobs: [{ ...next.musicJobs[0], binding: { provider: 'kie', adapterVersion: 1 } }] }).success).toBe(false)
  })
  it('persists full current provider IDs and titles without widening frozen historical schemas', () => {
    const id = randomUUID(), jobId = randomUUID(), batchId = randomUUID(), assetId = randomUUID(), resultId = randomUUID(), createdAt = new Date().toISOString()
    const draft = defaultMusicDraft('sunor'), taskId = 't'.repeat(200), remoteId = 'r'.repeat(200), title = '曲'.repeat(500)
    const project = { version: 4, id, name: '平台边界', directory: root, createdAt, updatedAt: createdAt, music: draft, image: DEFAULT_IMAGE, video: DEFAULT_VIDEO,
      batches: [{ id: batchId, total: 1, createdAt, state: 'completed' }], imageJobs: [], images: [], videoJobs: [],
      musicJobs: [{ id: jobId, batchId, index: 0, createdAt, status: 'succeeded', snapshot: draft, binding: { provider: 'sunor', adapterVersion: 1 }, taskId,
        outputs: [{ id: resultId, assetId, index: 0, remoteId, title, locator: 'a'.repeat(64), status: 'saved' }] }],
      audio: [{ id: assetId, resultId, jobId, taskId, remoteId, title, fileName: `audio/${assetId}.m4a`, createdAt, durationMs: 10000, prompt: '', model: 'v6', mode: 'instrumental', kept: false, provider: 'sunor' }] }
    expect(projectSchema.parse(project)).toEqual(project)
    expect(projectSchema.safeParse({ ...project, audio: [{ ...project.audio[0], title: title + '超限' }] }).success).toBe(false)
    expect(projectSchema.safeParse({ ...project, musicJobs: [{ ...project.musicJobs[0], taskId: taskId + 'x' }] }).success).toBe(false)
  })
  it('upgrades V3 defaults once and detects V4 data directories read-only', async () => {
    const old = { version: 3, projectRoot: root, musicDefaults: legacyMusic, imageDefaults: DEFAULT_IMAGE }
    const file = path.join(root, 'settings.json'); await writeFile(file, JSON.stringify(old))
    const next = await migrateSettings(file, old)
    expect(next).toEqual({ ...old, version: 4, musicDefaults: { ...legacyMusic, provider: 'mureka' }, aceStep: defaultAceStepSettings() })
    expect(await dataCandidates({ appData: root, legacyDefault: root })).toEqual([root])
  })
  it('preserves both V2 ciphertexts byte-for-byte without decrypting during upgrade', async () => {
    const encryption = cipher()
    const old = { version: 2, keys: { mureka: encryption.encryptString('fixture-mureka').toString('base64'), siliconflow: encryption.encryptString('fixture-siliconflow').toString('base64') } }
    const file = path.join(root, 'secrets.json'), bytes = Buffer.from(JSON.stringify(old)); await writeFile(file, bytes)
    encryption.encryptString.mockClear()
    const store = new SecretStore(root, encryption); await store.init()
    expect(encryption.encryptString).not.toHaveBeenCalled(); expect(encryption.decryptString).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...old, version: 3 })
    const backup = (await readdir(root)).find(name => name.startsWith('secrets.json.v2-'))!
    expect(await readFile(path.join(root, backup))).toEqual(bytes)
    const connectionId = defaultAceStepSettings().connectionId
    for (const provider of ['kie', 'reapi', 'sunor'] as const) await store.set(provider, `fixture-${provider}`)
    await store.set('acestep', 'x', connectionId)
    expect(store.has('acestep', randomUUID())).toBe(false)
    expect(() => store.get('acestep', randomUUID())).toThrow('连接')
    expect(store.get('acestep', connectionId)).toBe('x')
    expect(store.get('mureka')).toBe('fixture-mureka')
    await store.clear('reapi'); expect(store.has('kie')).toBe(true); expect(store.has('sunor')).toBe(true)
    await store.clear('acestep'); expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('aceStepConnectionId')
    await expect(store.set('acestep', 'x')).rejects.toThrow('连接标识')
  })
  it('restores the same original connection identity on switching the root back', async () => {
    const settings = new SettingsStore(root, root); await settings.init()
    const original = settings.get().aceStep
    await settings.configureAceStep({ baseUrl: 'http://127.0.0.1:8002', waitMinutes: 5, allowLan: false })
    expect(settings.get().aceStep.connectionId).not.toBe(original.connectionId)
    await settings.configureAceStep({ baseUrl: 'http://localhost:8001/', waitMinutes: 180, allowLan: false })
    expect(settings.get().aceStep.connectionId).toBe(original.connectionId)
    expect(settings.get().aceStep.baseUrl).toBe(original.baseUrl)
  })
})

describe('provider-aware music drafts', () => {
  it.each(['mureka', 'kie', 'reapi', 'sunor', 'acestep'] as const)('accepts the %s default, but rejects a foreign model', provider => {
    const draft = defaultMusicDraft(provider)
    expect(musicDraftSchema.safeParse(draft).success).toBe(true)
    if (provider !== 'acestep') expect(musicDraftSchema.safeParse({ ...draft, model: 'foreign' }).success).toBe(false)
    expect(legacyMusicDraftSchema.safeParse(draft).success).toBe(false)
  })
  it('separates custom lyrics from descriptions and rejects silent truncation', () => {
    const draft = defaultMusicDraft('kie')
    expect(musicDraftSchema.safeParse({ ...draft, mode: 'song', prompt: 'style' }).success).toBe(false)
    expect(musicDraftSchema.safeParse({ ...draft, mode: 'song', prompt: 'style', lyrics: '[Verse]\n歌词' }).success).toBe(true)
    expect(musicDraftSchema.safeParse({ ...draft, prompt: 'x'.repeat(1001) }).success).toBe(false)
    expect(musicDraftSchema.safeParse({ ...draft, seconds: 361 }).success).toBe(false)
    expect(musicDraftSchema.safeParse({ ...defaultMusicDraft('acestep'), seconds: 600 }).success).toBe(true)
  })
  it.each(['http://127.0.0.1:8001', 'http://localhost:8001/', 'https://[::1]:8001', 'http://192.168.1.2:8001', 'http://10.0.0.2:8001', 'http://172.16.0.2:8001'])('accepts a supported local root %s', url => {
    expect(normalizedAceStepURL(url)).toBeTruthy()
  })
  it.each(['http://example.com', 'https://8.8.8.8', 'http://169.254.169.254', 'http://0.0.0.0', 'http://127.1:8001', 'http://2130706433:8001', 'http://127.0.0.1:0', 'file:///secret', 'http://user:key@127.0.0.1', 'http://127.0.0.1/v1', 'http://127.0.0.1/?secret=x', 'http://127.0.0.1/#secret', 'http://192.168.1.255:8001', 'http://[::ffff:127.0.0.1]:8001'])('rejects unsafe/misleading endpoint %s', url => {
    expect(normalizedAceStepURL(url)).toBeUndefined()
  })
  it('requires explicit LAN approval and bounded waiting', () => {
    const value = { baseUrl: 'http://192.168.1.2:8001', waitMinutes: 60, allowLan: false }
    expect(aceStepConfigurationSchema.safeParse(value).success).toBe(false)
    expect(aceStepConfigurationSchema.safeParse({ ...value, allowLan: true }).success).toBe(true)
    expect(aceStepConfigurationSchema.safeParse({ ...value, allowLan: true, waitMinutes: 181 }).success).toBe(false)
  })
})
