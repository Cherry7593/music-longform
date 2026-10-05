import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { managedDirectory } from './managed'
import { AppError } from '../providers/http'
import { generationProjectSchema, entrySchema, requestSchema, submissionSchema, compositionProjectSchema, executionBatchSchema, apiRecordSchema, workbenchSettingsSchema } from '../../shared/workbench-schemas'
import type { GenerationProject, GenerationEntry, GenerationRequest, GenerationSubmission, CompositionProject, ExecutionBatch, WorkbenchSettings } from '../../shared/workbench-types'

export type ApiRecord = z.infer<typeof apiRecordSchema>
export interface Tables {
  generation: GenerationProject; entries: GenerationEntry; requests: GenerationRequest; submissions: GenerationSubmission
  composition: CompositionProject; executions: ExecutionBatch; apis: ApiRecord; settings: WorkbenchSettings
}
export type Table = keyof Tables
export interface Change { table: Table; id: string; value: unknown }
const tables = ['generation', 'entries', 'requests', 'submissions', 'composition', 'executions', 'apis', 'settings'] as const
const schemas: Record<Table, z.ZodType> = { generation: generationProjectSchema, entries: entrySchema, requests: requestSchema, submissions: submissionSchema,
  composition: compositionProjectSchema, executions: executionBatchSchema, apis: apiRecordSchema, settings: workbenchSettingsSchema }
const recordKey = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const indexSchema = z.object({ version: z.literal(1), ids: z.array(recordKey).max(100000) }).strict()
const changeSchema = z.object({ table: z.enum(tables), id: recordKey, value: z.unknown() }).strict()
const transactionSchema = z.object({ version: z.literal(1), id: z.string().uuid(), changes: z.array(changeSchema).min(1).max(5000) }).strict()
const LIMIT = 32 * 1024 * 1024

/** Separate entity files, one durable redo transaction. No media or credentials are stored here. */
export class WorkbenchDB {
  readonly directory: string
  private data = new Map<Table, Map<string, unknown>>(tables.map(table => [table, new Map()]))
  private readonly queue = new SerialQueue()
  private ready = false
  onChanged?: () => void
  constructor(dataDir: string) { this.directory = path.join(dataDir, 'workbench') }
  private row(table: Table, id: string): string { return path.join(this.directory, table, `${recordKey.parse(id)}.json`) }
  private index(table: Table): string { return path.join(this.directory, table, 'index.json') }
  private get transaction(): string { return path.join(this.directory, 'transaction.json') }
  private validate(changes: Change[]): Change[] {
    return changes.map(change => {
      changeSchema.parse(change)
      if (change.id === 'index') throw new AppError('记录标识不正确')
      const value = schemas[change.table].parse(change.value) as Record<string, unknown>
      if (change.table !== 'settings' && (change.table === 'apis' ? value.provider : value.id) !== change.id) throw new AppError('记录与索引标识不一致')
      if (change.table === 'settings' && change.id !== 'current') throw new AppError('设置标识不正确')
      return { ...change, value }
    })
  }
  private async apply(changes: Change[]): Promise<void> {
    const next = new Map<Table, Map<string, unknown>>([...this.data].map(([table, rows]) => [table, new Map(rows)]))
    for (const change of this.validate(changes)) {
      await atomicJson(this.row(change.table, change.id), change.value, LIMIT)
      next.get(change.table)!.set(change.id, change.value)
    }
    for (const table of new Set(changes.map(change => change.table))) await atomicJson(this.index(table), { version: 1, ids: [...next.get(table)!.keys()] }, LIMIT)
    this.data = next
  }
  private async recover(): Promise<void> {
    let raw: unknown
    try { raw = await readJson(this.transaction, LIMIT) } catch (error) { if (isMissing(error)) return; throw new AppError('工作区提交日志不可读取；原数据保留，请检查磁盘。') }
    const transaction = transactionSchema.safeParse(raw)
    if (!transaction.success) throw new AppError('工作区提交日志损坏，未覆盖原记录。')
    await this.apply(this.validate(transaction.data.changes))
    await unlink(this.transaction)
  }
  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.ready) return
      await managedDirectory(this.directory, true)
      for (const table of tables) {
        await mkdir(path.join(this.directory, table), { recursive: true })
        const files = (await readdir(path.join(this.directory, table))).filter(name => name.endsWith('.json') && name !== 'index.json')
        if (files.length > 100000) throw new AppError('工作区记录数量超限')
        const indexed: string[] = []
        try { indexed.push(...indexSchema.parse(await readJson(this.index(table), LIMIT)).ids) }
        catch (error) { if (!isMissing(error)) throw new AppError(`工作区 ${table} 索引损坏，未替换为空列表。`) }
        for (const name of files) {
          const id = name.slice(0, -5)
          try {
            const value = this.validate([{ table, id, value: await readJson(this.row(table, id), LIMIT) }])[0].value
            this.data.get(table)!.set(id, value)
          } catch { throw new AppError(`工作区 ${table} 记录 ${id} 不可读取，原记录未覆盖。`) }
        }
        // Interrupted transactions may restore a missing row; verify indexes after recovery below.
        for (const id of indexed) if (!this.data.get(table)!.has(id)) {
          let pending: unknown; try { pending = await readJson(this.transaction, LIMIT) } catch { /* diagnosed below */ }
          if (!pending) throw new AppError(`工作区 ${table} 详情缺失，索引未覆盖。`)
        }
      }
      await this.recover()
      for (const table of tables) {
        let indexed: string[] = []
        try { indexed = indexSchema.parse(await readJson(this.index(table), LIMIT)).ids } catch (error) { if (!isMissing(error)) throw error }
        if (indexed.some(id => !this.data.get(table)!.has(id))) throw new AppError('提交恢复后仍有详情缺失，未覆盖索引。')
        await atomicJson(this.index(table), { version: 1, ids: [...this.data.get(table)!.keys()] }, LIMIT)
      }
      this.ready = true
    })
  }
  list<K extends Table>(table: K): Tables[K][] { if (!this.ready) throw new AppError('工作区尚未初始化'); return structuredClone([...this.data.get(table)!.values()]) as Tables[K][] }
  get<K extends Table>(table: K, id: string): Tables[K] {
    if (!this.ready) throw new AppError('工作区尚未初始化')
    recordKey.parse(id)
    const value = this.data.get(table)!.get(id)
    if (!value) throw new AppError('没有找到此记录，请刷新工作区')
    return structuredClone(value) as Tables[K]
  }
  async transact(prepare: () => Change[]): Promise<void> {
    await this.queue.run(async () => {
      if (!this.ready) throw new AppError('工作区尚未初始化')
      await this.recover()
      const changes = this.validate(prepare())
      if (!changes.length) return
      const transaction = transactionSchema.parse({ version: 1, id: randomUUID(), changes })
      await atomicJson(this.transaction, transaction, LIMIT)
      await this.apply(changes)
      await unlink(this.transaction)
      try { this.onChanged?.() } catch { /* Committed. */ }
    })
  }
  async update<K extends Table>(table: K, id: string, change: (value: Tables[K]) => void): Promise<Tables[K]> {
    await this.transact(() => { const value = this.get(table, id); change(value); return [{ table, id, value }] })
    return this.get(table, id)
  }

  has(table: Table, id: string): boolean { return this.data.get(table)!.has(id) }
  async commit(changes: Change[]): Promise<void> {
    if (!changes.length) return
    await this.queue.run(async () => {
      if (!this.ready) throw new AppError('工作区尚未初始化')
      await this.recover()
      const validated = this.validate(changes)
      const transaction = transactionSchema.parse({ version: 1, id: randomUUID(), changes: validated })
      await atomicJson(this.transaction, transaction, LIMIT)
      await this.apply(validated)
      await unlink(this.transaction)
      try { this.onChanged?.() } catch { /* Already committed. */ }
    })
  }
  async put<K extends Table>(table: K, id: string, value: Tables[K]): Promise<void> { await this.commit([{ table, id, value }]) }
}
