import { createHash, randomUUID } from 'node:crypto'
import { opendir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ImportResult } from '../../shared/library-types'
import type { AssetOrigin, MediaKind, UsageRecord, WorkbenchAsset } from '../../shared/workbench-types'
import { ensureLibraryDirectory, safeLibraryPath, stageImport, type MediaMetadata } from '../library/imports'
import { AssetValidator, fingerprintRaw, pathKey, readMetadata, safeAncestors, sameStamp, stamp } from '../library/assets-v4-media'
import { LIMITS, hashSchema, indexSchema, kindSchema, mediaFile, metadataSchema, nameSchema, originSchema, ownerFor, recordSchema,
  relatedFile, relativeSchema, rootSchema, timeSchema, usageSchema, uuid, type AssetRecord, type DeletionFile, type Evidence, type Location, type RootRecord } from '../library/assets-v4-schema'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, SerialQueue } from './atomic'
import { localLibraryPath } from './library-validation'

export interface AssetRegistration {
  id: string; kind: MediaKind; name: string; createdAt: string; origin: AssetOrigin; rootId: string; fileName: string
  relatedFiles?: string[]; expectedSha256?: string
  metadata?: { format?: string; durationSeconds?: number; width?: number; height?: number }
  allowMissing?: boolean; validated?: boolean
}
export interface AssetStoreOptions { dataDir: string; root: string; getFFmpegPath: () => string | undefined }
const registrationSchema = z.object({
  id: uuid, kind: kindSchema, name: nameSchema, createdAt: timeSchema, origin: originSchema, rootId: uuid, fileName: relativeSchema,
  relatedFiles: z.array(relativeSchema).max(16).optional(), expectedSha256: hashSchema.optional(), metadata: metadataSchema.partial().optional(),
  allowMissing: z.boolean().optional(), validated: z.boolean().optional()
}).strict().refine(value => mediaFile(value.fileName, value.kind) && (value.relatedFiles ?? []).every(file => relatedFile(file, ownerFor(value.id, value.fileName))), '素材格式或附属路径不安全')
const message = (error: unknown, fallback: string): string => error instanceof AppError ? error.message.slice(0, 2000) : fallback
const clone = <T>(value: T): T => structuredClone(value)
const now = (): string => new Date().toISOString()
function rootIdFor(directory: string): string {
  const hex = createHash('sha256').update(`assets-v2-root:${pathKey(directory)}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
function unique<T>(values: T[], key: (value: T) => string): T[] { return [...new Map(values.map(value => [key(value), value])).values()] }

/** Main-process only. No project lookup, legacy scan, renderer paths or cross-process writers. */
export class AssetStore {
  readonly warnings: string[] = []
  onChanged?: () => void
  private readonly directory: string
  private readonly queue = new SerialQueue()
  private readonly validator: AssetValidator
  private records = new Map<string, AssetRecord>()
  private roots = new Map<string, RootRecord>()
  private usages = new Map<string, UsageRecord>()
  private aliases = new Map<string, string>()
  private sizes = new Map<string, number>()
  private metadataBytes = 0
  private leases = new Map<string, Map<string, number>>()
  private deleting = new Set<string>()
  private aliasChanges = new Set<string>()
  private indexDirty = false
  private verifying = new Map<string, Promise<{ asset: WorkbenchAsset; path: string }>>()
  private activeMediaOperations = 0
  private configuringRoot = false
  private initialized = false
  private initialization?: Promise<void>
  private managedId = ''
  constructor(private readonly options: AssetStoreOptions) {
    if (!localLibraryPath(options.dataDir) || !localLibraryPath(options.root)) throw new AppError('资产存储目录必须为安全本地绝对路径。')
    this.directory = path.join(options.dataDir, 'assets-v2')
    this.validator = new AssetValidator(options.getFFmpegPath)
  }
  init(): Promise<void> { return this.initialization ??= this.initialize() }
  private ready(): void { if (!this.initialized) throw new AppError('资产库尚未成功初始化；原始元数据未覆盖。') }
  private rootStable(): void { if (this.configuringRoot) throw new AppError('素材库目录正在切换，请稍后重试。') }
  private async mediaOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.ready(); this.rootStable(); this.activeMediaOperations++
    try { return await operation() } finally { this.activeMediaOperations-- }
  }
  private warn(text: string): void { if (!this.warnings.includes(text) && this.warnings.length < 500) this.warnings.push(text) }
  private changed(): void { try { this.onChanged?.() } catch { this.warn('资产变更通知失败；已保存的数据不受影响。') } }
  private async initialize(): Promise<void> {
    try {
      for (const name of ['', 'items', 'roots', 'usage']) await ensureLibraryDirectory(path.join(this.directory, name))
      let index: z.infer<typeof indexSchema> | undefined
      try { index = indexSchema.parse(await this.read('index.json', LIMITS.indexBytes)) } catch (error) {
        if (!isMissing(error)) throw new AppError('V2 资产索引损坏或不可读；已停止初始化，不会用空库覆盖。')
      }
      await this.loadDirectory('roots', LIMITS.roots, LIMITS.configBytes, (id, value) => {
        const root = rootSchema.parse(value)
        if (root.id !== id || rootIdFor(root.directory) !== id) throw new Error('root identity')
        this.roots.set(id, root)
      })
      await this.loadDirectory('items', LIMITS.items, LIMITS.recordBytes, (id, value) => {
        const record = recordSchema.parse(value)
        if (record.asset.id !== id || record.locations.some(location => !this.roots.has(location.rootId))) throw new Error('asset identity/root')
        this.records.set(id, record)
      })
      await this.loadDirectory('usage', LIMITS.usages, LIMITS.recordBytes, (id, value) => {
        const usage = usageSchema.parse(value)
        if (usage.id !== id) throw new Error('usage identity')
        this.usages.set(id, usage)
      })
      if (index?.ids.some(id => !this.records.has(id))) throw new AppError('V2 索引引用的资产详情缺失；保留原索引并停止写入。')
      this.rebuildAliases()
      const orphans = [...this.records.keys()].filter(id => !index?.ids.includes(id))
      if (orphans.length) this.warn(`已从详情优先提交恢复 ${orphans.length} 条资产记录。`)
      await ensureLibraryDirectory(this.options.root)
      this.managedId = await this.registerRootInternal(this.options.root, true)
      if (!index || orphans.length) await this.saveIndex()
      this.initialized = true
      for (const record of this.canonicalRecords()) {
        if (record.deletion && record.deletion.state !== 'done') {
          try { await this.delete(record.asset.id) } catch { this.warn(`资产 ${record.asset.id} 的删除尚未完成，残留文件已保留，请检查后重试。`) }
        }
      }
    } catch (error) {
      this.initialized = false
      const problem = message(error, 'V2 资产元数据损坏、超限或不可读取；已停止初始化，原文件未覆盖。')
      this.warn(problem); throw new AppError(problem)
    }
  }
  private async read(fileName: string, maximum: number): Promise<unknown> {
    const { data, bytes } = await readMetadata(path.join(this.directory, fileName), maximum)
    this.account(fileName, bytes); return data
  }
  private account(fileName: string, bytes: number): void {
    const total = this.metadataBytes - (this.sizes.get(fileName) ?? 0) + bytes
    if (total > LIMITS.metadataBytes) throw new AppError('V2 资产元数据总量超过安全上限。')
    this.metadataBytes = total; this.sizes.set(fileName, bytes)
  }
  private async loadDirectory(name: string, maximum: number, bytes: number, accept: (id: string, value: unknown) => void): Promise<void> {
    await safeLibraryPath(path.join(this.directory, name), true)
    const directory = await opendir(path.join(this.directory, name)); let count = 0
    for await (const entry of directory) {
      if (++count > maximum * 2 + 100) throw new AppError('V2 元数据目录条目数超限。')
      if (/^\..+\.tmp$/.test(entry.name) && entry.isFile()) continue
      if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid.safeParse(entry.name.slice(0, -5)).success) throw new AppError('V2 元数据目录包含不安全或未知条目。')
      accept(entry.name.slice(0, -5), await this.read(`${name}/${entry.name}`, bytes))
    }
  }
  private async save(fileName: string, value: unknown, maximum = LIMITS.recordBytes): Promise<void> {
    const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`)
    if (bytes > maximum || this.metadataBytes - (this.sizes.get(fileName) ?? 0) + bytes > LIMITS.metadataBytes) throw new AppError('资产元数据超过安全上限，未写入。')
    const file = path.join(this.directory, fileName)
    await safeLibraryPath(path.dirname(file), true)
    await safeAncestors(file)
    await atomicJson(file, value, maximum)
    if (fileName === 'index.json') this.indexDirty = false
    this.account(fileName, bytes)
  }
  private async saveIndex(): Promise<void> {
    await this.save('index.json', indexSchema.parse({ version: 2, ids: [...this.records.keys()] }), LIMITS.indexBytes)
  }
  private async commit(record: AssetRecord): Promise<void> {
    recordSchema.parse(record)
    if (!this.records.has(record.asset.id) && this.records.size >= LIMITS.items) throw new AppError('资产记录数量超过上限。')
    if ([...this.records.keys()].some(id => id !== record.asset.id && id.toLowerCase() === record.asset.id.toLowerCase())) throw new AppError('资产 ID 大小写冲突，拒绝覆盖既有详情。')
    const fresh = !this.records.has(record.asset.id)
    const reassigned = [...new Set(record.aliases.map(id => this.canonical(id)))].filter(id => id !== record.asset.id && this.records.has(id))
    if (reassigned.some(id => this.isPinned(id) || this.deleting.has(id) || this.aliasChanges.has(id))) throw new AppError('预约或删除中的资产不能合并别名。')
    reassigned.forEach(id => this.aliasChanges.add(id))
    try {
      // Detail-first includes aliases/tombstones; block new source leases while the alias commit awaits disk.
      await this.save(`items/${record.asset.id}.json`, record)
      this.records.set(record.asset.id, clone(record)); this.rebuildAliases()
      this.indexDirty ||= fresh
      if (this.indexDirty) await this.saveIndex()
    } finally { reassigned.forEach(id => this.aliasChanges.delete(id)) }
    this.changed()
  }
  private rebuildAliases(): void {
    const claims = new Map<string, string[]>()
    for (const record of this.records.values()) for (const id of record.aliases) claims.set(id, [...(claims.get(id) ?? []), record.asset.id])
    const resolved = new Map<string, string>(); const visiting = new Set<string>()
    const resolve = (id: string): string => {
      if (resolved.has(id)) return resolved.get(id)!
      if (visiting.has(id)) throw new AppError('资产别名存在循环，拒绝写入。')
      visiting.add(id)
      const targets = claims.get(id); const values = targets ? new Set(targets.map(resolve)) : new Set([id])
      if (values.size !== 1) throw new AppError('资产别名存在冲突，拒绝覆盖。')
      const target = [...values][0]; visiting.delete(id); resolved.set(id, target); return target
    }
    for (const id of claims.keys()) resolve(id)
    this.aliases = new Map([...resolved].filter(([id, target]) => id !== target))
  }
  private canonical(id: string): string { uuid.parse(id); return this.aliases.get(id) ?? id }
  private record(id: string): AssetRecord {
    const record = this.records.get(this.canonical(id))
    if (!record) throw new AppError('找不到该资产。')
    return record
  }
  private canonicalRecords(): AssetRecord[] { return [...this.records.values()].filter(record => !this.aliases.has(record.asset.id)) }
  private live(record: AssetRecord): void {
    if (record.asset.deletedAt || this.deleting.has(record.asset.id)) throw new AppError('资产已删除或正在删除，不能恢复旧 ID。')
    if (this.aliasChanges.has(record.asset.id)) throw new AppError('资产别名正在提交，请稍后重试。')
  }
  private view(record: AssetRecord, queuedIds: string[] = []): WorkbenchAsset {
    const id = record.asset.id
    const usages = [...this.usages.values()].flatMap(usage => {
      const certain = usage.assetIds.some(assetId => this.canonical(assetId) === id)
      const uncertain = usage.uncertainAssetIds.some(assetId => this.canonical(assetId) === id)
      if (!certain && !uncertain) return []
      const { id: usageId, videoId, projectId, name, finishedAt, durationSeconds } = usage
      return [{ id: usageId, videoId, projectId, name, finishedAt, durationSeconds, ...(!certain ? { uncertain: true } : {}) }]
    }).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    return clone({ ...record.asset, usages, usedCount: usages.filter(usage => !usage.uncertain).length,
      historyUncertain: usages.some(usage => usage.uncertain), queuedCount: queuedIds.filter(assetId => this.canonical(assetId) === id).length })
  }
  async all(queuedIds: string[] = []): Promise<WorkbenchAsset[]> {
    this.ready(); z.array(uuid).max(100000).parse(queuedIds)
    return this.canonicalRecords().filter(record => record.deletion?.state !== 'done').map(record => this.view(record, queuedIds))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }
  async get(id: string): Promise<WorkbenchAsset> { this.ready(); return this.view(this.record(id)) }
  async managedRootId(): Promise<string> { this.ready(); return this.managedId }
  /** First-use chooser only; settings persistence belongs to the main-process caller. */
  async configureRoot(root: string): Promise<void> {
    this.ready(); this.rootStable()
    if (!localLibraryPath(root)) throw new AppError('媒体根路径不安全。')
    const assertEmpty = (): void => {
      if (this.records.size || this.usages.size || this.aliases.size || this.leases.size || this.verifying.size
        || this.activeMediaOperations || this.deleting.size || this.aliasChanges.size) {
        throw new AppError('仅完全空库且没有导入、登记、校验或预约任务时可切换目录；历史资产和使用台账也会阻止切换。')
      }
    }
    assertEmpty(); this.configuringRoot = true
    try {
      await this.queue.run(async () => {
        assertEmpty()
        await ensureLibraryDirectory(root)
        const id = await this.registerRootInternal(root, true)
        this.options.root = path.resolve(root); this.managedId = id
      })
    } finally { this.configuringRoot = false }
    this.changed()
  }
  async registerRoot(directory: string, owned: boolean): Promise<string> {
    this.ready(); return this.queue.run(() => this.registerRootInternal(directory, owned))
  }
  private async registerRootInternal(directory: string, owned: boolean): Promise<string> {
    if (!localLibraryPath(directory) || typeof owned !== 'boolean') throw new AppError('媒体根路径不安全。')
    await safeAncestors(directory, true)
    directory = path.resolve(directory); const id = rootIdFor(directory); const existing = this.roots.get(id)
    if (existing) {
      if (existing.owned !== owned) throw new AppError('已登记媒体根的所有权不能静默变更。')
      return id
    }
    if (this.roots.size >= LIMITS.roots) throw new AppError('媒体根数量超过上限。')
    const root = rootSchema.parse({ version: 2, id, directory, owned })
    await this.save(`roots/${id}.json`, root, LIMITS.configBytes); this.roots.set(id, root); return id
  }
  async rootDirectory(rootId: string): Promise<string> {
    this.ready(); const root = this.roots.get(uuid.parse(rootId))
    if (!root) throw new AppError('媒体根未登记。')
    await safeAncestors(root.directory, true); return root.directory
  }
  private file(rootId: string, fileName: string): string {
    const root = this.roots.get(rootId)
    if (!root || !relativeSchema.safeParse(fileName).success) throw new AppError('媒体根或相对路径不安全。')
    const file = path.resolve(root.directory, ...fileName.split('/'))
    if (!pathKey(file).startsWith(`${pathKey(root.directory).replace(/[\\/]$/, '')}${path.sep}`) || !localLibraryPath(file)) throw new AppError('素材路径越出媒体根。')
    return file
  }
  private locationKey(location: Pick<Location, 'rootId' | 'fileName'>): string { return pathKey(this.file(location.rootId, location.fileName)) }
  private files(record: AssetRecord): DeletionFile[] {
    return unique(record.locations.flatMap(location => [{ rootId: location.rootId, fileName: location.fileName, stamp: location.stamp, done: false },
      ...location.related.map(file => ({ rootId: location.rootId, ...file, done: false }))]), file => this.locationKey(file))
  }
  private assertNotDeletingPath(file: string): void {
    for (const record of this.canonicalRecords()) if ((record.deletion && record.deletion.state !== 'done') || this.deleting.has(record.asset.id)) {
      if (this.files(record).some(candidate => this.locationKey(candidate) === pathKey(file))) throw new AppError('该路径仍在删除事务中，不能重新登记或导入。')
    }
  }
  private duplicate(kind: MediaKind, sha256?: string): AssetRecord | undefined {
    return sha256 ? this.canonicalRecords().find(record => !record.asset.deletedAt && !this.deleting.has(record.asset.id) && record.asset.kind === kind && record.asset.sha256 === sha256) : undefined
  }
  async register(input: AssetRegistration): Promise<WorkbenchAsset> { return this.mediaOperation(() => this.registerInternal(input)) }
  private async registerInternal(raw: AssetRegistration, imported?: { proof: Evidence; source: string }): Promise<WorkbenchAsset> {
    this.ready()
    const parsed = registrationSchema.safeParse(raw)
    if (!parsed.success) throw new AppError('资产登记数据、格式或相对路径无效。')
    const input = parsed.data; const prior = this.records.get(this.canonical(input.id))
    if (prior) { this.live(prior); if (prior.asset.kind !== input.kind) throw new AppError('资产 ID 已属于其他媒体类型。') }
    if (prior?.asset.sha256 && input.expectedSha256 && prior.asset.sha256 !== input.expectedSha256) throw new AppError('资产登记哈希冲突。')
    const file = this.file(input.rootId, input.fileName); this.assertNotDeletingPath(file)
    const release = prior ? this.pin([prior.asset.id], 'internal:register') : undefined
    let location: Location; let proof: Evidence | undefined
    try {
      const exists = await safeAncestors(file)
      if (!exists && !input.allowMissing) throw new AppError('素材文件缺失，未登记。')
      const previous = prior?.locations.find(candidate => candidate.rootId === input.rootId && this.locationKey(candidate) === pathKey(file))
      if (exists) proof = await this.validator.inspect(file, input.kind, prior?.asset.sha256 ?? input.expectedSha256, previous?.evidence ?? imported?.proof, !previous && !!imported)
      const ownerId = ownerFor(input.id, input.fileName)
      const related = new Set(input.relatedFiles ?? [])
      if ([...related].some(value => value.toLowerCase().startsWith(`.generated-audio/${ownerId}/`.toLowerCase()))) {
        // Saver receipts/hardlinks must not survive as a recovery path after asset deletion.
        for (const name of ['manifest.json', 'source.bin', 'compatible.flac', 'download.part']) related.add(`.generated-audio/${ownerId}/${name}`)
      }
      location = { rootId: input.rootId, fileName: input.fileName, ownerId, stamp: proof?.fingerprint, evidence: proof, related: [] }
      for (const fileName of related) {
        if (fileName === input.fileName) continue
        const relatedPath = this.file(input.rootId, fileName); this.assertNotDeletingPath(relatedPath)
        const exists = await safeAncestors(relatedPath)
        const fingerprint = exists ? await fingerprintRaw(relatedPath, fileName.toLowerCase().endsWith('/manifest.json') ? 8192 : LIMITS.audioBytes) : undefined
        const saved = previous?.related.find(candidate => candidate.fileName === fileName)
        const actual = fingerprint ? stamp(fingerprint.identity, fingerprint.sha256) : undefined
        if (saved?.stamp && actual && !sameStamp(saved.stamp, actual)) throw new AppError('已登记附属文件的指纹已变化，拒绝覆盖。')
        location.related.push({ fileName, stamp: saved?.stamp ?? actual })
      }
    } finally { release?.() }
    return this.queue.run(async () => {
      const current = this.records.get(this.canonical(input.id)); if (current) this.live(current)
      this.assertNotDeletingPath(file)
      for (const related of location.related) this.assertNotDeletingPath(this.file(location.rootId, related.fileName))
      if (proof && !sameStamp(proof.fingerprint, stamp(await safeLibraryPath(file), proof.fingerprint.sha256))) throw new AppError('素材在登记前发生变化。')
      if (current?.asset.sha256 && proof && current.asset.sha256 !== proof.fingerprint.sha256) throw new AppError('资产指纹冲突。')
      const duplicate = this.duplicate(input.kind, proof?.fingerprint.sha256)
      if (current && duplicate && current.asset.id !== duplicate.asset.id && this.isPinned(current.asset.id)) throw new AppError('预约中的资产不能合并别名。')
      let record = clone(duplicate ?? current ?? {
        version: 2, asset: { id: input.id, kind: input.kind, name: input.name, createdAt: input.createdAt, updatedAt: now(), available: false, origins: [] }, aliases: [], locations: [], importPaths: []
      }) as AssetRecord
      if (current && current.asset.id !== record.asset.id) record = this.merge(record, current)
      if (input.id !== record.asset.id) record.aliases = [...new Set([...record.aliases, input.id])]
      record.asset.origins = unique([...record.asset.origins, input.origin], origin => JSON.stringify(origin))
      const previous = record.locations.find(candidate => candidate.rootId === location.rootId && this.locationKey(candidate) === this.locationKey(location))
      if (previous) {
        location.related = unique([...previous.related, ...location.related], related => related.fileName)
        location.stamp ??= previous.stamp; location.evidence ??= previous.evidence
      }
      record.locations = unique([...record.locations, location], candidate => `${candidate.rootId}:${this.locationKey(candidate)}`)
      if (imported) {
        this.assertNotDeletingPath(imported.source)
        record.importPaths = unique([...record.importPaths, imported.source], pathKey)
      }
      if (proof) this.applyProof(record, proof)
      else if (!record.asset.available || !record.locations.some(candidate => this.locationKey(candidate) !== pathKey(file) && candidate.evidence)) {
        record.asset.available = false; record.asset.sha256 ??= input.expectedSha256; record.asset.problem = '素材文件缺失；历史 ID 和来源已保留。'
      }
      record.asset.updatedAt = now()
      await this.commit(record); return this.view(record)
    })
  }
  private applyProof(record: AssetRecord, proof: Evidence): void {
    Object.assign(record.asset, proof.metadata, { sha256: proof.fingerprint.sha256, bytes: proof.fingerprint.size, available: true })
    delete record.asset.problem
  }
  private merge(target: AssetRecord, source: AssetRecord): AssetRecord {
    if (target.asset.kind !== source.asset.kind || (target.asset.sha256 && source.asset.sha256 && target.asset.sha256 !== source.asset.sha256)) throw new AppError('不同内容的资产不能合并别名。')
    if (!target.asset.sha256 && source.asset.sha256) {
      const { sha256, bytes, format, durationSeconds, width, height, available, problem } = source.asset
      Object.assign(target.asset, { sha256, bytes, format, durationSeconds, width, height, available, problem })
    }
    target.asset.origins = unique([...target.asset.origins, ...source.asset.origins], origin => JSON.stringify(origin))
    target.aliases = [...new Set([...target.aliases, source.asset.id, ...source.aliases])].filter(id => id !== target.asset.id)
    target.locations = unique([...source.locations, ...target.locations], location => `${location.rootId}:${this.locationKey(location)}`)
    target.importPaths = unique([...target.importPaths, ...source.importPaths], pathKey)
    return target
  }
  async alias(id: string, targetId: string): Promise<void> {
    this.ready(); uuid.parse(id); uuid.parse(targetId)
    return this.queue.run(async () => {
      const target = this.record(targetId)
      if (this.canonical(id) === target.asset.id) return
      this.live(target)
      if (this.aliases.has(id)) throw new AppError('资产别名已指向其他资产。')
      const source = this.records.get(id)
      if (source) this.live(source)
      if (this.isPinned(id) || this.isPinned(target.asset.id)) throw new AppError('预约中的资产不能变更别名。')
      const record = source ? this.merge(clone(target), source) : clone(target)
      record.aliases = [...new Set([...record.aliases, id])]; record.asset.updatedAt = now()
      await this.commit(record)
    })
  }
  async rename(id: string, name: string): Promise<void> {
    this.ready(); nameSchema.parse(name)
    return this.queue.run(async () => {
      const record = clone(this.record(id)); this.live(record)
      record.asset.name = name; record.asset.updatedAt = now(); await this.commit(record)
    })
  }
  async pathForAsset(id: string): Promise<string> { return (await this.verify(id)).path }
  verify(id: string): Promise<{ asset: WorkbenchAsset; path: string }> {
    try {
      this.ready(); this.rootStable(); const record = this.record(id); this.live(record)
      const existing = this.verifying.get(record.asset.id); if (existing) return existing.then(clone)
      const release = this.pin([record.asset.id], 'internal:verify')
      const pending = this.verifyOnce(clone(record)).finally(() => { this.verifying.delete(record.asset.id); release() })
      this.verifying.set(record.asset.id, pending); return pending.then(clone)
    } catch (error) { return Promise.reject(error) }
  }
  private async verifyOnce(snapshot: AssetRecord): Promise<{ asset: WorkbenchAsset; path: string }> {
    let failure: unknown = new AppError('资产没有可读取的位置。')
    for (const location of snapshot.locations) {
      try {
        const file = this.file(location.rootId, location.fileName)
        const proof = await this.validator.inspect(file, snapshot.asset.kind, snapshot.asset.sha256, location.evidence)
        return await this.queue.run(async () => {
          const record = clone(this.record(snapshot.asset.id)); this.live(record)
          const target = record.locations.find(candidate => this.locationKey(candidate) === this.locationKey(location))!
          if (!sameStamp(proof.fingerprint, stamp(await safeLibraryPath(file), proof.fingerprint.sha256))) throw new AppError('素材在校验后发生变化。')
          const unchanged = target.evidence && JSON.stringify(target.evidence) === JSON.stringify(proof) && record.asset.available
          target.stamp = proof.fingerprint; target.evidence = proof; this.applyProof(record, proof)
          if (!unchanged) { record.asset.updatedAt = now(); await this.commit(record) }
          return { asset: this.view(record), path: file }
        })
      } catch (error) { failure = error }
    }
    const problem = message(failure, '素材文件缺失、不可读取或路径不安全。')
    await this.queue.run(async () => {
      const record = clone(this.record(snapshot.asset.id)); this.live(record)
      if (record.asset.available || record.asset.problem !== problem) { record.asset.available = false; record.asset.problem = problem; record.asset.updatedAt = now(); await this.commit(record) }
    })
    throw new AppError(problem)
  }
  async refresh(): Promise<WorkbenchAsset[]> {
    this.ready(); const ids = this.canonicalRecords().filter(record => !record.asset.deletedAt).map(record => record.asset.id)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) { const id = ids[cursor++]; try { await this.verify(id) } catch { /* The unavailable record retains its original digest and diagnostic. */ } }
    }))
    return this.all()
  }
  async importFiles(paths: string[], kind: 'audio' | 'image'): Promise<ImportResult> {
    return this.mediaOperation(() => this.importFilesInternal(paths, kind))
  }
  private async importFilesInternal(paths: string[], kind: 'audio' | 'image'): Promise<ImportResult> {
    this.ready()
    if (!Array.isArray(paths) || paths.length > LIMITS.filesPerImport || !['audio', 'image'].includes(kind)) throw new AppError('一次最多导入 500 个音乐或图片文件。')
    const result: ImportResult = { entries: [], cancelled: false }
    for (const source of paths.slice()) {
      const name = typeof source === 'string' ? path.basename(source) || '未命名素材' : '无效文件'
      let stage: Awaited<ReturnType<typeof stageImport>> | undefined; let release: (() => void) | undefined
      try {
        if (!nameSchema.safeParse(name).success || !localLibraryPath(source)) throw new AppError('导入名称或本地源路径不安全。')
        this.assertNotDeletingPath(source)
        const references = this.canonicalRecords().filter(record => !record.asset.deletedAt && this.files(record).some(file => this.locationKey(file) === pathKey(source)))
        release = this.pin(references.map(record => record.asset.id), 'internal:import-source')
        const root = await this.rootDirectory(this.managedId)
        stage = await stageImport(source, kind, root)
        const proof = await this.validator.inspect(stage.path, kind, stage.sha256)
        const duplicate = this.duplicate(kind, proof.fingerprint.sha256)
        if (duplicate) {
          const duplicateLease = this.pin([duplicate.asset.id], 'internal:import-duplicate')
          try {
            await this.verify(duplicate.asset.id)
            if (!duplicate.locations.some(location => location.rootId === this.managedId)) {
              const published = await stage.publish(duplicate.asset.id, proof.metadata.format as MediaMetadata['format'])
              await stage.dispose(); stage = undefined
              await this.registerInternal({ id: duplicate.asset.id, kind, name, createdAt: duplicate.asset.createdAt, origin: { type: 'import', name }, rootId: this.managedId, fileName: published.fileName, expectedSha256: proof.fingerprint.sha256 }, { proof, source: path.resolve(source) })
            } else await this.queue.run(async () => {
              const record = clone(this.record(duplicate.asset.id)); this.live(record)
              record.importPaths = unique([...record.importPaths, path.resolve(source)], pathKey)
              record.asset.origins = unique([...record.asset.origins, { type: 'import' as const, name }], origin => JSON.stringify(origin))
              record.asset.updatedAt = now(); await this.commit(record)
            })
            result.entries.push({ name, status: 'duplicate', assetId: duplicate.asset.id })
          } finally { duplicateLease() }
        } else {
          const id = randomUUID(); const published = await stage.publish(id, proof.metadata.format as MediaMetadata['format'])
          await stage.dispose(); stage = undefined
          const asset = await this.registerInternal({ id, kind, name, createdAt: now(), origin: { type: 'import', name }, rootId: this.managedId, fileName: published.fileName, expectedSha256: proof.fingerprint.sha256 }, { proof, source: path.resolve(source) })
          result.entries.push({ name, status: asset.id === id ? 'imported' : 'duplicate', assetId: asset.id })
        }
      } catch (error) { result.entries.push({ name, status: 'failed', error: message(error, '素材导入或保存失败；外部原件未修改，已有文件未覆盖。') }) }
      finally { await stage?.dispose(); release?.() }
    }
    return result
  }
  /** Synchronous all-or-nothing reservation closes the delete/queue await race. */
  pin(ids: string[], owner: string): () => void {
    this.ready(); this.rootStable(); z.array(uuid).max(100000).parse(ids)
    if (typeof owner !== 'string' || !owner.length || owner.length > 512) throw new AppError('资产预约所有者无效。')
    const records = unique(ids.map(id => this.record(id)), record => record.asset.id)
    records.forEach(record => this.live(record))
    for (const record of records) {
      const leases = this.leases.get(record.asset.id) ?? new Map<string, number>()
      leases.set(owner, (leases.get(owner) ?? 0) + 1); this.leases.set(record.asset.id, leases)
    }
    let released = false
    return () => {
      if (released) return; released = true
      for (const record of records) {
        const leases = this.leases.get(record.asset.id); const count = leases?.get(owner) ?? 0
        if (count <= 1) leases?.delete(owner); else leases?.set(owner, count - 1)
        if (!leases?.size) this.leases.delete(record.asset.id)
      }
    }
  }
  isPinned(id: string): boolean { return !!this.leases.get(this.canonical(id))?.size }
  private originalKept(file: DeletionFile): boolean {
    const key = this.locationKey(file)
    return this.canonicalRecords().some(record => record.importPaths.some(source => pathKey(source) === key))
  }
  private ownedFiles(record: AssetRecord): DeletionFile[] {
    const external = new Set(record.locations.filter(location => !this.roots.get(location.rootId)?.owned)
      .flatMap(location => [this.locationKey(location), ...location.related.map(file => this.locationKey({ rootId: location.rootId, fileName: file.fileName }))]))
    return this.files(record).filter(file => this.roots.get(file.rootId)?.owned && !external.has(this.locationKey(file)) && !this.originalKept(file))
  }
  async deletionInfo(id: string): Promise<{ ownedFiles: number; externalOriginalsKept: boolean }> {
    this.ready(); const record = this.record(id)
    const files = this.ownedFiles(record); let ownedFiles = 0
    for (const file of files) if (await safeAncestors(this.file(file.rootId, file.fileName))) ownedFiles++
    return { ownedFiles, externalOriginalsKept: record.importPaths.length > 0 || record.asset.origins.some(origin => origin.type === 'import') || record.locations.some(location => !this.roots.get(location.rootId)?.owned) }
  }
  async delete(id: string): Promise<void> {
    this.ready(); const existing = this.record(id); const canonical = existing.asset.id
    if (existing.deletion?.state === 'done') return
    if (this.isPinned(canonical) || this.deleting.has(canonical) || this.aliasChanges.has(canonical)) throw new AppError('资产正被排队、执行、别名提交或校验预约，不能删除。')
    this.deleting.add(canonical)
    try {
      await this.queue.run(async () => {
        const record = clone(this.record(canonical))
        record.asset.deletedAt ??= now(); record.asset.available = false; record.asset.problem = '资产删除尚未完成。'; record.asset.updatedAt = now()
        record.deletion ??= { state: 'pending', files: this.ownedFiles(record).sort((a, b) => Number(b.fileName.endsWith('/manifest.json')) - Number(a.fileName.endsWith('/manifest.json'))) }
        record.deletion.state = 'pending'; delete record.deletion.problem
        // Tombstone + complete bounded deletion plan MUST reach disk before the first unlink.
        await this.commit(record)
      })
      await this.removeFiles(canonical)
      await this.queue.run(async () => {
        const record = clone(this.record(canonical)); record.deletion!.state = 'done'
        record.asset.problem = '资产已删除；历史使用台账保留。'; await this.commit(record)
      })
    } catch (error) {
      const problem = message(error, '删除未完成；文件可能被占用、变更或存储不可写，残留记录保留供重试。')
      if (this.records.get(canonical)?.deletion) {
        try {
          await this.queue.run(async () => {
            const record = clone(this.record(canonical)); record.deletion!.state = 'failed'; record.deletion!.problem = problem; record.asset.problem = problem; await this.commit(record)
          })
        } catch { this.warn(`资产 ${canonical} 删除状态未能保存；重启后将按已落盘计划重试。`) }
      }
      throw new AppError(problem)
    } finally { this.deleting.delete(canonical) }
  }
  private async removeFiles(id: string): Promise<void> {
    const planned = this.record(id).deletion!.files
    const missing = new Set<string>()
    // Preflight all paths before unlinking anything. Never follow a missing leaf through a replaced parent.
    for (const file of planned) if (!await safeAncestors(this.file(file.rootId, file.fileName))) missing.add(this.locationKey(file))
    for (const file of planned) {
      const absolute = this.file(file.rootId, file.fileName)
      if (file.done && !missing.has(this.locationKey(file))) throw new AppError('已删除的路径重新出现，拒绝删除新文件。')
      if (missing.has(this.locationKey(file))) continue
      if (!this.roots.get(file.rootId)?.owned || this.originalKept(file)) throw new AppError('删除路径不是软件独占管理的文件，原件已保留。')
      if (this.canonicalRecords().some(record => record.asset.id !== id && record.deletion?.state !== 'done' && this.files(record).some(other => this.locationKey(other) === this.locationKey(file)))) throw new AppError('文件路径被其他资产共享，拒绝删除。')
      if (!file.stamp) throw new AppError('文件在登记后才出现，缺少可信文件身份，拒绝删除。')
      const actual = await fingerprintRaw(absolute); const actualStamp = stamp(actual.identity, actual.sha256)
      // Removing a known hardlink can alter ctime/nlink of its siblings, including across a crash.
      const removedSibling = planned.some(other => other !== file && other.stamp && sameStamp(file.stamp!, other.stamp, false) && missing.has(this.locationKey(other)))
      const expected = removedSibling && actualStamp.links < file.stamp.links ? { ...file.stamp, ctime: actualStamp.ctime } : file.stamp
      if (!sameStamp(expected, actualStamp)) throw new AppError('文件身份或指纹已变化，残留文件保留，删除未完成。')
    }
    for (let index = 0; index < planned.length; index++) {
      const file = planned[index]; if (file.done) continue
      const absolute = this.file(file.rootId, file.fileName)
      if (await safeAncestors(absolute)) {
        // Rehash immediately before unlink, and account only for our previously removed hardlinks.
        const actual = await fingerprintRaw(absolute); const actualStamp = stamp(actual.identity, actual.sha256)
        const removedSibling = planned.some(other => other !== file && other.stamp && sameStamp(file.stamp!, other.stamp, false) && (other.done || missing.has(this.locationKey(other))))
        const expected = removedSibling && actualStamp.links < file.stamp!.links ? { ...file.stamp!, ctime: actualStamp.ctime } : file.stamp!
        if (!sameStamp(expected, actualStamp)) throw new AppError('文件在删除前发生变化，已停止清理。')
        await safeLibraryPath(absolute).then(info => { if (!sameStamp(actualStamp, stamp(info, actual.sha256))) throw new AppError('文件在删除前被替换。') })
        await unlink(absolute)
      }
      await this.queue.run(async () => {
        const record = clone(this.record(id)); record.deletion!.files[index].done = true; await this.commit(record)
      })
      file.done = true
    }
  }
  private usageKey(record: UsageRecord): string {
    const assetIds = [...new Set(record.assetIds.map(id => this.canonical(id)))].sort()
    const uncertainAssetIds = [...new Set(record.uncertainAssetIds.map(id => this.canonical(id)))].filter(id => !assetIds.includes(id)).sort()
    return JSON.stringify({ ...record, videoId: record.videoId ? this.canonical(record.videoId) : undefined, assetIds, uncertainAssetIds })
  }
  async recordUsage(input: UsageRecord): Promise<void> {
    this.ready(); const record = usageSchema.parse(input)
    record.assetIds = [...new Set(record.assetIds)].sort(); record.uncertainAssetIds = [...new Set(record.uncertainAssetIds)].filter(id => !record.assetIds.includes(id)).sort()
    return this.queue.run(async () => {
      const existing = this.usages.get(record.id)
      if (existing) {
        if (this.usageKey(existing) !== this.usageKey(record)) throw new AppError('使用台账 ID 冲突；既有历史不会覆盖或重复记账。')
        return
      }
      if (this.usages.size >= LIMITS.usages) throw new AppError('使用台账数量超过安全上限。')
      if ([...this.usages.keys()].some(id => id.toLowerCase() === record.id.toLowerCase())) throw new AppError('使用台账 ID 大小写冲突，拒绝覆盖。')
      await this.save(`usage/${record.id}.json`, record); this.usages.set(record.id, clone(record)); this.changed()
    })
  }
  async allUsage(): Promise<UsageRecord[]> { this.ready(); return clone([...this.usages.values()]) }
}
