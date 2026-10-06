import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WorkbenchDB } from '../storage/workbench-db'
import type { AssetStore } from '../storage/assets-v2'
import type { DiagnosticStore } from '../storage/diagnostics'
import type { PublicationStore, PublicationV2 } from '../storage/publications-v2'
import type { BatchAssetSnapshot, BatchGroupInput, BatchPlan, BatchRequest } from '../../shared/library-types'
import { batchRequestSchema, batchGroupInputSchema } from '../../shared/batch-schemas'
import { batchDraft, planGroups, validateGroups } from '../../shared/batch-planner'
import { RENDER_ACTIVE, RENDER_RESERVED, type ExecutionBatch, type RenderJob, type WorkbenchAsset } from '../../shared/workbench-types'
import { newAssetName } from '../../shared/workbench-schemas'
import { renderMedia, type RenderProgress } from './pipeline'
import { discoverTools, requireTools, CancelledError, type VideoTools } from './ffmpeg'
import { ResourcePool, type ResourceLease } from './resource-pool'
import { cleanupWork, workDirectory, commitMedia } from './workfiles'
import { hashMedia } from '../storage/managed'
import { AppError, safeError } from '../providers/http'

const now = () => new Date().toISOString()
interface Dependencies {
  db: WorkbenchDB; assets: AssetStore; diagnostics: DiagnosticStore; publications: PublicationStore; pool: ResourcePool
  render?: typeof renderMedia; tools?: () => Promise<VideoTools>; onError?: (message: string) => void
}
interface Scheduled { batchId: string; jobId: string; controller: AbortController; done: Promise<void>; started: boolean; reason?: 'pause' | 'cancel' | 'shutdown' }
export class CompositionQueue {
  private plans = new Map<string, { projectId: string; revision: number; plan: BatchPlan }>()
  private scheduled = new Map<string, Scheduled>()
  private closing = false
  private readonly names = new Set<string>()
  constructor(private readonly deps: Dependencies) { }
  get busy(): boolean { return this.scheduled.size > 0 }
  isActiveAsset(id: string): boolean {
    return this.deps.db.list('executions').some(batch => batch.jobs.some(job => RENDER_RESERVED.has(job.status) && (job.id === id || job.group.imageId === id || job.group.audioIds.includes(id))))
  }
  queuedIds(): string[] { return this.deps.db.list('executions').flatMap(batch => batch.jobs.filter(job => RENDER_RESERVED.has(job.status)).flatMap(job => [...job.group.audioIds, job.group.imageId])) }
  async idle(): Promise<void> { while (this.scheduled.size) await Promise.allSettled([...this.scheduled.values()].map(value => value.done)) }
  async shutdown(): Promise<void> {
    this.closing = true
    for (const item of this.scheduled.values()) { item.reason = 'shutdown'; item.controller.abort() }
    this.deps.pool.close(); await this.idle()
  }
  private project(id: string) {
    const project = this.deps.db.get('composition', id); if (project.deletedAt) throw new AppError('合成项目已删除'); return project
  }
  private snapshot(asset: WorkbenchAsset): BatchAssetSnapshot {
    if (!asset.available || !asset.sha256 || !asset.bytes || asset.kind === 'video') throw new AppError(`素材“${asset.name}”不可用于此合成，请检查文件。`)
    return { id: asset.id, kind: asset.kind, name: asset.name.slice(0, 500), sha256: asset.sha256, bytes: asset.bytes, ...(asset.kind === 'audio' ? { durationSeconds: asset.durationSeconds } : {}) }
  }
  private storePlan(projectId: string, revision: number, plan: BatchPlan): BatchPlan {
    while (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(plan.id, { projectId, revision, plan: structuredClone(plan) }); return structuredClone(plan)
  }
  async plan(projectId: string, revision: number): Promise<BatchPlan> {
    const project = this.project(projectId)
    if (project.revision !== revision) throw new AppError('选材或参数已更新，请重新规划')
    const { groups, ...draft } = project.draft
    const request: BatchRequest = batchRequestSchema.parse({ ...draft, name: project.name.slice(0, 80) })
    const assets: BatchAssetSnapshot[] = []
    for (const id of [...request.audioIds, ...request.imageIds]) {
      const current = await this.deps.assets.verify(id)
      const snapshot = this.snapshot(current.asset)
      // Keep the submitted stable alias ID, never silently change selected identities.
      assets.push({ ...snapshot, id })
    }
    if (this.project(projectId).revision !== revision) throw new AppError('规划期间选材已修改，请重新规划')
    const validated = groups ? validateGroups(request, assets, groups) : planGroups(request, assets)
    return this.storePlan(projectId, revision, { id: randomUUID(), createdAt: now(), request, assets, ...validated })
  }
  async revise(projectId: string, planId: string, input: BatchGroupInput[]): Promise<BatchPlan> {
    const cached = this.plans.get(planId), project = this.project(projectId)
    if (!cached || cached.projectId !== projectId || cached.revision !== project.revision) throw new AppError('分组预览已失效，请重新规划')
    const groups = batchGroupInputSchema.array().min(1).max(100).parse(input)
    const result = validateGroups(cached.plan.request, cached.plan.assets, groups)
    const updated = await this.deps.db.update('composition', projectId, current => {
      if (current.revision !== cached.revision) throw new AppError('当前草稿已更新，请重新规划')
      current.draft.groups = groups; current.revision++; current.updatedAt = now()
    })
    this.plans.delete(planId)
    return this.storePlan(projectId, updated.revision, { ...cached.plan, id: randomUUID(), ...result })
  }
  async start(projectId: string, planId: string): Promise<ExecutionBatch> {
    const previous = this.deps.db.list('executions').find(batch => batch.planId === planId)
    if (previous) { if (previous.projectId !== projectId) throw new AppError('计划不属于当前项目'); return previous }
    const cached = this.plans.get(planId), project = this.project(projectId)
    if (!cached || cached.projectId !== projectId || cached.revision !== project.revision) throw new AppError('草稿改变或规划失效，请重新规划')
    if (cached.plan.issues.length || validateGroups(cached.plan.request, cached.plan.assets, cached.plan.groups).issues.length) throw new AppError('分组尚未全部达标，不能提交')
    const release = await this.deps.assets.pin(cached.plan.assets.map(asset => asset.id), `plan:${planId}`)
    try {
      for (const snapshot of cached.plan.assets) await this.verify(snapshot)
      const id = randomUUID(), stamp = now()
      const batch: ExecutionBatch = { version: 2, id, projectId, planId, name: project.name, createdAt: stamp, updatedAt: stamp, state: 'running', plan: structuredClone(cached.plan),
        jobs: cached.plan.groups.map((group, index) => ({ id: randomUUID(), index, group: { imageId: group.imageId, audioIds: [...group.audioIds] }, status: 'pending', attempts: [], queuedAt: stamp })) }
      await this.deps.db.transact(() => {
        const current = this.project(projectId)
        if (current.revision !== cached.revision) throw new AppError('提交前草稿已变化，请重新规划')
        const duplicate = this.deps.db.list('executions').find(item => item.planId === planId)
        if (duplicate) throw new AppError('此计划已经提交，请查看原批次')
        current.batchIds.push(id); current.updatedAt = stamp
        return [{ table: 'executions', id, value: batch }, { table: 'composition', id: projectId, value: current }]
      })
      this.launch()
      return batch
    } finally { release() }
  }
  private async verify(snapshot: BatchAssetSnapshot) {
    const result = await this.deps.assets.verify(snapshot.id)
    if (result.asset.sha256 !== snapshot.sha256 || result.asset.bytes !== snapshot.bytes || result.asset.kind !== snapshot.kind) throw new AppError(`素材“${snapshot.name}”指纹变化，原快照已拒绝；请重新规划。`)
    return result
  }
  private launch(): void {
    if (this.closing) return
    for (const batch of this.deps.db.list('executions').filter(item => item.state === 'running')) {
      for (const job of batch.jobs.filter(item => ['pending', 'blocked'].includes(item.status))) {
        if (this.scheduled.has(job.id)) continue
        const task: Scheduled = { batchId: batch.id, jobId: job.id, controller: new AbortController(), done: Promise.resolve(), started: false }
        this.scheduled.set(job.id, task)
        task.done = this.run(task).catch(error => this.deps.onError?.(`任务状态或诊断保存失败：${safeError(error)}。请保留文件并重新打开核对。`)).finally(async () => {
          this.scheduled.delete(job.id)
          await this.settle(batch.id).catch(error => this.deps.onError?.(safeError(error)))
        })
      }
    }
  }
  private async mutateJob(task: Scheduled, update: (job: RenderJob) => void): Promise<void> {
    await this.deps.db.update('executions', task.batchId, batch => { const job = batch.jobs.find(value => value.id === task.jobId); if (!job) throw new AppError('执行任务不存在'); update(job); batch.updatedAt = now() })
  }
  private async succeeded(task: Scheduled, receipt: PublicationV2): Promise<void> {
    let assetId = receipt.assetId
    try { assetId = (await this.deps.assets.get(assetId)).id } catch { /* The successful publication still exists in history, even if deleted later. */ }
    await this.mutateJob(task, job => { Object.assign(job, { status: 'succeeded', progress: 100, finishedAt: receipt.finishedAt, videoAssetId: assetId, durationSeconds: receipt.durationSeconds,
      detail: '成片已发布、入库及记账', error: undefined }); const attempt = job.attempts.at(-1); if (attempt && !attempt.finishedAt) attempt.finishedAt = now() })
  }
  private async run(task: Scheduled): Promise<void> {
    const batch = this.deps.db.get('executions', task.batchId), job = batch.jobs.find(value => value.id === task.jobId)!
    const snapshotMap = new Map(batch.plan.assets.map(asset => [asset.id, asset])), controller = task.controller
    let lease: ResourceLease | undefined, unpin: (() => void) | undefined, root: string | undefined, work: string | undefined
    const attemptId = randomUUID(), timings: Array<{ stage: string; elapsedMs: number }> = []
    let stage = 'tools', stageAt = performance.now(), startedAt = performance.now(), assetId: string | undefined, assetName: string | undefined, toolVersion: string | undefined
    let published = false, diagnosticsSaved = true, writes = Promise.resolve(), writeFailure: unknown, lastUpdate = 0, lastDetail = ''
    const recordTiming = () => { const elapsedMs = performance.now() - stageAt; const existing = timings.find(value => value.stage === stage); if (existing) existing.elapsedMs += elapsedMs; else timings.push({ stage, elapsedMs }); stageAt = performance.now() }
    const enter = (next: string) => { recordTiming(); stage = next }
    const update = (progress: RenderProgress) => {
      if (controller.signal.aborted || (progress.detail === lastDetail && Date.now() - lastUpdate < 700)) return
      lastUpdate = Date.now(); lastDetail = progress.detail
      writes = writes.then(() => this.mutateJob(task, current => { if (current.status === 'succeeded') return; current.status = progress.status; current.detail = progress.detail; current.progress = progress.progress === undefined ? undefined : Math.min(99, progress.progress * 100) })).catch(error => { writeFailure = error; controller.abort() })
    }
    try {
      const receipt = await this.deps.publications.reconcile(job.id)
      if (receipt) { await this.succeeded(task, receipt); return }
      const rootId = await this.deps.assets.managedRootId(); root = await this.deps.assets.rootDirectory(rootId)
      unpin = await this.deps.assets.pin([...job.group.audioIds, job.group.imageId], `render:${job.id}`)
      const options = this.deps.db.get('settings', 'current').render
      const seconds = job.group.audioIds.reduce((sum, id) => sum + (snapshotMap.get(id)?.durationSeconds ?? 0), 0)
      // Reserve continuous video + AAC, including faststart's second copy and the pipeline's 20% headroom.
      lease = await this.deps.pool.acquire(job.id, { root, diskBytes: Math.ceil(seconds * (48000 * 2 * 4 * 3 + (8000000 + 192000) / 8 * 2) * 1.2 + 512 * 1024 ** 2), memoryBytes: 512 * 1024 ** 2, gpu: options.encoder !== 'cpu' }, controller.signal, detail => {
        if (detail === lastDetail) return; lastDetail = detail
        writes = writes.then(() => this.mutateJob(task, current => { if (!task.started) { current.status = 'blocked'; current.detail = detail; current.progress = undefined } })).catch(error => { writeFailure = error; controller.abort() })
      })
      if (controller.signal.aborted) throw new CancelledError()
      task.started = true; startedAt = performance.now(); stageAt = startedAt
      await writes
      await this.mutateJob(task, current => { current.attempts.push({ id: attemptId, startedAt: now() }); current.startedAt = now(); current.status = 'analyzing'; current.error = undefined; current.progress = undefined; current.detail = '检查工具与素材' })
      const tools = this.deps.tools ? await this.deps.tools() : await requireTools(this.deps.db.get('settings', 'current').ffmpegPath)
      toolVersion = (await discoverTools(tools.ffmpeg)).version
      enter('probe')
      const tracks = []
      for (const id of job.group.audioIds) { if (controller.signal.aborted) throw new CancelledError(); assetId = id; assetName = snapshotMap.get(id)!.name; const media = await this.verify(snapshotMap.get(id)!); tracks.push({ id, path: media.path, durationSeconds: media.asset.durationSeconds! }) }
      assetId = job.group.imageId; assetName = snapshotMap.get(assetId)!.name
      const image = await this.verify(snapshotMap.get(assetId)!)
      assetId = undefined; assetName = undefined
      await cleanupWork(root, 'video', job.id); work = await workDirectory(root, 'video', job.id, true)
      const output = await (this.deps.render ?? renderMedia)({ tools, tracks, imagePath: image.path, draft: batchDraft(batch.plan.request, batch.plan.groups[job.index]),
        minimumSeconds: batch.plan.request.minimumSeconds, taskDirectory: work, kind: 'video', signal: controller.signal, onProgress: update,
        performance: { encoder: options.encoder, threads: lease.threads }, onStage: enter })
      await writes; if (writeFailure) throw writeFailure
      if (controller.signal.aborted) throw new CancelledError()
      enter('validate')
      for (const id of [...job.group.audioIds, job.group.imageId]) { assetId = id; assetName = snapshotMap.get(id)!.name; await this.verify(snapshotMap.get(id)!) }
      assetId = undefined; assetName = undefined
      enter('publish')
      await this.mutateJob(task, current => { current.status = 'publishing'; current.detail = '安全发布、登记视频资产与使用关系'; current.progress = 99 })
      const fingerprint = await hashMedia(output.filePath), project = this.project(batch.projectId)
      const assetNames = (await this.deps.assets.all()).map(asset => asset.name)
      const name = newAssetName('video', [...assetNames, ...this.names]); this.names.add(name)
      await this.deps.publications.prepare({ version: 2, id: job.id, batchId: batch.id, projectId: batch.projectId, state: 'prepared', assetId: job.id, rootId,
        fileName: `videos/${job.id}.mp4`, name, projectName: project.name, finishedAt: now(), durationSeconds: output.durationSeconds, assetIds: [...job.group.audioIds, job.group.imageId], ...fingerprint })
      if (controller.signal.aborted) throw new CancelledError()
      await commitMedia(output.filePath, work, path.join(root, 'videos', `${job.id}.mp4`)); published = true
      const committed = await this.deps.publications.reconcile(job.id)
      if (!committed) throw new AppError('成片已发布，登记回执尚待恢复；不会重新合成')
      await this.succeeded(task, committed)
      recordTiming()
      const metrics = output.metrics
      await this.mutateJob(task, current => Object.assign(current.attempts.find(item => item.id === attemptId)!, { finishedAt: now(), stages: timings, elapsedMs: performance.now() - startedAt, ...(metrics ? { encoder: metrics.encoder, staticVideo: metrics.staticVideo } : {}) }))
    } catch (error) {
      await writes
      if (!task.started) {
        if (task.reason === 'pause' || task.reason === 'shutdown') await this.mutateJob(task, current => { current.status = 'pending'; current.detail = '尚未启动，队列已暂停'; current.progress = undefined })
        else if (task.reason === 'cancel') await this.mutateJob(task, current => { current.status = 'cancelled'; current.detail = '启动前已取消'; current.finishedAt = now() })
        else {
          await this.mutateJob(task, current => { current.attempts.push({ id: attemptId, startedAt: now() }); current.startedAt = now() })
          const diagnostic = await this.deps.diagnostics.save(writeFailure ?? error, { taskId: job.id, attemptId, stage, assetId, assetName, toolVersion })
          await this.mutateJob(task, current => { current.status = 'failed'; current.error = diagnostic.message; current.detail = diagnostic.suggestion; current.attempts.at(-1)!.diagnosticId = diagnostic.id; current.attempts.at(-1)!.finishedAt = now() })
        }
      } else if (controller.signal.aborted && !writeFailure && !published) {
        await this.mutateJob(task, current => { current.status = this.closing ? 'interrupted' : 'cancelled'; current.detail = this.closing ? '关闭中断，需手动继续' : '此任务已取消，其他任务不受影响'; current.progress = undefined; current.finishedAt = now(); current.attempts.at(-1)!.finishedAt = now() })
      } else {
        try {
          const diagnostic = await this.deps.diagnostics.save(writeFailure ?? error, { taskId: job.id, attemptId, stage, assetId, assetName, toolVersion })
          await this.mutateJob(task, current => {
            current.status = published ? 'interrupted' : 'failed'; current.error = diagnostic.message; current.detail = published ? '成片已发布，等待登记对账，不重新渲染' : diagnostic.suggestion; current.progress = undefined; current.finishedAt = now()
            Object.assign(current.attempts.find(item => item.id === attemptId)!, { finishedAt: now(), diagnosticId: diagnostic.id, stages: [...timings, { stage, elapsedMs: performance.now() - stageAt }], elapsedMs: performance.now() - startedAt })
          })
          if (['disk-space', 'tool-missing', 'unsupported'].includes(diagnostic.category)) await this.pauseRelated(batch.id, diagnostic.message)
        } catch (saveError) { diagnosticsSaved = false; throw saveError }
      }
    } finally {
      if (root && work && diagnosticsSaved) await cleanupWork(root, 'video', job.id).catch(() => this.deps.onError?.('任务临时目录未能清理，请检查存储权限；不会删除原素材。'))
      unpin?.(); lease?.release()
    }
  }
  private async settle(id: string): Promise<void> {
    await this.deps.db.update('executions', id, batch => {
      if (batch.jobs.every(job => job.status === 'succeeded')) { batch.state = 'completed'; batch.message = '全部成片已发布'; return }
      if (batch.state === 'cancelled') return
      const running = batch.jobs.some(job => RENDER_ACTIVE.has(job.status))
      const waiting = batch.jobs.some(job => ['pending', 'blocked'].includes(job.status))
      if (batch.state === 'pausing' && !running) { batch.state = 'paused'; batch.message = '当前任务已结束，余下任务暂停'; return }
      if (batch.state === 'running' && !running && !waiting) { batch.state = 'partial'; batch.message = '执行结束，部分任务未成功；成功成片不会重跑。' }
    })
  }
  async pause(id: string): Promise<void> {
    await this.deps.db.update('executions', id, batch => { if (batch.state === 'running') { batch.state = 'pausing'; batch.message = '完成正在执行的视频后暂停，尚未启动的任务等待'; } })
    for (const task of this.scheduled.values()) if (task.batchId === id && !task.started) { task.reason = 'pause'; task.controller.abort() }
    await this.settle(id)
  }
  private async pauseRelated(_id: string, reason: string): Promise<void> {
    // This app has one output root and one tool configuration: pause waiting work sharing them.
    for (const batch of this.deps.db.list('executions').filter(item => item.state === 'running')) {
      await this.pause(batch.id)
      await this.deps.db.update('executions', batch.id, value => { value.message = `共享环境故障，未启动任务已暂停：${reason}` })
    }
  }
  async continue(id: string): Promise<void> {
    if (this.closing) throw new AppError('软件正在关闭')
    const previous = this.deps.db.get('executions', id); this.project(previous.projectId)
    if ([...this.scheduled.values()].some(task => task.batchId === id)) throw new AppError('请先等待此批次已运行任务安全退出')
    await this.deps.db.update('executions', id, batch => {
      if (batch.jobs.every(job => job.status === 'succeeded')) return
      for (const job of batch.jobs) if (job.status !== 'succeeded') { job.status = 'pending'; job.detail = '按原快照重试未成功项；以往诊断保留'; job.progress = undefined; job.queuedAt = now() }
      batch.state = 'running'; batch.message = undefined
    })
    this.launch()
  }
  async cancelJob(batchId: string, jobId: string): Promise<void> {
    const task = this.scheduled.get(jobId)
    if (task && task.batchId !== batchId) throw new AppError('任务不属于所选批次')
    if (task) { task.reason = 'cancel'; task.controller.abort() }
    await this.deps.db.update('executions', batchId, batch => {
      const job = batch.jobs.find(value => value.id === jobId); if (!job) throw new AppError('视频任务不存在')
      if (!RENDER_ACTIVE.has(job.status) && job.status !== 'succeeded') { job.status = 'cancelled'; job.detail = '已取消，成功成片和其他任务保留'; job.finishedAt = now() }
    })
    await task?.done; await this.settle(batchId)
  }
  async cancel(id: string): Promise<void> {
    await this.deps.db.update('executions', id, batch => { if (batch.state !== 'completed') batch.state = 'cancelled' })
    const jobs = this.deps.db.get('executions', id).jobs.filter(job => job.status !== 'succeeded')
    for (const job of jobs) { const task = this.scheduled.get(job.id); if (task) { task.reason = 'cancel'; task.controller.abort() } }
    await Promise.all(jobs.map(job => this.cancelJob(id, job.id)))
  }
  async cancelProject(id: string): Promise<void> { await Promise.all(this.deps.db.list('executions').filter(value => value.projectId === id).map(batch => this.cancel(batch.id))) }
  async recover(): Promise<void> {
    for (const batch of this.deps.db.list('executions')) {
      for (const job of batch.jobs) {
        if (job.status === 'succeeded') continue
        const receipt = await this.deps.publications.reconcile(job.id).catch(() => undefined)
        if (receipt) await this.succeeded({ batchId: batch.id, jobId: job.id, started: false, controller: new AbortController(), done: Promise.resolve() }, receipt)
      }
      await this.deps.db.update('executions', batch.id, current => {
        for (const job of current.jobs) if (RENDER_ACTIVE.has(job.status)) { job.status = 'interrupted'; job.progress = undefined; job.detail = '上次合成中断；原诊断保留，未自动重跑'; const attempt = job.attempts.at(-1); if (attempt && !attempt.finishedAt) attempt.finishedAt = now() }
        if (current.jobs.every(job => job.status === 'succeeded')) current.state = 'completed'
        else if (current.state !== 'cancelled') { current.state = 'paused'; current.message = '重启后队列暂停，请确认后继续未成功项' }
      })
    }
  }
}
