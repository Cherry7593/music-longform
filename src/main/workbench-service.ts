import path from 'node:path'
import { atomicJson, SerialQueue } from './storage/atomic'
import { WorkbenchDB } from './storage/workbench-db'
import { GenerationProjects, CompositionProjects, requestProtected } from './storage/workbench-projects'
import { ApiConfigurations } from './storage/api-configurations'
import type { AssetStore } from './storage/assets-v2'
import type { SecretStore } from './storage/secrets'
import type { MusicRegistry } from './providers/music-registry'
import type { ImageProvider } from '../shared/types'
import type { WorkbenchSettings, WorkbenchSnapshot, DeletionImpact } from '../shared/workbench-types'
import { settingsUpdateSchema } from '../shared/workbench-schemas'
import { GenerationQueue } from './generation-jobs'
import { CompositionQueue } from './video/composition-queue'
import { ResourcePool } from './video/resource-pool'
import { PublicationStore } from './storage/publications-v2'
import { DiagnosticStore } from './storage/diagnostics'
import { AppError } from './providers/http'
import type { saveGeneratedAudio } from './generated-audio'
import type { downloadImage } from './downloads'

export interface WorkbenchDependencies {
  dataDir: string; db: WorkbenchDB; assets: AssetStore; secrets: SecretStore; registry: MusicRegistry; images: ImageProvider
  testMode: boolean; warnings?: string[]; saveAudio?: typeof saveGeneratedAudio; saveImage?: typeof downloadImage; pollMs?: number
}
export class WorkbenchService {
  readonly generationProjects: GenerationProjects
  readonly compositionProjects: CompositionProjects
  readonly apis: ApiConfigurations
  readonly generation: GenerationQueue
  readonly composition: CompositionQueue
  readonly publications: PublicationStore
  readonly diagnostics: DiagnosticStore
  readonly pool: ResourcePool
  readonly control = new SerialQueue()
  private operations = new Set<Promise<unknown>>()
  private closing = false
  warnings: string[]
  onChanged?: () => void
  constructor(readonly deps: WorkbenchDependencies) {
    this.warnings = deps.warnings ?? []
    this.generationProjects = new GenerationProjects(deps.db); this.compositionProjects = new CompositionProjects(deps.db)
    this.apis = new ApiConfigurations(deps.db, deps.secrets, deps.registry, deps.images)
    this.publications = new PublicationStore(deps.dataDir, deps.assets); this.diagnostics = new DiagnosticStore(deps.dataDir)
    this.pool = new ResourcePool(() => this.settings().render)
    const onError = (message: string) => { if (!this.warnings.includes(message)) this.warnings.push(message); this.changed() }
    this.generation = new GenerationQueue({ ...deps, apis: this.apis, onError })
    this.composition = new CompositionQueue({ db: deps.db, assets: deps.assets, diagnostics: this.diagnostics, publications: this.publications, pool: this.pool, onError })
  }
  async init(): Promise<void> {
    await this.apis.init(); await this.publications.init(); await this.diagnostics.init()
    await this.publications.recover(); await this.generation.recover(); await this.composition.recover()
    this.deps.db.onChanged = () => this.changed(); this.deps.assets.onChanged = () => this.changed()
  }
  changed(): void { try { this.onChanged?.() } catch { /* UI cannot undo a commit. */ } }
  settings(): WorkbenchSettings { return this.deps.db.get('settings', 'current') }
  get busy(): boolean { return this.generation.busy || this.composition.busy || this.operations.size > 0 }
  async shutdown(): Promise<void> {
    this.closing = true
    await Promise.all([this.generation.shutdown(), this.composition.shutdown()])
    while (this.operations.size) await Promise.allSettled([...this.operations])
  }
  track<T>(action: () => Promise<T>, serial = false): Promise<T> {
    if (this.closing) return Promise.reject(new AppError('软件正在关闭，未启动新操作'))
    const work = serial ? this.control.run(action) : action()
    this.operations.add(work); void work.finally(() => this.operations.delete(work)).catch(() => undefined); return work
  }
  async snapshot(): Promise<WorkbenchSnapshot> {
    const db = this.deps.db, generationProjects = db.list('generation').filter(project => !project.deletedAt), compositionProjects = db.list('composition').filter(project => !project.deletedAt)
    const visible = new Set(generationProjects.map(project => project.id))
    return { settings: this.settings(), encryptionAvailable: this.deps.secrets.isAvailable(), apis: this.apis.list(),
      generationProjects: generationProjects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), compositionProjects: compositionProjects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      entries: db.list('entries').filter(entry => !entry.deletedAt && visible.has(entry.projectId)), requests: db.list('requests').filter(request => visible.has(request.projectId)),
      batches: db.list('executions').filter(batch => compositionProjects.some(project => project.id === batch.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      assets: await this.deps.assets.all(this.composition.queuedIds()), warnings: [...new Set([...this.warnings, ...this.deps.assets.warnings, ...this.publications.warnings])], testMode: this.deps.testMode }
  }
  async updateSettings(input: unknown): Promise<WorkbenchSettings> {
    const patch = settingsUpdateSchema.parse(input)
    if (patch.lastGenerationId) this.generationProjects.get(patch.lastGenerationId)
    if (patch.lastCompositionId) this.compositionProjects.get(patch.lastCompositionId)
    const value = await this.deps.db.update('settings', 'current', settings => Object.assign(settings, patch))
    await atomicJson(path.join(this.deps.dataDir, 'settings.json'), value, 256 * 1024)
    this.pool.wake(); return value
  }
  async assetImpact(id: string): Promise<DeletionImpact> {
    const asset = await this.deps.assets.get(id), references: DeletionImpact['references'] = [], reasons: string[] = []
    const canonical = new Map<string, string>([[id, asset.id], [asset.id, asset.id]])
    const same = async (ids: string[]): Promise<boolean> => {
      for (const value of ids) {
        if (!canonical.has(value)) { try { canonical.set(value, (await this.deps.assets.get(value)).id) } catch { canonical.set(value, value) } }
        if (canonical.get(value) === asset.id) return true
      }
      return false
    }
    for (const project of this.deps.db.list('composition').filter(value => !value.deletedAt)) {
      if (await same([...project.draft.audioIds, ...project.draft.imageIds])) references.push({ id: project.id, kind: '合成草稿', name: project.name })
    }
    for (const request of this.deps.db.list('requests')) {
      const related = await same(request.assetIds) || asset.origins.some(origin => origin.requestId === request.id)
      if (related) {
        const project = this.deps.db.get('generation', request.projectId)
        if (!project.deletedAt) references.push({ id: request.id, kind: '生成条目', name: project.name })
        if (requestProtected(request)) reasons.push('素材仍属于待处理或可恢复生成请求，请先完成或明确结束追踪。')
      }
    }
    for (const batch of this.deps.db.list('executions')) for (const job of batch.jobs) {
      const publication = this.publications.get(job.id)
      const awaitingPublication = publication?.state === 'prepared' && await same([publication.assetId])
      if (await same([...job.group.audioIds, job.group.imageId, ...(job.videoAssetId ? [job.videoAssetId] : [])]) || job.id === asset.id || awaitingPublication) {
        if (awaitingPublication) reasons.push('此成片已准备发布，入库或使用对账尚未完成；请先恢复原任务完成对账，不能删除后重新渲染。')
        if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) reasons.push('素材被排队或执行的视频任务使用，请先取消相关任务并等待退出。')
        references.push({ id: job.id, kind: '视频执行记录', name: `${batch.name} / ${job.index + 1}` })
      }
    }
    if (this.deps.assets.isPinned(asset.id)) reasons.push('素材正在读取或发布，请等待当前操作完成。')
    const files = await this.deps.assets.deletionInfo(asset.id)
    return { id: asset.id, name: asset.name, blocked: reasons.length > 0, reasons: [...new Set(reasons)], references, ...files }
  }
  async deleteAsset(id: string): Promise<void> {
    const impact = await this.assetImpact(id)
    if (impact.blocked) throw new AppError(impact.reasons.join('；'))
    await this.deps.assets.delete(id)
    this.changed()
  }
}
