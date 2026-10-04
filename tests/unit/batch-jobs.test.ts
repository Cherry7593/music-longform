import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BatchJobManager } from '../../src/main/video/batch-jobs'
import { RenderScheduler } from '../../src/main/video/scheduler'
import { VideoBatchStore } from '../../src/main/storage/video-batches'
import { ExportReceiptStore } from '../../src/main/storage/export-receipts'
import { hashMedia } from '../../src/main/storage/managed'
import { DEFAULT_BATCH_OPTIONS } from '../../src/shared/batch-schemas'
import { calculateTimeline } from '../../src/shared/video-timeline'
import { decorateLibrary } from '../../src/main/library/usage'
import type { BatchRequest, LibraryItem } from '../../src/shared/library-types'
import type { RenderRequest } from '../../src/main/video/pipeline'
import { AppError } from '../../src/main/providers/http'
import { CancelledError } from '../../src/main/video/ffmpeg'

let root: string
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('Isolated scratch required')
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'v3-batch-unit '))
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const data = path.join(root, 'metadata'); const media = path.join(root, '素材库')
  const batches = new VideoBatchStore(data, () => media)
  const receipts = new ExportReceiptStore(data)
  await batches.init(); await receipts.init()
  const items: LibraryItem[] = Array.from({ length: 6 }, (_, i) => ({ id: randomUUID(), kind: i < 4 ? 'audio' : 'image', name: `素材 ${i}`,
    createdAt: new Date().toISOString(), sha256: i.toString(16).padStart(64, '0'), bytes: 30, available: true, origins: [{ type: 'import', name: '测试文件' }],
    ...(i < 4 ? { durationSeconds: 40 } : { width: 100, height: 100 }) }))
  const library = { verify: vi.fn(async (id: string) => {
    const asset = items.find(a => a.id === id)
    if (!asset) throw new AppError('找不到素材')
    return { asset: structuredClone(asset), path: path.join(root, `${id}.${asset.kind === 'audio' ? 'wav' : 'png'}`) }
  }) }
  const scheduler = new RenderScheduler()
  const tools = vi.fn(async () => ({ ffmpeg: path.join(root, 'ffmpeg.exe'), ffprobe: path.join(root, 'ffprobe.exe') }))
  const render = vi.fn(async (req: RenderRequest) => {
    req.onProgress?.({ status: 'encoding', progress: 0.61, detail: '实际进度测试' })
    const timeline = calculateTimeline(req.draft, req.tracks)
    const filePath = path.join(req.taskDirectory, 'output.mp4')
    await writeFile(filePath, `verified render fixture:${req.draft.imageId}`)
    return { filePath, durationSeconds: timeline.outputSeconds, timeline }
  })
  const onError = vi.fn()
  const deps = { library, batches, receipts, scheduler, getFFmpegPath: () => undefined, tools, render, onError }
  const manager = new BatchJobManager(deps)
  const request: BatchRequest = { ...DEFAULT_BATCH_OPTIONS, name: '两个完整视频', minimumSeconds: 60, audioIds: items.filter(a => a.kind === 'audio').map(a => a.id), imageIds: items.filter(a => a.kind === 'image').map(a => a.id) }
  const plan = await manager.plan(request)
  expect(plan.issues).toEqual([])
  return { ...deps, deps, manager, request, plan, items, data, media }
}
describe('persistent serial batch queue and receipts', () => {
  it('exports whole songs serially, saves immutable plans, and counts successful usage once', async () => {
    const f = await fixture()
    const events: number[] = []
    f.batches.onChanged = b => { for (const j of b.jobs) if (j.status === 'encoding' && j.progress) events.push(j.progress) }
    const initial = await f.manager.start(f.plan.id)
    expect((await f.manager.start(f.plan.id)).id).toBe(initial.id)
    f.plan.groups[0].audioIds.reverse()
    await f.manager.idle()
    const batch = await f.batches.get(initial.id)
    expect(batch.state).toBe('completed')
    expect(batch.jobs.map(j => j.durationSeconds)).toEqual([77, 77])
    expect(f.render).toHaveBeenCalledTimes(2)
    expect(f.render.mock.calls.every(([r]) => r.minimumSeconds === 60 && r.draft.durationMode === 'all')).toBe(true)
    expect(events).toContain(61)
    expect(f.receipts.all().filter(r => r.state === 'committed')).toHaveLength(2)
    expect(decorateLibrary(f.items, [], [batch], f.receipts.all()).every(a => a.usages.length === 1 && a.queuedCount === 0)).toBe(true)
    for (const job of batch.jobs) expect(await readFile(await f.batches.pathForAsset(batch.id, job.id), 'utf8')).toContain('verified render fixture')
    await f.manager.recover(); await f.manager.continue(batch.id)
    expect(f.render).toHaveBeenCalledTimes(2)
    expect((await f.batches.all())).toHaveLength(1)
  })
  it('pauses on a failure; only successful assets count and retry skips success', async () => {
    const f = await fixture()
    const original = f.render.getMockImplementation()!
    f.render.mockImplementationOnce(original).mockRejectedValueOnce(new AppError('磁盘空间不足'))
    const batch = await f.manager.start(f.plan.id); await f.manager.idle()
    const stopped = await f.batches.get(batch.id)
    expect(stopped.state).toBe('paused')
    expect(stopped.jobs.map(j => j.status)).toEqual(['succeeded', 'failed'])
    expect(f.receipts.all()).toHaveLength(1)
    expect(decorateLibrary(f.items, [], [stopped], f.receipts.all()).filter(a => a.usages.length)).toHaveLength(3)
    await f.manager.continue(batch.id); await f.manager.idle()
    expect(f.render).toHaveBeenCalledTimes(3)
    expect((await f.batches.get(batch.id)).state).toBe('completed')
  })
  it('finishes the active video before pausing, then resumes pending outputs', async () => {
    const f = await fixture()
    let finish!: () => void
    const original = f.render.getMockImplementation()!
    f.render.mockImplementationOnce(async req => { await new Promise<void>(r => { finish = r }); return original(req) })
    const batch = await f.manager.start(f.plan.id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect((await f.manager.pause(batch.id)).state).toBe('pausing')
    finish(); await f.manager.idle()
    expect((await f.batches.get(batch.id)).jobs.map(j => j.status)).toEqual(['succeeded', 'pending'])
    await f.manager.continue(batch.id); await f.manager.idle()
    expect(f.render).toHaveBeenCalledTimes(2)
  })
  it('shares the render lock with old exports, and releases it after preparation failure', async () => {
    const f = await fixture(); const release = f.scheduler.reserve()
    await expect(f.manager.start(f.plan.id)).rejects.toThrow('已有视频任务')
    await expect(f.manager.plan(f.request)).rejects.toThrow('已有视频任务')
    release()
    f.tools.mockRejectedValueOnce(new AppError('缺少 FFmpeg'))
    await expect(f.manager.start(f.plan.id)).rejects.toThrow('FFmpeg')
    expect(f.scheduler.busy).toBe(false)
    expect(await f.batches.all()).toEqual([])
  })
  it('cancels current and remaining tasks without usage and deletes only owned temporary files', async () => {
    const f = await fixture()
    f.render.mockImplementationOnce(async req => {
      await writeFile(path.join(req.taskDirectory, 'partial.mp4'), 'partial')
      await new Promise<void>((_, reject) => {
        if (req.signal.aborted) reject(new CancelledError())
        else req.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true })
      })
      throw new Error('unreachable')
    })
    const batch = await f.manager.start(f.plan.id)
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1))
    const cancelled = await f.manager.cancel(batch.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.jobs.map(j => j.status)).toEqual(['cancelled', 'cancelled'])
    expect(await readdir(path.join(batch.directory, 'videos'))).toEqual([])
    expect(f.receipts.all()).toEqual([])
  })
  it('shutdown persists interruption; restart never automatically rerenders', async () => {
    const f = await fixture()
    f.render.mockImplementationOnce(async req => {
      await new Promise<void>((_, reject) => req.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true }))
      throw new Error('unreachable')
    })
    const batch = await f.manager.start(f.plan.id)
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1))
    await f.manager.shutdown()
    expect((await f.batches.get(batch.id)).jobs[0].status).toBe('interrupted')
    const reopened = new VideoBatchStore(f.data, () => f.media); await reopened.init()
    const manager = new BatchJobManager({ ...f.deps, batches: reopened })
    await manager.recover()
    expect(f.render).toHaveBeenCalledTimes(1)
    expect((await reopened.get(batch.id)).state).toBe('paused')
    await manager.continue(batch.id); await manager.idle()
    expect((await reopened.get(batch.id)).state).toBe('completed')
  })
  it('reconciles a crash after publication but before task-state save, without duplicate renders', async () => {
    const f = await fixture()
    const original = f.batches.mutate.bind(f.batches)
    let failOnce = true
    vi.spyOn(f.batches, 'mutate').mockImplementation(async (id, update) => {
      const sample = await f.batches.get(id); update(sample)
      if (failOnce && sample.jobs[0].status === 'succeeded') { failOnce = false; throw new AppError('模拟断电：状态未保存') }
      return original(id, update)
    })
    const batch = await f.manager.start(f.plan.id); await f.manager.idle()
    expect((await f.batches.get(batch.id)).jobs[0].status).toBe('interrupted')
    expect(f.receipts.all()[0].state).toBe('committed')
    await f.manager.recover()
    expect((await f.batches.get(batch.id)).jobs[0].status).toBe('succeeded')
    await f.manager.continue(batch.id); await f.manager.idle()
    expect(f.render).toHaveBeenCalledTimes(2)
    expect(f.receipts.all()).toHaveLength(2)
  })
  it('recovers prepared receipt after file publication; committed usage survives a moved output', async () => {
    const f = await fixture(); const batch = await f.batches.create(f.plan); const job = batch.jobs[0]
    await mkdir(path.join(batch.directory, 'videos'))
    const fileName = `videos/${job.id}.mp4`; const output = path.join(batch.directory, fileName)
    await writeFile(output, 'already validated output')
    await f.receipts.prepare({ version: 1, id: job.id, ownerId: batch.id, kind: 'batch', name: batch.name, state: 'prepared',
      finishedAt: new Date().toISOString(), durationSeconds: 77, assetIds: [...job.group.audioIds, job.group.imageId], directory: batch.directory, fileName, ...await hashMedia(output) })
    expect(decorateLibrary(f.items, [], [batch], f.receipts.all()).some(a => a.usages.length)).toBe(false)
    await f.manager.recover()
    expect((await f.batches.get(batch.id)).jobs[0].status).toBe('succeeded')
    await rm(output)
    await f.receipts.recover()
    expect(f.receipts.all()[0].state).toBe('committed')
    expect(decorateLibrary(f.items, [], [], f.receipts.all()).filter(a => a.usages.length)).toHaveLength(3)
    expect(f.render).not.toHaveBeenCalled()
  })
  it('rejects stale input and too-short decoded output before publication', async () => {
    const f = await fixture()
    f.items[0].sha256 = 'f'.repeat(64)
    await expect(f.manager.start(f.plan.id)).rejects.toThrow('已经改变')
    expect(await f.batches.all()).toEqual([])
    const newPlan = await f.manager.plan(f.request)
    const original = f.render.getMockImplementation()!
    f.render.mockImplementationOnce(async req => ({ ...await original(req), durationSeconds: 59.999 }))
    const batch = await f.manager.start(newPlan.id); await f.manager.idle()
    expect((await f.batches.get(batch.id)).jobs[0].status).toBe('failed')
    expect(f.receipts.all()).toEqual([])
    expect(await readdir(path.join(batch.directory, 'videos'))).toEqual([])
  })
  it('manual revisions invalidate old token and still reject duplicate/missing assignments', async () => {
    const f = await fixture()
    const groups = f.plan.groups.map(g => ({ imageId: g.imageId, audioIds: [...g.audioIds] }))
    groups[1].audioIds.push(groups[0].audioIds[0])
    const revised = await f.manager.revise(f.plan.id, groups)
    expect(revised.issues.length).toBeGreaterThan(0)
    await expect(f.manager.start(f.plan.id)).rejects.toThrow('失效')
    await expect(f.manager.start(revised.id)).rejects.toThrow('未全部达标')
    expect(await f.batches.all()).toEqual([])
  })
  it('preserves corrupted metadata instead of replacing with an empty index', async () => {
    const f = await fixture(); await f.batches.create(f.plan)
    const file = path.join(f.data, 'video-batches', 'index.json')
    await writeFile(file, '{broken')
    const reopened = new VideoBatchStore(f.data, () => f.media)
    await expect(reopened.init()).rejects.toThrow('索引损坏')
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
})

it('cancellation wins while continue is awaiting tool discovery', async () => {
  const f = await fixture(); const batch = await f.batches.create(f.plan)
  await f.batches.mutate(batch.id, b => { b.state = 'paused' })
  let release!: () => void
  f.tools.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r }); return { ffmpeg: 'fixture', ffprobe: 'fixture' } })
  const continuation = f.manager.continue(batch.id)
  const rejected = expect(continuation).rejects.toThrow('取消')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const cancelled = f.manager.cancel(batch.id)
  await vi.waitFor(async () => expect((await f.batches.get(batch.id)).state).toBe('cancelled'))
  release(); await rejected
  expect((await cancelled).jobs.every(j => j.status === 'cancelled')).toBe(true)
  expect((await f.batches.get(batch.id)).state).toBe('cancelled')
  expect(f.render).not.toHaveBeenCalled(); expect(f.scheduler.busy).toBe(false)
})

it('pause during the last output settles completed, and recovery normalizes old fully-successful paused batches', async () => {
  const f = await fixture()
  const plan = await f.manager.plan({ ...f.request, audioIds: f.request.audioIds.slice(0, 2), imageIds: f.request.imageIds.slice(0, 1) })
  let release!: () => void
  const original = f.render.getMockImplementation()!
  f.render.mockImplementationOnce(async req => { await new Promise<void>(r => { release = r }); return original(req) })
  const batch = await f.manager.start(plan.id)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await f.manager.pause(batch.id); release(); await f.manager.idle()
  expect((await f.batches.get(batch.id)).state).toBe('completed')
  await f.batches.mutate(batch.id, b => { b.state = 'paused' })
  await f.manager.recover(); expect((await f.batches.get(batch.id)).state).toBe('completed')
  await f.batches.mutate(batch.id, b => { b.state = 'paused' })
  expect((await f.manager.continue(batch.id)).state).toBe('completed')
  expect(f.render).toHaveBeenCalledTimes(1)
})
