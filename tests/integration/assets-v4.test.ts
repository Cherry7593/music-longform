import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AssetStore } from '../../src/main/storage/assets-v2'
import * as ffmpeg from '../../src/main/video/ffmpeg'
import type { VideoTools } from '../../src/main/video/ffmpeg'
import { saveGeneratedAudio } from '../../src/main/generated-audio'

vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>() }))
let root: string; let tools: VideoTools
let decodes = 0
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const codecs = { wav: 'pcm_s16le', mp3: 'libmp3lame', flac: 'flac', m4a: 'aac' }
async function tone(format: keyof typeof codecs): Promise<string> {
  const file = join(root, `${randomUUID()}.${format}`)
  await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=0.8:sample_rate=48000', '-ac', '2', '-c:a', codecs[format], file])
  return file
}
async function createStore(): Promise<{ store: AssetStore; options: { dataDir: string; root: string; getFFmpegPath: () => string } }> {
  const options = { dataDir: join(root, randomUUID()), root: join(root, randomUUID()), getFFmpegPath: () => tools.ffmpeg }
  const store = new AssetStore(options); await store.init(); return { store, options }
}
beforeAll(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'assets-v4-real-中文 & '))
  tools = await ffmpeg.requireTools(process.env.FFMPEG_PATH)
  const native = ffmpeg.runTool
  vi.spyOn(ffmpeg, 'runTool').mockImplementation(async (file, args, options) => {
    if (args.includes('null') && args.includes('-xerror')) decodes++
    return native(file, args, options)
  })
}, 120000)
afterAll(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })

describe('real local FFmpeg V4 assets', () => {
  it.each(['wav', 'mp3', 'flac', 'm4a'] as const)('imports %s byte-for-byte and caches full decode across concurrency and restart', async format => {
    const source = await tone(format); const bytes = await readFile(source); const { store, options } = await createStore()
    const before = decodes; const imported = await store.importFiles([source], 'audio')
    expect(imported.entries[0], JSON.stringify(imported)).toMatchObject({ status: 'imported' }); const id = imported.entries[0].assetId!
    expect(decodes - before).toBe(1)
    const resolved = await Promise.all(Array.from({ length: 6 }, () => store.verify(id)))
    expect(resolved[0].asset).toMatchObject({ sha256: hash(bytes), bytes: bytes.length, format, available: true }); expect(resolved[0].asset.durationSeconds).toBeGreaterThan(0.7)
    const restarted = new AssetStore(options); await restarted.init(); await restarted.verify(id)
    expect(decodes - before).toBe(1); expect(await readFile(source)).toEqual(bytes); expect(await readFile(resolved[0].path)).toEqual(bytes)
    await restarted.delete(id); expect(await readFile(source)).toEqual(bytes); expect(await restarted.all()).toEqual([])
    const again = await restarted.importFiles([source], 'audio'); expect(again.entries[0].status).toBe('imported'); expect(again.entries[0].assetId).not.toBe(id)
  })
  it('registers a real non-1080 MP4 independently of a removed project; video deletion retains usage', async () => {
    const { store, options } = await createStore(); const projectRoot = join(root, randomUUID()); await mkdir(projectRoot)
    const projectFile = join(projectRoot, 'project.json'); await writeFile(projectFile, JSON.stringify({ id: randomUUID(), name: 'former project' }))
    const videoId = randomUUID(); const video = join(projectRoot, `${videoId}.mp4`)
    await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=0.8', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.8:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', video])
    const audioId = (await store.importFiles([await tone('flac')], 'audio')).entries[0].assetId!
    const before = decodes; const asset = await store.register({ id: videoId, kind: 'video', name: '保留原规格旧成片', createdAt: new Date().toISOString(), origin: { type: 'composition', name: '已删除项目快照', projectId: randomUUID(), batchId: randomUUID() }, rootId: await store.registerRoot(projectRoot, true), fileName: `${videoId}.mp4`, validated: true, metadata: { width: 1920, height: 1080, durationSeconds: 100 } })
    expect(asset).toMatchObject({ width: 320, height: 180, format: 'mp4', available: true }); expect(decodes - before).toBe(1)
    await rm(projectFile); await store.rename(videoId, '改名不会被刷新覆盖'); expect(await store.pathForAsset(videoId)).toBe(video)
    const usage = { version: 2 as const, id: randomUUID(), videoId, name: asset.name, finishedAt: new Date().toISOString(), durationSeconds: asset.durationSeconds!, assetIds: [audioId], uncertainAssetIds: [] }
    await store.recordUsage(usage); await store.recordUsage(usage); await store.delete(videoId)
    const restarted = new AssetStore(options); await restarted.init(); await restarted.recordUsage(usage)
    expect(await restarted.get(audioId)).toMatchObject({ usedCount: 1 }); expect(await restarted.allUsage()).toHaveLength(1)
    await expect(restarted.pathForAsset(videoId)).rejects.toThrow('删除'); expect(await readdir(projectRoot)).toEqual([])
  })
  it('rejects invalid MP4 plus formats not allowed by manual imports without trusting validation flags', async () => {
    const { store, options } = await createStore(); const files: string[] = []
    for (const [codec, extension] of [['alac', 'm4a'], ['libopus', 'ogg'], ['aac', 'aac']]) {
      const file = join(root, `${randomUUID()}.${extension}`); files.push(file)
      await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.3', '-c:a', codec, file])
    }
    expect((await store.importFiles(files, 'audio')).entries.every(entry => entry.status === 'failed')).toBe(true)
    const id = randomUUID(); await writeFile(join(options.root, `${id}.mp4`), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]))
    await expect(store.register({ id, kind: 'video', name: 'invalid', createdAt: new Date().toISOString(), origin: { type: 'legacy', name: 'old' }, rootId: await store.managedRootId(), fileName: `${id}.mp4`, validated: true })).rejects.toThrow()
    expect(await store.all()).toEqual([])
  })
  it('deletes all generated audio recovery hardlinks and receipt, leaving external source unchanged', async () => {
    const { store, options } = await createStore(); const source = await tone('flac'); const bytes = await readFile(source)
    const id = randomUUID(); const work = join(options.root, '.generated-audio', id); await mkdir(work, { recursive: true }); await mkdir(join(options.root, 'audio'))
    await copyFile(source, join(work, 'source.bin')); await link(join(work, 'source.bin'), join(work, 'compatible.flac')); await link(join(work, 'source.bin'), join(options.root, 'audio', `${id}.flac`))
    await writeFile(join(work, 'manifest.json'), JSON.stringify({ version: 1, assetId: id, ready: { sha256: hash(bytes), bytes: bytes.length, format: 'flac', durationMs: 800 } }))
    await store.register({ id, kind: 'audio', name: '生成结果', createdAt: new Date().toISOString(), rootId: await store.managedRootId(), fileName: `audio/${id}.flac`, relatedFiles: [`.generated-audio/${id}/source.bin`, `.generated-audio/${id}/compatible.flac`], origin: { type: 'generation', name: '删除的生成项目' } })
    await store.delete(id); expect(await readdir(work)).toEqual([]); expect(await readdir(join(options.root, 'audio'))).toEqual([]); expect(await readFile(source)).toEqual(bytes)
  })
  it('registers and deletes a generated Opus original with its full FLAC copy and UUID-owned receipts', async () => {
    const { store, options } = await createStore(), id = randomUUID(), source = join(root, `${randomUUID()}.mp4`)
    await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=720:duration=0.8:sample_rate=48000', '-c:a', 'libopus', source])
    const bytes = await readFile(source)
    const saved = await saveGeneratedAudio({ directory: options.root, assetId: id, url: 'https://8.8.8.8/fixture.mp4', getFFmpegPath: () => tools.ffmpeg, fetcher: async () => new Response(bytes) })
    expect(saved.originalFileName).toBe(`audio-originals/${id}.mp4`)
    const input = { id, kind: 'audio' as const, name: '兼容副本', createdAt: new Date().toISOString(), rootId: await store.managedRootId(), fileName: saved.fileName,
      relatedFiles: [saved.originalFileName!, `.generated-audio/${id}/manifest.json`], origin: { type: 'legacy' as const, name: '旧生成项目' } }
    const asset = await store.register(input); expect(asset.format).toBe('flac')
    await expect(store.register({ ...input, relatedFiles: [`audio-originals/${randomUUID()}.mp4`] })).rejects.toThrow('路径')
    const reopened = new AssetStore(options); await reopened.init(); await reopened.delete(id)
    await expect(readFile(join(options.root, saved.originalFileName!))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(options.root, saved.fileName))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source)).toEqual(bytes)
    expect(await readdir(join(options.root, '.generated-audio', id))).toEqual([])
  })

  it.each(['png', 'jpeg', 'webp'] as const)('preserves real %s image metadata bytes and only removes its managed copy', async format => {
    const { store } = await createStore(); const source = join(root, `${randomUUID()}.arbitrary`)
    const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#8a12aa' } }).withMetadata({ density: 120 }).toFormat(format).toBuffer(); await writeFile(source, bytes)
    const result = await store.importFiles([source], 'image'); expect(result.entries[0].status).toBe('imported'); const id = result.entries[0].assetId!
    expect(await store.get(id)).toMatchObject({ format, width: 48, height: 32, sha256: hash(bytes) }); expect(await readFile(await store.pathForAsset(id))).toEqual(bytes)
    await store.delete(id); expect(await readFile(source)).toEqual(bytes)
  })
})
