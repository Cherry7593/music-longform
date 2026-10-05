import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE, DEFAULT_MUSIC, DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { ImageAsset, Project } from '../../src/shared/types'
import { AppError } from '../../src/main/providers/http'
import * as atomic from '../../src/main/storage/atomic'
import { LibraryStore, type LibraryStoreOptions } from '../fixtures/v31/main/storage/library'
import { existingAssetPath } from '../../src/main/storage/paths'
import { LIBRARY_LIMITS } from '../../src/main/storage/library-validation'
import * as ffmpeg from '../../src/main/video/ffmpeg'

vi.mock('../../src/main/storage/atomic', async original => ({ ...await original<typeof import('../../src/main/storage/atomic')>() }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), requireTools: vi.fn().mockRejectedValue(new AppError('未找到 FFmpeg，请配置工具后重新校验。')) }))
let root: string
let data: string
let projects: Project[]
let options: LibraryStoreOptions
const picture = (background = '#a43211') => sharp({ create: { width: 32, height: 24, channels: 3, background } }).withMetadata({ density: 96 }).png().toBuffer()
async function source(name = '中文 原图.png', bytes?: Buffer): Promise<string> {
  const file = join(root, name); await writeFile(file, bytes ?? await picture()); return file
}
async function store(): Promise<LibraryStore> { const result = new LibraryStore(options); await result.init(); return result }
async function projectImage(bytes?: Buffer): Promise<{ project: Project; asset: ImageAsset; file: string }> {
  const id = randomUUID(); const assetId = randomUUID(); const now = new Date().toISOString()
  const project: Project = {
    version: 4, id, name: '历史 来源', directory: join(root, id), createdAt: now, updatedAt: now,
    music: structuredClone(DEFAULT_MUSIC), image: structuredClone(DEFAULT_IMAGE), video: structuredClone(DEFAULT_VIDEO),
    musicJobs: [], batches: [], imageJobs: [], audio: [], images: [], videoJobs: []
  }
  const asset: ImageAsset = { id: assetId, jobId: randomUUID(), fileName: `images/${assetId}.png`, createdAt: now, provider: 'siliconflow', model: 'legacy-model', prompt: '不能改写的生成提示词', size: '32x24', format: 'png' }
  project.images.push(asset); project.selectedImageId = asset.id
  await mkdir(join(project.directory, 'images'), { recursive: true })
  const file = join(project.directory, asset.fileName)
  if (bytes) await writeFile(file, bytes)
  await writeFile(join(project.directory, 'project.json'), JSON.stringify(project))
  projects.push(project)
  return { project, asset, file }
}
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'library-storage-'))
  data = join(root, 'data'); projects = []
  options = {
    dataDir: data, defaultRoot: join(root, '托管 素材'), getFFmpegPath: () => undefined,
    projects: {
      all: vi.fn(async () => structuredClone(projects)),
      get: vi.fn(async id => { const found = projects.find(project => project.id === id); if (!found) throw new AppError('项目不存在'); return structuredClone(found) }),
      pathForAsset: vi.fn(async (projectId, kind, id) => {
        const project = projects.find(project => project.id === projectId)!
        const asset = (kind === 'image' ? project.images : project.audio).find(asset => asset.id === id)!
        return existingAssetPath(project.directory, kind, id, asset.fileName)
      })
    }
  }
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('LibraryStore durable bounded metadata', () => {
  it('persists root and generation session independently, clones public data, only notifies durable commits', async () => {
    const { project } = await projectImage()
    const library = await store(); const notify = vi.fn(() => { throw new Error('observer failure') }); library.onChanged = notify
    await library.configureRoot(join(root, '首次 自选'))
    await library.setGenerationProject(project.id)
    library.getConfig().root = 'not persisted'
    const reopened = await store()
    expect(reopened.getConfig()).toEqual({ version: 1, root: join(root, '首次 自选'), generationProjectId: project.id })
    expect(notify).toHaveBeenCalledTimes(2)
    const item = (await reopened.all())[0]
    expect(item).not.toHaveProperty('locations'); expect(item).not.toHaveProperty('usages'); expect(item).not.toHaveProperty('importPaths')
    item.origins.length = 0
    expect((await reopened.get(item.id)).origins).toHaveLength(1)
    await expect(readFile(join(data, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['broken JSON', 'null', '{"version":99,"ids":[]}', '{"version":1,"ids":["../outside"]}'])('preserves corrupt index bytes: %s', async bytes => {
    await mkdir(join(data, 'library'), { recursive: true })
    const file = join(data, 'library', 'index.json'); await writeFile(file, bytes)
    await expect(store()).rejects.toThrow('原文件未被覆盖')
    expect(await readFile(file, 'utf8')).toBe(bytes)
    await expect(readFile(join(data, 'library', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['null', 'false', '{}'])('does not replace structurally corrupt config with default root: %s', async bytes => {
    await store()
    const file = join(data, 'library', 'config.json'); await writeFile(file, bytes)
    await expect(store()).rejects.toThrow('原文件未被覆盖')
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })

  it('rejects oversized index, corrupt config and indexed missing/corrupt details without clearing data', async () => {
    const library = await store(); const file = await source()
    const id = (await library.importFiles([file], 'image')).entries[0].assetId!
    const detail = join(data, 'library', 'items', `${id}.json`)
    const index = join(data, 'library', 'index.json'); const savedIndex = await readFile(index)
    await writeFile(index, Buffer.alloc(LIBRARY_LIMITS.indexBytes + 1, 32))
    await expect(store()).rejects.toThrow('未被覆盖')
    expect((await readFile(index)).length).toBe(LIBRARY_LIMITS.indexBytes + 1)
    await writeFile(index, savedIndex)
    await writeFile(detail, '{broken detail')
    await expect(store()).rejects.toThrow('未被覆盖')
    expect(await readFile(detail, 'utf8')).toBe('{broken detail')
    await rm(detail)
    await expect(store()).rejects.toThrow('未被覆盖')
    expect(await readFile(index)).toEqual(savedIndex)
    await writeFile(join(data, 'library', 'config.json'), '{bad config')
    await expect(store()).rejects.toThrow('未被覆盖')
  })

  it('recovers durable orphan details after an index-write failure and makes retries duplicate/idempotent', async () => {
    const library = await store(); const file = await source(); const notified = vi.fn(); library.onChanged = notified
    const write = atomic.atomicJson
    const injected = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (target, value, maximum) => {
      if (target === join(data, 'library', 'index.json')) throw new Error('disk full')
      await write(target, value, maximum)
    })
    const imported = await library.importFiles([file], 'image')
    expect(imported.entries[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('待恢复') })
    expect(notified).not.toHaveBeenCalled(); expect(await library.all()).toEqual([])
    const names = await readdir(join(data, 'library', 'items')); expect(names).toHaveLength(1)
    const id = names[0].slice(0, -5)
    injected.mockRestore()
    const reopened = await store()
    expect((await reopened.all()).map(item => item.id)).toEqual([id]); expect(reopened.warnings.join()).toContain('已恢复')
    expect((await reopened.importFiles([file], 'image')).entries[0]).toMatchObject({ status: 'duplicate', assetId: id })
    expect(await readdir(join(options.defaultRoot, 'images'))).toHaveLength(1)
    expect((await reopened.verify(id)).asset.available).toBe(true)
  })

  it('repairs a missing index from details but refuses to guess a missing configured root', async () => {
    const library = await store(); const id = (await library.importFiles([await source()], 'image')).entries[0].assetId!
    await rm(join(data, 'library', 'index.json'))
    expect((await (await store()).all())[0].id).toBe(id)
    await rm(join(data, 'library', 'config.json'))
    await expect(store()).rejects.toThrow('未被覆盖')
  })

  it('serializes simultaneous duplicate imports, preserves provenance, and does not reset or create usage state', async () => {
    const library = await store(); const a = await source(); const b = await source('同字节.jpg')
    const results = await Promise.all([library.importFiles([a], 'image'), library.importFiles([b], 'image')])
    expect(results.map(result => result.entries[0].status)).toEqual(['imported', 'duplicate'])
    expect(results[0].entries[0].assetId).toBe(results[1].entries[0].assetId)
    const items = await library.all(); expect(items).toHaveLength(1); expect(items[0].origins).toHaveLength(2)
    expect(JSON.stringify(items)).not.toContain(root)
    const unchanged = await readFile(join(data, 'library', 'items', `${items[0].id}.json`))
    const notified = vi.fn(); library.onChanged = notified
    await library.importFiles([a], 'image')
    expect(await readFile(join(data, 'library', 'items', `${items[0].id}.json`))).toEqual(unchanged)
    expect(notified).not.toHaveBeenCalled()
  })

  it('blocks root relocation after managed imports, orphan media or even an empty batch output directory', async () => {
    const library = await store(); const alternate = join(root, 'elsewhere')
    await mkdir(join(options.defaultRoot, 'batches'), { recursive: true })
    await expect(library.configureRoot(alternate)).rejects.toThrow('批量输出')
    await rm(join(options.defaultRoot, 'batches'), { recursive: true })
    await mkdir(join(options.defaultRoot, 'audio'))
    await writeFile(join(options.defaultRoot, 'audio', 'orphan.mp3'), 'preserve me')
    await expect(library.configureRoot(alternate)).rejects.toThrow('托管文件')
    await rm(join(options.defaultRoot, 'audio'), { recursive: true })
    await library.importFiles([await source()], 'image')
    await expect(library.configureRoot(alternate)).rejects.toThrow('已有托管素材')
    expect(library.getConfig().root).toBe(options.defaultRoot)
  })

  it('rejects path requests except registered IDs and refuses redirected managed parents', async () => {
    const library = await store(); const file = await source(); const id = (await library.importFiles([file], 'image')).entries[0].assetId!
    await expect(library.pathForAsset(file)).rejects.toThrow('标识')
    await expect(library.pathForAsset(randomUUID())).rejects.toThrow('不存在')
    const imageDir = join(options.defaultRoot, 'images'); const name = (await readdir(imageDir))[0]
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, name), await picture())
    await rm(imageDir, { recursive: true }); await symlink(outside, imageDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(library.pathForAsset(id)).rejects.toThrow('不安全')
    await expect(library.verify(id)).rejects.toThrow('不安全')
    expect(await readFile(join(outside, name))).toEqual(await picture())
  })
})

describe('project sources and refresh', () => {
  it('references originals in place, preserves IDs/model/prompt/selection and skips generation progress redecodes', async () => {
    const bytes = await picture(); const { project, asset, file } = await projectImage(bytes)
    const originalProject = await readFile(join(project.directory, 'project.json'))
    const library = await store(); const items = await library.all()
    expect(items).toHaveLength(1); expect(items[0].id).not.toBe(asset.id)
    expect(items[0].origins[0]).toMatchObject({ projectId: project.id, assetId: asset.id, model: asset.model, prompt: asset.prompt })
    expect(await library.pathForAsset(items[0].id)).toBe(file)
    const writes = vi.spyOn(atomic, 'atomicJson'); vi.mocked(options.projects.pathForAsset).mockClear()
    await library.syncProject({ ...project, updatedAt: new Date(Date.now() + 1000).toISOString() })
    await library.syncProject({ ...project, selectedImageId: undefined })
    expect(writes).not.toHaveBeenCalled(); expect(options.projects.pathForAsset).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(bytes); expect(await readFile(join(project.directory, 'project.json'))).toEqual(originalProject)
    expect((await (await store()).all())[0].id).toBe(items[0].id)
    expect((await library.findProjectAsset(project.id, asset.id))?.id).toBe(items[0].id)
  })

  it('merges newly generated matching bytes into managed assets without copying/replacing project originals', async () => {
    const library = await store(); const bytes = await picture(); const id = (await library.importFiles([await source('manual.png', bytes)], 'image')).entries[0].assetId!
    const { project, asset, file } = await projectImage(bytes)
    await library.syncProject(project); await library.syncProject(project)
    expect(await library.all()).toHaveLength(1)
    expect((await library.get(id)).origins).toHaveLength(2)
    expect((await library.findProjectAsset(project.id, asset.id))?.id).toBe(id)
    expect(await readFile(file)).toEqual(bytes)
  })

  it('retains missing project entries and IDs, and refresh recovers them and detects missing managed media', async () => {
    const { project, asset, file } = await projectImage()
    const library = await store(); const item = (await library.all())[0]
    expect(item).toMatchObject({ available: false, origins: [expect.objectContaining({ assetId: asset.id })] })
    await expect(library.verify(item.id)).rejects.toThrow('缺失')
    await writeFile(file, await picture())
    await library.refresh()
    expect(await library.get(item.id)).toMatchObject({ id: item.id, available: true, width: 32 })
    expect((await library.findProjectAsset(project.id, asset.id))?.id).toBe(item.id)
    const manualId = (await library.importFiles([await source('different.png', await picture('#333333'))], 'image')).entries[0].assetId!
    await rm(await library.pathForAsset(manualId)); await library.refresh()
    expect(await library.get(manualId)).toMatchObject({ available: false, problem: expect.stringContaining('缺失') })
    expect(await library.all()).toHaveLength(2)
  })

  it('verifies current bytes, refuses changed originals without replacing fingerprints, and recovers restored bytes', async () => {
    const original = await picture(); const { file } = await projectImage(original)
    const library = await store(); const item = (await library.all())[0]
    await writeFile(file, await picture('#ffffff'))
    await expect(library.verify(item.id)).rejects.toThrow('指纹已变化')
    expect(await library.get(item.id)).toMatchObject({ sha256: item.sha256, available: false })
    await library.refresh(); expect((await library.get(item.id)).sha256).toBe(item.sha256)
    await writeFile(file, original)
    expect((await library.verify(item.id)).asset).toMatchObject({ id: item.id, sha256: item.sha256, available: true })
  })

  it('keeps restored duplicate placeholder IDs resolvable through durable aliases', async () => {
    const missing = await projectImage(); const library = await store(); const placeholder = (await library.all())[0].id
    const id = (await library.importFiles([await source()], 'image')).entries[0].assetId!
    await writeFile(missing.file, await picture()); await library.refresh()
    expect(await library.all()).toHaveLength(1); expect((await library.get(placeholder)).id).toBe(id)
    expect((await library.findProjectAsset(missing.project.id, missing.asset.id))?.id).toBe(id)
    const reopened = await store(); expect((await reopened.get(placeholder)).id).toBe(id)
  })

  it('registers unvalidated audio with source provenance when tools are absent; does not block images', async () => {
    const { project } = await projectImage(await picture()); const id = randomUUID()
    project.audio.push({ id, provider: 'mureka', jobId: randomUUID(), taskId: 'task', remoteId: 'remote', title: '音乐', fileName: `audio/${id}.wav`, durationMs: 999999, createdAt: new Date().toISOString(), model: 'old-model', prompt: '原始音频提示词', mode: 'instrumental', kept: true })
    await mkdir(join(project.directory, 'audio'))
    await writeFile(join(project.directory, `audio/${id}.wav`), Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(64)]))
    const library = await store(); const audio = await library.findProjectAsset(project.id, id)
    expect(audio).toMatchObject({ available: false, problem: expect.stringContaining('FFmpeg') }); expect(audio?.durationSeconds).toBeUndefined()
    expect((await library.all()).find(item => item.kind === 'image')?.available).toBe(true)
    expect(ffmpeg.requireTools).toHaveBeenCalled()
  })
})
