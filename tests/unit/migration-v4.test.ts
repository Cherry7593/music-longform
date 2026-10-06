import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inspectV4Migration, migrateV4, type V4MigrationOptions } from '../../src/main/storage/migration-v4'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { AssetStore, type AssetRegistration } from '../../src/main/storage/assets-v2'
import { SecretStore } from '../../src/main/storage/secrets'
import { legacyDefaultAceStep, stableMigrationId } from '../../src/main/migration/legacy-decode'
import type { Project, Settings } from '../../src/shared/types'
import type { UsageRecord, WorkbenchAsset } from '../../src/shared/workbench-types'
import type { LibraryRecord } from '../../src/main/storage/library-validation'
import type { VideoBatch } from '../../src/shared/library-types'

const createdAt = '2026-05-01T01:02:03.000Z', updatedAt = '2026-05-02T04:05:06.000Z'
const oldImage = { prompt: '', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'high', format: 'png' } as const
const oldMusic = { prompt: '', mode: 'instrumental', model: 'mureka-9.5', count: 20, styles: [] } as const
const image = { prompt: '', model: 'Qwen/Qwen-Image', size: '1664x928' }
const video = { initialized: false, audioIds: [], durationMode: 'target', targetSeconds: 3600, transition: 'crossfade', transitionSeconds: 3,
  fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain' } as const
let root: string, dataDir: string, defaultMediaRoot: string
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required; tests must not touch a user profile')
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'migration-v4-'))
  dataDir = path.join(root, 'profile'); defaultMediaRoot = path.join(root, 'fresh-media')
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function save(file: string, value: unknown): Promise<Buffer> {
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(` \r\n${JSON.stringify(value, null, 3)}\r\n`); await writeFile(file, bytes); return bytes
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
function settings(lastProjectId?: string): Settings {
  return { version: 4, projectRoot: path.join(root, 'old-project-root'), aceStep: legacyDefaultAceStep(), musicDefaults: { ...oldMusic, styles: [], provider: 'mureka' }, imageDefaults: image, ...(lastProjectId ? { lastProjectId } : {}) }
}
const noDecrypt = () => ({ isEncryptionAvailable: () => false,
  encryptString: vi.fn((): Buffer => { throw new Error('must not encrypt') }), decryptString: vi.fn((): string => { throw new Error('must not decrypt') }) })
async function stores(mediaRoot = defaultMediaRoot) {
  const db = new WorkbenchDB(dataDir); await db.init()
  const assets = new AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => undefined }); await assets.init()
  const encryption = noDecrypt(), secrets = new SecretStore(dataDir, encryption); await secrets.init()
  return { db, assets, secrets, encryption }
}
function v1Project() {
  const id = randomUUID(), batchId = randomUUID(), musicId = randomUUID(), imageId = randomUUID(), audioId = randomUUID()
  return { version: 1, id, name: '原固定生成会话', directory: path.join(root, 'old', id), createdAt, updatedAt, music: { ...oldMusic, styles: [] }, image: oldImage,
    batches: [{ id: batchId, total: 3, createdAt, state: 'running' }],
    musicJobs: [
      { id: musicId, batchId, index: 0, createdAt, status: 'succeeded', snapshot: { ...oldMusic, styles: [] }, taskId: 'accepted-old-id' },
      { id: randomUUID(), batchId, index: 1, createdAt, status: 'running', snapshot: { ...oldMusic, styles: [] }, taskId: 'resume-only-id' },
      { id: randomUUID(), batchId, index: 2, createdAt, status: 'pending', snapshot: { ...oldMusic, styles: [] } },
      { id: randomUUID(), batchId, index: 3, createdAt, status: 'submitting', snapshot: { ...oldMusic, styles: [] } }
    ], imageJobs: [{ id: imageId, createdAt, status: 'submitting', snapshot: oldImage }],
    audio: [{ id: audioId, jobId: musicId, taskId: 'accepted-old-id', remoteId: 'remote-one', title: '原曲名', fileName: `audio/${audioId}.mp3`, durationMs: 180000, createdAt,
      model: 'mureka-9.5', prompt: '原提示', mode: 'instrumental', kept: false }], images: [] }
}
function v4Project(): Project {
  const id = randomUUID(), jobId = randomUUID(), batchId = randomUUID(), imageId = randomUUID(), imageJob = randomUUID()
  const audioIds = [randomUUID(), randomUUID(), randomUUID()]
  const music = { ...oldMusic, styles: [], provider: 'mureka' as const }
  return { version: 4, id, name: '不能改写的项目名', directory: path.join(root, 'old', id), createdAt, updatedAt, music, image,
    batches: [{ id: batchId, createdAt, total: 1, state: 'completed' }], musicJobs: [{ id: jobId, batchId, index: 0, createdAt, status: 'succeeded', taskId: 'original-task-id', actualModel: 'mureka-9.5', snapshot: music,
      binding: { provider: 'mureka', adapterVersion: 1 }, outputs: audioIds.slice(0, 2).map((id, index) => ({ id: randomUUID(), assetId: id, index, locator: String(index).repeat(64), status: 'saved', remoteId: `choice-${index}`, title: `原名称${index}` })) }],
    imageJobs: [{ id: imageJob, createdAt, status: 'succeeded', provider: 'siliconflow', snapshot: image }],
    audio: audioIds.map((id, index) => ({ id, jobId: index < 2 ? jobId : randomUUID(), taskId: 'original-task-id', provider: 'mureka', remoteId: `choice-${index}`, title: `原曲名${index}`, fileName: `audio/${id}.mp3`, durationMs: 180000,
      createdAt, model: 'mureka-9.5', prompt: '原提示', mode: 'instrumental', kept: true })),
    images: [{ id: imageId, jobId: imageJob, createdAt, fileName: `images/${imageId}.png`, model: image.model, prompt: '原图片提示', size: image.size, provider: 'siliconflow', format: 'png' }],
    video: { ...video, audioIds, initialized: true, imageId }, videoJobs: [] }
}
async function seedProject(project: { id: string; directory: string }, oldSettings: unknown = settings(project.id)): Promise<void> {
  await save(path.join(dataDir, 'settings.json'), oldSettings)
  await save(path.join(dataDir, 'projects.json'), { version: 1, projects: [{ id: project.id, directory: project.directory }] })
  await save(path.join(project.directory, 'project.json'), project)
}
async function library(project: Project) {
  const canonical = randomUUID(), alias = randomUUID(), imageId = randomUUID(), mediaRoot = path.join(root, 'existing-library')
  const records: LibraryRecord[] = [canonical, alias].map((id, index) => ({ version: 1, item: { id, kind: 'audio', name: '已命名库音乐', createdAt, sha256: 'a'.repeat(64), bytes: 100,
    format: 'mp3', durationSeconds: 180, available: false, problem: '原文件缺失', origins: [{ type: 'project', name: project.name, projectId: project.id, assetId: project.audio[index].id }] },
    locations: [{ type: 'project', directory: project.directory, projectId: project.id, assetId: project.audio[index].id, fileName: project.audio[index].fileName }], importPaths: [], ...(index ? { aliasOf: canonical } : {}) }))
  records.push({ version: 1, item: { id: imageId, kind: 'image', name: '旧图片名', createdAt, sha256: 'b'.repeat(64), bytes: 50, format: 'png', width: 64, height: 64,
    available: false, problem: '原文件缺失', origins: [{ type: 'project', name: project.name, projectId: project.id, assetId: project.images[0].id }] },
    locations: [{ type: 'project', directory: project.directory, projectId: project.id, assetId: project.images[0].id, fileName: project.images[0].fileName }], importPaths: [] })
  await save(path.join(dataDir, 'library', 'config.json'), { version: 1, root: mediaRoot })
  await save(path.join(dataDir, 'library', 'index.json'), { version: 1, ids: records.map(record => record.item.id) })
  for (const record of records) await save(path.join(dataDir, 'library', 'items', `${record.item.id}.json`), record)
  return { canonical, alias, imageId, mediaRoot, records }
}
function batch(audioId: string, imageId: string, status: 'succeeded' | 'encoding'): VideoBatch {
  const id = randomUUID(), planId = randomUUID(), jobId = randomUUID(), group = { imageId, audioIds: [audioId], durationSeconds: 180, issues: [] }
  return { version: 1, id, planId, name: '原批次名称', createdAt, updatedAt, directory: path.join(root, `原批次-${id}`), state: status === 'succeeded' ? 'completed' : 'running',
    plan: { id: planId, createdAt, request: { name: '原批次名称', audioIds: [audioId], imageIds: [imageId], minimumSeconds: 60, transition: 'cut', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain' },
      assets: [{ id: audioId, kind: 'audio', name: '已命名库音乐', sha256: 'a'.repeat(64), bytes: 100, durationSeconds: 180 }, { id: imageId, kind: 'image', name: '旧图片名', sha256: 'b'.repeat(64), bytes: 50 }], groups: [group], issues: [] },
    jobs: [{ id: jobId, index: 0, group, status, ...(status === 'succeeded' ? { fileName: `videos/${jobId}.mp4`, durationSeconds: 180, finishedAt: updatedAt } : {}) }] }
}

/** Isolates reconciliation tests from codecs; real AssetStore is exercised in the other tests. */
type MigrationAssets = V4MigrationOptions['assets']
class AssetStub implements MigrationAssets {
  readonly roots = new Map<string, { directory: string; owned: boolean }>()
  readonly entries = new Map<string, WorkbenchAsset>()
  readonly aliases = new Map<string, string>()
  readonly usages = new Map<string, UsageRecord>()
  readonly registrations: AssetRegistration[] = []
  async registerRoot(directory: string, owned: boolean): Promise<string> { const id = stableMigrationId(directory); this.roots.set(id, { directory, owned }); return id }
  async get(id: string): Promise<WorkbenchAsset> { const asset = this.entries.get(this.aliases.get(id) ?? id); if (!asset) throw new Error('missing asset'); return structuredClone(asset) }
  async alias(id: string, target: string): Promise<void> { this.aliases.set(id, (await this.get(target)).id) }
  async register(input: AssetRegistration): Promise<WorkbenchAsset> {
    this.registrations.push(input)
    let bytes: Buffer | undefined
    try { bytes = await readFile(path.join(this.roots.get(input.rootId)!.directory, input.fileName)) } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
    const sha256 = bytes ? hash(bytes) : input.expectedSha256
    const duplicate = bytes ? [...this.entries.values()].find(asset => asset.kind === input.kind && asset.sha256 === sha256) : undefined
    const id = duplicate?.id ?? this.aliases.get(input.id) ?? input.id
    if (id !== input.id) this.aliases.set(input.id, id)
    const prior = this.entries.get(id)
    const asset: WorkbenchAsset = { id, kind: input.kind, name: prior?.name ?? input.name, createdAt: input.createdAt, updatedAt, available: !!bytes, sha256, ...input.metadata,
      origins: [...(prior?.origins ?? []), input.origin], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false }
    this.entries.set(id, asset); return structuredClone(asset)
  }
  async recordUsage(usage: UsageRecord): Promise<void> {
    const previous = this.usages.get(usage.id)
    if (previous && !isDeepStrictEqual(previous, usage)) throw new Error('usage conflict')
    this.usages.set(usage.id, structuredClone(usage))
  }
  async allUsage(): Promise<UsageRecord[]> { return structuredClone([...this.usages.values()]) }
}

describe('V4 migration independent storage', () => {
  it('fresh inspection is read-only; installs empty projects/APIs and fixed V5 render defaults', async () => {
    expect(await inspectV4Migration(dataDir, defaultMediaRoot)).toEqual({ mediaRoot: defaultMediaRoot, legacySettings: undefined, warnings: [] })
    await expect(readdir(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    const storesValue = await stores(); const { db, assets, secrets, encryption } = storesValue
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.list('generation')).toEqual([]); expect(db.list('composition')).toEqual([]); expect(db.list('apis')).toEqual([])
    expect(db.get('settings', 'current')).toEqual({ version: 5, mediaRoot: defaultMediaRoot, page: 'generation', render: { concurrency: 2, threads: 4, encoder: 'auto' } })
    expect(encryption.decryptString).not.toHaveBeenCalled(); expect(encryption.encryptString).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).version).toBe(5)
  })

  it('decodes V1 + fixed session without count expansion or provider substitution, backing up exact encrypted originals', async () => {
    const project = v1Project(), settingsFile = path.join(dataDir, 'settings.json')
    await seedProject(project, { version: 1, projectRoot: path.join(root, 'old-settings-root'), musicDefaults: { ...oldMusic, styles: [] }, imageDefaults: oldImage, lastProjectId: project.id })
    const mediaRoot = path.join(root, 'preferred-library')
    await save(path.join(dataDir, 'library', 'config.json'), { version: 1, root: mediaRoot, generationProjectId: project.id })
    const originalSecret = await save(path.join(dataDir, 'secrets.json'), { version: 1, keys: { mureka: 'ZW5jcnlwdGVk', openai: 'bGVnYWN5LW9wZW5haQ==' } })
    const originalProject = await readFile(path.join(project.directory, 'project.json')), originalSettings = await readFile(settingsFile), originalIndex = await readFile(path.join(dataDir, 'projects.json'))
    expect((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot).toBe(mediaRoot)
    expect(await readFile(settingsFile)).toEqual(originalSettings)
    await expect(readdir(path.join(dataDir, 'migration-v4'))).rejects.toMatchObject({ code: 'ENOENT' })
    const { db, assets, secrets, encryption } = await stores(mediaRoot)
    const upgradedSecret = await readFile(path.join(dataDir, 'secrets.json'))
    const result = await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.list('generation')).toHaveLength(1); expect(db.get('generation', project.id).name).toBe(project.name)
    expect(db.list('entries')).toHaveLength(7); expect(db.list('requests')).toHaveLength(5)
    expect(db.list('entries').every(entry => !('count' in entry.draft))).toBe(true)
    expect(db.get('requests', project.musicJobs[1].id)).toMatchObject({ status: 'paused', taskId: 'resume-only-id', recoverable: true })
    expect(db.get('requests', project.musicJobs[2].id)).toMatchObject({ status: 'paused', recoverable: false, detail: expect.stringContaining('明确确认') })
    expect(db.get('requests', project.musicJobs[3].id)).toMatchObject({ status: 'unknown', recoverable: false })
    expect(db.get('requests', project.imageJobs[0].id)).toMatchObject({ status: 'unknown', binding: { provider: 'openai', adapterVersion: 1 }, legacyImage: true })
    expect(db.get('requests', project.imageJobs[0].id).snapshot.provider).toBeUndefined()
    expect(db.list('apis').map(api => api.provider)).toEqual(['mureka']); expect(result.warnings.join(' ')).toContain('无法判断')
    expect(db.get('settings', 'current').lastGenerationId).toBe(project.id); expect(db.list('composition')).toEqual([])
    expect(await readFile(path.join(project.directory, 'project.json'))).toEqual(originalProject); expect(await readFile(path.join(dataDir, 'projects.json'))).toEqual(originalIndex)
    expect(await readFile(path.join(dataDir, 'secrets.json'))).toEqual(upgradedSecret)
    const backupDir = path.join(dataDir, 'migration-v4', 'backup'), manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8')) as { sources: Array<{ source: string; backup: string; sha256: string }> }
    for (const source of manifest.sources) expect(hash(await readFile(path.join(backupDir, source.backup)))).toBe(source.sha256)
    expect(manifest.sources.some(source => source.sha256 === hash(originalSecret))).toBe(true)
    expect(manifest.sources.find(source => source.source === settingsFile)?.sha256).toBe(hash(originalSettings))
    expect(encryption.decryptString).not.toHaveBeenCalled(); expect(encryption.encryptString).not.toHaveBeenCalled()
  })

  it('retains library canonical IDs/aliases, multiple results, independent batches, missing short videos and uncertain historical tails', async () => {
    const project = v4Project(), videoId = randomUUID(), previewId = randomUUID()
    project.videoJobs = [{ id: videoId, kind: 'video', status: 'succeeded', snapshot: project.video, createdAt, finishedAt: updatedAt, fileName: `videos/${videoId}.mp4`, durationSeconds: 14 },
      { id: previewId, kind: 'preview', status: 'succeeded', snapshot: project.video, createdAt, fileName: `previews/${previewId}.wav`, durationSeconds: 8 },
      { id: randomUUID(), kind: 'video', status: 'encoding', snapshot: project.video, createdAt }]
    await seedProject(project)
    const lib = await library(project), done = batch(lib.alias, lib.imageId, 'succeeded'), active = batch(lib.canonical, lib.imageId, 'encoding')
    await save(path.join(dataDir, 'video-batches', 'index.json'), { version: 1, ids: [done.id, active.id] })
    for (const value of [done, active]) await save(path.join(dataDir, 'video-batches', `${value.id}.json`), value)
    const { db, assets, secrets } = await stores((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    const request = db.get('requests', project.musicJobs[0].id)
    expect(request.outputs?.map(output => output.id)).toEqual(project.musicJobs[0].outputs?.map(output => output.id))
    expect(request.outputs?.map(output => output.assetId)).toEqual([lib.canonical, lib.canonical]); expect(request.assetIds).toEqual([lib.canonical])
    expect((await assets.get(lib.alias)).id).toBe(lib.canonical); expect((await assets.get(lib.canonical)).name).toBe('已命名库音乐')
    const tailId = stableMigrationId(`asset/${project.id}/${project.audio[2].id}`)
    expect((await assets.get(tailId)).origins.some(origin => origin.legacyAssetId === project.audio[2].id)).toBe(true)
    expect(db.list('composition')).toHaveLength(3)
    const single = db.get('composition', stableMigrationId(`composition/single/${project.id}`))
    expect(single.draft).toMatchObject({ minimumSeconds: 60, audioIds: [lib.canonical, tailId], imageIds: [lib.imageId] })
    expect(single.draft).not.toHaveProperty('targetSeconds'); expect(single.migrationNote).toContain('重新规划')
    expect(db.get('executions', done.id)).toMatchObject({ version: 2, planId: done.planId, state: 'completed', jobs: [{ id: done.jobs[0].id, status: 'succeeded', videoAssetId: done.jobs[0].id }] })
    expect(db.get('executions', active.id)).toMatchObject({ state: 'paused', jobs: [{ id: active.jobs[0].id, status: 'interrupted' }] })
    expect(db.get('executions', done.id)).not.toHaveProperty('directory')
    expect((await assets.get(videoId)).available).toBe(false); await expect(assets.get(previewId)).rejects.toThrow()
    const usage = (await assets.allUsage()).find(usage => usage.id === videoId)!
    expect(usage.durationSeconds).toBe(14); expect(usage.assetIds).toEqual([lib.canonical, lib.imageId].sort()); expect(usage.uncertainAssetIds).toEqual([tailId])
    expect((await assets.get(lib.canonical)).usedCount).toBe(2); expect((await assets.get(tailId)).historyUncertain).toBe(true)
    expect(db.get('settings', 'current').lastCompositionId).toBe(single.id); expect(single.id).not.toBe(project.id)
  })

  it('preserves count-free ACE drafts and original connection/task binding even with no local key', async () => {
    const project = v4Project(), connection = legacyDefaultAceStep()
    project.music = { provider: 'acestep', model: 'default', prompt: '', count: 9, styles: [], mode: 'song', inputMode: 'description', language: 'zh', seconds: 600 }
    project.musicJobs = [{ id: randomUUID(), batchId: project.batches[0].id, index: 0, createdAt, status: 'running', taskId: 'accepted-local-job', snapshot: project.music,
      binding: { provider: 'acestep', adapterVersion: 1, local: { baseUrl: connection.baseUrl, connectionId: connection.connectionId } } }]
    project.audio = []; project.images = []; project.imageJobs = []; project.video = { ...video, audioIds: [] }
    await seedProject(project)
    const inspected = await inspectV4Migration(dataDir, defaultMediaRoot)
    expect(inspected.mediaRoot).toBe(path.join(settings().projectRoot, '总素材库'))
    const { db, assets, secrets, encryption } = await stores(inspected.mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.list('apis')).toEqual([expect.objectContaining({ provider: 'acestep', local: connection })])
    expect(db.list('apis')[0]).not.toHaveProperty('hasKey')
    expect(db.get('requests', project.musicJobs[0].id)).toMatchObject({ status: 'paused', taskId: 'accepted-local-job', binding: project.musicJobs[0].binding })
    expect(encryption.decryptString).not.toHaveBeenCalled()
  })

  it.each(['custom-address', 'custom-wait', 'saved-key'] as const)('adopts ACE only on positive %s evidence, leaving V3 ciphertext untouched', async evidence => {
    const legacy = settings()
    if (evidence === 'custom-address') legacy.aceStep.baseUrl = 'http://127.0.0.1:8002'
    if (evidence === 'custom-wait') legacy.aceStep.waitMinutes = 90
    await save(path.join(dataDir, 'settings.json'), legacy)
    const secretBytes = await save(path.join(dataDir, 'secrets.json'), { version: 3, keys: evidence === 'saved-key' ? { acestep: 'ZW5jcnlwdGVk' } : {}, ...(evidence === 'saved-key' ? { aceStepConnectionId: legacy.aceStep.connectionId } : {}) })
    const { db, assets, secrets } = await stores((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.list('apis').map(api => api.provider)).toEqual(['acestep']); expect(await readFile(path.join(dataDir, 'secrets.json'))).toEqual(secretBytes)
  })

  it('reconciles prepared receipts by hash, keeps orphan committed receipts, and never re-renders or registers external originals as owned', async () => {
    await save(path.join(dataDir, 'settings.json'), settings())
    const assets = new AssetStub(), db = new WorkbenchDB(dataDir); await db.init()
    const id = randomUUID(), orphanId = randomUUID(), sourceId = randomUUID(), ownerId = randomUUID(), directory = path.join(root, 'old-output')
    const content = Buffer.from('isolated published video bytes for receipt hashing only')
    await mkdir(path.join(directory, 'videos'), { recursive: true }); await writeFile(path.join(directory, 'videos', `${id}.mp4`), content)
    const receipt = { version: 1, id, ownerId, kind: 'batch', name: '原发布名称', state: 'prepared', finishedAt: updatedAt, durationSeconds: 14, assetIds: [sourceId], directory, fileName: `videos/${id}.mp4`, sha256: hash(content), bytes: content.length }
    const receiptBytes = await save(path.join(dataDir, 'export-receipts', `${id}.json`), receipt)
    // Independent missing output, not an identical-byte alias whose canonical name depends on UUID order.
    const orphanContent = Buffer.from('different isolated orphan video payload')
    await save(path.join(dataDir, 'export-receipts', `${orphanId}.json`), { ...receipt, id: orphanId, fileName: `videos/${orphanId}.mp4`, state: 'committed', sha256: hash(orphanContent), bytes: orphanContent.length })
    const external = path.join(root, 'external', 'song.mp3'), libraryId = randomUUID()
    const oldRecord: LibraryRecord = { version: 1, item: { id: libraryId, kind: 'audio', name: '外部原名', createdAt, sha256: 'a'.repeat(64), bytes: 100, format: 'mp3', durationSeconds: 80, available: false, problem: '缺文件', origins: [{ type: 'import', name: 'song.mp3' }] },
      importPaths: [external], locations: [{ type: 'managed', fileName: `audio/${libraryId}.mp3` }] }
    await save(path.join(dataDir, 'library', 'config.json'), { version: 1, root: defaultMediaRoot })
    await save(path.join(dataDir, 'library', 'items', `${libraryId}.json`), oldRecord)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'))
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets: { has: () => false } })
    expect((await assets.allUsage()).map(record => record.id).sort()).toEqual([id, orphanId].sort())
    expect((await assets.get(id)).name).toBe(`${id}.mp4`); expect((await assets.get(orphanId)).available).toBe(false)
    expect(await readFile(path.join(dataDir, 'export-receipts', `${id}.json`))).toEqual(receiptBytes)
    expect([...assets.roots.values()].some(root => root.directory === external || root.directory === path.dirname(external))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('registers only frozen UUID-related audio original/saver paths and retains orphan generation results', async () => {
    const project = v4Project(), asset = project.audio[2]
    asset.originalFileName = `audio-originals/${asset.id}.ogg`; asset.originalSha256 = 'c'.repeat(64)
    await seedProject(project)
    const assets = new AssetStub(), db = new WorkbenchDB(dataDir); await db.init()
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets: { has: () => false } })
    const registration = assets.registrations.find(input => input.origin.legacyAssetId === asset.id)!
    expect(registration.relatedFiles).toEqual([asset.originalFileName, ...['manifest.json', 'source.bin', 'compatible.flac', 'download.part'].map(name => `.generated-audio/${asset.id}/${name}`)])
    expect(registration.origin.requestId).toBeUndefined(); expect(registration.origin.projectId).toBe(project.id)
  })

  it('resumes after committed-row interruption using backups/stable IDs, then never resurrects deletions or rescans old files', async () => {
    const project = v4Project(); await seedProject(project); const lib = await library(project)
    const { db, assets, secrets } = await stores((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot)
    const commit = db.commit.bind(db)
    const interrupted = vi.spyOn(db, 'commit').mockImplementationOnce(async changes => { await commit(changes); throw new Error('simulated power failure after rows') })
    await expect(migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })).rejects.toThrow('simulated power')
    const beforeEntries = db.list('entries').map(entry => entry.id)
    interrupted.mockRestore()
    await writeFile(path.join(project.directory, 'project.json'), '{now-unreadable-source')
    expect((await inspectV4Migration(dataDir, path.join(root, 'wrong-new-default'))).mediaRoot).toBe(lib.mediaRoot)
    const restarted = new WorkbenchDB(dataDir); await restarted.init()
    await migrateV4({ dataDir, defaultMediaRoot, db: restarted, assets, secrets })
    expect(restarted.list('entries').map(entry => entry.id).sort()).toEqual(beforeEntries.sort())
    await assets.delete(lib.canonical)
    await restarted.update('generation', project.id, value => { value.deletedAt = updatedAt })
    const settingsBefore = restarted.get('settings', 'current'); await restarted.put('settings', 'current', { ...settingsBefore, page: 'library', mediaRoot: path.join(root, 'changed-current-root') })
    await writeFile(path.join(dataDir, 'library', 'index.json'), 'corrupt source after completed migration')
    const register = vi.spyOn(assets, 'register'), again = await migrateV4({ dataDir, defaultMediaRoot, db: restarted, assets, secrets })
    expect(again.warnings).toBeInstanceOf(Array); expect(register).not.toHaveBeenCalled()
    expect((await assets.get(lib.canonical)).deletedAt).toBeDefined(); expect(restarted.get('generation', project.id).deletedAt).toBe(updatedAt)
    expect((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot).toBe(path.join(root, 'changed-current-root'))
    expect(restarted.get('settings', 'current').page).toBe('library')
  })

  it.each(['settings', 'project', 'library', 'batch', 'receipt'] as const)('blocks corrupt/missing %s sources without replacing any old index or creating a migration backup', async kind => {
    await save(path.join(dataDir, 'settings.json'), settings())
    let file: string
    if (kind === 'settings') { file = path.join(dataDir, 'settings.json'); await writeFile(file, '{broken') }
    else if (kind === 'project') { file = path.join(dataDir, 'projects.json'); await save(file, { version: 1, projects: [{ id: randomUUID(), directory: path.join(root, 'missing-project') }] }) }
    else if (kind === 'library') { file = path.join(dataDir, 'library', 'index.json'); await save(path.join(dataDir, 'library', 'config.json'), { version: 1, root: defaultMediaRoot }); await save(file, { version: 1, ids: [randomUUID()] }) }
    else if (kind === 'batch') { file = path.join(dataDir, 'video-batches', 'index.json'); await save(file, { version: 1, ids: [randomUUID()] }) }
    else { file = path.join(dataDir, 'export-receipts', `${randomUUID()}.json`); await save(file, { version: 1 }) }
    const original = await readFile(file)
    await expect(inspectV4Migration(dataDir, defaultMediaRoot)).rejects.toThrow(/V4 迁移停止/)
    const db = new WorkbenchDB(dataDir); await db.init(); const assets = new AssetStub()
    await expect(migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets: { has: () => false } })).rejects.toThrow(/不会替换为空库/)
    expect(await readFile(file)).toEqual(original); expect(assets.registrations).toEqual([]); expect(db.list('generation')).toEqual([])
    await expect(readdir(path.join(dataDir, 'migration-v4'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses prepared hash mismatch and tampered recovery backups without marking completion', async () => {
    await save(path.join(dataDir, 'settings.json'), settings())
    const id = randomUUID(), directory = path.join(root, 'output'), data = Buffer.from('the original bytes')
    await mkdir(path.join(directory, 'videos'), { recursive: true }); await writeFile(path.join(directory, 'videos', `${id}.mp4`), data)
    await save(path.join(dataDir, 'export-receipts', `${id}.json`), { version: 1, id, ownerId: randomUUID(), kind: 'project', name: 'original', state: 'prepared', finishedAt: updatedAt, durationSeconds: 14,
      assetIds: [randomUUID()], directory, fileName: `videos/${id}.mp4`, sha256: '0'.repeat(64), bytes: data.length })
    const db = new WorkbenchDB(dataDir); await db.init(); const assets = new AssetStub(), options = { dataDir, defaultMediaRoot, db, assets, secrets: { has: () => false } }
    await expect(migrateV4(options)).rejects.toThrow(/prepared 回执指纹不符/)
    expect(await assets.allUsage()).toEqual([]); expect(db.list('settings')).toEqual([])
    const backupDir = path.join(dataDir, 'migration-v4', 'backup'), names = await readdir(backupDir)
    await writeFile(path.join(backupDir, names.find(name => name.endsWith('.bak'))!), 'tampered')
    await expect(inspectV4Migration(dataDir, defaultMediaRoot)).rejects.toThrow(/备份内容或来源映射不符/)
    await expect(readFile(path.join(dataDir, 'migration-v4', 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([2, 3] as const)('purely decodes V%s projects and settings without rewriting historical shapes', async version => {
    const old = v1Project()
    const project = { ...old, version, video: { ...video, audioIds: [] }, videoJobs: [], ...(version === 3 ? { image, imageJobs: old.imageJobs.map(job => ({ ...job, provider: 'openai' })) } : {}) }
    await seedProject(project, { version, projectRoot: path.join(root, 'old-root'), musicDefaults: { ...oldMusic, styles: [] }, imageDefaults: version === 3 ? image : oldImage, lastProjectId: project.id })
    const original = await readFile(path.join(project.directory, 'project.json'))
    const { db, assets, secrets } = await stores((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.get('generation', project.id).entryIds).toHaveLength(7)
    expect(db.get('requests', old.imageJobs[0].id).binding.provider).toBe('openai')
    expect(await readFile(path.join(project.directory, 'project.json'))).toEqual(original)
  })

  it('prefers committed usage over inferred successful-job selections, including alias deduplication', async () => {
    const project = v4Project(), id = randomUUID()
    project.videoJobs = [{ id, kind: 'video', status: 'succeeded', snapshot: project.video, createdAt, finishedAt: updatedAt, fileName: `videos/${id}.mp4`, durationSeconds: 14 }]
    await seedProject(project); const lib = await library(project)
    await save(path.join(dataDir, 'export-receipts', `${id}.json`), { version: 1, id, ownerId: project.id, kind: 'project', name: '回执原名', state: 'committed', finishedAt: updatedAt,
      durationSeconds: 14, assetIds: [lib.alias, lib.canonical], directory: project.directory, fileName: `videos/${id}.mp4`, sha256: 'e'.repeat(64), bytes: 12 })
    const { db, assets, secrets } = await stores(lib.mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(await assets.allUsage()).toEqual([expect.objectContaining({ id, name: '回执原名', assetIds: [lib.canonical], uncertainAssetIds: [] })])
    expect((await assets.get(lib.canonical)).usedCount).toBe(1)
    expect((await assets.get(stableMigrationId(`asset/${project.id}/${project.audio[2].id}`))).historyUncertain).toBe(false)
  })

  it('reconciles a published prepared batch output to succeeded without replaying its old interrupted render', async () => {
    const project = v4Project(); await seedProject(project); const lib = await library(project), active = batch(lib.alias, lib.imageId, 'encoding'), job = active.jobs[0]
    await save(path.join(dataDir, 'video-batches', `${active.id}.json`), active)
    const bytes = Buffer.from('prepared published bytes only; codec validation stubbed')
    await mkdir(path.join(active.directory, 'videos'), { recursive: true }); await writeFile(path.join(active.directory, 'videos', `${job.id}.mp4`), bytes)
    await save(path.join(dataDir, 'export-receipts', `${job.id}.json`), { version: 1, id: job.id, ownerId: active.id, kind: 'batch', name: active.name, state: 'prepared', finishedAt: updatedAt,
      durationSeconds: 14, assetIds: [lib.alias, lib.imageId], directory: active.directory, fileName: `videos/${job.id}.mp4`, sha256: hash(bytes), bytes: bytes.length })
    const db = new WorkbenchDB(dataDir); await db.init(); const assets = new AssetStub()
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets: { has: () => false } })
    expect(db.get('executions', active.id)).toMatchObject({ state: 'completed', jobs: [{ id: job.id, status: 'succeeded', videoAssetId: job.id, durationSeconds: 14 }] })
    expect(await assets.allUsage()).toHaveLength(1)
  })

  it('resumes an interrupted asset registration from the same stable identities after reopening the real store', async () => {
    const project = v4Project(); await seedProject(project)
    const inspected = await inspectV4Migration(dataDir, defaultMediaRoot), { db, assets, secrets } = await stores(inspected.mediaRoot)
    const original = assets.register.bind(assets)
    const failure = vi.spyOn(assets, 'register').mockImplementationOnce(async input => { await original(input); throw new Error('registration interrupted after durable write') })
    await expect(migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })).rejects.toThrow('registration interrupted')
    expect(db.list('generation')).toEqual([]); failure.mockRestore()
    const reopened = new AssetStore({ dataDir, root: inspected.mediaRoot, getFFmpegPath: () => undefined }); await reopened.init()
    await migrateV4({ dataDir, defaultMediaRoot, db, assets: reopened, secrets })
    const all = await reopened.all()
    expect(all).toHaveLength(4); expect(new Set(all.map(asset => asset.id)).size).toBe(4)
    for (const asset of [...project.audio, ...project.images]) expect(all.some(value => value.id === stableMigrationId(`asset/${project.id}/${asset.id}`))).toBe(true)
  })

  it('does not turn ACE global defaults into an added API and will not choose a fresh root for missing old settings', async () => {
    const legacy = settings(); legacy.musicDefaults = { provider: 'acestep', model: 'default', prompt: '', mode: 'instrumental', count: 20, styles: [], inputMode: 'description' }
    await save(path.join(dataDir, 'settings.json'), legacy)
    const { db, assets, secrets } = await stores((await inspectV4Migration(dataDir, defaultMediaRoot)).mediaRoot)
    await migrateV4({ dataDir, defaultMediaRoot, db, assets, secrets })
    expect(db.list('apis')).toEqual([]); expect(db.list('entries')).toEqual([])
    const other = path.join(root, 'missing-root-profile')
    await save(path.join(other, 'projects.json'), { version: 1, projects: [] })
    await expect(inspectV4Migration(other, defaultMediaRoot)).rejects.toThrow('媒体根设置缺失')
  })
})
