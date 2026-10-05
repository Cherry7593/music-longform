import { randomUUID } from 'node:crypto'
import { AppError } from '../providers/http'
import { WorkbenchDB, type Change } from './workbench-db'
import { alternativesSchema, compositionDraftSchema, entryDraftSchema, initialComposition, initialEntry, nameSchema, newProjectName } from '../../shared/workbench-schemas'
import { GENERATION_ACTIVE, RENDER_RESERVED, type CompositionDraft, type CompositionProject, type DeletionImpact, type EntryDraft, type GenerationEntry, type GenerationKind, type GenerationProject, type GenerationRequest } from '../../shared/workbench-types'

const now = () => new Date().toISOString()
export function requestProtected(request: GenerationRequest): boolean {
  return GENERATION_ACTIVE.has(request.status) || request.status === 'paused' || request.status === 'unknown' || (request.status === 'failed' && Boolean(request.recoverable))
}
export class GenerationProjects {
  constructor(readonly db: WorkbenchDB) { }
  get(id: string): GenerationProject { const value = this.db.get('generation', id); if (value.deletedAt) throw new AppError('生成项目已删除'); return value }
  async create(): Promise<GenerationProject> {
    const id = randomUUID(), stamp = now()
    await this.db.transact(() => [{ table: 'generation', id, value: { version: 1, id, name: newProjectName(this.db.list('generation').map(p => p.name)), createdAt: stamp, updatedAt: stamp, page: 'audio', entryIds: [] } }])
    return this.get(id)
  }
  async update(id: string, patch: { name?: string; page?: GenerationKind }): Promise<GenerationProject> {
    this.get(id)
    return this.db.update('generation', id, project => {
      if (project.deletedAt) throw new AppError('生成项目已删除')
      if (patch.name !== undefined) project.name = nameSchema.parse(patch.name)
      if (patch.page !== undefined) project.page = patch.page
      project.updatedAt = now()
    })
  }
  impact(id: string): DeletionImpact {
    const project = this.get(id), requests = this.db.list('requests').filter(item => item.projectId === id && requestProtected(item))
    return { id, name: project.name, blocked: requests.length > 0, reasons: requests.length ? ['请先停止未提交任务；已受理、未知或可恢复的请求须恢复或明确结束追踪。项目删除不会取消厂商已受理的任务。'] : [],
      references: requests.map(item => ({ id: item.id, kind: '生成请求', name: item.snapshot.title || item.snapshot.prompt.slice(0, 50) })), externalOriginalsKept: true }
  }
  async delete(id: string): Promise<void> {
    await this.db.transact(() => {
      const impact = this.impact(id); if (impact.blocked) throw new AppError(impact.reasons[0])
      const project = this.get(id), stamp = now(); project.deletedAt = stamp; project.updatedAt = stamp
      const changes: Change[] = [{ table: 'generation', id, value: project }]
      return changes // Assets, request history and usage ledger are never erased.
    })
  }
  async add(projectId: string, kind: GenerationKind, copyId?: string): Promise<GenerationEntry> {
    const id = randomUUID(), stamp = now()
    await this.db.transact(() => {
      const project = this.get(projectId)
      if (project.entryIds.length >= 20000) throw new AppError('此项目条目数量已达上限，请新建项目')
      const copy = copyId ? this.db.get('entries', copyId) : undefined
      if (copy && (copy.projectId !== projectId || copy.kind !== kind || copy.deletedAt)) throw new AppError('不能从其他项目或类型复制条目')
      const provider = this.db.list('apis').find(config => !config.deletedAt && config.kind === kind)?.provider
      const entry: GenerationEntry = { version: 1, id, projectId, kind, createdAt: stamp, updatedAt: stamp, revision: 0,
        draft: copy ? structuredClone(copy.draft) : initialEntry(kind, provider), alternatives: copy ? structuredClone(copy.alternatives) : {} }
      project.entryIds.push(id); project.updatedAt = stamp; project.page = kind
      return [{ table: 'entries', id, value: entry }, { table: 'generation', id: projectId, value: project }]
    })
    return this.db.get('entries', id)
  }
  async updateEntry(id: string, revision: number, draft: EntryDraft, alternatives: GenerationEntry['alternatives']): Promise<GenerationEntry> {
    const input = entryDraftSchema.parse(draft), variants = alternativesSchema.parse(alternatives)
    await this.db.transact(() => {
      const entry = this.db.get('entries', id); const project = this.get(entry.projectId)
      if (entry.deletedAt || entry.requestId) throw new AppError('条目已提交或删除；修改请先复制为新条目')
      if (entry.revision !== revision) throw new AppError('条目已被更新，未覆盖新内容；请刷新后重新编辑')
      entry.draft = input; entry.alternatives = variants; entry.revision++; entry.updatedAt = now(); project.updatedAt = entry.updatedAt
      return [{ table: 'entries', id, value: entry }, { table: 'generation', id: project.id, value: project }]
    })
    return this.db.get('entries', id)
  }
  async deleteEntry(id: string): Promise<void> {
    await this.db.transact(() => {
      const entry = this.db.get('entries', id), project = this.get(entry.projectId)
      if (entry.requestId) throw new AppError('已提交条目保留任务记录，不能作为未提交草稿删除')
      entry.deletedAt = now(); project.entryIds = project.entryIds.filter(item => item !== id); project.updatedAt = now()
      return [{ table: 'entries', id, value: entry }, { table: 'generation', id: project.id, value: project }]
    })
  }
}
export class CompositionProjects {
  constructor(readonly db: WorkbenchDB) { }
  get(id: string): CompositionProject { const value = this.db.get('composition', id); if (value.deletedAt) throw new AppError('合成项目已删除'); return value }
  async create(): Promise<CompositionProject> {
    const id = randomUUID(), stamp = now()
    await this.db.transact(() => [{ table: 'composition', id, value: { version: 1, id, name: newProjectName(this.db.list('composition').map(p => p.name)), createdAt: stamp, updatedAt: stamp,
      revision: 0, draft: initialComposition(), batchIds: [] } }])
    return this.get(id)
  }
  async update(id: string, revision: number, patch: { name?: string; draft?: CompositionDraft }): Promise<CompositionProject> {
    return this.db.update('composition', id, project => {
      if (project.deletedAt) throw new AppError('合成项目已删除')
      if (project.revision !== revision) throw new AppError('合成草稿已经更新，未覆盖当前内容；请刷新后编辑')
      if (patch.name !== undefined) project.name = nameSchema.parse(patch.name)
      if (patch.draft !== undefined) project.draft = compositionDraftSchema.parse(patch.draft)
      project.revision++; project.updatedAt = now()
    })
  }
  impact(id: string): DeletionImpact {
    const project = this.get(id)
    const tasks = this.db.list('executions').filter(batch => batch.projectId === id).flatMap(batch => batch.jobs.filter(job => RENDER_RESERVED.has(job.status)).map(job => ({ id: job.id, kind: '视频任务', name: `${batch.name} / ${job.index + 1}` })))
    return { id, name: project.name, blocked: tasks.length > 0, reasons: tasks.length ? ['仍有排队或执行任务，请先取消本项目的未完成任务并等待安全退出。'] : [], references: tasks, externalOriginalsKept: true }
  }
  async delete(id: string): Promise<void> {
    await this.db.transact(() => {
      const impact = this.impact(id); if (impact.blocked) throw new AppError(impact.reasons[0])
      const value = this.get(id); value.deletedAt = now(); value.updatedAt = value.deletedAt
      return [{ table: 'composition', id, value }]
    })
  }
}
