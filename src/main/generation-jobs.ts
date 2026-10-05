import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type { WorkbenchDB, Change } from './storage/workbench-db'
import type { AssetStore } from './storage/assets-v2'
import type { ApiConfigurations } from './storage/api-configurations'
import type { MusicRegistry } from './providers/music-registry'
import type { ImageProvider } from '../shared/types'
import type { GenerationRequest, GenerationSelection } from '../shared/workbench-types'
import type { MusicBinding, ProviderMusicTask } from '../shared/music-types'
import { generationSelectionSchema, imageInput, musicInput, newAssetName, submissionIssue } from '../shared/workbench-schemas'
import { AppError, safeError } from './providers/http'
import { matchMusicResults } from './music-results'
import { saveGeneratedAudio } from './generated-audio'
import { downloadImage } from './downloads'
import { requireTools } from './video/ffmpeg'

const now = () => new Date().toISOString()
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
  const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish()
})
interface Dependencies {
  db: WorkbenchDB; assets: AssetStore; apis: ApiConfigurations; registry: MusicRegistry; images: ImageProvider
  saveAudio?: typeof saveGeneratedAudio; saveImage?: typeof downloadImage; prepare?: () => Promise<void>; pollMs?: number
  onError?: (message: string) => void
}
/** A single confirmed queue, immutable per-entry requests, never a repeated-count generator. */
export class GenerationQueue {
  private readonly queue = new Set<string>()
  private active?: { id: string; controller: AbortController }
  private worker?: Promise<void>
  private closing = false
  private imageResponses = new Map<string, { url: string; model: string }>()
  constructor(private readonly deps: Dependencies) { }
  get busy(): boolean { return Boolean(this.active || this.queue.size) }
  async idle(): Promise<void> { while (this.worker) await this.worker }
  async shutdown(): Promise<void> { this.closing = true; this.queue.clear(); this.active?.controller.abort(); await this.idle() }
  async recover(): Promise<void> {
    const changes: Change[] = []
    for (const request of this.deps.db.list('requests')) {
      if (!['pending', 'submitting', 'running', 'saving'].includes(request.status)) continue
      const prior = request.status
      request.status = request.taskId || prior === 'pending' || prior === 'saving' ? 'paused' : 'unknown'
      request.recoverable = Boolean(request.taskId || request.outputs?.length)
      request.detail = request.status === 'unknown' ? '上次提交未取得任务 ID；请先核对厂商队列，不会自动重发。' : '上次执行已暂停，保留原请求；未提交条目须重新确认。'
      request.updatedAt = now(); changes.push({ table: 'requests', id: request.id, value: request })
    }
    await this.deps.db.commit(changes)
  }
  private checkSelection(value: GenerationSelection): void {
    const project = this.deps.db.get('generation', value.projectId)
    if (project.deletedAt) throw new AppError('生成项目已删除')
    if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw new AppError('同一条目不能重复提交')
    for (const item of value.entries) {
      const entry = this.deps.db.get('entries', item.id)
      if (entry.projectId !== value.projectId || entry.deletedAt || !project.entryIds.includes(entry.id)) throw new AppError('条目不属于当前生成项目')
      if (entry.revision !== item.revision) throw new AppError('确认后的条目已有修改，请重新核对后提交')
      const issue = submissionIssue(entry.kind, entry.draft); if (issue) throw new AppError(issue)
      const config = this.deps.apis.get(entry.draft.provider!)
      if (config.kind !== entry.kind) throw new AppError('API 用途不适用于条目类型')
      if (entry.requestId) {
        const request = this.deps.db.get('requests', entry.requestId)
        if (request.status !== 'paused' || request.submittedAt || request.taskId || request.outputs?.length) throw new AppError('条目已提交；可恢复原请求或复制新条目，不会重复创建')
      }
      this.deps.apis.connection(this.deps.apis.binding(entry.draft.provider!))
    }
  }
  async submit(input: GenerationSelection): Promise<void> {
    if (this.closing) throw new AppError('软件正在关闭')
    const value = generationSelectionSchema.parse(input), db = this.deps.db
    if (db.has('submissions', value.submissionId)) {
      const previous = db.get('submissions', value.submissionId)
      if (previous.projectId !== value.projectId || JSON.stringify(previous.entries.map(({ id, revision }) => ({ id, revision }))) !== JSON.stringify(value.entries)) throw new AppError('提交标识对应不同条目，不会覆盖原批次')
      return
    }
    this.checkSelection(value)
    // Tool preflight happens before any paid POST, not after the first response.
    if (value.entries.some(item => db.get('entries', item.id).kind === 'audio')) await this.prepare()
    const requestIds: string[] = []
    await db.transact(() => {
      if (db.has('submissions', value.submissionId)) return []
      this.checkSelection(value)
      const changes: Change[] = [], stamp = now()
      const items = value.entries.map(item => {
        const entry = db.get('entries', item.id), requestId = entry.requestId ?? randomUUID()
        const request: GenerationRequest = entry.requestId ? db.get('requests', requestId) : {
          version: 1, id: requestId, entryId: entry.id, projectId: value.projectId, submissionId: value.submissionId, kind: entry.kind,
          createdAt: stamp, updatedAt: stamp, snapshot: structuredClone(entry.draft), binding: this.deps.apis.binding(entry.draft.provider!), status: 'pending', assetIds: []
        }
        request.submissionId = value.submissionId // Reconfirmed, never-submitted requests now share this confirmation's failure boundary.
        request.status = 'pending'; request.updatedAt = stamp; request.error = undefined; request.detail = '等待串行提交（不会重复创建）'
        entry.requestId = requestId; entry.updatedAt = stamp
        requestIds.push(requestId)
        changes.push({ table: 'requests', id: requestId, value: request }, { table: 'entries', id: entry.id, value: entry })
        return { ...item, requestId }
      })
      changes.push({ table: 'submissions', id: value.submissionId, value: { version: 1, id: value.submissionId, projectId: value.projectId, createdAt: stamp, entries: items } })
      return changes
    })
    for (const id of requestIds) this.queue.add(id)
    this.pump()
  }
  async stop(projectId: string): Promise<void> {
    await this.deps.db.transact(() => this.deps.db.list('requests').filter(request => request.projectId === projectId && ['pending', 'paused'].includes(request.status) && !request.taskId && !request.outputs?.length).map(request => {
      this.queue.delete(request.id)
      return { table: 'requests', id: request.id, value: { ...request, status: 'cancelled', updatedAt: now(), detail: '未提交请求已停止，已受理任务不受影响。' } }
    }))
  }
  async resume(id: string): Promise<void> {
    if (this.closing) throw new AppError('软件正在关闭')
    const request = this.deps.db.get('requests', id)
    if (this.active?.id === id || this.queue.has(id)) return
    if (!['failed', 'paused', 'unknown'].includes(request.status) || (!request.taskId && !request.outputs?.length)) throw new AppError('此条目不能恢复查询；未提交条目请重新统一确认，没有任务 ID 的未知请求须先核对。')
    this.deps.apis.connection(request.binding)
    if (request.kind === 'audio') await this.prepare()
    await this.change(id, { status: 'paused', detail: '等待恢复原请求，不创建新任务。', error: undefined })
    this.queue.add(id); this.pump()
  }
  async abandon(id: string): Promise<void> {
    if (this.active?.id === id || this.queue.has(id)) throw new AppError('请等待当前任务结束或先停止未提交任务')
    await this.deps.db.update('requests', id, request => {
      if (!['unknown', 'failed', 'paused', 'cancelled'].includes(request.status)) throw new AppError('只能明确结束暂停、失败或未知请求的追踪')
      request.status = 'abandoned'; request.recoverable = false; request.updatedAt = now()
      request.detail = '用户已结束追踪；不代表服务端任务已取消，不会自动重发，已保存素材保留。'
    })
  }
  private async prepare(): Promise<void> {
    if (this.deps.prepare) await this.deps.prepare()
    else await requireTools(this.deps.db.get('settings', 'current').ffmpegPath)
  }
  private change(id: string, patch: Partial<GenerationRequest>) {
    return this.deps.db.update('requests', id, request => { Object.assign(request, patch, { updatedAt: now() }) })
  }
  private pump(): void {
    if (this.worker || this.closing) return
    this.worker = (async () => {
      while (!this.closing && this.queue.size) {
        const id = this.queue.values().next().value!; this.queue.delete(id)
        const request = this.deps.db.get('requests', id)
        if (!['pending', 'paused'].includes(request.status)) continue
        const controller = new AbortController(); this.active = { id, controller }
        try { await this.process(request, controller.signal) }
        catch (error) { this.deps.onError?.(`请求记录保存失败：${safeError(error)}。请保留数据并重启核对，不能直接再次生成。`) }
        finally { this.active = undefined }
      }
    })().finally(() => { this.worker = undefined; if (this.queue.size && !this.closing) this.pump() })
  }
  private async process(request: GenerationRequest, signal: AbortSignal): Promise<void> {
    let creating = false
    try {
      if (request.status === 'pending') {
        const connection = this.deps.apis.connection(request.binding, signal)
        if (request.kind === 'audio') await this.deps.registry.get(request.binding.provider as MusicBinding['provider']).preflight?.(musicInput(request.snapshot), connection)
        if (signal.aborted) return
        const updated = await this.deps.db.update('requests', request.id, current => {
          if (current.status !== 'pending') return
          current.status = 'submitting'; current.updatedAt = now(); current.submittedAt = current.updatedAt; current.detail = '正在提交一次请求'
        })
        if (updated.status !== 'submitting') return
        creating = true
      }
      if (request.kind === 'audio') await this.music(request, signal, creating)
      else await this.image(request, signal, creating)
    } catch (error) {
      const current = this.deps.db.get('requests', request.id)
      if (this.closing || signal.aborted) {
        await this.change(request.id, { status: creating && !current.taskId && !current.outputs?.length ? 'unknown' : 'paused', recoverable: Boolean(current.taskId || current.outputs?.length), detail: '本机等待已停止，原任务保留；服务端可能仍在处理。' })
        return
      }
      const uncertain = creating && !current.taskId && !current.outputs?.length && (error instanceof AppError ? error.uncertain : true)
      await this.change(request.id, { status: uncertain ? 'unknown' : 'failed', recoverable: Boolean(current.taskId || current.outputs?.length), error: safeError(error).slice(0, 4000), detail: current.assetIds.length ? `已保存 ${current.assetIds.length} 个结果；只补缺失结果，不重新生成。` : '未自动重发，已保存文件保留。' })
      // Pause only this confirmed submission, not unrelated projects/providers already queued.
      await this.deps.db.transact(() => this.deps.db.list('requests').filter(next => next.submissionId === request.submissionId && next.status === 'pending').map(next => {
        this.queue.delete(next.id); return { table: 'requests', id: next.id, value: { ...next, status: 'paused', updatedAt: now(), detail: '本提交出现错误，后续请求已暂停，请核对后继续。' } }
      }))
    }
  }
  private async storage(request: GenerationRequest): Promise<{ rootId: string; directory: string }> {
    const rootId = request.storageRootId ?? await this.deps.assets.managedRootId()
    if (!request.storageRootId) await this.change(request.id, { storageRootId: rootId })
    return { rootId, directory: await this.deps.assets.rootDirectory(rootId) }
  }
  private async music(request: GenerationRequest, signal: AbortSignal, creating: boolean): Promise<void> {
    const binding = request.binding as MusicBinding, adapter = this.deps.registry.get(binding.provider), input = musicInput(request.snapshot)
    let task: ProviderMusicTask
    const connection = () => this.deps.apis.connection(binding, signal)
    if (creating) {
      task = await adapter.create(input, connection())
      await this.change(request.id, { taskId: task.id, actualModel: task.model, recoverable: true })
    } else {
      if (!request.taskId) throw new AppError('缺少原任务 ID，不会重新提交音乐')
      task = await adapter.query(input, request.taskId, connection())
    }
    const known = this.deps.db.get('requests', request.id).taskId!
    const deadline = Date.now() + (binding.provider === 'acestep' ? this.deps.apis.get('acestep').local!.waitMinutes : 30) * 60000
    while (!signal.aborted) {
      if (task.id !== known) throw new AppError('查询结果不是原任务，已停止接收')
      if (['failed', 'timeouted', 'cancelled'].includes(task.status)) {
        await this.change(request.id, { status: 'failed', recoverable: false, error: '服务商报告生成失败；请核对额度、模型或本地推理状态。未重新提交。' })
        return
      }
      if (task.status === 'succeeded') break
      if (Date.now() >= deadline) throw new AppError('等待时间已到，仅暂停本机查询；原任务 ID 保留，不会重新生成。')
      await this.change(request.id, { status: 'running', detail: task.detail ?? (task.status === 'queued' ? '服务端排队中' : '服务端生成中（无可靠百分比）') })
      await sleep(this.deps.pollMs ?? 3000, signal)
      if (signal.aborted) return
      task = await adapter.query(input, known, connection())
    }
    if (signal.aborted) return
    const current = this.deps.db.get('requests', request.id), results = matchMusicResults(binding, task.choices ?? [], current.outputs, [], request.id)
    await this.change(request.id, { outputs: results.map(result => result.output), actualModel: task.model ?? current.actualModel, status: 'saving', detail: '下载、校验并登记所有返回结果' })
    const storage = await this.storage(current), errors: string[] = []
    for (const { output, choice } of results) {
      if (signal.aborted) return
      const savedRequest = this.deps.db.get('requests', request.id)
      if (savedRequest.outputs?.find(item => item.id === output.id)?.status === 'saved') continue
      try {
        const media = await (this.deps.saveAudio ?? saveGeneratedAudio)({ directory: storage.directory, assetId: output.assetId, url: choice.url,
          ...(binding.provider === 'acestep' ? { connection: connection() } : {}), signal, getFFmpegPath: () => this.deps.db.get('settings', 'current').ffmpegPath })
        const all = await this.deps.assets.all(), project = this.deps.db.get('generation', request.projectId)
        const asset = await this.deps.assets.register({ id: output.assetId, kind: 'audio', name: newAssetName('audio', all.map(a => a.name), request.snapshot.title, choice.title), createdAt: request.createdAt,
          origin: { type: 'generation', name: project.name, projectId: project.id, entryId: request.entryId, requestId: request.id, provider: binding.provider, model: task.model ?? request.snapshot.model, prompt: request.snapshot.prompt },
          rootId: storage.rootId, fileName: media.fileName, relatedFiles: [`.generated-audio/${output.assetId}/manifest.json`, ...(media.originalFileName ? [media.originalFileName] : [])], metadata: { durationSeconds: media.durationMs / 1000 } })
        await this.deps.db.update('requests', request.id, row => {
          Object.assign(row.outputs!.find(item => item.id === output.id)!, { status: 'saved', libraryAssetId: asset.id })
          if (!row.assetIds.includes(asset.id)) row.assetIds.push(asset.id)
          row.updatedAt = now()
        })
      } catch (error) { errors.push(safeError(error)) }
    }
    if (errors.length) throw new AppError(`部分结果未保存：${errors[0]}`)
    await this.change(request.id, { status: 'succeeded', recoverable: false, error: undefined, detail: `请求完成，返回 ${results.length} 个结果，已全部保存/登记。` })
  }
  private async image(request: GenerationRequest, signal: AbortSignal, creating: boolean): Promise<void> {
    if (request.binding.provider !== 'siliconflow') throw new AppError('历史图片服务仅保留记录，不会自动改为其他服务生成')
    const storage = await this.storage(request)
    let current = this.deps.db.get('requests', request.id)
    if (creating) {
      const connection = this.deps.apis.connection(request.binding, signal)
      const result = await this.deps.images.generate(imageInput(request.snapshot), connection.key!, signal)
      this.imageResponses.set(request.id, result)
      const outputId = randomUUID()
      await this.change(request.id, { status: 'saving', actualModel: result.model, outputs: [{ id: randomUUID(), assetId: outputId, index: 0, locator: '0'.repeat(64), status: 'pending' }], detail: '图片已返回，正在保存原始字节' })
      current = this.deps.db.get('requests', request.id)
    }
    const output = current.outputs?.[0]
    if (!output) throw new AppError('图片请求没有可恢复的本地结果；请核对服务商，不能自动重新生成')
    let fileName: string | undefined
    for (const suffix of ['png', 'jpg', 'webp']) {
      const candidate = `images/${output.assetId}.${suffix}`
      try { await access(path.join(storage.directory, candidate)); fileName = candidate; break } catch { /* Only exact registered candidate names. */ }
    }
    if (!fileName) {
      const result = this.imageResponses.get(request.id)
      if (!result) throw new AppError('图片原始响应已失效且未保存文件；不能安全重新提交。请在原服务核对或手动导入。')
      fileName = (await (this.deps.saveImage ?? downloadImage)(result.url, storage.directory, output.assetId, undefined, signal)).fileName
    }
    const all = await this.deps.assets.all(), project = this.deps.db.get('generation', request.projectId)
    const asset = await this.deps.assets.register({ id: output.assetId, kind: 'image', name: newAssetName('image', all.map(a => a.name), request.snapshot.title), createdAt: request.createdAt,
      origin: { type: 'generation', name: project.name, projectId: project.id, entryId: request.entryId, requestId: request.id, provider: 'siliconflow', model: current.actualModel ?? request.snapshot.model, prompt: request.snapshot.prompt }, rootId: storage.rootId, fileName })
    await this.change(request.id, { status: 'succeeded', assetIds: [asset.id], outputs: [{ ...output, libraryAssetId: asset.id, status: 'saved' }], error: undefined, recoverable: false, detail: '图片原件已保存并入库' })
    this.imageResponses.delete(request.id)
  }
}
