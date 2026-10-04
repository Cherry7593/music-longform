import { mkdir, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { BatchPlan, VideoBatch } from '../../shared/library-types'
import { videoBatchSchema } from '../../shared/batch-schemas'
import { idSchema } from '../../shared/schemas'
import { validateGroups } from '../../shared/batch-planner'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { managedDirectory } from './managed'
import { existingAssetPath } from './paths'

const indexSchema = z.object({ version: z.literal(1), ids: z.array(idSchema).max(10000).refine(ids => new Set(ids).size === ids.length) }).strict()
export class VideoBatchStore {
  private readonly queue = new SerialQueue()
  private readonly entries = new Map<string, VideoBatch>()
  private readonly directory: string
  private ready = false
  onChanged?: (batch: VideoBatch) => void
  constructor(dataDir: string, private readonly outputRoot: () => string) { this.directory = path.join(dataDir, 'video-batches') }
  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.ready) return
      await managedDirectory(this.directory, true)
      let indexed: string[] = []
      const indexPath = path.join(this.directory, 'index.json')
      try { indexed = indexSchema.parse(await readJson(indexPath, 4 * 1024 * 1024)).ids } catch (error) {
        if (!isMissing(error)) throw new AppError('批次索引损坏，原文件未覆盖，请先备份并修复')
      }
      const found = (await readdir(this.directory)).filter(name => name !== 'index.json' && name.endsWith('.json'))
      if (found.length > 10000) throw new AppError('批次记录数量超限')
      for (const name of found) {
        const id = name.slice(0, -5)
        if (!idSchema.safeParse(id).success) throw new AppError('批次记录文件名不正确，原数据保留')
        let batch: VideoBatch
        try { batch = videoBatchSchema.parse(await readJson(path.join(this.directory, name), 8 * 1024 * 1024)) } catch { throw new AppError('批次记录损坏，原数据保留') }
        if (batch.id !== id || !path.isAbsolute(batch.directory) || /^[\\/]{2}/.test(batch.directory)
          || !path.basename(batch.directory).endsWith(`-${id}`) || validateGroups(batch.plan.request, batch.plan.assets, batch.plan.groups).issues.length) throw new AppError('批次快照不正确，原数据保留')
        this.entries.set(id, batch)
      }
      if (indexed.some(id => !this.entries.has(id))) throw new AppError('部分批次详情缺失，索引未覆盖')
      // Details are authoritative after a detail-then-index crash; recover orphan details, never drop them.
      await atomicJson(indexPath, { version: 1, ids: [...this.entries.keys()] }, 4 * 1024 * 1024)
      this.ready = true
    })
  }
  private current(id: string): VideoBatch {
    if (!this.ready) throw new AppError('批次存储尚未初始化')
    if (!idSchema.safeParse(id).success || !this.entries.has(id)) throw new AppError('没有找到这个批次')
    return this.entries.get(id)!
  }
  async get(id: string): Promise<VideoBatch> { return structuredClone(this.current(id)) }
  async all(): Promise<VideoBatch[]> {
    if (!this.ready) throw new AppError('批次存储尚未初始化')
    return structuredClone([...this.entries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }
  private notify(batch: VideoBatch): void { try { this.onChanged?.(structuredClone(batch)) } catch { /* Committed */ } }
  async create(plan: BatchPlan): Promise<VideoBatch> {
    return this.queue.run(async () => {
      if (!this.ready) throw new AppError('批次存储尚未初始化')
      const previous = [...this.entries.values()].find(batch => batch.planId === plan.id)
      if (previous) return structuredClone(previous)
      if (this.entries.size >= 10000) throw new AppError('批次数量已达上限')
      if (plan.issues.length || validateGroups(plan.request, plan.assets, plan.groups).issues.length) throw new AppError('规划未全部达标，不能开始合成')
      const id = randomUUID()
      const safeName = plan.request.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 40) || '批次'
      const parent = await managedDirectory(path.join(this.outputRoot(), '批量视频'), true)
      const directory = path.join(parent, `${safeName}-${id}`)
      await mkdir(directory)
      const now = new Date().toISOString()
      const batch: VideoBatch = videoBatchSchema.parse({ version: 1, id, planId: plan.id, name: plan.request.name, createdAt: now, updatedAt: now,
        directory, state: 'running', plan: structuredClone(plan), jobs: plan.groups.map((group, index) => ({ id: randomUUID(), index, group: structuredClone(group), status: 'pending' })) })
      await atomicJson(path.join(this.directory, `${id}.json`), batch, 8 * 1024 * 1024)
      this.entries.set(id, batch)
      await atomicJson(path.join(this.directory, 'index.json'), { version: 1, ids: [...this.entries.keys()] }, 4 * 1024 * 1024)
      this.notify(batch)
      return structuredClone(batch)
    })
  }
  async mutate(id: string, update: (batch: VideoBatch) => void): Promise<VideoBatch> {
    return this.queue.run(async () => {
      const before = this.current(id)
      const next = structuredClone(before)
      update(next)
      if (next.id !== before.id || next.directory !== before.directory || next.createdAt !== before.createdAt || next.planId !== before.planId
        || JSON.stringify(next.plan) !== JSON.stringify(before.plan) || next.jobs.some((job, i) => job.id !== before.jobs[i]?.id)) throw new AppError('不能更改已提交批次的快照')
      next.updatedAt = new Date(Math.max(Date.now(), Date.parse(before.updatedAt) + 1)).toISOString()
      const parsed = videoBatchSchema.parse(next)
      await atomicJson(path.join(this.directory, `${id}.json`), parsed, 8 * 1024 * 1024)
      this.entries.set(id, parsed); this.notify(parsed)
      return structuredClone(parsed)
    })
  }
  async pathForAsset(id: string, jobId: string): Promise<string> {
    const batch = this.current(id)
    const job = batch.jobs.find(j => j.id === jobId && j.status === 'succeeded')
    if (!job?.fileName) throw new AppError('这条视频尚未成功导出')
    await managedDirectory(batch.directory)
    return existingAssetPath(batch.directory, 'video', job.id, job.fileName)
  }
}
