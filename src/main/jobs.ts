import { randomUUID } from 'node:crypto'
import type { Project, MusicProvider, ImageProvider, MusicJob, RemoteMusicTask, Provider } from '../shared/types'
import { activeMusicStatuses, imageDraftSchema, musicDraftSchema } from '../shared/schemas'
import { AppError, safeError } from './providers/http'
import { downloadAudio, downloadImage } from './downloads'

export interface JobStore {
  get(id: string): Promise<Project>
  all(): Promise<Project[]>
  mutate(id: string, update: (project: Project) => void): Promise<Project>
}
interface Dependencies {
  projects: JobStore
  keys: { get(provider: Provider): string }
  music: MusicProvider
  images: ImageProvider
  download?: typeof downloadAudio
  downloadImage?: typeof downloadImage
  pollIntervalMs?: number
  pollLimit?: number
  onError?: (message: string) => void
}
class TerminalTaskError extends AppError {}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const now = (): string => new Date().toISOString()

/** Creates are never retried. Only persisted remote IDs may be polled after restart. */
export class JobManager {
  private musicBusy = false
  private imagesBusy = new Set<string>()
  private work = new Set<Promise<void>>()
  private closing = false
  private readonly download: typeof downloadAudio
  private readonly writeImage: typeof downloadImage
  constructor(private readonly deps: Dependencies) {
    this.download = deps.download ?? downloadAudio
    this.writeImage = deps.downloadImage ?? downloadImage
  }
  get busy(): boolean { return this.musicBusy || this.imagesBusy.size > 0 }
  shutdown(): void { this.closing = true }
  async idle(): Promise<void> { while (this.work.size) await Promise.all([...this.work]) }
  private launch(work: Promise<void>): void {
    const guarded = work.catch(error => this.deps.onError?.(`任务保存或执行失败：${safeError(error)}。请保留项目文件，重启后核对服务商任务，勿直接重复生成。`))
    this.work.add(guarded)
    void guarded.finally(() => this.work.delete(guarded))
  }
  private reserveMusic(): void {
    if (this.closing) throw new AppError('软件正在关闭')
    if (this.musicBusy) throw new AppError('已有音乐任务正在处理，请等待完成或停止后续任务')
    this.musicBusy = true
  }
  async startMusic(projectId: string): Promise<Project> {
    this.reserveMusic()
    try {
      const project = await this.deps.projects.get(projectId)
      const draft = musicDraftSchema.parse(project.music)
      if (!draft.prompt.trim()) throw new AppError('请先填写音乐提示词')
      this.deps.keys.get('mureka')
      if (project.musicJobs.some(j => j.status === 'pending' || activeMusicStatuses.has(j.status))) {
        throw new AppError('这个项目还有未完成的队列，请继续队列或停止后续任务后再新建一批')
      }
      const batchId = randomUUID()
      const result = await this.deps.projects.mutate(projectId, p => {
        p.batches.push({ id: batchId, total: draft.count, createdAt: now(), state: 'running' })
        for (let i = 0; i < draft.count; i++) p.musicJobs.push({
          id: randomUUID(), batchId, index: i, status: 'pending', createdAt: now(),
          snapshot: { ...structuredClone(draft), count: 1 }
        })
      })
      this.launch(this.runBatch(projectId, batchId).finally(() => { this.musicBusy = false }))
      return result
    } catch (error) { this.musicBusy = false; throw error }
  }
  async stopMusic(projectId: string, batchId: string): Promise<Project> {
    return this.deps.projects.mutate(projectId, p => {
      const batch = p.batches.find(b => b.id === batchId)
      if (!batch) throw new AppError('没有找到这批任务')
      for (const job of p.musicJobs.filter(j => j.batchId === batchId && j.status === 'pending')) job.status = 'cancelled'
      const active = p.musicJobs.some(j => j.batchId === batchId && activeMusicStatuses.has(j.status))
      batch.state = active ? 'stopping' : 'completed'
      batch.message = active ? '已停止后续任务，已提交的当前任务仍可能完成并计费。' : '未提交的任务已停止。'
    })
  }
  async continueMusic(projectId: string, batchId: string): Promise<Project> {
    this.reserveMusic()
    try {
      this.deps.keys.get('mureka')
      const result = await this.deps.projects.mutate(projectId, p => {
        const batch = p.batches.find(b => b.id === batchId)
        if (!batch || batch.state !== 'paused') throw new AppError('这批任务没有处于暂停状态')
        if (!p.musicJobs.some(j => j.batchId === batchId && j.status === 'pending')) throw new AppError('没有待提交的任务；失败曲目如需重新生成，请新建一批')
        if (p.musicJobs.some(j => activeMusicStatuses.has(j.status))) throw new AppError('请先等待已提交任务完成')
        batch.state = 'running'
        batch.message = undefined
      })
      this.launch(this.runBatch(projectId, batchId).finally(() => { this.musicBusy = false }))
      return result
    } catch (error) { this.musicBusy = false; throw error }
  }
  async retryMusicJob(projectId: string, jobId: string): Promise<Project> {
    this.reserveMusic()
    try {
      this.deps.keys.get('mureka')
      const result = await this.deps.projects.mutate(projectId, p => {
        const job = p.musicJobs.find(j => j.id === jobId)
        if (!job?.taskId || !job.recoverable || job.status === 'succeeded') throw new AppError('这条任务不能恢复查询；不会重新提交生成请求')
        job.status = 'queued'
        job.error = undefined
      })
      this.launch((async () => {
        await this.processMusicJob(projectId, jobId, true)
        await this.settleBatch(projectId, result.musicJobs.find(j => j.id === jobId)!.batchId)
      })().finally(() => { this.musicBusy = false }))
      return result
    } catch (error) { this.musicBusy = false; throw error }
  }
  private async runBatch(projectId: string, batchId: string): Promise<void> {
    while (!this.closing) {
      const project = await this.deps.projects.get(projectId)
      if (project.batches.find(b => b.id === batchId)?.state !== 'running') break
      const job = project.musicJobs.find(j => j.batchId === batchId && j.status === 'pending')
      if (!job) break
      const ok = await this.processMusicJob(projectId, job.id, false)
      if (!ok) {
        await this.deps.projects.mutate(projectId, p => {
          const batch = p.batches.find(b => b.id === batchId)!
          batch.state = 'paused'
          batch.message = '当前任务未完成，后续生成已暂停；已成功的素材仍保留。'
        })
        return
      }
    }
    if (!this.closing) await this.settleBatch(projectId, batchId)
  }
  private async settleBatch(projectId: string, batchId: string): Promise<void> {
    await this.deps.projects.mutate(projectId, p => {
      const batch = p.batches.find(b => b.id === batchId)!
      if (p.musicJobs.some(j => j.batchId === batchId && activeMusicStatuses.has(j.status))) return
      if (p.musicJobs.some(j => j.batchId === batchId && j.status === 'pending')) {
        batch.state = 'paused'
        batch.message = '待提交任务已暂停，请确认后继续。'
      } else {
        batch.state = 'completed'
        const failed = p.musicJobs.some(j => j.batchId === batchId && (j.status === 'failed' || j.status === 'unknown'))
        if (failed) batch.message = '这批任务已结束，部分曲目需要处理；不会自动重复生成。'
      }
    })
  }
  private async changeJob(projectId: string, jobId: string, patch: Partial<MusicJob>): Promise<Project> {
    return this.deps.projects.mutate(projectId, p => {
      const job = p.musicJobs.find(j => j.id === jobId)
      if (!job) throw new AppError('任务记录不存在')
      Object.assign(job, patch)
    })
  }
  private async processMusicJob(projectId: string, jobId: string, queryOnly: boolean): Promise<boolean> {
    let submitted = false
    let knownId: string | undefined
    try {
      const project = await this.deps.projects.get(projectId)
      const job = project.musicJobs.find(j => j.id === jobId)!
      knownId = job.taskId
      const key = this.deps.keys.get('mureka')
      let task: RemoteMusicTask
      if (queryOnly) {
        if (!knownId) throw new AppError('缺少远端任务 ID，无法恢复查询')
        task = await this.deps.music.query(job.snapshot.mode, knownId, key)
      } else {
        if (job.status !== 'pending') return false
        // Commit before POST; a crash without task ID is deliberately uncertain.
        const changed = await this.deps.projects.mutate(projectId, p => {
          const current = p.musicJobs.find(j => j.id === jobId)!
          if (current.status === 'pending' && p.batches.find(b => b.id === current.batchId)?.state === 'running') current.status = 'submitting'
        })
        if (changed.musicJobs.find(j => j.id === jobId)!.status !== 'submitting') return true
        submitted = true
        task = await this.deps.music.create(job.snapshot, key)
        knownId = task.id
        await this.changeJob(projectId, jobId, { taskId: knownId, actualModel: task.model, recoverable: true })
      }
      for (let attempt = 0; ; attempt++) {
        if (this.closing) return false
        if (task.status === 'failed' || task.status === 'timeouted' || task.status === 'cancelled') {
          throw new TerminalTaskError('服务商报告音乐任务失败或已结束，请到服务商后台核对；重新生成会产生新的费用。')
        }
        if (task.status === 'succeeded') {
          if (!task.choices?.length) throw new AppError('任务成功但未返回音频，请稍后重新查询，不要重复生成')
          await this.changeJob(projectId, jobId, { status: 'downloading', actualModel: task.model ?? job.actualModel })
          for (const choice of task.choices) {
            const latest = await this.deps.projects.get(projectId)
            if (latest.audio.some(a => a.jobId === jobId && a.remoteId === choice.id)) continue
            const assetId = randomUUID()
            const saved = await this.download(choice.url, latest.directory, assetId)
            await this.deps.projects.mutate(projectId, p => {
              p.audio.push({
                id: assetId, jobId, taskId: knownId!, remoteId: choice.id,
                title: `曲目 ${String(p.audio.length + 1).padStart(2, '0')}`,
                fileName: saved.fileName, durationMs: choice.duration, createdAt: now(),
                model: task.model ?? job.actualModel ?? job.snapshot.model,
                prompt: job.snapshot.prompt, mode: job.snapshot.mode, kept: false
              })
            })
          }
          await this.changeJob(projectId, jobId, { status: 'succeeded', error: undefined, recoverable: false })
          return true
        }
        await this.changeJob(projectId, jobId, { status: task.status, actualModel: task.model ?? job.actualModel })
        if (attempt >= (this.deps.pollLimit ?? 360)) throw new AppError('查询等待已达上限。任务可能仍在服务商生成，可稍后恢复查询，不会重新扣费创建')
        await sleep(this.deps.pollIntervalMs ?? 5000)
        if (this.closing) return false
        task = await this.deps.music.query(job.snapshot.mode, knownId!, key)
      }
    } catch (error) {
      if (this.closing) return false
      const uncertain = submitted && !knownId && error instanceof AppError && error.uncertain
      const message = uncertain
        ? `${safeError(error)}。请求是否被受理未知，请先核对服务商后台；没有自动重复提交。`
        : safeError(error)
      await this.changeJob(projectId, jobId, {
        taskId: knownId,
        status: uncertain ? 'unknown' : 'failed',
        recoverable: !!knownId && !(error instanceof TerminalTaskError),
        error: message
      })
      return false
    }
  }
  async startImage(projectId: string): Promise<Project> {
    if (this.closing) throw new AppError('软件正在关闭')
    if (this.imagesBusy.has(projectId)) throw new AppError('图片正在生成，请等待完成，避免重复扣费')
    this.imagesBusy.add(projectId)
    try {
      const project = await this.deps.projects.get(projectId)
      const draft = imageDraftSchema.parse(project.image)
      if (!draft.prompt.trim()) throw new AppError('请先填写图片提示词')
      const key = this.deps.keys.get('siliconflow')
      if (project.imageJobs.some(j => j.status === 'submitting' || j.status === 'downloading')) throw new AppError('已有图片请求尚未完成')
      const jobId = randomUUID()
      const result = await this.deps.projects.mutate(projectId, p => {
        p.imageJobs.push({ id: jobId, provider: 'siliconflow', status: 'submitting', createdAt: now(), snapshot: structuredClone(draft) })
      })
      this.launch((async () => {
        let received = false
        try {
          const image = await this.deps.images.generate(draft, key)
          received = true
          await this.deps.projects.mutate(projectId, p => { p.imageJobs.find(j => j.id === jobId)!.status = 'downloading' })
          const assetId = randomUUID()
          const file = await this.writeImage(image.url, project.directory, assetId)
          await this.deps.projects.mutate(projectId, p => {
            p.images.push({ id: assetId, jobId, provider: 'siliconflow', fileName: file.fileName, format: file.format, createdAt: now(), model: image.model, prompt: draft.prompt, size: `${file.width}x${file.height}` })
            p.selectedImageId = assetId
            p.imageJobs.find(j => j.id === jobId)!.status = 'succeeded'
          })
        } catch (error) {
          await this.deps.projects.mutate(projectId, p => {
            const job = p.imageJobs.find(j => j.id === jobId)!
            const uncertain = error instanceof AppError && error.uncertain
            job.status = uncertain ? 'unknown' : 'failed'
            job.error = `${safeError(error)}${uncertain ? '。请核对硅基流动后台；不会自动再次生成。' : received ? '。服务商已生成，但本地下载或保存失败；重新生成会再次计费。' : ''}`
          })
        }
      })().finally(() => { this.imagesBusy.delete(projectId) }))
      return result
    } catch (error) { this.imagesBusy.delete(projectId); throw error }
  }
  async recover(): Promise<void> {
    this.reserveMusic()
    try {
      const resume: { projectId: string; jobId: string; batchId: string }[] = []
      for (const project of await this.deps.projects.all()) {
        const needsRecovery = project.batches.some(b => b.state === 'running' || b.state === 'stopping') || project.musicJobs.some(j => activeMusicStatuses.has(j.status)) || project.imageJobs.some(j => j.status === 'submitting' || j.status === 'downloading')
        if (!needsRecovery) continue
        await this.deps.projects.mutate(project.id, p => {
          for (const batch of p.batches.filter(b => b.state === 'running' || b.state === 'stopping')) {
            batch.state = 'paused'
            batch.message = '软件上次关闭时任务未结束。仅恢复已提交任务的查询，待提交任务需手动继续。'
          }
          for (const job of p.musicJobs.filter(j => activeMusicStatuses.has(j.status))) {
            if (job.taskId) {
              resume.push({ projectId: p.id, jobId: job.id, batchId: job.batchId })
              job.status = 'queued'
              job.recoverable = true
            } else {
              job.status = 'unknown'
              job.error = '上次提交后未能保存远端任务 ID，是否已受理未知。请先核对 Mureka 后台，不会自动重复生成。'
            }
          }
          for (const job of p.imageJobs.filter(j => j.status === 'submitting' || j.status === 'downloading')) {
            job.status = 'unknown'
            job.error = `图片请求在软件关闭时中断，可能已计费。无法恢复此同步请求，请核对${job.provider === 'openai' ? ' OpenAI ' : '硅基流动'}后台；不会自动重新生成。`
          }
        })
      }
      if (!resume.length) { this.musicBusy = false; return }
      this.launch((async () => {
        for (const item of resume) {
          if (this.closing) break
          await this.processMusicJob(item.projectId, item.jobId, true)
          await this.settleBatch(item.projectId, item.batchId)
        }
      })().finally(() => { this.musicBusy = false }))
    } catch (error) { this.musicBusy = false; throw error }
  }
}
