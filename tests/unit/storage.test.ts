import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE, DEFAULT_MUSIC } from '../../src/shared/schemas'
import type { AudioAsset, Project, Settings } from '../../src/shared/types'
import { atomicBuffer, atomicJson, readJson, SerialQueue } from '../../src/main/storage/atomic'
import * as atomic from '../../src/main/storage/atomic'
import { projectSchema } from '../../src/main/storage/validation'
import { ProjectStore } from '../../src/main/storage/projects'
import { SecretStore } from '../../src/main/storage/secrets'
import { SettingsStore } from '../../src/main/storage/settings'

// Real disk operations remain in use; configurable exports allow failure injection under ESM.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

let root: string
let data: string
const defaults = (): Settings => ({ version: 3, projectRoot: join(root, '中文 项目'), musicDefaults: structuredClone(DEFAULT_MUSIC), imageDefaults: structuredClone(DEFAULT_IMAGE) })
const encryption = () => ({
  isEncryptionAvailable: vi.fn(() => true),
  // Reversible fake for injection tests, NOT a cryptographic implementation.
  encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5))),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString('utf8'))
})
const audio = (id = randomUUID()): AudioAsset => ({
  id, jobId: randomUUID(), taskId: '123', remoteId: '456', title: '曲目', fileName: `audio/${id}.mp3`,
  durationMs: 123456, createdAt: new Date().toISOString(), model: 'mureka-9.5', prompt: '钢琴', mode: 'instrumental', kept: false
})

beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated disk tests')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'canvas-storage-'))
  data = join(root, 'data')
})
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })

describe('SettingsStore', () => {
  it('persists shared defaults, clones getters and serializes independent updates', async () => {
    const store = new SettingsStore(data, defaults().projectRoot)
    await store.init()
    expect(store.get()).toEqual(defaults())
    store.get().musicDefaults.styles.push('jazz')
    expect(store.get().musicDefaults.styles).toEqual([])
    const id = randomUUID()
    const newRoot = join(root, '新的 项目')
    await Promise.all([store.update({ projectRoot: newRoot }), store.update({ lastProjectId: id })])
    const reopened = new SettingsStore(data, join(root, 'ignored'))
    await reopened.init()
    expect(reopened.get()).toMatchObject({ projectRoot: newRoot, lastProjectId: id })
    await expect(readdir(newRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(data)).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it.each(['broken JSON', '{"version":99}', '{"version":1,"projectRoot":"relative"}'])('does not overwrite malformed settings: %s', async (content) => {
    await mkdir(data)
    await writeFile(join(data, 'settings.json'), content)
    await expect(new SettingsStore(data, defaults().projectRoot).init()).rejects.toThrow('未被覆盖')
    expect(await readFile(join(data, 'settings.json'), 'utf8')).toBe(content)
  })

  it('rejects relative roots and publishes memory only after successful disk writes', async () => {
    const store = new SettingsStore(data, defaults().projectRoot)
    await store.init()
    await expect(store.update({ projectRoot: '../outside' })).rejects.toThrow('绝对路径')
    const path = join(data, 'settings.json')
    await rm(path)
    await mkdir(path)
    await expect(store.update({ lastProjectId: randomUUID() })).rejects.toThrow('保存失败')
    expect(store.get()).toEqual(defaults())
    expect(await readdir(data)).toEqual(['settings.json'])
    await rm(path, { recursive: true })
    const saved = await store.update({ projectRoot: join(root, 'new') })
    expect(saved.projectRoot).toBe(join(root, 'new'))
  })
})

describe('SecretStore', () => {
  it('starts unconfigured, encrypts current keys, reloads and clears SiliconFlow without touching Mureka', async () => {
    const cipher = encryption()
    const store = new SecretStore(data, cipher)
    await store.init()
    expect(store.has('siliconflow')).toBe(false)
    expect(() => store.get('siliconflow')).toThrow('尚未配置')
    expect(JSON.parse(await readFile(join(data, 'secrets.json'), 'utf8'))).toEqual({ version: 2, keys: {} })
    const musicKey = 'sk-unit-secret-no-real-key'; const imageKey = 'sk-siliconflow-unit-key'
    await Promise.all([store.set('mureka', ` ${musicKey} `), store.set('siliconflow', imageKey)])
    expect(store.has('mureka')).toBe(true)
    expect(store.has('siliconflow')).toBe(true)
    expect(cipher.decryptString).not.toHaveBeenCalled()
    const raw = await readFile(join(data, 'secrets.json'), 'utf8')
    expect(raw).not.toContain(musicKey)
    expect(raw).not.toContain(imageKey)
    const disk = JSON.parse(raw) as { version: number; keys: Record<string, string> }
    expect(disk.version).toBe(2)
    expect(Object.keys(disk.keys).sort()).toEqual(['mureka', 'siliconflow'])
    expect(Buffer.from(disk.keys.mureka, 'base64')).toEqual(cipher.encryptString(musicKey))
    expect(Buffer.from(disk.keys.siliconflow, 'base64')).toEqual(cipher.encryptString(imageKey))
    const reopened = new SecretStore(data, cipher)
    await reopened.init()
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(reopened.get('mureka')).toBe(musicKey)
    expect(reopened.get('siliconflow')).toBe(imageKey)
    await reopened.clear('siliconflow')
    expect(reopened.has('siliconflow')).toBe(false)
    expect(() => reopened.get('siliconflow')).toThrow('尚未配置')
    expect(reopened.has('mureka')).toBe(true)
    expect(JSON.parse(await readFile(join(data, 'secrets.json'), 'utf8'))).toEqual({ version: 2, keys: { mureka: disk.keys.mureka } })
    const cleared = new SecretStore(data, cipher); await cleared.init()
    expect(cleared.has('siliconflow')).toBe(false)
    expect(cleared.get('mureka')).toBe(musicKey)
    expect(await readdir(data)).toEqual(['secrets.json'])
  })

  it('backs up both V1 keys byte-for-byte, never decrypts during init, and preserves Mureka ciphertext exactly', async () => {
    await mkdir(data)
    const cipher = encryption()
    const musicKey = 'sk-legacy-mureka-fixture'; const oldImageKey = 'sk-legacy-openai-fixture'
    const oldKeys = { mureka: cipher.encryptString(musicKey).toString('base64'), openai: cipher.encryptString(oldImageKey).toString('base64') }
    const original = Buffer.from(` \r\n${JSON.stringify({ version: 1, keys: oldKeys }, null, 3)}\r\n`)
    const file = join(data, 'secrets.json'); await writeFile(file, original)
    cipher.encryptString.mockClear()
    cipher.isEncryptionAvailable.mockReturnValue(false)
    const copy = vi.spyOn(fs, 'copyFile')
    const store = new SecretStore(data, cipher); await store.init()
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(cipher.encryptString).not.toHaveBeenCalled()
    expect(store.has('mureka')).toBe(true)
    expect(store.has('siliconflow')).toBe(false)
    expect(() => store.get('siliconflow')).toThrow('尚未配置')
    expect(cipher.decryptString).not.toHaveBeenCalled()
    const active = await readFile(file, 'utf8')
    expect(JSON.parse(active)).toEqual({ version: 2, keys: { mureka: oldKeys.mureka } })
    expect(Buffer.from(JSON.parse(active).keys.mureka, 'base64')).toEqual(Buffer.from(oldKeys.mureka, 'base64'))
    expect(active).not.toContain('openai')
    expect(active).not.toContain(oldKeys.openai)
    expect(active).not.toContain(musicKey)
    expect(active).not.toContain(oldImageKey)
    const backups = (await readdir(data)).filter(name => name !== 'secrets.json')
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^secrets\.json\.v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bak$/)
    expect(await readFile(join(data, backups[0]))).toEqual(original)
    expect(copy).toHaveBeenCalledWith(file, join(data, backups[0]), fs.constants.COPYFILE_EXCL)
    const write = vi.spyOn(atomic, 'atomicJson')
    await store.init()
    const reopened = new SecretStore(data, cipher); await reopened.init()
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(active)
    expect((await readdir(data)).sort()).toEqual(['secrets.json', ...backups].sort())
    cipher.isEncryptionAvailable.mockReturnValue(true)
    expect(reopened.get('mureka')).toBe(musicKey)
    expect(cipher.decryptString).toHaveBeenCalledExactlyOnceWith(Buffer.from(oldKeys.mureka, 'base64'))
    expect(reopened.has('siliconflow')).toBe(false)
    await reopened.set('siliconflow', 'sk-new-siliconflow-fixture')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.keys.mureka).toBe(oldKeys.mureka)
    expect(saved.keys).not.toHaveProperty('openai')
    expect(await readFile(join(data, backups[0]))).toEqual(original)
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('refuses a real backup-name collision without overwriting the original or the existing encrypted backup', async () => {
    await mkdir(data)
    const cipher = encryption()
    const original = Buffer.from(JSON.stringify({ version: 1, keys: { mureka: cipher.encryptString('sk-collision-fixture').toString('base64') } }))
    const file = join(data, 'secrets.json'); await writeFile(file, original)
    const previousBackup = Buffer.from('previous encrypted backup fixture bytes')
    const realCopy = fs.copyFile
    vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (source, destination, flags) => {
      // Emulate a destination appearing just before the exclusive native copy.
      await writeFile(destination, previousBackup, { flag: 'wx' })
      return realCopy(source, destination, flags)
    })
    const write = vi.spyOn(atomic, 'atomicJson')
    const store = new SecretStore(data, cipher)
    await expect(store.init()).rejects.toThrow('无法备份')
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(original)
    const backups = (await readdir(data)).filter(name => name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(data, backups[0]))).toEqual(previousBackup)
    expect(() => store.has('mureka')).toThrow('尚未初始化')
    expect(cipher.decryptString).not.toHaveBeenCalled()
  })

  it.each(['mureka', 'openai', 'empty'] as const)('migrates a V1 %s-only file without inventing a SiliconFlow key', async provider => {
    await mkdir(data)
    const cipher = encryption()
    const ciphertext = cipher.encryptString('sk-only-local-fixture').toString('base64')
    const keys = provider === 'empty' ? {} : { [provider]: ciphertext }
    await writeFile(join(data, 'secrets.json'), JSON.stringify({ version: 1, keys }))
    const store = new SecretStore(data, cipher); await store.init()
    expect(store.has('mureka')).toBe(provider === 'mureka')
    expect(store.has('siliconflow')).toBe(false)
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(data, 'secrets.json'), 'utf8'))).toEqual({ version: 2, keys: provider === 'mureka' ? { mureka: ciphertext } : {} })
  })

  it.each(['backup', 'write'] as const)('retains the V1 secret file and unpublished memory on migration %s failure', async failure => {
    await mkdir(data)
    const cipher = encryption()
    const keys = { mureka: cipher.encryptString('sk-old-mureka-fixture').toString('base64'), openai: cipher.encryptString('sk-old-openai-fixture').toString('base64') }
    const original = Buffer.from(`\n${JSON.stringify({ version: 1, keys }, null, 4)}\r\n`)
    const file = join(data, 'secrets.json'); await writeFile(file, original)
    const fault = failure === 'backup'
      ? vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('denied'))
      : vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    const store = new SecretStore(data, cipher)
    await expect(store.init()).rejects.toThrow(failure === 'backup' ? '无法备份' : '写入失败')
    expect(await readFile(file)).toEqual(original)
    expect(() => store.has('mureka')).toThrow('尚未初始化')
    expect(cipher.decryptString).not.toHaveBeenCalled()
    const previousBackups = (await readdir(data)).filter(name => name.endsWith('.bak'))
    expect(previousBackups).toHaveLength(failure === 'backup' ? 0 : 1)
    for (const backup of previousBackups) expect(await readFile(join(data, backup))).toEqual(original)
    expect((await readdir(data)).some(name => name.endsWith('.tmp'))).toBe(false)
    fault.mockRestore()
    await store.init()
    expect(store.has('mureka')).toBe(true)
    expect(store.has('siliconflow')).toBe(false)
    expect(cipher.decryptString).not.toHaveBeenCalled()
    const allBackups = (await readdir(data)).filter(name => name.endsWith('.bak'))
    expect(allBackups).toHaveLength(previousBackups.length + 1)
    for (const backup of allBackups) expect(await readFile(join(data, backup))).toEqual(original)
  })

  it('never falls back to plaintext when encryption is unavailable, but permits clearing', async () => {
    const cipher = encryption()
    const store = new SecretStore(data, cipher)
    await store.init()
    await store.set('mureka', 'sk-unit-key')
    const previous = await readFile(join(data, 'secrets.json'), 'utf8')
    cipher.isEncryptionAvailable.mockReturnValue(false)
    expect(store.isAvailable()).toBe(false)
    expect(store.has('mureka')).toBe(true)
    expect(() => store.get('mureka')).toThrow('不会改用明文')
    await expect(store.set('siliconflow', 'sk-never-save-me')).rejects.toThrow('不会改用明文')
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe(previous)
    await store.clear('mureka')
    expect(store.has('mureka')).toBe(false)
  })

  it('reports incompatible ciphertext without leaking decrypt errors', async () => {
    const cipher = encryption()
    const store = new SecretStore(data, cipher)
    await store.init()
    await store.set('siliconflow', 'sk-unit-key')
    cipher.decryptString.mockImplementation(() => { throw new Error('plaintext diagnostic secret') })
    expect(store.has('siliconflow')).toBe(true)
    expect(() => store.get('siliconflow')).toThrow('不兼容')
    expect(() => store.get('siliconflow')).not.toThrow('plaintext')
  })

  it('validates keys and leaves memory unchanged on failed set and clear writes', async () => {
    const store = new SecretStore(data, encryption())
    await store.init()
    await store.set('mureka', 'sk-old-unit-key')
    for (const key of ['short', 'sk-has spaces', 'sk-中文测试']) await expect(store.set('siliconflow', key)).rejects.toThrow('格式')
    const path = join(data, 'secrets.json')
    await rm(path)
    await mkdir(path)
    await expect(store.set('mureka', 'sk-new-unit-key')).rejects.toThrow('保存失败')
    await expect(store.clear('mureka')).rejects.toThrow('清除失败')
    expect(store.get('mureka')).toBe('sk-old-unit-key')
    expect(await readdir(data)).toEqual(['secrets.json'])
  })

  it.each([
    'broken JSON', '{"version":99,"keys":{}}',
    '{"version":1,"keys":{"mureka":"sk-plaintext-secret"}}',
    '{"version":1,"keys":{"openai":"not base64"}}',
    '{"version":2,"keys":{"openai":"ZW5jcnlwdGVk"}}'
  ])('does not replace or back up malformed/unknown secret data: %s', async content => {
    await mkdir(data)
    const cipher = encryption()
    await writeFile(join(data, 'secrets.json'), content)
    await expect(new SecretStore(data, cipher).init()).rejects.toThrow('未被覆盖')
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe(content)
    expect(await readdir(data)).toEqual(['secrets.json'])
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(cipher.encryptString).not.toHaveBeenCalled()
  })
})

describe('ProjectStore', () => {
  it('uses UUID directories and preserves registered old roots after defaults change', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const first = await store.create(defaults())
    const second = await store.create({ ...defaults(), projectRoot: join(root, 'new root') })
    await store.patch(first.id, { name: '../../不是文件路径' })
    expect(first.directory).toBe(join(defaults().projectRoot, first.id))
    expect(await readdir(first.directory)).toEqual(['audio', 'images', 'project.json'])
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect((await reopened.get(first.id)).directory).toBe(first.directory)
    expect((await reopened.get(second.id)).directory).toBe(second.directory)
    expect((await reopened.list()).map((entry) => entry.id)).toEqual([first.id, second.id])
    expect(reopened.warnings).toEqual([])
  })

  it('serializes creates so every project remains in the index', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const created = await Promise.all(Array.from({ length: 5 }, () => store.create(defaults())))
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect((await reopened.all()).map((project) => project.id).sort()).toEqual(created.map((project) => project.id).sort())
  })

  it('mutates the latest clone inside the queue without clobbering unrelated jobs or drafts', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    store.onChanged = (changed) => { changed.name = 'external mutation'; throw new Error('listener failed') }
    const jobId = randomUUID()
    await Promise.all([
      store.patch(project.id, { music: { ...project.music, prompt: 'new music' } }),
      store.mutate(project.id, (latest) => {
        latest.imageJobs.push({ id: jobId, provider: 'siliconflow', createdAt: new Date().toISOString(), status: 'submitting', snapshot: { ...latest.image, prompt: 'snapshot' } })
      }),
      store.patch(project.id, { image: { ...project.image, prompt: 'new image' } })
    ])
    const result = await store.get(project.id)
    expect(result.music.prompt).toBe('new music')
    expect(result.image.prompt).toBe('new image')
    expect(result.imageJobs[0].id).toBe(jobId)
    result.music.prompt = 'unsaved'
    expect((await store.get(project.id)).music.prompt).toBe('new music')
    expect((await store.get(project.id)).name).toBe('未命名项目')
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect((await reopened.get(project.id)).imageJobs[0].snapshot.prompt).toBe('snapshot')
  })

  it.each(['png', 'jpeg', 'webp'] as const)('round-trips current %s assets and snapshots without legacy quality or draft format', async format => {
    const store = new ProjectStore(data); await store.init()
    const project = await store.create(defaults())
    const id = randomUUID(); const jobId = randomUUID()
    const asset = { id, jobId, fileName: `images/${id}.${format === 'jpeg' ? 'jpg' : format}`, createdAt: project.createdAt, model: 'Qwen/Qwen-Image', prompt: '当前画面', size: '1664x928', provider: 'siliconflow' as const, format }
    const job = { id: jobId, createdAt: project.createdAt, provider: 'siliconflow' as const, status: 'succeeded' as const, snapshot: { ...project.image, prompt: asset.prompt } }
    const saved = await store.mutate(project.id, draft => { draft.images.push(asset); draft.imageJobs.push(job); draft.selectedImageId = id })
    await writeFile(join(project.directory, asset.fileName), 'local image bytes')
    const reopened = new ProjectStore(data); await reopened.init()
    expect(await reopened.get(project.id)).toEqual(saved)
    expect(saved.version).toBe(3)
    expect(saved.images).toEqual([asset])
    expect(saved.imageJobs).toEqual([job])
    expect(saved.imageJobs[0].snapshot).not.toHaveProperty('quality')
    expect(saved.imageJobs[0].snapshot).not.toHaveProperty('format')
    expect(await reopened.pathForAsset(project.id, 'image', id)).toBe(await realpath(join(project.directory, asset.fileName)))
    expect((await readdir(project.directory)).some(name => name.endsWith('.bak'))).toBe(false)
    expect(reopened.warnings).toEqual([])
  })

  it('requires provider-specific historical snapshots and explicit, matching asset formats', async () => {
    const store = new ProjectStore(data); await store.init()
    const project = await store.create(defaults())
    const legacyImage = Object.freeze({ prompt: '历史图片', model: 'gpt-image-2.5-flare', size: '864x1536', quality: 'low', format: 'png' } as const)
    const job = { id: randomUUID(), createdAt: project.createdAt, status: 'succeeded' }
    const id = randomUUID()
    const asset = { id, jobId: job.id, createdAt: project.createdAt, fileName: `images/${id}.png`, model: 'Qwen/Qwen-Image', prompt: '当前图片', size: '1664x928', provider: 'siliconflow', format: 'png' }
    const legacyAsset = { ...asset, model: legacyImage.model, prompt: legacyImage.prompt, size: legacyImage.size, provider: 'openai', quality: legacyImage.quality }
    expect(projectSchema.safeParse({ ...project, images: [asset], imageJobs: [{ ...job, provider: 'siliconflow', snapshot: project.image }] }).success).toBe(true)
    expect(projectSchema.safeParse({ ...project, images: [legacyAsset], imageJobs: [{ ...job, provider: 'openai', snapshot: legacyImage }] }).success).toBe(true)
    for (const invalidJob of [
      { ...job, snapshot: project.image },
      { ...job, provider: 'openai', snapshot: project.image },
      { ...job, provider: 'siliconflow', snapshot: legacyImage },
      { ...job, provider: 'siliconflow', snapshot: { ...project.image, quality: 'high', format: 'png' } }
    ]) expect(projectSchema.safeParse({ ...project, imageJobs: [invalidJob] }).success).toBe(false)
    for (const invalidAsset of [
      { ...asset, provider: undefined }, { ...asset, format: undefined }, { ...asset, quality: 'high' },
      { ...asset, format: 'jpeg' }, { ...legacyAsset, quality: undefined },
      { ...legacyAsset, fileName: `images/${id}.webp`, format: 'webp' }
    ]) expect(projectSchema.safeParse({ ...project, images: [invalidAsset] }).success).toBe(false)
  })

  it('does not publish failed writes or invalid persisted shapes and keeps the queue usable', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    const changed = vi.fn()
    store.onChanged = changed
    await expect(store.mutate(project.id, (draft) => { draft.directory = root })).rejects.toThrow('不能更改')
    await expect(store.mutate(project.id, (draft) => { draft.music.count = 99 })).rejects.toThrow('数据格式')
    const path = join(project.directory, 'project.json')
    await rm(path)
    await mkdir(path)
    await expect(store.patch(project.id, { name: 'not saved' })).rejects.toThrow('保存失败')
    expect(await store.get(project.id)).toEqual(project)
    expect(changed).not.toHaveBeenCalled()
    expect((await readdir(project.directory)).some((file) => file.endsWith('.tmp'))).toBe(false)
    await rm(path, { recursive: true })
    await store.patch(project.id, { name: 'saved later' })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('uses the registered directory instead of a forged project JSON directory', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    await writeFile(join(project.directory, 'project.json'), JSON.stringify({ ...project, directory: join(root, 'forged') }))
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect((await reopened.get(project.id)).directory).toBe(project.directory)
    await reopened.patch(project.id, { name: 'saved to original' })
    await expect(readdir(join(root, 'forged'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['music', 'musicJobs', 'imageJobs', 'audio', 'images', 'batches'])('warns about malformed %s without erasing projects or the index', async (field) => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    const path = join(project.directory, 'project.json')
    const corrupt = JSON.stringify({ ...project, [field]: field === 'music' ? { prompt: 'incomplete' } : [{}] })
    await writeFile(path, corrupt)
    const index = await readFile(join(data, 'projects.json'), 'utf8')
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect(await reopened.list()).toEqual([])
    expect(reopened.warnings[0]).toContain(project.id)
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    expect(await readFile(join(data, 'projects.json'), 'utf8')).toBe(index)
    await reopened.create(defaults())
    expect((JSON.parse(await readFile(join(data, 'projects.json'), 'utf8')) as { projects: unknown[] }).projects).toHaveLength(2)
  })

  it('warns about missing projects and explicitly fails on malformed indexes', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    await rm(join(project.directory, 'project.json'))
    const reopened = new ProjectStore(data)
    await reopened.init()
    expect(reopened.warnings).toHaveLength(1)
    await writeFile(join(data, 'projects.json'), 'broken index')
    await expect(new ProjectStore(data).init()).rejects.toThrow('未被覆盖')
    expect(await readFile(join(data, 'projects.json'), 'utf8')).toBe('broken index')
  })

  it('only resolves known regular assets and rejects traversal and escaping junctions', async () => {
    const store = new ProjectStore(data)
    await store.init()
    const project = await store.create(defaults())
    const asset = audio()
    await store.mutate(project.id, (draft) => { draft.audio.push(asset) })
    await expect(store.pathForAsset(project.id, 'audio', randomUUID())).rejects.toThrow('不存在')
    await expect(store.pathForAsset(project.id, 'audio', asset.id)).rejects.toThrow('不存在')
    await writeFile(join(project.directory, asset.fileName), 'fixture')
    expect(await store.pathForAsset(project.id, 'audio', asset.id)).toBe(await realpath(join(project.directory, asset.fileName)))
    await expect(store.mutate(project.id, (draft) => { draft.audio[0].fileName = '../secrets.json' })).rejects.toThrow('数据格式')
    await expect(store.pathForAsset(project.id, 'audio', '../secrets')).rejects.toThrow('标识')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, `${asset.id}.mp3`), 'private fixture')
    await rm(join(project.directory, 'audio'), { recursive: true })
    await symlink(outside, join(project.directory, 'audio'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.pathForAsset(project.id, 'audio', asset.id)).rejects.toThrow('不安全')
  })

  it('does not expose internal clones through all or onChanged', async () => {
    const store = new ProjectStore(data)
    await store.init()
    let event: Project | undefined
    store.onChanged = (project) => { event = project }
    const project = await store.create(defaults())
    if (event) event.image.prompt = 'listener mutation'
    const projects = await store.all()
    projects[0].music.prompt = 'array mutation'
    expect((await store.get(project.id)).image.prompt).toBe('')
    expect((await store.get(project.id)).music.prompt).toBe('')
  })
})

it('atomic writes remove failed temporary files and bounded JSON reads reject oversized files', async () => {
  await mkdir(data)
  const target = join(data, 'blocked')
  await mkdir(target)
  await expect(atomicBuffer(target, Buffer.from('payload'))).rejects.toBeDefined()
  expect(await readdir(data)).toEqual(['blocked'])
  await writeFile(join(data, 'large.json'), ' '.repeat(100))
  await expect(readJson(join(data, 'large.json'), 10)).rejects.toThrow()
  await expect(atomicJson(join(data, 'large.json'), { value: 'x'.repeat(100) }, 10)).rejects.toThrow('limit')
  expect(await readFile(join(data, 'large.json'), 'utf8')).toBe(' '.repeat(100))
  const queue = new SerialQueue()
  await expect(queue.run(async () => { throw new Error('first') })).rejects.toThrow('first')
  expect(await queue.run(async () => 42)).toBe(42)
})
