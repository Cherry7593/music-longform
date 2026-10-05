import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AssetKind, Project, Settings, VideoAnalysis, VideoDraft, VideoJob, VideoToolsStatus } from '../../../../../src/shared/types'
import { activeVideoStatuses, videoDraftSchema } from '../../../../../src/shared/schemas'
import { calculateTimeline } from '../../../../../src/shared/video-timeline'
import { AppError, safeError } from '../../../../../src/main/providers/http'
import { assetDirectories, assetFolder } from '../../../../../src/main/storage/paths'
import { CancelledError, discoverTools, probeMedia, type VideoTools } from '../../../../../src/main/video/ffmpeg'
import { renderMedia, type RenderProgress, type RenderTrack } from '../../../../../src/main/video/pipeline'
import { cleanupWork, commitMedia, workDirectory } from '../../../../../src/main/video/workfiles'
import { RenderScheduler } from './scheduler'
import type { ExportReceipt } from '../../../../../src/shared/library-types'

export interface VideoPublication {
  prepare(project: Project, job: VideoJob, output: Awaited<ReturnType<typeof renderMedia>>, fileName: string): Promise<void>
  commit(jobId: string): Promise<ExportReceipt | undefined>
  recover(jobId: string): Promise<ExportReceipt | undefined>
}

export interface VideoStore {
  get(id: string): Promise<Project>
  all(): Promise<Project[]>
  mutate(id: string, update: (p: Project) => void): Promise<Project>
  pathForAsset(id: string, kind: AssetKind, assetId: string): Promise<string>
}
interface Dependencies {
  projects: VideoStore
  settings: { get(): Settings }
  render?: typeof renderMedia
  discover?: typeof discoverTools
  probe?: typeof probeMedia
  onError?: (message: string) => void
  scheduler?: RenderScheduler
  publication?: VideoPublication
}
interface Active {
  projectId: string; jobId?: string; controller: AbortController
  done: Promise<void>; release: () => void
}
const now = (): string => new Date().toISOString()
export class VideoJobManager {
  private active?: Active
  private closing = false
  private readonly render: typeof renderMedia
  private readonly discover: typeof discoverTools
  private readonly probe: typeof probeMedia
  private readonly scheduler: RenderScheduler
  constructor(private readonly deps: Dependencies) {
    this.render = deps.render ?? renderMedia
    this.discover = deps.discover ?? discoverTools
    this.probe = deps.probe ?? probeMedia
    this.scheduler = deps.scheduler ?? new RenderScheduler()
  }
  get busy(): boolean { return !!this.active }
  private reserve(projectId: string, jobId?: string): Active {
    if (this.closing) throw new AppError('软件正在关闭')
    if (this.active) throw new AppError('已有视频任务、试听或素材检查正在处理，请等待结束或取消后再操作')
    const releaseRender = this.scheduler.reserve()
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const active = { projectId, jobId, controller: new AbortController(), done, release: () => { releaseRender(); release() } }
    this.active = active
    return active
  }
  private finish(active: Active): void { if (this.active === active) this.active = undefined; active.release() }
  async idle(): Promise<void> { await this.active?.done }
  async shutdown(): Promise<void> { this.closing = true; this.active?.controller.abort(); await this.idle() }
  checkTools(): Promise<VideoToolsStatus> { return this.discover(this.deps.settings.get().ffmpegPath) }
  private async inputs(project: Project, draft: VideoDraft, signal: AbortSignal, requireImage: boolean): Promise<{ analysis: VideoAnalysis; tracks: RenderTrack[]; imagePath?: string; tools: VideoTools }> {
    const status = await this.checkTools()
    if (!status.available || !status.ffmpeg || !status.ffprobe) throw new AppError(status.message)
    const tools = { ffmpeg: status.ffmpeg, ffprobe: status.ffprobe }
    const tracks: RenderTrack[] = []
    const problems: string[] = []
    for (const id of draft.audioIds) {
      if (signal.aborted) throw new CancelledError()
      const file = await this.deps.projects.pathForAsset(project.id, 'audio', id)
      const info = await this.probe(tools, file, signal)
      if (!info.streams.some(stream => stream.codec_type === 'audio') || !Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0) throw new AppError('音乐文件没有有效的音频或时长，请检查素材')
      tracks.push({ id, path: file, durationSeconds: info.durationSeconds })
    }
    let imagePath: string | undefined
    let imageWidth: number | undefined
    let imageHeight: number | undefined
    if (draft.imageId && requireImage) {
      imagePath = await this.deps.projects.pathForAsset(project.id, 'image', draft.imageId)
      const info = await this.probe(tools, imagePath, signal)
      const image = info.streams.find(stream => stream.codec_type === 'video')
      if (!image?.width || !image.height) throw new AppError('无法读取所选图片的尺寸')
      imageWidth = image.width; imageHeight = image.height
    } else if (requireImage) problems.push('请选择一张图片')
    const timeline = calculateTimeline(draft, tracks)
    timeline.issues.push(...problems)
    return { tools, tracks, imagePath, analysis: { draft: structuredClone(draft), timeline, imageWidth, imageHeight, tools: status } }
  }
  async analyze(projectId: string): Promise<VideoAnalysis> {
    const active = this.reserve(projectId)
    try {
      const p = await this.deps.projects.get(projectId)
      return (await this.inputs(p, videoDraftSchema.parse(p.video), active.controller.signal, true)).analysis
    } finally { this.finish(active) }
  }
  async start(projectId: string, kind: 'video' | 'preview' = 'video', boundaryIndex?: number): Promise<Project> {
    const id = randomUUID()
    const active = this.reserve(projectId, id)
    try {
      const project = await this.deps.projects.get(projectId)
      const draft = videoDraftSchema.parse(project.video)
      if (!draft.audioIds.length) throw new AppError('请至少选择一首音乐')
      if (kind === 'video' && !draft.imageId) throw new AppError('请选择一张图片')
      if (kind === 'preview' && (!Number.isInteger(boundaryIndex) || boundaryIndex! < 0 || boundaryIndex! >= draft.audioIds.length - 1)) throw new AppError('请选择两个相邻曲目的连接处')
      if (project.videoJobs.some(job => activeVideoStatuses.has(job.status))) throw new AppError('该项目还有未完成的视频任务，请重新打开软件恢复记录')
      const saved = await this.deps.projects.mutate(projectId, p => {
        p.videoJobs.push({ id, kind, status: 'analyzing', snapshot: structuredClone(draft), createdAt: now(), ...(kind === 'preview' ? { boundaryIndex } : {}), detail: '正在核对本地素材与工具' })
      })
      void this.run(active, project, saved.videoJobs.find(job => job.id === id)!).catch(error => this.deps.onError?.(safeError(error))).finally(() => this.finish(active))
      return saved
    } catch (error) { this.finish(active); throw error }
  }
  private async run(active: Active, project: Project, job: VideoJob): Promise<void> {
    const signal = active.controller.signal
    let createdWork = false
    let published = false
    let progressWrites: Promise<unknown> = Promise.resolve()
    let progressFailure: unknown
    let lastWrite = 0
    let lastStage = job.status
    const update = (event: RenderProgress): void => {
      if (signal.aborted) return
      if (event.status === lastStage && Date.now() - lastWrite < 750) return
      lastWrite = Date.now(); lastStage = event.status
      progressWrites = progressWrites.then(() => this.deps.projects.mutate(project.id, p => {
        const entry = p.videoJobs.find(j => j.id === job.id)!
        if (!activeVideoStatuses.has(entry.status)) return
        entry.status = event.status
        entry.detail = event.detail.slice(0, 2000)
        entry.progress = event.progress === undefined ? undefined : Math.min(99, Math.max(0, Math.round(event.progress * 1000) / 10))
      })).catch(error => { progressFailure = error; active.controller.abort() })
    }
    try {
      const inputs = await this.inputs(project, job.snapshot, signal, job.kind === 'video')
      let renderDraft = job.snapshot
      if (job.kind === 'preview' && inputs.analysis.timeline.missingSeconds > 0) {
        // Audition existing boundaries before the full playlist is ready. The target ending has
        // not been reached, so do not invent its final fade or fill any missing audio.
        renderDraft = { ...job.snapshot, durationMode: 'all', fadeOutSeconds: 0 }
        inputs.analysis.timeline = calculateTimeline(renderDraft, inputs.tracks)
      }
      if (inputs.analysis.timeline.issues.length) throw new AppError(inputs.analysis.timeline.issues.join('；').slice(0, 1800))
      if (signal.aborted) throw new CancelledError()
      const work = await workDirectory(project.directory, job.kind, job.id, true)
      createdWork = true
      const output = await this.render({ tools: inputs.tools, draft: renderDraft, tracks: inputs.tracks, imagePath: inputs.imagePath, taskDirectory: work, kind: job.kind, boundaryIndex: job.boundaryIndex, signal, onProgress: update })
      await progressWrites
      if (progressFailure) throw progressFailure
      if (signal.aborted) throw new CancelledError()
      const folder = await assetFolder(project.directory, job.kind)
      const fileName = `${assetDirectories[job.kind]}/${job.id}.${job.kind === 'video' ? 'mp4' : 'wav'}`
      if (job.kind === 'video') await this.deps.publication?.prepare(project, job, output, fileName)
      if (signal.aborted) throw new CancelledError()
      await commitMedia(output.filePath, work, join(folder, `${job.id}.${job.kind === 'video' ? 'mp4' : 'wav'}`))
      published = true
      if (job.kind === 'video' && this.deps.publication && !await this.deps.publication.commit(job.id)) throw new AppError('成片已发布，等待回执对账；请勿重复合成')
      // Publication is the commit point: a completed output wins a cancellation arriving after it.
      await this.deps.projects.mutate(project.id, p => Object.assign(p.videoJobs.find(j => j.id === job.id)!, {
        status: 'succeeded', progress: 100, finishedAt: now(), fileName,
        durationSeconds: output.durationSeconds, detail: job.kind === 'video' ? '成片已校验并保存' : '连接处试听已准备好'
      }))
    } catch (error) {
      await progressWrites
      const cancelled = !progressFailure && (signal.aborted || error instanceof CancelledError)
      await this.deps.projects.mutate(project.id, p => Object.assign(p.videoJobs.find(j => j.id === job.id)!, {
        status: published ? 'interrupted' : cancelled ? 'cancelled' : 'failed', finishedAt: now(), progress: undefined,
        error: cancelled ? undefined : safeError(progressFailure ?? error).slice(0, 2000),
        detail: published ? '成片已发布，等待回执对账；不会自动重复渲染' : cancelled ? '任务已取消，原素材未改动' : '导出未完成；原素材与此前成片仍保留'
      }))
    } finally {
      if (createdWork) await cleanupWork(project.directory, job.kind, job.id).catch(() => this.deps.onError?.('导出临时文件清理失败，请检查项目内 .work 目录；未删除原素材。'))
    }
  }
  async cancel(projectId: string, jobId: string): Promise<Project> {
    const active = this.active
    if (active?.projectId === projectId && active.jobId === jobId) {
      active.controller.abort()
      await active.done
    } else {
      const p = await this.deps.projects.get(projectId)
      if (!p.videoJobs.some(job => job.id === jobId)) throw new AppError('没有找到这个导出任务')
    }
    return this.deps.projects.get(projectId)
  }
  async recover(): Promise<void> {
    for (const project of await this.deps.projects.all()) {
      const restored = new Map<string, ExportReceipt>()
      for (const job of project.videoJobs.filter(j => j.kind === 'video' && j.status !== 'succeeded')) {
        try { const receipt = await this.deps.publication?.recover(job.id); if (receipt) restored.set(job.id, receipt) } catch (error) { this.deps.onError?.(safeError(error)) }
      }
      const interrupted = project.videoJobs.filter(job => activeVideoStatuses.has(job.status) || restored.has(job.id))
      if (!interrupted.length) continue
      await this.deps.projects.mutate(project.id, p => {
        for (const job of p.videoJobs.filter(j => activeVideoStatuses.has(j.status))) Object.assign(job, {
          status: 'interrupted', finishedAt: now(), progress: undefined,
          detail: '上次关闭中断了导出，未自动重跑。原素材仍在，请按当前设置重新导出。'
        })
        for (const job of p.videoJobs) {
          const receipt = restored.get(job.id)
          if (receipt) Object.assign(job, { status: 'succeeded', progress: 100, fileName: receipt.fileName, durationSeconds: receipt.durationSeconds, finishedAt: receipt.finishedAt, error: undefined, detail: '已恢复成功成片回执' })
        }
      })
      for (const job of interrupted) await cleanupWork(project.directory, job.kind, job.id).catch(() => {
        this.deps.onError?.('上次导出的临时文件暂不可清理；中断记录已保留，没有终止未知进程。')
      })
    }
  }
}
