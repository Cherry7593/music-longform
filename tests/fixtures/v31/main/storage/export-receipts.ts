import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ExportReceipt } from '../../../../../src/shared/library-types'
import { idSchema } from '../../../../../src/shared/schemas'
import { AppError } from '../../../../../src/main/providers/http'
import { atomicJson, readJson, SerialQueue } from '../../../../../src/main/storage/atomic'
import { existingAssetPath } from '../../../../../src/main/storage/paths'
import { hashMedia, managedDirectory } from '../../../../../src/main/storage/managed'

const receiptSchema = z.object({
  version: z.literal(1), id: idSchema, ownerId: idSchema, kind: z.enum(['batch', 'project']), name: z.string().min(1).max(200),
  state: z.enum(['prepared', 'committed']), finishedAt: z.iso.datetime(), durationSeconds: z.number().finite().positive().max(21600.1),
  assetIds: z.array(idSchema).min(1).max(101).refine(ids => ids.length === new Set(ids).size),
  directory: z.string().min(1).max(2000), fileName: z.string().max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(32 * 1073741824)
}).strict().refine(r => path.isAbsolute(r.directory) && !/^[\\/]{2}/.test(r.directory) && r.fileName === `videos/${r.id}.mp4`)
export class ExportReceiptStore {
  private readonly directory: string
  private readonly records = new Map<string, ExportReceipt>()
  private readonly queue = new SerialQueue()
  private ready = false
  onChanged?: () => void
  warnings: string[] = []
  constructor(dataDir: string) { this.directory = path.join(dataDir, 'export-receipts') }
  async init(): Promise<void> {
    await managedDirectory(this.directory, true)
    const names = (await readdir(this.directory)).filter(n => n.endsWith('.json'))
    if (names.length > 100000) throw new AppError('成片回执数量超限')
    for (const name of names) {
      try {
        const record = receiptSchema.parse(await readJson(path.join(this.directory, name), 128 * 1024))
        if (name !== `${record.id}.json`) throw new Error('id')
        this.records.set(record.id, record)
      } catch { throw new AppError('成片使用回执损坏，原记录未覆盖') }
    }
    this.ready = true
  }
  all(): ExportReceipt[] { if (!this.ready) throw new AppError('使用回执尚未初始化'); return structuredClone([...this.records.values()]) }
  get(id: string): ExportReceipt | undefined { return structuredClone(this.records.get(id)) }
  async prepare(record: ExportReceipt): Promise<void> {
    await this.queue.run(async () => {
      if (!this.ready) throw new AppError('使用回执尚未初始化')
      const parsed = receiptSchema.parse(record)
      const prior = this.records.get(parsed.id)
      if (parsed.state !== 'prepared' || (prior && (prior.ownerId !== parsed.ownerId || prior.kind !== parsed.kind || prior.directory !== parsed.directory || JSON.stringify(prior.assetIds) !== JSON.stringify(parsed.assetIds)))) throw new AppError('成片使用回执与任务不一致')
      if (prior?.state === 'committed') throw new AppError('此成片已经成功发布，不会重复导出')
      await managedDirectory(parsed.directory)
      await atomicJson(path.join(this.directory, `${parsed.id}.json`), parsed, 128 * 1024)
      this.records.set(parsed.id, parsed)
    })
  }
  /** Content hash links a prepared receipt to its already-validated, atomically published output. */
  async reconcile(id: string): Promise<ExportReceipt | undefined> {
    return this.queue.run(async () => {
      const record = this.records.get(id)
      if (!record) return undefined
      if (record.state === 'committed') return structuredClone(record)
      await managedDirectory(record.directory)
      const { lstat } = await import('node:fs/promises')
      const file = path.join(record.directory, record.fileName)
      try { await lstat(file) } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
        throw new AppError('成片发布状态暂时无法核对，请检查存储权限')
      }
      const actual = await hashMedia(await existingAssetPath(record.directory, 'video', record.id, record.fileName))
      if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) throw new AppError('成片与发布回执指纹不符；已阻止覆盖和重复记账，请保留文件并检查')
      const committed: ExportReceipt = { ...record, state: 'committed' }
      await atomicJson(path.join(this.directory, `${id}.json`), committed, 128 * 1024)
      this.records.set(id, committed)
      try { this.onChanged?.() } catch { /* Commit already durable */ }
      return structuredClone(committed)
    })
  }
  async recover(): Promise<void> {
    this.warnings = []
    for (const receipt of this.all().filter(r => r.state === 'prepared')) {
      try { await this.reconcile(receipt.id) } catch (error) { this.warnings.push(error instanceof AppError ? error.message : '成片回执暂时无法恢复，原记录保留') }
    }
  }
}
