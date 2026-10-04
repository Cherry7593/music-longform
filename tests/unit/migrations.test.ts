import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { MusicDraft } from '../../src/shared/types'
import { migrateProject, migrateSettings } from '../../src/main/storage/migrations'
import { dataCandidates, resolveDataDirectory } from '../../src/main/storage/data-directory'
import { ProjectStore } from '../../src/main/storage/projects'
import { SettingsStore } from '../../src/main/storage/settings'
import * as atomic from '../../src/main/storage/atomic'

// Real disk operations remain in use; configurable exports allow failure injection under ESM.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

// Independent of current defaults: changing providers must not modernize the input fixtures.
const legacyImage = Object.freeze({ prompt: '旧版画面：海边的夜晚', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'high', format: 'png' } as const)
const createdAt = '2026-05-01T01:02:03.000Z'
const updatedAt = '2026-05-02T04:05:06.000Z'
let root: string
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated disk tests')
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'yt-v21-迁移 '))
})
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })
function legacyMusic(): MusicDraft { return { prompt: '保留 Mureka 音乐描述', mode: 'instrumental', model: 'mureka-9.5', count: 2, styles: ['jazz', 'lo-fi'] } }
function legacySettings(version: 1 | 2 = 1) {
  return {
    version, projectRoot: path.join(root, '保留 项目'), musicDefaults: legacyMusic(), imageDefaults: { ...legacyImage }, lastProjectId: randomUUID(),
    ...(version === 2 ? { ffmpegPath: path.join(root, '工具 空格', 'ffmpeg.exe') } : {})
  }
}
function legacyProject(directory: string) {
  const completedBatch = randomUUID(); const activeBatch = randomUUID()
  const doneMusic = randomUUID(); const doneImage = randomUUID(); const secondImageJob = randomUUID()
  const imageIds = [randomUUID(), randomUUID()]
  return {
    version: 1, id: randomUUID(), name: '有完整历史的旧项目', directory, createdAt, updatedAt,
    music: legacyMusic(), image: { ...legacyImage },
    batches: [
      { id: completedBatch, total: 1, createdAt, state: 'completed' as const },
      { id: activeBatch, total: 2, createdAt, state: 'running' as const, message: '原批次恢复信息' }
    ],
    musicJobs: [
      { id: doneMusic, batchId: completedBatch, index: 0, createdAt, status: 'succeeded' as const, snapshot: { ...legacyMusic(), count: 1 }, taskId: 'mureka_done-123', actualModel: 'mureka-9.5' },
      { id: randomUUID(), batchId: activeBatch, index: 0, createdAt, status: 'running' as const, snapshot: legacyMusic(), taskId: 'mureka_running-456', actualModel: 'mureka-9.5', recoverable: true, error: '只查询原任务，不重新提交' },
      { id: randomUUID(), batchId: activeBatch, index: 1, createdAt, status: 'pending' as const, snapshot: legacyMusic() }
    ],
    audio: ['mp3', 'wav'].map((extension, index) => {
      const id = randomUUID()
      return { id, jobId: doneMusic, taskId: 'mureka_done-123', remoteId: `choice_${index}`, title: `原曲目 ${index}`, fileName: `audio/${id}.${extension}`, durationMs: 180123 + index, createdAt, model: 'mureka-9.5', prompt: '原生成音乐提示', mode: 'instrumental' as const, kept: index === 0 }
    }),
    imageJobs: [
      { id: doneImage, createdAt, status: 'succeeded' as const, snapshot: { ...legacyImage, prompt: '原横屏生成描述' } },
      { id: secondImageJob, createdAt, status: 'succeeded' as const, snapshot: { ...legacyImage, size: '1024x1024', quality: 'medium' as const, prompt: '原方图生成描述' } },
      { id: randomUUID(), createdAt, status: 'submitting' as const, snapshot: { ...legacyImage, size: '864x1536', quality: 'low' as const, prompt: '中断的竖图请求' } },
      { id: randomUUID(), createdAt, status: 'downloading' as const, snapshot: { ...legacyImage }, error: '下载被中断' },
      { id: randomUUID(), createdAt, status: 'failed' as const, snapshot: { ...legacyImage }, error: '原失败记录' },
      { id: randomUUID(), createdAt, status: 'unknown' as const, snapshot: { ...legacyImage }, error: '原未知结果，请核对账单' }
    ],
    images: imageIds.map((id, index) => ({
      id, jobId: index === 0 ? doneImage : secondImageJob, fileName: `images/${id}.png`, createdAt, model: legacyImage.model,
      prompt: index === 0 ? '原横屏生成描述' : '原方图生成描述', size: index === 0 ? legacyImage.size : '1024x1024', quality: index === 0 ? 'high' as const : 'medium' as const
    })),
    selectedImageId: imageIds[1]
  }
}
function legacyV2Project(directory: string) {
  const project = legacyProject(directory)
  const video = {
    ...structuredClone(DEFAULT_VIDEO), initialized: true, audioIds: project.audio.map(asset => asset.id).reverse(), imageId: project.images[0].id,
    durationMode: 'all' as const, targetSeconds: 7200, transition: 'fade' as const, transitionSeconds: 4, fadeInSeconds: 1, fadeOutSeconds: 5, normalize: true, fit: 'cover' as const
  }
  const videoId = randomUUID(); const previewId = randomUUID()
  return {
    ...project, version: 2, video,
    videoJobs: [
      { id: videoId, kind: 'video' as const, status: 'succeeded' as const, snapshot: { ...video, fit: 'contain' as const }, createdAt, finishedAt: updatedAt, progress: 100, detail: '原导出记录', fileName: `videos/${videoId}.mp4`, durationSeconds: 360.247 },
      { id: previewId, kind: 'preview' as const, status: 'succeeded' as const, snapshot: structuredClone(video), createdAt, finishedAt: updatedAt, fileName: `previews/${previewId}.wav`, durationSeconds: 12, boundaryIndex: 0 },
      { id: randomUUID(), kind: 'video' as const, status: 'encoding' as const, snapshot: structuredClone(video), createdAt, progress: 42, detail: '原进行中任务' },
      { id: randomUUID(), kind: 'video' as const, status: 'failed' as const, snapshot: structuredClone(video), createdAt, finishedAt: updatedAt, error: '原导出错误' }
    ]
  }
}
function expectedUpgrade(raw: ReturnType<typeof legacyProject> | ReturnType<typeof legacyV2Project>) {
  return {
    video: structuredClone(DEFAULT_VIDEO), videoJobs: [], ...raw, version: 3,
    image: { prompt: raw.image.prompt, model: 'Qwen/Qwen-Image', size: '1664x928' },
    images: raw.images.map(asset => ({ ...asset, provider: 'openai', format: 'png' })),
    imageJobs: raw.imageJobs.map(job => ({
      ...job, provider: 'openai',
      ...(['submitting', 'downloading'].includes(job.status) ? { status: 'unknown', error: expect.stringMatching(/OpenAI.*中断.*可能已计费.*不会.*硅基流动.*重新生成/) } : {})
    }))
  }
}
async function save(file: string, content: unknown): Promise<Buffer> {
  const bytes = Buffer.from(` \r\n${JSON.stringify(content, null, 3)}\r\n`)
  await writeFile(file, bytes)
  return bytes
}
async function backups(file: string, version: number): Promise<string[]> {
  return (await readdir(path.dirname(file))).filter(name => name.startsWith(`${path.basename(file)}.v${version}-`))
}
async function expectBackup(file: string, version: number, original: Buffer, count = 1): Promise<void> {
  const names = await backups(file, version)
  expect(names).toHaveLength(count)
  for (const name of names) {
    expect(name).toMatch(/\.v[12]-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bak$/)
    expect(await readFile(path.join(path.dirname(file), name))).toEqual(original)
  }
}

describe.each([1, 2] as const)('V%i to V3 migration', version => {
  it('preserves complete music, assets, selections and video history; annotates only legacy images', async () => {
    const raw = version === 1 ? legacyProject(root) : legacyV2Project(root)
    const untouched = structuredClone(raw)
    const file = path.join(root, 'project.json')
    const original = await save(file, raw)
    const copy = vi.spyOn(fs, 'copyFile')
    const result = await migrateProject(file, raw, root, raw.id)
    expect(result).toEqual(expectedUpgrade(raw))
    expect(raw).toEqual(untouched)
    expect(result.imageJobs.map(job => job.snapshot)).toEqual(raw.imageJobs.map(job => job.snapshot))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(result)
    await expectBackup(file, version, original)
    expect(copy).toHaveBeenCalledWith(file, expect.any(String), fs.constants.COPYFILE_EXCL)
    const currentBytes = await readFile(file)
    const write = vi.spyOn(atomic, 'atomicJson')
    const repeated = await migrateProject(file, JSON.parse(currentBytes.toString('utf8')), root, raw.id)
    expect(repeated).toEqual(result)
    expect(await readFile(file)).toEqual(currentBytes)
    expect(write).not.toHaveBeenCalled()
    await expectBackup(file, version, original)
  })

  it('preserves music defaults, roots, last project and FFmpeg while upgrading only image defaults', async () => {
    const raw = legacySettings(version)
    const untouched = structuredClone(raw)
    const file = path.join(root, 'settings.json')
    const original = await save(file, raw)
    const result = await migrateSettings(file, raw)
    expect(result).toEqual({ ...raw, version: 3, imageDefaults: { prompt: raw.imageDefaults.prompt, model: 'Qwen/Qwen-Image', size: '1664x928' } })
    expect(raw).toEqual(untouched)
    await expectBackup(file, version, original)
    const current = await readFile(file)
    expect(await migrateSettings(file, JSON.parse(current.toString('utf8')))).toEqual(result)
    expect(await readFile(file)).toEqual(current)
    await expectBackup(file, version, original)
  })

  it.each([['1536x864', '1664x928'], ['1024x1024', '1328x1328'], ['864x1536', '928x1664']])('maps %s to %s without truncating a 32,000-character prompt', async (oldSize, newSize) => {
    const prompt = '旧图，保留完整提示。'.repeat(3200)
    expect(prompt).toHaveLength(32000)
    const project = version === 1 ? legacyProject(root) : legacyV2Project(root)
    const settings = legacySettings(version)
    const image = { ...legacyImage, size: oldSize, prompt }
    const oldProject = { ...project, image }
    const oldSettings = { ...settings, imageDefaults: image }
    const projectPath = path.join(root, 'project.json'); const settingsPath = path.join(root, 'settings.json')
    await save(projectPath, oldProject); await save(settingsPath, oldSettings)
    const migratedProject = await migrateProject(projectPath, oldProject, root, project.id)
    const migratedSettings = await migrateSettings(settingsPath, oldSettings)
    const expected = { prompt, model: 'Qwen/Qwen-Image', size: newSize }
    expect(migratedProject.image).toEqual(expected)
    expect(migratedSettings.imageDefaults).toEqual(expected)
    expect(migratedProject.imageJobs.map(job => job.snapshot)).toEqual(project.imageJobs.map(job => job.snapshot))
  })
})

describe('migration storage safety', () => {
  it('keeps V2 directories, index bytes, all media files and unrelated encrypted secrets in place across reopening', async () => {
    const profile = path.join(root, '音乐画布'); await mkdir(profile)
    const directory = path.join(root, '旧 素材'); await mkdir(directory)
    const project = legacyV2Project(directory)
    const original = await save(path.join(directory, 'project.json'), project)
    const index = await save(path.join(profile, 'projects.json'), { version: 1, projects: [{ id: project.id, directory }] })
    const settings = legacySettings(2)
    const settingsBytes = await save(path.join(profile, 'settings.json'), settings)
    const secrets = await save(path.join(profile, 'secrets.json'), { version: 1, keys: { mureka: 'ZW5jcnlwdGVk' } })
    const files = [...project.audio, ...project.images, ...project.videoJobs].flatMap(asset => asset.fileName ? [asset.fileName] : [])
    for (const file of files) { await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), `original ${file}`) }
    for (let attempt = 0; attempt < 2; attempt++) {
      const projects = new ProjectStore(profile); await projects.init()
      const store = new SettingsStore(profile, path.join(root, 'unused')); await store.init()
      expect(await projects.get(project.id)).toEqual(expectedUpgrade(project))
      expect(projects.warnings).toEqual([])
      expect(store.get()).toMatchObject({ version: 3, projectRoot: settings.projectRoot, ffmpegPath: settings.ffmpegPath, lastProjectId: settings.lastProjectId, musicDefaults: settings.musicDefaults })
      expect(await readFile(path.join(profile, 'projects.json'))).toEqual(index)
      expect(await readFile(path.join(profile, 'secrets.json'))).toEqual(secrets)
      for (const file of files) expect(await readFile(path.join(directory, file), 'utf8')).toBe(`original ${file}`)
      for (const image of project.images) expect(await readFile(await projects.pathForAsset(project.id, 'image', image.id), 'utf8')).toBe(`original ${image.fileName}`)
      await expectBackup(path.join(directory, 'project.json'), 2, original)
      await expectBackup(path.join(profile, 'settings.json'), 2, settingsBytes)
    }
    await expect(readdir(path.join(root, 'unused'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['project', 'settings'] as const)('retains the original %s when backup fails and never writes', async kind => {
    const raw = kind === 'project' ? legacyV2Project(root) : legacySettings(2)
    const file = path.join(root, `${kind}.json`)
    const original = await save(file, raw)
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('backup permission denied'))
    const write = vi.spyOn(atomic, 'atomicJson')
    const run = () => kind === 'project' ? migrateProject(file, raw, root, 'id' in raw ? raw.id : '') : migrateSettings(file, raw)
    await expect(run()).rejects.toThrow('无法备份')
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(root)).toEqual([`${kind}.json`])
  })

  it.each(['project', 'settings'] as const)('retains the original %s and every backup after an atomic rename failure, then retries safely', async kind => {
    const raw = kind === 'project' ? legacyV2Project(root) : legacySettings(2)
    const file = path.join(root, `${kind}.json`)
    const original = await save(file, raw)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    const run = () => kind === 'project' ? migrateProject(file, raw, root, 'id' in raw ? raw.id : '') : migrateSettings(file, raw)
    await expect(run()).rejects.toThrow('写入失败')
    expect(await readFile(file)).toEqual(original)
    await expectBackup(file, 2, original)
    expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false)
    rename.mockRestore()
    await run()
    await expectBackup(file, 2, original, 2)
  })

  it('validates the registered project ID before any backup', async () => {
    const file = path.join(root, 'project.json'); const raw = legacyProject(root)
    const original = await save(file, raw)
    await expect(migrateProject(file, raw, root, randomUUID())).rejects.toThrow('标识')
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(root)).toEqual(['project.json'])
  })

  it.each([
    { label: 'unknown version', patch: { version: 99 } },
    { label: 'corrupt V3 with legacy fields', patch: { version: 3 } },
    { label: 'unknown field', patch: { unexpected: true } },
    { label: 'current model in legacy data', patch: { image: { ...legacyImage, model: 'Qwen/Qwen-Image' } } },
    { label: 'malformed music jobs', patch: { musicJobs: [{}] } },
    { label: 'missing selected image', patch: { selectedImageId: randomUUID() } },
    { label: 'missing video references', patch: { video: { ...DEFAULT_VIDEO, audioIds: [randomUUID()] } } }
  ])('does not migrate or back up a project with $label', async ({ patch }) => {
    const raw = { ...legacyV2Project(root), ...patch }
    const file = path.join(root, 'project.json'); const original = await save(file, raw)
    await expect(migrateProject(file, raw, root, raw.id)).rejects.toThrow('格式不兼容')
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(root)).toEqual(['project.json'])
  })

  it.each([
    { label: 'unknown version', patch: { version: 99 } },
    { label: 'corrupt V3', patch: { version: 3 } },
    { label: 'unknown field', patch: { unexpected: true } },
    { label: 'relative root', patch: { projectRoot: '../outside' } },
    { label: 'invalid image defaults', patch: { imageDefaults: { ...legacyImage, quality: 'invalid' } } }
  ])('does not migrate or back up settings with $label', async ({ patch }) => {
    const raw = { ...legacySettings(2), ...patch }
    const file = path.join(root, 'settings.json'); const original = await save(file, raw)
    await expect(migrateSettings(file, raw)).rejects.toThrow('格式不兼容')
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(root)).toEqual(['settings.json'])
  })

  it.each(['broken JSON', 'null', '[]'])('stores leave corrupt JSON untouched with no migration backup: %s', async content => {
    const profile = path.join(root, 'profile'); await mkdir(profile)
    const directory = path.join(root, 'project'); await mkdir(directory)
    const id = randomUUID()
    const index = await save(path.join(profile, 'projects.json'), { version: 1, projects: [{ id, directory }] })
    await writeFile(path.join(directory, 'project.json'), content)
    await writeFile(path.join(profile, 'settings.json'), content)
    const projects = new ProjectStore(profile); await projects.init()
    expect(await projects.list()).toEqual([])
    expect(projects.warnings).toHaveLength(1)
    await expect(new SettingsStore(profile, root).init()).rejects.toThrow('未被覆盖')
    expect(await readFile(path.join(directory, 'project.json'), 'utf8')).toBe(content)
    expect(await readFile(path.join(profile, 'settings.json'), 'utf8')).toBe(content)
    expect(await readFile(path.join(profile, 'projects.json'))).toEqual(index)
    expect(await readdir(directory)).toEqual(['project.json'])
    expect(await readdir(profile)).toEqual(['projects.json', 'settings.json'])
  })
})

describe('data directory compatibility', () => {
  describe.each([1, 2, 3] as const)('V%i settings discovery', version => {
    it.each(['音乐画布', 'music-canvas', '油管视频生成'])('detects %s without creating, moving or migrating files', async name => {
      const directory = path.join(root, name); await mkdir(directory)
      const settings = version === 3 ? { ...legacySettings(2), version: 3, imageDefaults: { prompt: '当前画面', model: 'Qwen/Qwen-Image', size: '1328x1328' } } : legacySettings(version)
      const bytes = await save(path.join(directory, 'settings.json'), settings)
      expect(await dataCandidates({ appData: root })).toEqual([directory])
      expect(await resolveDataDirectory({ appData: root }, async () => { throw new Error('must not prompt') })).toBe(directory)
      expect(await readdir(root)).toEqual([name])
      expect(await readdir(directory)).toEqual(['settings.json'])
      expect(await readFile(path.join(directory, 'settings.json'))).toEqual(bytes)
    })
  })
  it('multiple histories require a real selection; cancel never silently chooses a directory', async () => {
    const paths = ['音乐画布', 'music-canvas'].map(name => path.join(root, name))
    for (const [index, folder] of paths.entries()) { await mkdir(folder); await save(path.join(folder, 'settings.json'), legacySettings(index === 0 ? 1 : 2)) }
    const choose = vi.fn(async () => paths[1])
    expect(await resolveDataDirectory({ appData: root }, choose)).toBe(paths[1])
    expect(choose).toHaveBeenCalledWith(paths)
    expect(await resolveDataDirectory({ appData: root }, async () => null)).toBeNull()
    await expect(resolveDataDirectory({ appData: root }, async () => root)).rejects.toThrow('选择不正确')
  })
  it('explicit command/test paths override discovery; fresh installs get the new brand without writes', async () => {
    expect(await resolveDataDirectory({ appData: root }, async () => null)).toBe(path.join(root, '油管视频生成'))
    const explicit = path.join(root, '自定义')
    expect(await resolveDataDirectory({ appData: root, explicit }, async () => null)).toBe(explicit)
    expect(await readdir(root)).toEqual([])
    await expect(resolveDataDirectory({ appData: root, explicit: '..\\relative' }, async () => null)).rejects.toThrow('绝对路径')
  })
  it.each(['corrupt', '{"version":99}'])('does not abandon unreadable/unknown legacy data to show an empty account: %s', async content => {
    const directory = path.join(root, '音乐画布'); await mkdir(directory)
    await writeFile(path.join(directory, 'settings.json'), content)
    await expect(resolveDataDirectory({ appData: root }, async () => null)).rejects.toThrow('旧数据')
    expect(await readFile(path.join(directory, 'settings.json'), 'utf8')).toBe(content)
    expect(await readdir(directory)).toEqual(['settings.json'])
  })
})
