import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { JobManager, type JobStore } from '../fixtures/v31/main/jobs'
import { AppError } from '../../src/main/providers/http'
import { DEFAULT_IMAGE, DEFAULT_MUSIC, DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { Project, RemoteMusicTask, ImageResult, MusicJob } from '../../src/shared/types'

function fixture() {
  const project: Project = {
    version: 4, id: randomUUID(), name: '测试项目', directory: 'unused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    music: { ...structuredClone(DEFAULT_MUSIC), prompt: '舒缓钢琴', count: 3 }, image: { ...DEFAULT_IMAGE, prompt: '宁静的山川' },
    musicJobs: [], batches: [], imageJobs: [], audio: [], images: [], video: structuredClone(DEFAULT_VIDEO), videoJobs: []
  }
  let saved = structuredClone(project)
  const store: JobStore = {
    get: async () => structuredClone(saved), all: async () => [structuredClone(saved)],
    mutate: async (_id, fn) => { const next = structuredClone(saved); fn(next); saved = next; return structuredClone(next) }
  }
  const success = (id = 'task1'): RemoteMusicTask => ({ id, model: 'mureka-9.5', status: 'succeeded', choices: [{ id: `song-${id}`, url: 'https://example.com/music.mp3', duration: 120000 }] })
  const music = { create: vi.fn(async () => success(randomUUID())), query: vi.fn(async (_mode: string, taskId: string) => success(taskId)), check: vi.fn() }
  const images = { generate: vi.fn(async (): Promise<ImageResult> => ({ url: 'https://cdn.example.com/picture', model: 'Qwen/Qwen-Image' })), check: vi.fn() }
  const download = vi.fn(async (_url: string, _directory: string, id: string) => ({ fileName: `audio/${id}.mp3` }))
  const saveImage = vi.fn(async (_url: string, _directory: string, id: string) => ({ fileName: `images/${id}.webp`, width: 1664, height: 928, format: 'webp' as const }))
  const onError = vi.fn()
  const keys = { get: vi.fn(() => 'test-not-a-real-key') }
  const manager = new JobManager({ projects: store, music, images, keys, download, downloadImage: saveImage, pollIntervalMs: 1, pollLimit: 2, onError })
  return { project, store, music, images, download, saveImage, manager, keys, success, onError }
}
function pendingJob(batchId: string, status: MusicJob['status'] = 'pending', taskId?: string): MusicJob {
  return { id: randomUUID(), batchId, index: 1, createdAt: new Date().toISOString(), status, taskId, binding: { provider: 'mureka', adapterVersion: 1 }, snapshot: { ...DEFAULT_MUSIC, prompt: '钢琴' } }
}

describe('music queue and no duplicate billing', () => {
  it('serially generates exact count with count=1 snapshots and preserves image prompt', async () => {
    const f = fixture()
    await f.manager.startMusic(f.project.id)
    await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(f.music.create).toHaveBeenCalledTimes(3)
    expect(f.music.create.mock.calls.every(c => (c as unknown as [{ count: number }])[0].count === 1)).toBe(true)
    expect(p.audio).toHaveLength(3)
    expect(p.audio.every(a => a.durationMs === 120000 && !a.kept)).toBe(true)
    expect(p.image.prompt).toBe('宁静的山川')
    expect(p.batches[0].state).toBe('completed')
    expect(f.onError).not.toHaveBeenCalled()
  })
  it('prevents concurrent double clicks before project loads', async () => {
    const f = fixture()
    const first = f.manager.startMusic(f.project.id)
    await expect(f.manager.startMusic(f.project.id)).rejects.toThrow('已有音乐任务')
    await first; await f.manager.idle()
    expect(f.music.create).toHaveBeenCalledTimes(3)
  })
  it('keeps successes, pauses remainder on failure; continue skips failed item', async () => {
    const f = fixture()
    f.music.create.mockResolvedValueOnce(f.success()).mockRejectedValueOnce(new AppError('余额不足'))
    await f.manager.startMusic(f.project.id); await f.manager.idle()
    let p = await f.store.get(f.project.id)
    expect(p.audio).toHaveLength(1)
    expect(p.musicJobs.map(j => j.status)).toEqual(['succeeded', 'failed', 'pending'])
    await f.manager.continueMusic(p.id, p.batches[0].id); await f.manager.idle()
    p = await f.store.get(p.id)
    expect(p.audio).toHaveLength(2)
    expect(f.music.create).toHaveBeenCalledTimes(3)
  })
  it('marks transport failures unknown and does not automatically POST again', async () => {
    const f = fixture()
    f.music.create.mockRejectedValue(new AppError('超时', true))
    await f.manager.startMusic(f.project.id); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(p.musicJobs[0].status).toBe('unknown')
    expect(p.musicJobs[0].error).toContain('核对服务商后台')
    expect(f.music.create).toHaveBeenCalledTimes(1)
    expect(p.musicJobs[1].status).toBe('pending')
    await expect(f.manager.retryMusicJob(p.id, p.musicJobs[0].id)).rejects.toThrow('不能恢复查询')
  })
  it('stop cancels only pending work, not the request already submitted', async () => {
    const f = fixture()
    let resolve!: (task: RemoteMusicTask) => void
    f.music.create.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const batch = await f.manager.startMusic(f.project.id)
    await vi.waitFor(() => expect(f.music.create).toHaveBeenCalledTimes(1))
    await f.manager.stopMusic(batch.id, batch.batches[0].id)
    resolve(f.success()); await f.manager.idle()
    const p = await f.store.get(batch.id)
    expect(p.audio).toHaveLength(1)
    expect(p.musicJobs.map(j => j.status)).toEqual(['succeeded', 'cancelled', 'cancelled'])
    expect(f.music.create).toHaveBeenCalledTimes(1)
  })
  it('download failure can recover through query only without another generation', async () => {
    const f = fixture()
    await f.store.mutate(f.project.id, p => { p.music.count = 1 })
    f.download.mockRejectedValueOnce(new Error('下载失败'))
    await f.manager.startMusic(f.project.id); await f.manager.idle()
    let p = await f.store.get(f.project.id)
    expect(p.musicJobs[0].recoverable).toBe(true)
    await f.manager.retryMusicJob(p.id, p.musicJobs[0].id); await f.manager.idle()
    p = await f.store.get(p.id)
    expect(p.audio).toHaveLength(1)
    expect(p.musicJobs[0].status).toBe('succeeded')
    expect(f.music.create).toHaveBeenCalledTimes(1)
    expect(f.music.query).toHaveBeenCalledTimes(1)
  })
  it('recovery queries known IDs, marks unknown submits, leaves unsubmitted paused', async () => {
    const f = fixture()
    const batchId = randomUUID()
    await f.store.mutate(f.project.id, p => {
      p.batches.push({ id: batchId, total: 3, state: 'running', createdAt: new Date().toISOString() })
      p.musicJobs.push(pendingJob(batchId, 'running', 'remote1'), pendingJob(batchId, 'submitting'), pendingJob(batchId))
      p.imageJobs.push({ id: randomUUID(), provider: 'siliconflow', createdAt: new Date().toISOString(), status: 'submitting', snapshot: DEFAULT_IMAGE })
    })
    await f.manager.recover(); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(f.music.create).not.toHaveBeenCalled()
    expect(f.images.generate).not.toHaveBeenCalled()
    expect(p.musicJobs.map(j => j.status)).toEqual(['succeeded', 'unknown', 'pending'])
    expect(p.imageJobs[0].status).toBe('unknown')
    expect(p.batches[0].state).toBe('paused')
  })
  it('retains remote task ID even when credentials are missing after restart', async () => {
    const f = fixture()
    const batchId = randomUUID()
    await f.store.mutate(f.project.id, p => {
      p.batches.push({ id: batchId, total: 1, state: 'running', createdAt: new Date().toISOString() })
      p.musicJobs.push(pendingJob(batchId, 'running', 'remote123'))
    })
    f.keys.get.mockImplementation(() => { throw new Error('缺少密钥') })
    await f.manager.recover(); await f.manager.idle()
    const job = (await f.store.get(f.project.id)).musicJobs[0]
    expect(job.taskId).toBe('remote123')
    expect(job.recoverable).toBe(true)
    expect(f.music.create).not.toHaveBeenCalled()
  })
  it('bounded polling leaves the task recoverable without creating another', async () => {
    const f = fixture()
    f.music.create.mockResolvedValue({ id: 'slow', status: 'running' })
    f.music.query.mockResolvedValue({ id: 'slow', status: 'running' })
    await f.manager.startMusic(f.project.id); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(p.musicJobs[0].recoverable).toBe(true)
    expect(f.music.query).toHaveBeenCalledTimes(2)
    expect(f.music.create).toHaveBeenCalledTimes(1)
  })
})

describe('independent image generation', () => {
  it('creates one image, preserves previous assets and music draft', async () => {
    const f = fixture()
    await f.manager.startImage(f.project.id); await f.manager.idle()
    await f.manager.startImage(f.project.id); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(p.images).toHaveLength(2)
    expect(p.selectedImageId).toBe(p.images[1].id)
    expect(p.music.prompt).toBe('舒缓钢琴')
    expect(p.imageJobs.every(j => j.status === 'succeeded')).toBe(true)
    expect(f.keys.get.mock.calls).toEqual([['siliconflow'], ['siliconflow']])
    expect(p.images.every(a => a.provider === 'siliconflow' && a.format === 'webp' && a.size === '1664x928')).toBe(true)
    expect(f.saveImage).toHaveBeenCalledWith('https://cdn.example.com/picture', f.project.directory, expect.any(String))
    expect(f.music.create).not.toHaveBeenCalled()
  })
  it('does not retry timed out POST and leaves unknown error visible', async () => {
    const f = fixture()
    f.images.generate.mockRejectedValue(new AppError('超时', true))
    await f.manager.startImage(f.project.id); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(p.imageJobs[0].status).toBe('unknown')
    expect(f.images.generate).toHaveBeenCalledTimes(1)
    expect(f.music.create).not.toHaveBeenCalled()
  })
  it('rejects missing keys and blank prompts before persisting or submitting', async () => {
    const f = fixture()
    await f.store.mutate(f.project.id, p => { p.image.prompt = '   ' })
    await expect(f.manager.startImage(f.project.id)).rejects.toThrow('提示词')
    expect(f.images.generate).not.toHaveBeenCalled()
    f.keys.get.mockImplementation(() => { throw new Error('请设置密钥') })
    await expect(f.manager.startMusic(f.project.id)).rejects.toThrow('密钥')
    expect((await f.store.get(f.project.id)).musicJobs).toHaveLength(0)
  })
  it('does not generate again after download/decode failure and registers no broken asset', async () => {
    const f = fixture()
    f.saveImage.mockRejectedValue(new AppError('图片链接已过期'))
    await f.manager.startImage(f.project.id); await f.manager.idle()
    const p = await f.store.get(f.project.id)
    expect(p.images).toHaveLength(0)
    expect(p.selectedImageId).toBeUndefined()
    expect(p.imageJobs[0]).toMatchObject({ provider: 'siliconflow', status: 'failed' })
    expect(p.imageJobs[0].error).toContain('服务商已生成')
    expect(f.images.generate).toHaveBeenCalledTimes(1)
    expect(f.saveImage).toHaveBeenCalledTimes(1)
    await f.manager.recover(); await f.manager.idle()
    expect(f.images.generate).toHaveBeenCalledTimes(1)
  })
})
