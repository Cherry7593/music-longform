import { readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { idSchema } from '../../shared/schemas'
import type { UsageRecord } from '../../shared/workbench-types'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { hashMedia, managedDirectory } from './managed'
import type { AssetStore } from './assets-v2'

const schema = z.object({ version: z.literal(2), id: idSchema, batchId: idSchema, projectId: idSchema, state: z.enum(['prepared', 'committed']),
  assetId: idSchema, rootId: idSchema, fileName: z.string().max(250), name: z.string().min(1).max(500), projectName: z.string().max(500), finishedAt: z.iso.datetime(),
  durationSeconds: z.number().positive().max(21601), assetIds: z.array(idSchema).min(1).max(101), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(32 * 1024 ** 3)
}).strict().refine(value => value.fileName === `videos/${value.id}.mp4` && value.assetId === value.id, '发布路径与任务不匹配')
export type PublicationV2 = z.infer<typeof schema>
export class PublicationStore {
  private readonly records = new Map<string, PublicationV2>()
  private readonly queue = new SerialQueue()
  private readonly directory: string
  warnings: string[] = []
  constructor(dataDir: string, private readonly assets: AssetStore) { this.directory = path.join(dataDir, 'publications-v2') }
  async init(): Promise<void> {
    await managedDirectory(this.directory, true)
    const files = (await readdir(this.directory)).filter(name => name.endsWith('.json'))
    if (files.length > 100000) throw new AppError('发布回执数量超限')
    for (const file of files) {
      const record = schema.parse(await readJson(path.join(this.directory, file), 256 * 1024))
      if (file !== `${record.id}.json`) throw new AppError('发布回执标识不一致')
      this.records.set(record.id, record)
    }
  }
  get(id: string): PublicationV2 | undefined { idSchema.parse(id); return structuredClone(this.records.get(id)) }
  async prepare(value: PublicationV2): Promise<void> {
    await this.queue.run(async () => {
      const record = schema.parse(value), previous = this.records.get(record.id)
      if (previous?.state === 'committed') throw new AppError('此成片已经发布，不会重新合成')
      if (previous && (previous.projectId !== record.projectId || previous.batchId !== record.batchId || previous.rootId !== record.rootId || JSON.stringify(previous.assetIds) !== JSON.stringify(record.assetIds))) throw new AppError('发布回执身份与原任务不一致')
      await atomicJson(path.join(this.directory, `${record.id}.json`), record, 256 * 1024)
      this.records.set(record.id, record)
    })
  }
  async reconcile(id: string): Promise<PublicationV2 | undefined> {
    return this.queue.run(async () => {
      const record = this.records.get(id)
      if (!record) return undefined
      if (record.state === 'committed') return structuredClone(record)
      const directory = await this.assets.rootDirectory(record.rootId), file = path.join(directory, record.fileName)
      try { await lstat(file) } catch (error) { if (isMissing(error)) return undefined; throw error }
      const fingerprint = await hashMedia(file)
      if (fingerprint.sha256 !== record.sha256 || fingerprint.bytes !== record.bytes) throw new AppError('已发布文件与准备回执指纹不同，已阻止重复渲染和覆盖。请查看诊断。')
      const asset = await this.assets.register({ id: record.assetId, kind: 'video', name: record.name, createdAt: record.finishedAt, rootId: record.rootId, fileName: record.fileName,
        expectedSha256: record.sha256, metadata: { durationSeconds: record.durationSeconds, format: 'mp4', width: 1920, height: 1080 },
        origin: { type: 'composition', name: record.projectName, projectId: record.projectId, batchId: record.batchId, requestId: record.id } })
      const usage: UsageRecord = { version: 2, id: record.id, videoId: asset.id, projectId: record.projectId, name: record.name, finishedAt: record.finishedAt,
        durationSeconds: record.durationSeconds, assetIds: [...new Set(record.assetIds)], uncertainAssetIds: [] }
      await this.assets.recordUsage(usage)
      const committed: PublicationV2 = { ...record, state: 'committed' }
      await atomicJson(path.join(this.directory, `${record.id}.json`), committed, 256 * 1024)
      this.records.set(id, committed)
      return structuredClone(committed)
    })
  }
  async recover(): Promise<void> {
    this.warnings = []
    for (const record of this.records.values()) if (record.state === 'prepared') {
      try { await this.reconcile(record.id) } catch { this.warnings.push(`成片 ${record.name} 发布对账未完成，请检查文件及诊断，不能重新生成覆盖。`) }
    }
  }
}
