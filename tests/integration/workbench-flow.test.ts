import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { requireTools, runTool, probeMedia, type VideoTools } from '../../src/main/video/ffmpeg'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { AssetStore } from '../../src/main/storage/assets-v2'
import { SecretStore } from '../../src/main/storage/secrets'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { WorkbenchService } from '../../src/main/workbench-service'
import { initialEntry, initialComposition } from '../../src/shared/workbench-schemas'
import { startAceStepFixture } from '../fixtures/acestep-server'
import { mediaResponse } from '../../src/main/media-protocol'

let root: string, tools: VideoTools, audio: string, pictures: string[]
beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v4-real-flow-')); tools = await requireTools(); audio = path.join(root, '外部原件.flac')
  await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=554:duration=65:sample_rate=48000', '-c:a', 'flac', audio])
  pictures = []
  for (const color of ['#264a7b', '#983917']) { const file = path.join(root, `外部图片-${pictures.length}.png`); await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(file); pictures.push(file) }
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(Buffer.from(text).map(value => value ^ 61)), decryptString: (bytes: Buffer) => Buffer.from(bytes.map(value => value ^ 61)).toString() }

describe('V4 actual isolated HTTP → asset → parallel composition → usage → deletion', () => {
  it('binds generation to A, renders across independent projects, retains assets after deletion and keeps usage after video removal', async () => {
    const dataDir = path.join(root, 'appdata'), mediaRoot = path.join(root, 'media')
    const db = new WorkbenchDB(dataDir); await db.init()
    await db.put('settings', 'current', { version: 5, mediaRoot, ffmpegPath: tools.ffmpeg, render: { concurrency: 2, threads: 2, encoder: 'cpu', staticVideo: true }, page: 'generation' })
    const assets = new AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => tools.ffmpeg }); await assets.init()
    const secrets = new SecretStore(dataDir, encryption); await secrets.init()
    const registry = new MusicRegistry(), server = await startAceStepFixture({ audio: await readFile(audio), key: 'a', durationSeconds: 999 })
    const service = new WorkbenchService({ dataDir, db, assets, secrets, registry, images: { generate: async () => { throw new Error('No image API calls') }, check: async () => ({ message: 'unused' }) }, testMode: false, pollMs: 10 })
    await service.init()
    try {
      expect((await service.snapshot()).apis).toEqual([])
      await service.apis.save({ provider: 'acestep', key: 'a', local: { baseUrl: server.baseUrl, waitMinutes: 5, allowLan: false } })
      const a = await service.generationProjects.create(), b = await service.generationProjects.create()
      let entry = await service.generationProjects.add(a.id, 'audio')
      entry = await service.generationProjects.updateEntry(entry.id, entry.revision, { ...initialEntry('audio', 'acestep'), mode: 'instrumental', prompt: '人工接口测试，不代表模型推理', seconds: 10, title: '用户明确曲名' }, {})
      await service.generation.submit({ projectId: a.id, submissionId: randomUUID(), entries: [{ id: entry.id, revision: entry.revision }] })
      await service.updateSettings({ lastGenerationId: b.id })
      await service.generation.idle()
      const request = db.list('requests')[0]
      expect(request.status, request.error).toBe('succeeded'); expect(request.projectId).toBe(a.id)
      expect(db.get('generation', b.id).entryIds).toEqual([])
      expect(server.tasks.size).toBe(1); expect(server.requests.every(item => item.authorized)).toBe(true)
      const song = await assets.get(request.assetIds[0]); expect(song.durationSeconds).toBeCloseTo(65, 1); expect(song.name).toBe('用户明确曲名')
      const imported = await assets.importFiles(pictures, 'image'); expect(imported.entries.every(item => item.status === 'imported')).toBe(true)
      const c1 = await service.compositionProjects.create(), c2 = await service.compositionProjects.create()
      const makeDraft = (imageId: string) => ({ ...initialComposition(), minimumSeconds: 60, audioIds: [song.id], imageIds: [imageId] })
      const cp1 = await service.compositionProjects.update(c1.id, 0, { name: '合成一', draft: makeDraft(imported.entries[0].assetId!) })
      const cp2 = await service.compositionProjects.update(c2.id, 0, { name: '合成二', draft: makeDraft(imported.entries[1].assetId!) })
      const p1 = await service.composition.plan(c1.id, cp1.revision), p2 = await service.composition.plan(c2.id, cp2.revision)
      expect(p1.issues).toEqual([]); expect(p2.issues).toEqual([])
      const batch1 = await service.composition.start(c1.id, p1.id), batch2 = await service.composition.start(c2.id, p2.id)
      expect((await service.assetImpact(song.id)).blocked).toBe(true)
      await expect(service.compositionProjects.delete(c1.id)).rejects.toThrow('任务')
      await service.composition.idle()
      const one = db.get('executions', batch1.id), two = db.get('executions', batch2.id)
      expect(one.jobs[0].status, one.jobs[0].error).toBe('succeeded'); expect(two.jobs[0].status, two.jobs[0].error).toBe('succeeded')
      const attempts = [one.jobs[0].attempts[0], two.jobs[0].attempts[0]]
      expect(Math.max(...attempts.map(attempt => Date.parse(attempt.startedAt)))).toBeLessThan(Math.min(...attempts.map(attempt => Date.parse(attempt.finishedAt!))))
      expect(attempts.every(attempt => attempt.stages?.some(stage => stage.stage === 'publish') && attempt.staticVideo)).toBe(true)
      const videos = (await assets.all()).filter(asset => asset.kind === 'video'); expect(videos).toHaveLength(2)
      for (const video of videos) {
        const info = await probeMedia(tools, await assets.pathForAsset(video.id))
        expect(info.durationSeconds).toBeCloseTo(65, 1)
        expect(info.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, r_frame_rate: '30/1', codec_name: 'h264' })
      }
      expect((await assets.get(song.id)).usedCount).toBe(2)
      await service.generationProjects.delete(a.id); await service.compositionProjects.delete(c1.id)
      const media = await mediaResponse(new Request(`canvas-media://library/${song.id}`, { headers: { Range: 'bytes=0-15' } }), { pathForAsset: async () => { throw new Error('Legacy resolver must not be used') } }, { library: assets, batches: { pathForAsset: async () => { throw new Error('Legacy batch resolver must not be used') } } })
      expect(media.status).toBe(206); expect((await media.arrayBuffer()).byteLength).toBe(16)
      await service.deleteAsset(videos[0].id)
      expect((await assets.get(song.id)).usedCount).toBe(2)
      expect((await assets.get(song.id)).historyUncertain).toBe(false)
      await service.shutdown()
      const reopened = new AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => tools.ffmpeg }); await reopened.init()
      expect((await reopened.get(song.id)).usedCount).toBe(2)
      expect((await reopened.all()).filter(asset => asset.kind === 'video')).toHaveLength(1)
      await reopened.delete(song.id); await reopened.refresh()
      expect((await reopened.all()).some(asset => asset.id === song.id)).toBe(false)
      expect((await readFile(audio)).subarray(0, 4).toString()).toBe('fLaC')
      expect((await reopened.get(song.id)).usedCount).toBe(2)
      expect(server.tasks.size).toBe(1)
    } finally { await service.shutdown(); await server.close() }
  })
})
