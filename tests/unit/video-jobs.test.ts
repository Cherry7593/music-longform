import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { VideoJobManager } from '../fixtures/v31/main/video/jobs'
import { CancelledError, type ProbeInfo } from '../../src/main/video/ffmpeg'
import type { RenderRequest } from '../../src/main/video/pipeline'
import { ProjectStore } from '../fixtures/v31/main/storage/projects'
import { SettingsStore } from '../fixtures/v31/main/storage/settings'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import { calculateTimeline } from '../../src/shared/video-timeline'
import { AppError } from '../../src/main/providers/http'

let root: string
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated disk tests')
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'yt-video-jobs '))
})
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const store = new ProjectStore(path.join(root, 'data'))
  const settings = new SettingsStore(path.join(root, 'data'), path.join(root, '素材'))
  await settings.init(); await store.init()
  let p = await store.create(settings.get())
  const audioId = randomUUID(); const second = randomUUID(); const imageId = randomUUID()
  p = await store.mutate(p.id, p => {
    for (const id of [audioId, second]) p.audio.push({ id, provider: 'mureka', jobId: randomUUID(), remoteId: '123', taskId: '123', title: '曲目', fileName: `audio/${id}.wav`, createdAt: new Date().toISOString(), durationMs: 999000, prompt: 'test', model: 'test', mode: 'instrumental', kept: true })
    p.images.push({ id: imageId, jobId: randomUUID(), fileName: `images/${imageId}.png`, createdAt: new Date().toISOString(), prompt: 'test', model: 'test', quality: 'medium', size: '1024x1024', provider: 'openai', format: 'png' })
    p.video = { ...DEFAULT_VIDEO, initialized: true, audioIds: [audioId, second], imageId, durationMode: 'all' }
  })
  for (const asset of [...p.audio, ...p.images]) await writeFile(path.join(p.directory, asset.fileName), 'original fixture')
  const discover = vi.fn(async () => ({ available: true, ffmpeg: path.join(root, 'ffmpeg.exe'), ffprobe: path.join(root, 'ffprobe.exe'), message: 'test' }))
  const probe = vi.fn(async (_tools, file: string): Promise<ProbeInfo> => file.endsWith('.png') ? { durationSeconds: 0, streams: [{ codec_type: 'video', width: 100, height: 100 }] } : { durationSeconds: 10, streams: [{ codec_type: 'audio' }] })
  const render = vi.fn(async (request: RenderRequest) => {
    request.onProgress?.({ status: 'encoding', progress: 0.55, detail: 'encoding test' })
    const filePath = path.join(request.taskDirectory, request.kind === 'video' ? 'output.mp4' : 'preview.wav')
    await writeFile(filePath, 'rendered fixture')
    return { filePath, durationSeconds: 17, timeline: calculateTimeline(request.draft, request.tracks) }
  })
  const onError = vi.fn()
  const manager = new VideoJobManager({ projects: store, settings, render, discover, probe, onError })
  return { store, settings, p, manager, render, probe, discover, onError }
}
describe('video jobs', () => {
  it('uses probed durations not provider metadata and reports target deficits', async () => {
    const f = await fixture()
    const check = await f.manager.analyze(f.p.id)
    expect(check.timeline.rawSeconds).toBe(20)
    expect(check.timeline.availableSeconds).toBe(17)
    await f.store.patch(f.p.id, { video: { ...f.p.video, durationMode: 'target', targetSeconds: 60 } })
    await f.manager.start(f.p.id); await f.manager.idle()
    const job = (await f.store.get(f.p.id)).videoJobs[0]
    expect(job.status).toBe('failed')
    expect(job.error).toContain('还差 43 秒')
    expect(f.render).not.toHaveBeenCalled()
  })
  it('takes immutable snapshots, publishes complete files and never touches source media', async () => {
    const f = await fixture()
    const started = await f.manager.start(f.p.id)
    await f.store.patch(f.p.id, { video: { ...f.p.video, fit: 'cover' }, music: { ...f.p.music, prompt: 'still editing' } })
    await f.manager.idle()
    const current = await f.store.get(f.p.id)
    const job = current.videoJobs[0]
    expect(job.status).toBe('succeeded'); expect(job.progress).toBe(100)
    expect(job.snapshot.fit).toBe('contain'); expect(current.video.fit).toBe('cover')
    expect(current.music.prompt).toBe('still editing')
    expect(await readFile(await f.store.pathForAsset(f.p.id, 'video', job.id), 'utf8')).toBe('rendered fixture')
    expect(await readdir(path.join(f.p.directory, 'videos'))).toEqual([`${started.videoJobs[0].id}.mp4`])
    for (const source of [...current.audio, ...current.images]) expect(await readFile(path.join(current.directory, source.fileName), 'utf8')).toBe('original fixture')
    expect(f.onError).not.toHaveBeenCalled()
  })
  it('global reservation blocks simultaneous exports/previews and cancellation cleans its work only', async () => {
    const f = await fixture()
    f.render.mockImplementationOnce(async request => {
      await writeFile(path.join(request.taskDirectory, 'partial.mp4'), 'incomplete')
      await new Promise<void>((resolve, reject) => { if (request.signal.aborted) reject(new CancelledError()); else request.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true }) })
      throw new Error('unreachable')
    })
    const first = f.manager.start(f.p.id)
    await expect(f.manager.start(f.p.id, 'preview', 0)).rejects.toThrow('已有视频任务')
    const initial = await first
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1))
    const cancelled = await f.manager.cancel(f.p.id, initial.videoJobs[0].id)
    expect(cancelled.videoJobs[0].status).toBe('cancelled')
    expect(await readdir(path.join(f.p.directory, 'videos'))).toEqual([])
    expect(f.manager.busy).toBe(false)
    expect(await readFile(path.join(f.p.directory, f.p.audio[0].fileName), 'utf8')).toBe('original fixture')
  })
  it('preview can run without a selected image and is separately registered as WAV', async () => {
    const f = await fixture()
    await f.store.patch(f.p.id, { video: { ...f.p.video, imageId: undefined } })
    await expect(f.manager.start(f.p.id)).rejects.toThrow('图片')
    await f.manager.start(f.p.id, 'preview', 0); await f.manager.idle()
    const job = (await f.store.get(f.p.id)).videoJobs[0]
    expect(job.kind).toBe('preview'); expect(job.status).toBe('succeeded')
    expect(await f.store.pathForAsset(f.p.id, 'preview', job.id)).toContain('.wav')
    await expect(f.store.pathForAsset(f.p.id, 'video', job.id)).rejects.toThrow('不存在')
  })
  it('rejects missing files, invalid boundary and unavailable tools without rendering', async () => {
    const f = await fixture()
    await expect(f.manager.start(f.p.id, 'preview', 1)).rejects.toThrow('相邻')
    await rm(path.join(f.p.directory, f.p.audio[0].fileName))
    await f.manager.start(f.p.id); await f.manager.idle()
    expect((await f.store.get(f.p.id)).videoJobs[0].status).toBe('failed')
    f.discover.mockResolvedValueOnce({ available: false, ffmpeg: '', ffprobe: '', message: '找不到 FFmpeg' })
    await expect(f.manager.analyze(f.p.id)).rejects.toThrow('FFmpeg')
    expect(f.render).not.toHaveBeenCalled()
  })
  it('recovery marks interrupted, preserves all completed outputs and never rerenders', async () => {
    const f = await fixture()
    await f.manager.start(f.p.id); await f.manager.idle()
    await f.store.mutate(f.p.id, p => p.videoJobs.push({ id: randomUUID(), kind: 'video', status: 'encoding', createdAt: new Date().toISOString(), snapshot: p.video }))
    await f.manager.recover()
    const p = await f.store.get(f.p.id)
    expect(p.videoJobs.map(j => j.status)).toEqual(['succeeded', 'interrupted'])
    expect(f.render).toHaveBeenCalledTimes(1)
    expect(await readFile(await f.store.pathForAsset(p.id, 'video', p.videoJobs[0].id), 'utf8')).toBe('rendered fixture')
  })
  it('render failure never publishes a completed asset', async () => {
    const f = await fixture()
    f.render.mockRejectedValueOnce(new AppError('模拟磁盘空间不足'))
    await f.manager.start(f.p.id); await f.manager.idle()
    const job = (await f.store.get(f.p.id)).videoJobs[0]
    expect(job.status).toBe('failed'); expect(job.error).toContain('空间不足')
    await expect(f.store.pathForAsset(f.p.id, 'video', job.id)).rejects.toThrow('不存在')
  })
})

it('converts engine fractions to UI percentages before final completion', async () => {
  const f = await fixture()
  const progress: number[] = []
  f.store.onChanged = p => { const job = p.videoJobs[0]; if (job?.status === 'encoding' && job.progress !== undefined) progress.push(job.progress) }
  await f.manager.start(f.p.id); await f.manager.idle()
  expect(progress).toContain(55)
  expect(progress.every(p => p < 100)).toBe(true)
})

it('auditions an existing boundary even when a target is not yet filled, without padding or changing the stored draft', async () => {
  const f = await fixture()
  await f.store.patch(f.p.id, { video: { ...f.p.video, durationMode: 'target', targetSeconds: 3600 } })
  await f.manager.start(f.p.id, 'preview', 0); await f.manager.idle()
  const p = await f.store.get(f.p.id)
  expect(p.videoJobs[0].status).toBe('succeeded')
  expect(p.videoJobs[0].snapshot.targetSeconds).toBe(3600)
  expect(p.video.durationMode).toBe('target')
  expect(f.render.mock.calls[0][0].draft).toMatchObject({ durationMode: 'all', fadeOutSeconds: 0 })
  await f.manager.start(f.p.id); await f.manager.idle()
  expect((await f.store.get(f.p.id)).videoJobs[1].status).toBe('failed')
  expect(f.render).toHaveBeenCalledTimes(1)
})
