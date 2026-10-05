import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetStore, type AssetRegistration } from '../../src/main/storage/assets-v2'
import * as atomic from '../../src/main/storage/atomic'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'
import type { UsageRecord } from '../../src/shared/workbench-types'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../../src/main/storage/atomic', async original => ({ ...await original<typeof import('../../src/main/storage/atomic')>() }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), requireTools: vi.fn(), runTool: vi.fn() }))
let root: string; let dataDir: string; let managed: string; let store: AssetStore; let rootId: string
let tools: { ffmpeg: string; ffprobe: string }; let decodes: number; let version: string
let decodeHook: (() => Promise<void>) | undefined
const createdAt = '2026-10-04T12:00:00.000Z'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const wav = (suffix = '') => Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(100), Buffer.from(suffix)])
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)])
function fresh(): AssetStore { return new AssetStore({ dataDir, root: managed, getFFmpegPath: () => tools.ffmpeg }) }
async function restart(): Promise<AssetStore> { const next = fresh(); await next.init(); return next }
async function input(kind: 'audio' | 'image' | 'video' = 'audio', bytes = wav(), extension = kind === 'video' ? 'mp4' : kind === 'image' ? 'png' : 'wav'): Promise<AssetRegistration> {
  const id = randomUUID(); const fileName = `${kind === 'image' ? 'images' : kind}/${id}.${extension}`
  await mkdir(join(managed, kind === 'image' ? 'images' : kind), { recursive: true }); await writeFile(join(managed, fileName), bytes)
  return { id, kind, fileName, rootId, name: '既有原始长名称'.repeat(35), createdAt, origin: { type: 'generation', name: '项目快照', projectId: randomUUID(), requestId: randomUUID() } }
}
function usage(assetIds: string[], uncertainAssetIds: string[] = []): UsageRecord {
  return { version: 2, id: randomUUID(), projectId: randomUUID(), videoId: randomUUID(), name: '历史成片快照', finishedAt: createdAt, durationSeconds: 12.5, assetIds, uncertainAssetIds }
}
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'assets-v4-unit-中文 & ')); dataDir = join(root, 'data'); managed = join(root, 'managed')
  tools = { ffmpeg: join(root, 'ffmpeg-fixture.exe'), ffprobe: join(root, 'ffprobe-fixture.exe') }
  await writeFile(tools.ffmpeg, 'fixture'); await writeFile(tools.ffprobe, 'fixture')
  decodes = 0; version = 'fixture-v1'; decodeHook = undefined
  vi.mocked(requireTools).mockReset().mockResolvedValue(tools)
  vi.mocked(runTool).mockReset().mockImplementation(async (executable, args, options) => {
    if (args.includes('-version')) return { stdout: `${executable === tools.ffmpeg ? 'ffmpeg' : 'ffprobe'} version ${version}\n`, stderr: '' }
    if (executable === tools.ffprobe) {
      const video = args[args.length - 1].endsWith('.mp4')
      return { stdout: JSON.stringify({ format: { format_name: video ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'wav', duration: '12.5' }, streams: video
        ? [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }]
        : [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, duration: '12.5' }] }), stderr: '' }
    }
    decodes++; await decodeHook?.(); options?.onProgress?.(12.5)
    return { stdout: 'frame=375\nout_time_us=12500000\nprogress=end\n', stderr: '' }
  })
  store = fresh(); await store.init(); rootId = await store.managedRootId()
})
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })

describe('independent V2 assets and durable histories', () => {
  it('resolves without a project store; preserves names, multiple origins, canonical IDs and aliases across restart', async () => {
    const first = await input(); const firstAsset = await store.register(first)
    await store.rename(first.id, '手工名称'.repeat(80))
    const second = await input(); const duplicate = await store.register(second)
    expect(duplicate.id).toBe(first.id); expect(duplicate.name).toBe('手工名称'.repeat(80)); expect(duplicate.origins).toHaveLength(2)
    const oldLibraryId = randomUUID(); await store.alias(oldLibraryId, second.id); await store.alias(oldLibraryId, first.id)
    store = await restart()
    expect(await store.pathForAsset(oldLibraryId)).toBe(join(managed, first.fileName))
    expect((await store.get(second.id)).id).toBe(firstAsset.id)
    expect((await store.all([first.id, second.id, oldLibraryId]))[0].queuedCount).toBe(3)
    const publicAsset = await store.get(first.id); expect(JSON.stringify(publicAsset)).not.toContain(managed); expect(publicAsset).not.toHaveProperty('locations')
    publicAsset.origins.length = 0; expect((await store.get(first.id)).origins).toHaveLength(2)
    const different = await input('audio', wav('different')); await store.register(different)
    await expect(store.alias(oldLibraryId, different.id)).rejects.toThrow('别名')
    await expect(store.alias(first.id, different.id)).rejects.toThrow('不同内容')
  })
  it('retains a missing migrated video and missing root; refresh never scans legacy library/projects', async () => {
    const missingRoot = join(root, 'lost-project'); const missingRootId = await store.registerRoot(missingRoot, true)
    const id = randomUUID()
    const result = await store.register({ id, kind: 'video', name: '已遗失成片', createdAt, origin: { type: 'legacy', name: '已删除项目' }, rootId: missingRootId, fileName: `exports/${id}.mp4`, allowMissing: true, validated: true, metadata: { durationSeconds: 100, width: 1920, height: 1080 } })
    expect(result).toMatchObject({ id, available: false }); expect(result.durationSeconds).toBeUndefined()
    await expect(store.pathForAsset(id)).rejects.toThrow('缺失')
    await mkdir(join(dataDir, 'library'), { recursive: true }); await writeFile(join(dataDir, 'library', 'index.json'), '{invalid legacy deliberately ignored')
    store = await restart(); expect(await store.refresh()).toHaveLength(1); expect((await store.get(id)).available).toBe(false)
    expect(await store.registerRoot(missingRoot, true)).toBe(missingRootId)
  })
  it('keeps idempotent certain/uncertain usage after asset/video/project deletion and after a publication retry', async () => {
    const a = await input(); await store.register(a); const alias = randomUUID(); await store.alias(alias, a.id)
    const certain = usage([a.id, alias]); const uncertain = usage([], [a.id])
    await Promise.all([store.recordUsage(certain), store.recordUsage(certain), store.recordUsage(uncertain)])
    expect(await store.get(a.id)).toMatchObject({ usedCount: 1, historyUncertain: true }); expect((await store.get(a.id)).usages).toHaveLength(2)
    await store.delete(a.id); expect(await store.all()).toEqual([])
    await store.recordUsage(certain); store = await restart(); await store.recordUsage(certain)
    expect(await store.allUsage()).toHaveLength(2); expect((await store.get(alias)).usedCount).toBe(1)
    await expect(store.recordUsage({ ...certain, name: 'changed' })).rejects.toThrow('冲突')
    const late = usage([alias]); await store.recordUsage(late); expect((await store.get(a.id)).usedCount).toBe(2)
    await expect(store.register({ ...a, allowMissing: true })).rejects.toThrow('删除')
  })
  it('uses stable trusted roots; refuses unsafe/redirected roots and ownership changes', async () => {
    const external = join(root, 'external'); await mkdir(external)
    const id = await store.registerRoot(external, false); expect(await store.registerRoot(external, false)).toBe(id)
    expect(await store.rootDirectory(id)).toBe(external)
    await expect(store.registerRoot(external, true)).rejects.toThrow('所有权')
    const redirect = join(root, 'redirect'); await symlink(external, redirect, process.platform === 'win32' ? 'junction' : 'dir')
    for (const unsafe of ['relative', '\\\\server\\share', '\\\\?\\C:\\devices', `${external}:ads`, redirect]) await expect(store.registerRoot(unsafe, true)).rejects.toThrow()
    store = await restart(); expect(await store.managedRootId()).toBe(rootId); expect(await store.registerRoot(external, false)).toBe(id)
  })
  it('bounds relative media paths, kinds, UUID-related files and untrusted validation hints', async () => {
    const a = await input()
    for (const fileName of ['../outside.wav', '/absolute.wav', 'audio/../file.wav', 'audio\\file.wav', 'audio/file.wav:ads', 'audio/nul.wav', 'audio/file.wav.', 'audio//x.wav']) await expect(store.register({ ...a, fileName, allowMissing: true })).rejects.toThrow()
    await expect(store.register({ ...a, relatedFiles: [`audio/${randomUUID()}.wav`] })).rejects.toThrow()
    await expect(store.register({ ...a, kind: 'video', allowMissing: true })).rejects.toThrow()
    await expect(store.register({ ...a, name: 'x'.repeat(513) })).rejects.toThrow()
    await writeFile(join(managed, a.fileName), '#EXTM3U\nfile:///outside.wav')
    await expect(store.register({ ...a, validated: true, metadata: { format: 'wav', durationSeconds: 12.5 } })).rejects.toThrow()
    expect(await store.all()).toEqual([])
  })
  it('does not accept redirected/missing leaf paths even with allowMissing', async () => {
    const outside = join(root, 'outside'); await mkdir(outside)
    await symlink(outside, join(managed, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
    const id = randomUUID()
    await expect(store.register({ id, kind: 'audio', name: 'unsafe', createdAt, origin: { type: 'legacy', name: 'old' }, rootId, fileName: `redirect/${id}.wav`, allowMissing: true })).rejects.toThrow('不安全')
  })
  it('performs constrained full video decode, not a 1080p migration gate and not trusting metadata', async () => {
    const a = await input('video', mp4()); const asset = await store.register({ ...a, validated: true, metadata: { width: 1920, height: 1080, durationSeconds: 1000 } })
    expect(asset).toMatchObject({ format: 'mp4', width: 640, height: 360, durationSeconds: 12.5 }); expect(decodes).toBe(1)
    const call = vi.mocked(runTool).mock.calls.find(([executable, args]) => executable === tools.ffmpeg && args.includes('-xerror'))!
    expect(call[1]).toEqual(expect.arrayContaining(['-format_whitelist', 'mov', '-enable_drefs', '0', '-use_absolute_path', '-map', '0:V:0', '0:a?', '-f', 'null']))
  })
})

describe('validation evidence and concurrency', () => {
  it('caches exact identity/hash/tool/version evidence across verify/refresh/restart, and invalidates changed timestamps/tools', async () => {
    const a = await input(); await store.register(a); expect(decodes).toBe(1)
    await Promise.all(Array.from({ length: 12 }, () => store.verify(a.id))); await store.refresh(); expect(decodes).toBe(1)
    store = await restart(); await store.verify(a.id); expect(decodes).toBe(1)
    await utimes(join(managed, a.fileName), new Date(), new Date(Date.now() - 20000)); await store.verify(a.id); expect(decodes).toBe(2)
    version = 'fixture-v2'; await writeFile(tools.ffmpeg, 'changed tool binary'); await store.verify(a.id); expect(decodes).toBe(3)
  })
  it('coalesces same-asset cold decode while different assets run concurrently and metadata edits proceed', async () => {
    const a = await input(); const b = await input('audio', wav('second')); await store.register(a); await store.register(b)
    await utimes(join(managed, a.fileName), new Date(), new Date(Date.now() - 20000)); await utimes(join(managed, b.fileName), new Date(), new Date(Date.now() - 20000))
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0; let peak = 0
    decodeHook = async () => { active++; peak = Math.max(peak, active); await gate; active-- }
    const tasks = [store.verify(a.id), store.verify(a.id), store.verify(b.id)]
    await vi.waitFor(() => expect(active).toBe(2)); expect(peak).toBe(2)
    await store.rename(a.id, '解码时改名仍正常'); await expect(store.delete(a.id)).rejects.toThrow('预约')
    release(); await Promise.all(tasks); expect(decodes).toBe(4); expect((await store.get(a.id)).name).toBe('解码时改名仍正常')
  })
  it('rejects changed bytes without replacing hashes or silently trusting validated=true', async () => {
    const a = await input(); const asset = await store.register(a)
    await writeFile(join(managed, a.fileName), wav('tampered'))
    await expect(store.verify(a.id)).rejects.toThrow('指纹已变化'); expect(await store.get(a.id)).toMatchObject({ sha256: asset.sha256, available: false })
    await expect(store.register({ ...a, validated: true })).rejects.toThrow('指纹已变化')
    expect(decodes).toBe(1)
  })
})

describe('bounded durable metadata', () => {
  it('recovers detail-first orphan after index-write failure without creating a second asset', async () => {
    const a = await input(); const native = atomic.atomicJson
    const spy = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (file, data, maximum) => {
      if (file === join(dataDir, 'assets-v2', 'index.json')) throw new Error('injected index crash')
      return native(file, data, maximum)
    })
    await expect(store.register(a)).rejects.toThrow('injected'); spy.mockRestore()
    store = await restart(); expect(await store.all()).toHaveLength(1); expect(store.warnings.join(' ')).toContain('恢复')
    expect((await store.register(a)).id).toBe(a.id); expect((await store.all())[0].origins).toHaveLength(1)
  })
  it('refuses corrupted or oversized indexes and missing indexed details, never overwriting with an empty library', async () => {
    const a = await input(); await store.register(a)
    const index = join(dataDir, 'assets-v2', 'index.json'); const valid = await readFile(index)
    await writeFile(index, '{ corrupt index'); await expect(fresh().init()).rejects.toThrow('索引'); expect(await readFile(index, 'utf8')).toBe('{ corrupt index')
    const handle = await open(index, 'w'); await handle.truncate(4 * 1024 ** 2 + 1); await handle.close(); await expect(fresh().init()).rejects.toThrow('索引')
    await writeFile(index, valid); await rm(join(dataDir, 'assets-v2', 'items', `${a.id}.json`))
    await expect(fresh().init()).rejects.toThrow('详情缺失'); expect(await readFile(index)).toEqual(valid)
  })
  it('refuses corrupt detail/usage records rather than resetting either ledger', async () => {
    const a = await input(); await store.register(a); const u = usage([a.id]); await store.recordUsage(u)
    const ledger = join(dataDir, 'assets-v2', 'usage', `${u.id}.json`); await writeFile(ledger, '{}')
    await expect(fresh().init()).rejects.toThrow('元数据'); expect(await readFile(ledger, 'utf8')).toBe('{}')
  })
})

describe('tombstones, leases and safe deletion', () => {
  it('holds all-or-nothing reference-counted leases including aliases and closes both sides of the delete race', async () => {
    const a = await input(); await store.register(a); const alias = randomUUID(); await store.alias(alias, a.id)
    const release1 = store.pin([a.id, alias], 'queued'); const release2 = store.pin([alias], 'queued')
    expect(store.isPinned(alias)).toBe(true); await expect(store.delete(a.id)).rejects.toThrow('预约')
    release1(); release1(); expect(store.isPinned(a.id)).toBe(true); release2(); expect(store.isPinned(a.id)).toBe(false)
    expect(() => store.pin([a.id, randomUUID()], 'invalid')).toThrow(); expect(store.isPinned(a.id)).toBe(false)
    const deleting = store.delete(a.id); expect(() => store.pin([alias], 'too late')).toThrow('删除'); await deleting
    await expect(store.pathForAsset(a.id)).rejects.toThrow('删除'); store = await restart(); await expect(store.register({ ...a, allowMissing: true })).rejects.toThrow('删除')
  })
  it('persists tombstone+plan before unlink and resumes an unlink-before-progress crash', async () => {
    const a = await input(); await store.register(a); const native = fs.unlink
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      const record = JSON.parse(await readFile(join(dataDir, 'assets-v2', 'items', `${a.id}.json`), 'utf8'))
      expect(record.asset.deletedAt).toBeTruthy(); expect(record.deletion.files).toHaveLength(1)
      await native(file); throw new Error('crash after unlink')
    })
    await expect(store.delete(a.id)).rejects.toThrow('删除未完成'); expect((await store.all())[0].deletedAt).toBeTruthy()
    spy.mockRestore(); store = await restart(); expect(await store.all()).toEqual([]); expect((await store.get(a.id)).deletedAt).toBeTruthy()
    expect(await readdir(managed)).toContain('audio')
  })
  it('cleans generated-audio hardlinks plus receipt, without deleting the root or leaving a resurrection path', async () => {
    const a = await input(); const work = join(managed, '.generated-audio', a.id); await mkdir(work, { recursive: true })
    await link(join(managed, a.fileName), join(work, 'source.bin')); await link(join(managed, a.fileName), join(work, 'compatible.flac')); await writeFile(join(work, 'manifest.json'), JSON.stringify({ assetId: a.id, ready: true }))
    await store.register({ ...a, relatedFiles: [`.generated-audio/${a.id}/source.bin`] })
    const native = fs.unlink; let count = 0
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async file => { await native(file); if (++count === 2) throw new Error('interrupt hardlink cleanup') })
    await expect(store.delete(a.id)).rejects.toThrow(); spy.mockRestore()
    store = await restart(); expect(await store.all()).toEqual([]); expect(await readdir(work)).toEqual([]); expect(await readdir(managed)).toContain('audio')
  })
  it('keeps changed or redirected files as visible failed deletions rather than claiming success', async () => {
    const a = await input(); await store.register(a); await writeFile(join(managed, a.fileName), wav('changed'))
    await expect(store.delete(a.id)).rejects.toThrow('指纹已变化'); expect(await store.all()).toHaveLength(1); expect(await readFile(join(managed, a.fileName))).toEqual(wav('changed'))
    store = await restart(); expect((await store.all())[0].problem).toContain('变化')
    const otherData = join(root, 'other-data'); const otherManaged = join(root, 'other-managed'); const other = new AssetStore({ dataDir: otherData, root: otherManaged, getFFmpegPath: () => tools.ffmpeg }); await other.init()
    await mkdir(join(otherManaged, 'audio')); const id = randomUUID(); await writeFile(join(otherManaged, 'audio', `${id}.wav`), wav())
    await other.register({ id, kind: 'audio', name: 'junction', createdAt, rootId: await other.managedRootId(), fileName: `audio/${id}.wav`, origin: { type: 'legacy', name: 'old' } })
    await rename(join(otherManaged, 'audio'), join(root, 'moved')); await symlink(join(root, 'moved'), join(otherManaged, 'audio'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(other.delete(id)).rejects.toThrow('不安全'); expect(await readFile(join(root, 'moved', `${id}.wav`))).toEqual(wav())
  })
  it('refuses shared paths belonging to another asset even through distinct root registrations', async () => {
    const a = await input(); await store.register(a)
    // A second logical missing record predates the file's return, so dedup has no bytes to compare.
    const c = randomUUID(); const temporary = join(root, 'temporarily-moved.wav'); await rename(join(managed, a.fileName), temporary)
    const nestedRoot = await store.registerRoot(join(managed, 'audio'), true)
    await store.register({ id: c, kind: 'audio', name: 'missing overlapping alias', createdAt, rootId: nestedRoot, fileName: `${a.id}.wav`, allowMissing: true, origin: { type: 'legacy', name: 'separate history' } })
    await rename(temporary, join(managed, a.fileName))
    await expect(store.delete(a.id)).rejects.toThrow('共享'); expect(await readFile(join(managed, a.fileName))).toEqual(wav())
  })
  it('keeps unowned originals and imported external bytes; explicit reimport after deletion gets a fresh ID', async () => {
    const source = join(root, 'original.custom'); const bytes = await sharp({ create: { width: 20, height: 16, channels: 3, background: '#ab1234' } }).png().toBuffer(); await writeFile(source, bytes)
    const imported = await store.importFiles([source], 'image'); expect(imported.entries[0].status).toBe('imported')
    const id = imported.entries[0].assetId!; expect((await store.get(id)).sha256).toBe(sha(bytes)); expect(await store.deletionInfo(id)).toEqual({ ownedFiles: 1, externalOriginalsKept: true })
    expect((await store.importFiles([source], 'image')).entries[0]).toMatchObject({ status: 'duplicate', assetId: id })
    await store.delete(id); expect(await readFile(source)).toEqual(bytes)
    const next = (await store.importFiles([source], 'image')).entries[0]; expect(next.status).toBe('imported'); expect(next.assetId).not.toBe(id)
    const external = join(root, 'unowned'); await mkdir(external); const outsideId = randomUUID(); await writeFile(join(external, 'original.wav'), wav('unowned'))
    await store.register({ id: outsideId, kind: 'audio', name: 'external', createdAt, rootId: await store.registerRoot(external, false), fileName: 'original.wav', origin: { type: 'legacy', name: 'external' } })
    expect(await store.deletionInfo(outsideId)).toEqual({ ownedFiles: 0, externalOriginalsKept: true }); await store.delete(outsideId); expect(await readFile(join(external, 'original.wav'))).toEqual(wav('unowned'))
  })
  it('does not broaden manual import formats or scan supplied directories', async () => {
    const invalid = join(root, 'playlist.mp3'); await writeFile(invalid, '#EXTM3U\nhttps://example.invalid/audio')
    const result = await store.importFiles([invalid, root, '../relative.wav', join(root, 'missing.wav')], 'audio')
    expect(result.entries.every(entry => entry.status === 'failed')).toBe(true); expect(await store.all()).toEqual([])
    await expect(store.importFiles(Array(501).fill(invalid), 'audio')).rejects.toThrow('500')
    expect(await readFile(invalid, 'utf8')).toContain('#EXTM3U')
  })
})

describe('alias and publication commit races', () => {
  it('cannot acquire a source lease or delete while an alias is being durably reassigned', async () => {
    const source = await input(); await rm(join(managed, source.fileName)); await store.register({ ...source, allowMissing: true })
    const target = await input(); await store.register(target)
    let unblock!: () => void; let writing = false; const gate = new Promise<void>(resolve => { unblock = resolve })
    const native = atomic.atomicJson
    const spy = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (file, data, maximum) => {
      if (file === join(dataDir, 'assets-v2', 'items', `${target.id}.json`)) { writing = true; await gate }
      return native(file, data, maximum)
    })
    const pending = store.alias(source.id, target.id)
    await vi.waitFor(() => expect(writing).toBe(true))
    expect(() => store.pin([source.id], 'racing job')).toThrow('别名'); await expect(store.delete(source.id)).rejects.toThrow('预约')
    unblock(); await pending; spy.mockRestore()
    const release = store.pin([source.id], 'queued'); await expect(store.delete(target.id)).rejects.toThrow('预约'); release()
    store = await restart(); expect((await store.get(source.id)).id).toBe(target.id)
  })
  it('recognizes a usage publication retry canonicalized after an alias migration', async () => {
    const a = await input(); await store.register(a); const oldId = randomUUID(); const ledger = usage([oldId])
    await store.recordUsage(ledger); await store.alias(oldId, a.id)
    await store.recordUsage({ ...ledger, assetIds: [a.id] }); store = await restart()
    await store.recordUsage({ ...ledger, assetIds: [a.id] }); expect(await store.allUsage()).toHaveLength(1); expect((await store.get(a.id)).usedCount).toBe(1)
  })
  it('creates a managed copy when an import deduplicates against an unowned location', async () => {
    const external = join(root, 'external-import'); await mkdir(external); const source = join(external, 'source.wav'); await writeFile(source, wav())
    const id = randomUUID(); await store.register({ id, kind: 'audio', name: 'original long name', createdAt, rootId: await store.registerRoot(external, false), fileName: 'source.wav', origin: { type: 'legacy', name: 'old' } })
    expect((await store.importFiles([source], 'audio')).entries[0]).toMatchObject({ status: 'duplicate', assetId: id })
    expect(await readFile(source)).toEqual(wav()); await rm(source)
    expect(await store.pathForAsset(id)).toBe(join(managed, 'audio', `${id}.wav`)); expect((await store.get(id)).name).toBe('original long name')
    await store.delete(id); expect(await readdir(join(managed, 'audio'))).toEqual([])
  })
  it('never unlinks if writing the first tombstone fails', async () => {
    const a = await input(); await store.register(a); const native = atomic.atomicJson; const unlinkSpy = vi.spyOn(fs, 'unlink')
    const spy = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (file, data, maximum) => {
      if (file === join(dataDir, 'assets-v2', 'items', `${a.id}.json`)) throw new Error('disk full')
      return native(file, data, maximum)
    })
    await expect(store.delete(a.id)).rejects.toThrow('删除未完成'); expect(unlinkSpy).not.toHaveBeenCalled(); spy.mockRestore()
    expect(await store.get(a.id)).toMatchObject({ available: true }); expect(await readFile(join(managed, a.fileName))).toEqual(wav())
  })
  it('keeps failed decode out of the evidence cache and rejects a valid probe with no decoded frames', async () => {
    const a = await input(); decodeHook = async () => { throw new Error('decode failed') }
    await expect(store.register({ ...a, validated: true })).rejects.toThrow('decode failed'); expect(await store.all()).toEqual([])
    decodeHook = undefined; await store.register(a); expect(decodes).toBe(2)
    const video = await input('video', mp4()); const previous = vi.mocked(runTool).getMockImplementation()!
    vi.mocked(runTool).mockImplementation(async (file, args, options) => args.includes('0:V:0') ? (options?.onProgress?.(12.5), { stdout: 'frame=0\n', stderr: '' }) : previous(file, args, options))
    await expect(store.register({ ...video, validated: true })).rejects.toThrow('完整解码')
  })
})

describe('missing replay and overlapping root ownership', () => {
  it('marks a replayed missing file unavailable without losing its name, ID or original digest', async () => {
    const a = await input(); const before = await store.register(a); await store.rename(a.id, '保留改名'); await rm(join(managed, a.fileName))
    expect(await store.register({ ...a, allowMissing: true })).toMatchObject({ id: a.id, name: '保留改名', sha256: before.sha256, available: false })
    store = await restart(); expect((await store.get(a.id)).available).toBe(false)
  })
  it('never turns an explicitly unowned original into owned bytes via an overlapping root', async () => {
    const a = await input(); const externalRoot = await store.registerRoot(join(managed, 'audio'), false)
    await store.register({ ...a, rootId: externalRoot, fileName: `${a.id}.wav` })
    const duplicate = await store.register({ ...a, id: randomUUID() }); expect(duplicate.id).toBe(a.id)
    expect(await store.deletionInfo(a.id)).toEqual({ ownedFiles: 0, externalOriginalsKept: true })
    await store.delete(a.id); expect(await readFile(join(managed, a.fileName))).toEqual(wav())
  })
})

describe('first-use managed root configuration', () => {
  it('safely changes an empty root and uses it for import and DB-root restart', async () => {
    const options = { dataDir, root: managed, getFFmpegPath: () => tools.ffmpeg }
    store = new AssetStore(options); await store.init()
    const selected = join(root, 'chosen-media'); const outside = join(root, 'outside'); await mkdir(outside)
    const redirect = join(root, 'redirect-root'); await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.configureRoot('../relative')).rejects.toThrow('不安全')
    await expect(store.configureRoot(redirect)).rejects.toThrow('不安全'); expect(await store.managedRootId()).toBe(rootId)
    await store.configureRoot(selected); const selectedId = await store.managedRootId()
    expect(selectedId).not.toBe(rootId); expect(options.root).toBe(selected); expect(await store.rootDirectory(selectedId)).toBe(selected)
    const interrupted = new AssetStore({ ...options, root: managed }); await interrupted.init()
    expect(await interrupted.managedRootId()).toBe(rootId) // Root registry alone never overrides DB settings.
    const source = join(root, 'external-source.wav'); await writeFile(source, wav())
    const imported = (await store.importFiles([source], 'audio')).entries[0]; expect(imported.status).toBe('imported')
    expect(await store.pathForAsset(imported.assetId!)).toBe(join(selected, 'audio', `${imported.assetId}.wav`))
    const restarted = new AssetStore({ ...options, root: selected }); await restarted.init()
    expect(await restarted.managedRootId()).toBe(selectedId); expect(await restarted.pathForAsset(imported.assetId!)).toBe(join(selected, 'audio', `${imported.assetId}.wav`))
    expect(await readFile(source)).toEqual(wav())
  })
  it('rejects existing assets, leases, tombstones and a usage-only history without changing roots', async () => {
    const a = await input(); await store.register(a); const selected = join(root, 'must-not-create')
    const release = store.pin([a.id], 'queued-job')
    await expect(store.configureRoot(selected)).rejects.toThrow('完全空库'); release()
    await expect(store.configureRoot(selected)).rejects.toThrow('完全空库')
    await store.delete(a.id); expect(await store.all()).toEqual([])
    store = await restart(); await expect(store.configureRoot(selected)).rejects.toThrow('完全空库'); expect(await store.managedRootId()).toBe(rootId)
    const ledgerOnly = new AssetStore({ dataDir: join(root, 'usage-only-data'), root: join(root, 'usage-only-media'), getFFmpegPath: () => tools.ffmpeg })
    await ledgerOnly.init(); const ledgerRoot = await ledgerOnly.managedRootId(); await ledgerOnly.recordUsage(usage([]))
    await expect(ledgerOnly.configureRoot(selected)).rejects.toThrow('完全空库'); expect(await ledgerOnly.managedRootId()).toBe(ledgerRoot)
    await expect(fs.lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('blocks both directions of configure/import/register races and releases guards after failures', async () => {
    const a = await input(); const selected = join(root, 'race-selected'); let writing = false; let unblock!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve }); const native = atomic.atomicJson
    const spy = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (file, data, maximum) => {
      if (file.includes(join('assets-v2', 'roots'))) { writing = true; await gate }
      return native(file, data, maximum)
    })
    const configuring = store.configureRoot(selected); await vi.waitFor(() => expect(writing).toBe(true))
    await expect(store.register(a)).rejects.toThrow('正在切换'); await expect(store.importFiles([join(managed, a.fileName)], 'audio')).rejects.toThrow('正在切换')
    await expect(store.verify(a.id)).rejects.toThrow('正在切换'); expect(() => store.pin([], 'queue')).toThrow('正在切换')
    await expect(store.configureRoot(join(root, 'other-root'))).rejects.toThrow('正在切换')
    unblock(); await configuring; spy.mockRestore()
    let decoding = false; let finishImport!: () => void; const importGate = new Promise<void>(resolve => { finishImport = resolve })
    decodeHook = async () => { decoding = true; await importGate; throw new Error('injected import decode failure') }
    const importing = store.importFiles([join(managed, a.fileName)], 'audio'); await vi.waitFor(() => expect(decoding).toBe(true))
    expect(await store.all()).toEqual([]); await expect(store.configureRoot(join(root, 'during-import'))).rejects.toThrow('完全空库')
    finishImport(); expect((await importing).entries[0].status).toBe('failed')
    await store.configureRoot(join(root, 'after-failure')); expect(await store.rootDirectory(await store.managedRootId())).toBe(join(root, 'after-failure'))
    decoding = false; let finishRegister!: () => void; const registerGate = new Promise<void>(resolve => { finishRegister = resolve })
    decodeHook = async () => { decoding = true; await registerGate }
    const registering = store.register(a); await vi.waitFor(() => expect(decoding).toBe(true))
    expect(await store.all()).toEqual([]); await expect(store.configureRoot(join(root, 'during-register'))).rejects.toThrow('完全空库')
    finishRegister(); expect((await registering).id).toBe(a.id)
  })
})
