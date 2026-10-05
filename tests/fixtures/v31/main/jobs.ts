import { randomUUID } from 'node:crypto'
import type { Project, MusicProvider, ImageProvider, MusicJob, Provider, Settings, MusicDraft } from '../../../../src/shared/types'
import type { MusicBinding, MusicConnection, ProviderMusicTask, GeneratedAudioResult } from '../../../../src/shared/music-types'
import { musicBindingSchema } from '../../../../src/shared/music-schemas'
import { MUSIC_PROVIDER_LABELS } from '../../../../src/shared/music-capabilities'
import { MusicRegistry } from '../../../../src/main/providers/music-registry'
import { saveGeneratedAudio } from '../../../../src/main/generated-audio'
import { matchMusicResults } from '../../../../src/main/music-results'
import { requireTools } from '../../../../src/main/video/ffmpeg'
import { activeMusicStatuses, imageDraftSchema, musicDraftSchema } from '../../../../src/shared/schemas'
import { AppError, safeError } from '../../../../src/main/providers/http'
import { downloadAudio, downloadImage } from '../../../../src/main/downloads'

export interface JobStore {
  get(id: string): Promise<Project>
  all(): Promise<Project[]>
  mutate(id: string, update: (project: Project) => void): Promise<Project>
}
interface Dependencies {
  projects: JobStore
  keys: { get(provider: Provider, connectionId?: string): string; has?(provider: Provider, connectionId?: string): boolean }
  settings?: { get(): Settings }
  registry?: Pick<MusicRegistry, 'get'>
  saveAudio?: typeof saveGeneratedAudio
  prepareAudio?: () => Promise<void>
  music: MusicProvider
  images: ImageProvider
  download?: typeof downloadAudio
  downloadImage?: typeof downloadImage
  pollIntervalMs?: number
  pollLimit?: number
  onError?: (message: string) => void
}
class TerminalTaskError extends AppError {}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
const now = (): string => new Date().toISOString()

/** Creates are never retried. Only persisted remote IDs may be polled after restart. */
export class JobManager {
  private musicBusy = false
  private imagesBusy = new Set<string>()
  private work = new Set<Promise<void>>()
  private closing = false
  private readonly download: typeof downloadAudio
  private readonly writeImage: typeof downloadImage
  private readonly registry: Pick<MusicRegistry, 'get'>
  private readonly musicAbort = new AbortController()
  constructor(private readonly deps: Dependencies) {
    this.download = deps.download ?? downloadAudio
    this.writeImage = deps.downloadImage ?? downloadImage
    this.registry = deps.registry ?? new MusicRegistry(deps.music)
  }
  get busy(): boolean { return this.musicBusy || this.imagesBusy.size > 0 }
  shutdown(): void { this.closing = true; this.musicAbort.abort() }
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
  private binding(draft: MusicDraft): MusicBinding {
    if (draft.provider !== 'acestep') return { provider: draft.provider, adapterVersion: 1 }
    const settings = this.deps.settings?.get().aceStep
    if (!settings) throw new AppError('请先配置 ACE-Step 服务地址。')
    return { provider: 'acestep', adapterVersion: 1, local: { baseUrl: settings.baseUrl, connectionId: settings.connectionId } }
  }
  private connection(binding: MusicBinding): MusicConnection {
    if (!musicBindingSchema.safeParse(binding).success) throw new AppError('音乐任务连接信息不完整，不能安全恢复。')
    if (binding.provider !== 'acestep') return { key: this.deps.keys.get(binding.provider), signal: this.musicAbort.signal }
    const current = this.deps.settings?.get().aceStep
    if (!current || current.baseUrl !== binding.local?.baseUrl || current.connectionId !== binding.local?.connectionId) {
      throw new AppError('ACE-Step 连接已变更；原任务仍绑定原服务，请恢复原连接记录后再查询，不会向新服务提交。')
    }
    return {
      baseUrl: current.baseUrl, signal: this.musicAbort.signal,
      ...(this.deps.keys.has?.('acestep', current.connectionId) ? { key: this.deps.keys.get('acestep', current.connectionId) } : {})
    }
  }
  private async preflight(draft: MusicDraft, binding: MusicBinding): Promise<void> {
    const connection = this.connection(binding)
    if (draft.provider !== 'mureka') {
      if (this.deps.prepareAudio) await this.deps.prepareAudio()
      else await requireTools(this.deps.settings?.get().ffmpegPath)
    }
    await this.registry.get(binding.provider).preflight?.(draft, connection)
    this.connection(binding)
    if (this.closing) throw new AppError('软件正在关闭，未提交生成。')
  }
  async startMusic(projectId: string): Promise<Project> {
    this.reserveMusic()
    try {
      const project = await this.deps.projects.get(projectId)
      const draft = musicDraftSchema.parse(project.music)
      if (!draft.prompt.trim()) throw new AppError('请先填写音乐提示词')
      const binding = this.binding(draft)
      await this.preflight(draft, binding)
      if (project.musicJobs.some(j => j.status === 'pending' || activeMusicStatuses.has(j.status))) {
        throw new AppError('这个项目还有未完成的队列，请继续队列或停止后续任务后再新建一批')
      }
      const batchId = randomUUID()
      const result = await this.deps.projects.mutate(projectId, p => {
        p.batches.push({ id: batchId, total: draft.count, createdAt: now(), state: 'running' })
        for (let i = 0; i < draft.count; i++) p.musicJobs.push({
          id: randomUUID(), batchId, index: i, status: 'pending', createdAt: now(),
          snapshot: { ...structuredClone(draft), count: 1 }, binding: structuredClone(binding)
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
      const local = p.musicJobs.filter(j => j.batchId === batchId).every(j => j.binding.provider === 'acestep')
      batch.message = active ? local ? '已停止后续任务，当前本地任务仍由服务继续处理。' : '已停止后续任务，已提交的当前任务仍可能完成并计费。' : '未提交的任务已停止。'
    })
  }
  async continueMusic(projectId: string, batchId: string): Promise<Project> {
    this.reserveMusic()
    try {
      const previous = await this.deps.projects.get(projectId)
      const pending = previous.musicJobs.find(job => job.batchId === batchId && job.status === 'pending')
      if (pending) await this.preflight(pending.snapshot, pending.binding)
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
      const previous = await this.deps.projects.get(projectId)
      const original = previous.musicJobs.find(job => job.id === jobId)
      if (original) this.connection(original.binding)
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
    let local = false
    try {
      const project = await this.deps.projects.get(projectId)
      const job = project.musicJobs.find(j => j.id === jobId)!
      knownId = job.taskId
      local = job.binding.provider === 'acestep'
      const adapter = this.registry.get(job.binding.provider)
      let task: ProviderMusicTask
      if (queryOnly) {
        if (!knownId) throw new AppError('缺少远端任务 ID，无法恢复查询')
        task = await adapter.query(job.snapshot, knownId, this.connection(job.binding))
      } else {
        if (job.status !== 'pending') return false
        await this.preflight(job.snapshot, job.binding)
        const changed = await this.deps.projects.mutate(projectId, p => {
          const current = p.musicJobs.find(j => j.id === jobId)!
          if (current.status === 'pending' && p.batches.find(b => b.id === current.batchId)?.state === 'running') current.status = 'submitting'
        })
        if (changed.musicJobs.find(j => j.id === jobId)!.status !== 'submitting') return true
        // Commit before POST; a crash without task ID remains uncertain. Never replay creation.
        submitted = true
        task = await adapter.create(job.snapshot, this.connection(job.binding))
        knownId = task.id
        await this.changeJob(projectId, jobId, { taskId: knownId, actualModel: task.model, recoverable: true })
      }
      const deadline = Date.now() + (local ? this.deps.settings!.get().aceStep.waitMinutes : 30) * 60000
      for (let attempt = 0; ; attempt++) {
        if (this.closing) return false
        if (task.id !== knownId) throw new AppError('查询结果与原任务 ID 不一致，已停止接收。')
        if (task.status === 'failed' || task.status === 'timeouted' || task.status === 'cancelled') {
          throw new TerminalTaskError(local ? 'ACE-Step 报告任务失败或已结束，请检查服务终端的模型、显存和推理错误；未自动重新生成。' : '服务商报告音乐任务失败或已结束，请到服务商后台核对；重新生成会产生新的费用。')
        }
        if (task.status === 'succeeded') {
          if (!task.choices?.length) throw new AppError('任务成功但未返回音频，请稍后重新查询，不要重复生成')
          const latest = await this.deps.projects.get(projectId)
          const current = latest.musicJobs.find(item => item.id === jobId)!
          const results = matchMusicResults(job.binding, task.choices, current.outputs, latest.audio, jobId)
          await this.changeJob(projectId, jobId, { status: 'downloading', actualModel: task.model ?? job.actualModel, outputs: results.map(item => item.output) })
          let failed: unknown
          for (const { output, choice } of results) {
            if (this.closing) return false
            const refreshed = await this.deps.projects.get(projectId)
            if (refreshed.audio.some(asset => asset.id === output.assetId)) continue
            await this.changeJob(projectId, jobId, { detail: `保存结果 ${output.index + 1} / ${results.length}` })
            try {
              const connection = this.connection(job.binding)
              let saved: GeneratedAudioResult
              if (job.binding.provider === 'mureka') {
                saved = { ...await this.download(choice.url, refreshed.directory, output.assetId), durationMs: choice.durationMs ?? 0 }
              } else {
                saved = await (this.deps.saveAudio ?? saveGeneratedAudio)({
                  directory: refreshed.directory, assetId: output.assetId, url: choice.url,
                  ...(local ? { connection } : {}), getFFmpegPath: () => this.deps.settings?.get().ffmpegPath,
                  signal: this.musicAbort.signal
                })
              }
              await this.deps.projects.mutate(projectId, p => {
                if (!p.audio.some(asset => asset.id === output.assetId)) p.audio.push({
                  id: output.assetId, jobId, taskId: knownId!, ...(choice.remoteId ? { remoteId: choice.remoteId } : {}), resultId: output.id,
                  provider: job.binding.provider, title: output.title || job.snapshot.title?.trim() || `曲目 ${String(p.audio.length + 1).padStart(2, '0')}`,
                  ...saved, createdAt: now(), model: task.model ?? job.actualModel ?? job.snapshot.model,
                  prompt: job.snapshot.prompt, mode: job.snapshot.mode, kept: false
                })
                const record = p.musicJobs.find(item => item.id === jobId)!.outputs!.find(item => item.id === output.id)!
                record.status = 'saved'
              })
            } catch (error) { failed = error }
          }
          if (failed) {
            const end = await this.deps.projects.get(projectId)
            const savedCount = end.audio.filter(asset => asset.jobId === jobId).length
            throw new AppError(`生成已成功，已保存 ${savedCount} / ${results.length} 首；剩余下载或本地保存待恢复。${safeError(failed)}。恢复只处理原任务，不重新生成。`)
          }
          await this.changeJob(projectId, jobId, { status: 'succeeded', error: undefined, recoverable: false, detail: `已保存 ${results.length} 首` })
          return true
        }
        await this.changeJob(projectId, jobId, { status: task.status, actualModel: task.model ?? job.actualModel, detail: task.detail })
        if (Date.now() >= deadline || (this.deps.pollLimit !== undefined && attempt >= this.deps.pollLimit)) throw new AppError('查询等待已达上限。原任务可能仍在生成，可稍后恢复查询；不会重新创建。')
        await sleep(Math.min(this.deps.pollIntervalMs ?? 5000, Math.max(0, deadline - Date.now())), this.musicAbort.signal)
        if (this.closing) return false
        task = await adapter.query(job.snapshot, knownId!, this.connection(job.binding))
      }
    } catch (error) {
      if (this.closing) return false
      const uncertain = submitted && !knownId && (!(error instanceof AppError) || error.uncertain)
      const message = uncertain
        ? `${safeError(error)}。请求是否被受理未知，请先核对${local ? 'ACE-Step 服务' : '服务商后台'}；没有自动重复提交。`
        : safeError(error)
      await this.changeJob(projectId, jobId, {
        taskId: knownId, status: uncertain ? 'unknown' : 'failed',
        recoverable: !!knownId && !(error instanceof TerminalTaskError), error: message.slice(0, 2000)
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
              job.error = `上次提交后未能保存远端任务 ID，是否已受理未知。请先核对 ${MUSIC_PROVIDER_LABELS[job.binding.provider]} ${job.binding.provider === 'acestep' ? '服务' : '后台'}，不会自动重复生成。`
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
