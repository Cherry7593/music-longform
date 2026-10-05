import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BatchAssetSnapshot, BatchGroupInput, BatchPlan, BatchRequest, BatchVideoJob, ExportReceipt, LibraryItem, VideoBatch } from '../../../../../src/shared/library-types'
import { batchGroupInputSchema, batchRequestSchema } from '../../../../../src/shared/batch-schemas'
import { batchDraft, planGroups, validateGroups } from '../../../../../src/shared/batch-planner'
import { activeVideoStatuses } from '../../../../../src/shared/schemas'
import type { VideoBatchStore } from '../storage/video-batches'
import type { ExportReceiptStore } from '../storage/export-receipts'
import { hashMedia, managedDirectory } from '../../../../../src/main/storage/managed'
import { AppError, safeError } from '../../../../../src/main/providers/http'
import { CancelledError, requireTools, type VideoTools } from '../../../../../src/main/video/ffmpeg'
import { renderMedia, type RenderProgress, type RenderTrack } from '../../../../../src/main/video/pipeline'
import { RenderScheduler } from './scheduler'
import { cleanupWork, commitMedia, workDirectory } from '../../../../../src/main/video/workfiles'

interface BatchLibrary { verify(id: string): Promise<{ asset: LibraryItem; path: string }> }
interface Dependencies {
  library: BatchLibrary
  batches: VideoBatchStore
  receipts: ExportReceiptStore
  scheduler: RenderScheduler
  getFFmpegPath: () => string | undefined
  render?: typeof renderMedia
  tools?: (custom?: string) => Promise<VideoTools>
  onError?: (message: string) => void
}
interface Active { batchId?: string; controller: AbortController; done: Promise<void>; release: () => void }
const now = (): string => new Date().toISOString()
export class BatchJobManager {
  private active?: Active
  private closing = false
  private readonly plans = new Map<string, BatchPlan>()
  private readonly render: typeof renderMedia
  private readonly tools: (custom?: string) => Promise<VideoTools>
  constructor(private readonly deps: Dependencies) { this.render = deps.render ?? renderMedia; this.tools = deps.tools ?? requireTools }
  get busy(): boolean { return !!this.active }
  async idle(): Promise<void> { await this.active?.done }
  async shutdown(): Promise<void> { this.closing = true; this.active?.controller.abort(); await this.idle() }
  private reserve(batchId?: string): Active {
    if (this.closing) throw new AppError('软件正在关闭')
    const releaseRender = this.deps.scheduler.reserve()
    let resolve!: () => void
    const done = new Promise<void>(r => { resolve = r })
    const active = { batchId, controller: new AbortController(), done, release: () => { releaseRender(); resolve() } }
    this.active = active
    return active
  }
  private finish(active: Active): void { if (this.active === active) this.active = undefined; active.release() }
  private abort(active: Active): void { if (active.controller.signal.aborted) throw new CancelledError() }
  private cache(plan: BatchPlan): BatchPlan {
    while (this.plans.size >= 12) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(plan.id, structuredClone(plan))
    return structuredClone(plan)
  }
  private planned(id: string): BatchPlan {
    const plan = this.plans.get(id)
    if (!plan) throw new AppError('分组预览已失效，请重新规划')
    return structuredClone(plan)
  }
  private snapshot(asset: LibraryItem): BatchAssetSnapshot {
    if (!asset.available || !asset.sha256 || !asset.bytes) throw new AppError(`素材“${asset.name}”不可用，请重新导入或恢复原文件`)
    return { id: asset.id, kind: asset.kind, name: asset.name, sha256: asset.sha256, bytes: asset.bytes,
      ...(asset.kind === 'audio' ? { durationSeconds: asset.durationSeconds } : {}) }
  }
  async plan(input: BatchRequest): Promise<BatchPlan> {
    const parsed = batchRequestSchema.safeParse(input)
    if (!parsed.success) throw new AppError('批量参数不正确，请检查素材数量和最短时长')
    const active = this.reserve()
    try {
      await this.tools(this.deps.getFFmpegPath())
      const request = parsed.data
      const assets: BatchAssetSnapshot[] = []
      for (const id of [...request.audioIds, ...request.imageIds]) {
        this.abort(active)
        assets.push(this.snapshot((await this.deps.library.verify(id)).asset))
      }
      this.abort(active)
      return this.cache({ id: randomUUID(), createdAt: now(), request, assets, ...planGroups(request, assets) })
    } finally { this.finish(active) }
  }
  async revise(id: string, input: BatchGroupInput[]): Promise<BatchPlan> {
    const groups = batchGroupInputSchema.array().min(1).max(100).safeParse(input)
    if (!groups.success) throw new AppError('分组格式不正确')
    const previous = this.planned(id)
    const plan = { id: randomUUID(), createdAt: previous.createdAt, request: previous.request, assets: previous.assets, ...validateGroups(previous.request, previous.assets, groups.data) }
    this.plans.delete(id)
    return this.cache(plan)
  }
  private async verifySnapshot(snapshot: BatchAssetSnapshot): Promise<{ asset: LibraryItem; path: string }> {
    const current = await this.deps.library.verify(snapshot.id)
    if (!current.asset.available || current.asset.kind !== snapshot.kind || current.asset.sha256 !== snapshot.sha256 || current.asset.bytes !== snapshot.bytes) throw new AppError(`素材“${snapshot.name}”已经改变，请重新规划；不会使用过期快照`)
    return current
  }
  async start(planId: string): Promise<VideoBatch> {
    const prior = (await this.deps.batches.all()).find(batch => batch.planId === planId)
    if (prior) return prior // Idempotent submission; never starts a second copy.
    const plan = this.planned(planId)
    if (plan.issues.length) throw new AppError('分组还未全部达标，请先调整')
    const active = this.reserve()
    try {
      await this.tools(this.deps.getFFmpegPath())
      const fresh: BatchAssetSnapshot[] = []
      for (const snapshot of plan.assets) { this.abort(active); fresh.push(this.snapshot((await this.verifySnapshot(snapshot)).asset)) }
      if (validateGroups(plan.request, fresh, plan.groups).issues.length) throw new AppError('真实时长或素材条件发生改变，请重新规划')
      this.abort(active)
      const batch = await this.deps.batches.create(plan)
      active.batchId = batch.id
      this.launch(active)
      return batch
    } catch (error) { this.finish(active); throw error }
  }
  private launch(active: Active): void {
    void this.run(active).catch(error => this.deps.onError?.(`批次执行或保存失败：${safeError(error)}。原素材与成功成片保留，请重新打开后核对。`)).finally(() => this.finish(active))
  }
  private async succeeded(batchId: string, jobId: string, receipt: ExportReceipt): Promise<void> {
    await this.deps.batches.mutate(batchId, batch => Object.assign(batch.jobs.find(j => j.id === jobId)!, {
      status: 'succeeded', progress: 100, finishedAt: receipt.finishedAt, fileName: receipt.fileName,
      durationSeconds: receipt.durationSeconds, detail: '成片已校验并保存', error: undefined
    }))
  }
  private async run(active: Active): Promise<void> {
    const id = active.batchId!
    for (;;) {
      const batch = await this.deps.batches.get(id)
      if (batch.jobs.every(job => job.status === 'succeeded')) {
        await this.deps.batches.mutate(id, b => { b.state = 'completed'; b.message = '全部成片已保存' })
        return
      }
      if (this.closing || active.controller.signal.aborted || batch.state === 'pausing') {
        if (batch.state !== 'cancelled') await this.deps.batches.mutate(id, b => { b.state = 'paused'; b.message = '已暂停，成功成片保留；可继续未完成任务' })
        return
      }
      if (batch.state !== 'running') return
      const job = batch.jobs.find(j => j.status === 'pending')
      if (!job) {
        await this.deps.batches.mutate(id, b => { b.state = b.jobs.every(j => j.status === 'succeeded') ? 'completed' : 'paused'; b.message = b.state === 'completed' ? '全部成片已保存' : '有任务未完成，请处理后继续' })
        return
      }
      if (!await this.runOne(active, batch, job)) {
        await this.deps.batches.mutate(id, b => { if (b.state !== 'cancelled') b.state = 'paused'; b.message = '导出已暂停，成功项不会重复处理；请核对错误后继续' })
        return
      }
    }
  }
  private async runOne(active: Active, batch: VideoBatch, job: BatchVideoJob): Promise<boolean> {
    let createdWork = false
    let published = false
    let writes: Promise<unknown> = Promise.resolve()
    let writeFailure: unknown
    let lastWrite = 0
    let lastStatus = job.status
    const update = (event: RenderProgress): void => {
      if (active.controller.signal.aborted) return
      if (event.status === lastStatus && Date.now() - lastWrite < 750) return
      lastStatus = event.status; lastWrite = Date.now()
      writes = writes.then(() => this.deps.batches.mutate(batch.id, b => {
        const entry = b.jobs.find(j => j.id === job.id)!
        if (entry.status === 'succeeded' || entry.status === 'cancelled') return
        entry.status = event.status; entry.detail = event.detail.slice(0, 2000)
        entry.progress = event.progress === undefined ? undefined : Math.min(99, Math.max(0, Math.round(event.progress * 1000) / 10))
      })).catch(error => { writeFailure = error; active.controller.abort() })
    }
    try {
      const previous = await this.deps.receipts.reconcile(job.id)
      if (previous) { await this.succeeded(batch.id, job.id, previous); return true }
      await managedDirectory(batch.directory)
      this.abort(active)
      await this.deps.batches.mutate(batch.id, b => Object.assign(b.jobs.find(j => j.id === job.id)!, { status: 'analyzing', detail: '核对素材指纹与真实时长', error: undefined, progress: undefined }))
      const tools = await this.tools(this.deps.getFFmpegPath())
      const snapshots = new Map(batch.plan.assets.map(a => [a.id, a]))
      const tracks: RenderTrack[] = []
      for (const id of job.group.audioIds) {
        this.abort(active)
        const current = await this.verifySnapshot(snapshots.get(id)!)
        tracks.push({ id, path: current.path, durationSeconds: current.asset.durationSeconds! })
      }
      const image = await this.verifySnapshot(snapshots.get(job.group.imageId)!)
      this.abort(active)
      await cleanupWork(batch.directory, 'video', job.id)
      const work = await workDirectory(batch.directory, 'video', job.id, true)
      createdWork = true
      const output = await this.render({ tools, draft: batchDraft(batch.plan.request, job.group), tracks, imagePath: image.path,
        minimumSeconds: batch.plan.request.minimumSeconds, taskDirectory: work, kind: 'video', signal: active.controller.signal, onProgress: update })
      await writes
      if (writeFailure) throw writeFailure
      this.abort(active)
      if (output.durationSeconds + 1 / 48000 < batch.plan.request.minimumSeconds) throw new AppError('成片实际时长不足最短时长，未发布；请补充音乐后重新规划')
      // Recheck inputs after the long render, not just before it.
      for (const id of [...job.group.audioIds, job.group.imageId]) { this.abort(active); await this.verifySnapshot(snapshots.get(id)!) }
      const fingerprint = await hashMedia(output.filePath)
      const fileName = `videos/${job.id}.mp4`
      await this.deps.receipts.prepare({ version: 1, id: job.id, ownerId: batch.id, kind: 'batch', name: `${batch.name} / 视频 ${job.index + 1}`,
        state: 'prepared', finishedAt: now(), durationSeconds: output.durationSeconds, assetIds: [...job.group.audioIds, job.group.imageId],
        directory: batch.directory, fileName, ...fingerprint })
      this.abort(active)
      await commitMedia(output.filePath, work, path.join(batch.directory, fileName))
      published = true
      const receipt = await this.deps.receipts.reconcile(job.id)
      if (!receipt) throw new AppError('成片已发布，使用回执尚待恢复，请勿重复合成')
      await this.succeeded(batch.id, job.id, receipt)
      return true
    } catch (error) {
      await writes
      const cancelled = !writeFailure && (active.controller.signal.aborted || error instanceof CancelledError)
      await this.deps.batches.mutate(batch.id, b => Object.assign(b.jobs.find(j => j.id === job.id)!, {
        status: published || this.closing ? 'interrupted' : cancelled ? 'cancelled' : 'failed', progress: undefined, finishedAt: now(),
        error: cancelled && !published ? undefined : safeError(writeFailure ?? error).slice(0, 2000),
        detail: published ? '成片已发布，等待回执对账；不会自动重复渲染' : this.closing ? '关闭中断了当前导出，原素材保留' : cancelled ? '已取消，原素材保留' : '导出未完成，成功成片与原素材保留'
      }))
      return false
    } finally {
      if (createdWork) await cleanupWork(batch.directory, 'video', job.id).catch(() => this.deps.onError?.('批次临时文件清理失败，原素材未改动'))
    }
  }
  async pause(id: string): Promise<VideoBatch> {
    return this.deps.batches.mutate(id, batch => {
      if (batch.jobs.every(job => job.status === 'succeeded')) { batch.state = 'completed'; batch.message = '全部成片已保存'; return }
      if (batch.state === 'running') { batch.state = this.active?.batchId === id ? 'pausing' : 'paused'; batch.message = '完成当前视频后暂停' }
    })
  }
  async continue(id: string): Promise<VideoBatch> {
    const current = await this.deps.batches.get(id)
    if (current.jobs.every(j => j.status === 'succeeded')) return current.state === 'completed' ? current : this.deps.batches.mutate(id, b => { b.state = 'completed'; b.message = '全部成片已保存' })
    const active = this.reserve(id)
    try {
      await this.tools(this.deps.getFFmpegPath())
      this.abort(active)
      const batch = await this.deps.batches.mutate(id, b => {
        this.abort(active)
        b.state = 'running'; b.message = undefined
        for (const job of b.jobs.filter(j => j.status !== 'succeeded')) { job.status = 'pending'; job.error = undefined; job.progress = undefined; job.detail = '等待导出' }
      })
      this.launch(active)
      return batch
    } catch (error) { this.finish(active); throw error }
  }
  async cancel(id: string): Promise<VideoBatch> {
    const active = this.active?.batchId === id ? this.active : undefined
    active?.controller.abort()
    await this.deps.batches.mutate(id, b => {
      if (b.state === 'completed') return
      b.state = 'cancelled'; b.message = '已取消未完成任务，成功成片保留'
      for (const job of b.jobs.filter(j => j.status === 'pending')) { job.status = 'cancelled'; job.detail = '未开始的任务已取消'; job.finishedAt = now() }
    })
    await active?.done
    return this.deps.batches.get(id)
  }
  async recover(): Promise<void> {
    for (const batch of await this.deps.batches.all()) {
      const commits = new Map<string, ExportReceipt>()
      for (const job of batch.jobs.filter(j => j.status !== 'succeeded')) {
        try { const receipt = await this.deps.receipts.reconcile(job.id); if (receipt) commits.set(job.id, receipt) } catch (error) { this.deps.onError?.(safeError(error)) }
      }
      if (!commits.size && !['running', 'pausing'].includes(batch.state) && !batch.jobs.some(j => activeVideoStatuses.has(j.status))
        && !(batch.state !== 'completed' && batch.jobs.every(j => j.status === 'succeeded'))) continue
      await this.deps.batches.mutate(batch.id, b => {
        for (const job of b.jobs) {
          const receipt = commits.get(job.id)
          if (receipt) Object.assign(job, { status: 'succeeded', progress: 100, fileName: receipt.fileName, durationSeconds: receipt.durationSeconds, finishedAt: receipt.finishedAt, detail: '已恢复成片发布回执', error: undefined })
          else if (activeVideoStatuses.has(job.status)) Object.assign(job, { status: 'interrupted', progress: undefined, detail: '上次导出中断，可继续未成功项；未自动重新渲染' })
        }
        b.state = b.jobs.every(j => j.status === 'succeeded') ? 'completed' : b.state === 'cancelled' ? 'cancelled' : 'paused'
        b.message = b.state === 'completed' ? '全部成片已保存' : '上次队列已恢复，请确认后继续；成功项不会重复导出'
      })
      for (const job of batch.jobs.filter(j => activeVideoStatuses.has(j.status) || commits.has(j.id))) await cleanupWork(batch.directory, 'video', job.id).catch(() => this.deps.onError?.('旧批次临时目录暂不可清理'))
    }
  }
}
