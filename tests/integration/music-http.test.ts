import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { startAceStepFixture } from '../fixtures/acestep-server'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { JobManager } from '../fixtures/v31/main/jobs'
import { ProjectStore } from '../fixtures/v31/main/storage/projects'
import { SettingsStore } from '../fixtures/v31/main/storage/settings'
import { LibraryStore } from '../fixtures/v31/main/storage/library'
import { defaultMusicDraft } from '../../src/shared/music-capabilities'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'
import { mediaResponse } from '../../src/main/media-protocol'

let root: string, audio: Buffer
beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v31-http-'))
  const tools = await requireTools()
  const file = path.join(root, '人工 测试音.flac')
  await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=1.5:sample_rate=48000', '-c:a', 'flac', file])
  audio = await readFile(file)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('ACE-Step production adapter through real isolated TCP and media decoding', () => {
  it.each([undefined, 'x'])('submits, queries, downloads, registers and restarts with key=%s', async key => {
    const server = await startAceStepFixture({ audio, key, durationSeconds: 999, failDownloads: key ? 1 : 0 })
    let manager: JobManager | undefined
    try {
      const data = path.join(root, key ? 'protected' : 'no-key'), media = path.join(data, 'projects')
      const settings = new SettingsStore(data, media); await settings.init()
      await settings.configureAceStep({ baseUrl: server.baseUrl, waitMinutes: 5, allowLan: false })
      const projects = new ProjectStore(data); await projects.init()
      const project = await projects.create(settings.get())
      await projects.patch(project.id, { music: { ...defaultMusicDraft('acestep'), prompt: 'Synthetic protocol fixture, not AI music', seconds: 10 } })
      const registry = new MusicRegistry()
      const status = await registry.getAceStepModels({ baseUrl: server.baseUrl, key })
      expect(status.llmInitialized).toBe(false); expect(status.models[0].name).toBe('acestep-v15-turbo')
      const keys = { has: () => key !== undefined, get: () => key! }
      manager = new JobManager({ projects, settings, registry, keys, music: { create: async () => { throw new Error('Must not call Mureka') }, query: async () => { throw new Error('Must not call Mureka') }, check: async () => ({ message: 'unused' }) },
        images: { generate: async () => { throw new Error('Must not generate image') }, check: async () => ({ message: 'unused' }) }, pollIntervalMs: 5, pollLimit: 4 })
      await manager.startMusic(project.id); await manager.idle()
      if (key) {
        const pending = (await projects.get(project.id)).musicJobs[0]
        expect(pending.status).toBe('failed'); expect(pending.recoverable).toBe(true)
        await manager.retryMusicJob(project.id, pending.id); await manager.idle()
      }
      const saved = await projects.get(project.id)
      expect(saved.musicJobs[0].status, saved.musicJobs[0].error).toBe('succeeded')
      expect(saved.audio).toHaveLength(1); expect(saved.audio[0].provider).toBe('acestep')
      expect(saved.audio[0].durationMs).toBeCloseTo(1500, 0)
      expect(saved.audio[0].fileName.endsWith('.flac')).toBe(true)
      expect(await readFile(await projects.pathForAsset(project.id, 'audio', saved.audio[0].id))).toEqual(audio)
      const response = await mediaResponse(new Request(`canvas-media://asset/${project.id}/audio/${saved.audio[0].id}`, { headers: { Range: 'bytes=0-31' } }), projects)
      expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(audio.subarray(0, 32))
      const library = new LibraryStore({ dataDir: data, defaultRoot: path.join(data, 'library'), projects, getFFmpegPath: () => undefined }); await library.init()
      const items = await library.all(); expect(items).toHaveLength(1); expect(items[0].origins[0].provider).toBe('acestep')
      expect(items[0].durationSeconds).toBeCloseTo(1.5, 2)
      const reopened = new ProjectStore(data); await reopened.init(); expect((await reopened.get(project.id)).audio).toEqual(saved.audio)
      await manager.recover(); await manager.idle(); expect(server.tasks.size).toBe(1)
      expect(server.requests.every(request => request.authorized)).toBe(true)
      const body = [...server.tasks.values()][0].body
      expect(body).toMatchObject({ task_type: 'text2music', batch_size: 1, audio_format: 'flac', thinking: false, use_cot_caption: false, use_cot_language: false })
      expect(body).not.toHaveProperty('sample_query')
    } finally { manager?.shutdown(); await manager?.idle(); await server.close() }
  })
})
