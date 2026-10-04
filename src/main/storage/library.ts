import { randomUUID } from 'node:crypto'
import { opendir } from 'node:fs/promises'
import path from 'node:path'
import type { ImportResult, LibraryConfig, LibraryItem, LibraryKind } from '../../shared/library-types'
import { idSchema } from '../../shared/schemas'
import type { AssetKind, Project } from '../../shared/types'
import { AppError } from '../providers/http'
import { assertFingerprint, ensureLibraryDirectory, fingerprintFile, libraryTools, safeLibraryPath, samePath, stageImport, validateMedia, type Fingerprint, type MediaMetadata, type ToolResolver } from '../library/imports'
import { projectLibrarySignature, projectLibrarySources, type ProjectLibrarySource } from '../library/project-sync'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { LIBRARY_LIMITS, libraryConfigSchema, libraryFileName, libraryIndexSchema, libraryRecordSchema, type LibraryLocation, type LibraryRecord } from './library-validation'

export interface LibraryStoreOptions {
  dataDir: string
  defaultRoot: string
  projects: { all(): Promise<Project[]>; get(id: string): Promise<Project>; pathForAsset(projectId: string, kind: AssetKind, assetId: string): Promise<string> }
  getFFmpegPath: () => string | undefined
}
const corrupt = () => new AppError('总素材库配置、索引或详情损坏/不兼容；原文件未被覆盖，请先备份并修复。')
const pendingProblem = '素材待本地校验，尚不可用于合成。'
const recordSize = (record: LibraryRecord): number => Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') + 1

/** Main-process only. Public records deliberately contain no private disk locations or usage accounting. */
export class LibraryStore {
  warnings: string[] = []
  onChanged?: () => void
  private readonly queue = new SerialQueue()
  private readonly records = new Map<string, LibraryRecord>()
  private readonly signatures = new Map<string, string>()
  private readonly detailBytes = new Map<string, number>()
  private metadataBytes = 0
  private readonly directory: string
  private readonly details: string
  private readonly indexPath: string
  private readonly configPath: string
  private config!: LibraryConfig
  private initialized = false
  private pending?: LibraryRecord

  constructor(private readonly options: LibraryStoreOptions) {
    this.directory = path.join(options.dataDir, 'library')
    this.details = path.join(this.directory, 'items')
    this.indexPath = path.join(this.directory, 'index.json')
    this.configPath = path.join(this.directory, 'config.json')
  }
  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings = [...this.warnings.slice(-199), message.slice(0, 2000)]
  }
  private notify(): void { try { this.onChanged?.() } catch { /* Already durable; observers cannot roll back a save. */ } }
  private ready(): void { if (!this.initialized) throw new AppError('总素材库尚未初始化。') }
  private detailPath(id: string): string { return path.join(this.details, `${id}.json`) }
  private async optionalJson(file: string, maximum: number): Promise<unknown | undefined> {
    try { await safeLibraryPath(file); return await readJson(file, maximum) } catch (error) { if (isMissing(error)) return undefined; throw corrupt() }
  }
  private async write(file: string, data: unknown, maximum: number): Promise<void> {
    await safeLibraryPath(path.dirname(file), true)
    try { await safeLibraryPath(file) } catch (error) { if (!isMissing(error)) throw error }
    await atomicJson(file, data, maximum)
  }
  private async writeIndex(ids: string[]): Promise<void> {
    if (!libraryIndexSchema.safeParse({ version: 1, ids }).success) throw new AppError('素材库条目数量超过 50,000 或索引标识无效。')
    await this.write(this.indexPath, { version: 1, ids }, LIBRARY_LIMITS.indexBytes)
  }

  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.initialized) { await this.recoverPending(); return }
      try { await ensureLibraryDirectory(this.details) } catch { throw new AppError('无法创建安全的素材库元数据目录，请检查路径和存储权限。') }
      const rawConfig = await this.optionalJson(this.configPath, LIBRARY_LIMITS.configBytes)
      const rawIndex = await this.optionalJson(this.indexPath, LIBRARY_LIMITS.indexBytes)
      const index = libraryIndexSchema.safeParse(rawIndex === undefined ? { version: 1, ids: [] } : rawIndex)
      if (!index.success) throw corrupt()
      const ids = index.data.ids
      const config = libraryConfigSchema.safeParse(rawConfig === undefined ? { version: 1, root: this.options.defaultRoot } : rawConfig)
      if (!config.success) throw corrupt()
      const loaded = new Map<string, LibraryRecord>()
      const folder = await opendir(this.details)
      let count = 0
      let diskBytes = 0
      let metadataBytes = 0
      for await (const entry of folder) {
        if (++count > LIBRARY_LIMITS.items + 1000) throw corrupt()
        if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue // Never erase unfinished writes.
        if (!entry.name.endsWith('.json') || !entry.isFile() || !idSchema.safeParse(entry.name.slice(0, -5)).success) throw corrupt()
        diskBytes += Number((await safeLibraryPath(path.join(this.details, entry.name))).size)
        if (diskBytes > LIBRARY_LIMITS.metadataBytes) throw corrupt()
        const raw = await this.optionalJson(path.join(this.details, entry.name), LIBRARY_LIMITS.recordBytes)
        const parsed = libraryRecordSchema.safeParse(raw)
        if (!parsed.success || parsed.data.item.id !== entry.name.slice(0, -5) || loaded.size >= LIBRARY_LIMITS.items) throw corrupt()
        metadataBytes += recordSize(parsed.data)
        if (metadataBytes > LIBRARY_LIMITS.metadataBytes) throw corrupt()
        loaded.set(parsed.data.item.id, parsed.data)
      }
      if ((rawConfig === undefined && (loaded.size || ids.length)) || ids.some(id => !loaded.has(id))) throw corrupt()
      for (const record of loaded.values()) {
        const visited = new Set<string>()
        let current = record
        while (current.aliasOf) {
          if (visited.has(current.item.id)) throw corrupt()
          visited.add(current.item.id)
          const target = loaded.get(current.aliasOf)
          if (!target || target.item.kind !== record.item.kind || !record.item.sha256 || target.item.sha256 !== record.item.sha256) throw corrupt()
          current = target
        }
      }
      const registered = new Set(ids)
      const recovered = [...loaded.keys()].filter(id => !registered.has(id))
      try {
        if (rawConfig === undefined) await this.write(this.configPath, config.data, LIBRARY_LIMITS.configBytes)
        if (rawIndex === undefined || recovered.length) await this.writeIndex([...ids, ...recovered])
      } catch { throw new AppError('素材库索引保存失败；已有详情和媒体保留，可重新启动恢复。') }
      this.config = config.data
      this.records.clear(); this.detailBytes.clear(); this.metadataBytes = metadataBytes
      for (const [id, record] of loaded) { this.records.set(id, record); this.detailBytes.set(id, recordSize(record)) }
      this.initialized = true
      if (recovered.length) { this.warn(`已恢复 ${recovered.length} 条已保存但未写入索引的素材记录。`); this.notify() }
      // Registration is entirely local. A failed sync must never resubmit a paid generation job.
      const tools = libraryTools(this.options.getFFmpegPath)
      for (const project of await this.options.projects.all()) {
        try { await this.sync(project, tools) } catch { this.warn(`项目 ${project.id} 生成成功，入库待恢复；原项目未修改，请刷新重试本地登记。`) }
      }
    })
  }

  private current(id: string): LibraryRecord {
    this.ready()
    if (!idSchema.safeParse(id).success) throw new AppError('素材库标识不正确。')
    const seen = new Set<string>()
    let record = this.records.get(id)
    while (record?.aliasOf) {
      if (seen.has(record.item.id)) throw corrupt()
      seen.add(record.item.id); record = this.records.get(record.aliasOf)
    }
    if (!record) throw new AppError('素材库中不存在所选素材。')
    return record
  }
  async all(): Promise<LibraryItem[]> {
    return this.queue.run(async () => {
      this.ready()
      return structuredClone([...this.records.values()].filter(record => !record.aliasOf).map(record => record.item).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)))
    })
  }
  async get(id: string): Promise<LibraryItem> { return this.queue.run(async () => structuredClone(this.current(id).item)) }
  getConfig(): LibraryConfig { this.ready(); return structuredClone(this.config) }
  private findSource(projectId: string, assetId: string): LibraryRecord | undefined {
    const record = [...this.records.values()].find(record => record.item.origins.some(origin => origin.type === 'project' && origin.projectId === projectId && origin.assetId === assetId))
    return record ? this.current(record.item.id) : undefined
  }
  async findProjectAsset(projectId: string, assetId: string): Promise<LibraryItem | undefined> {
    return this.queue.run(async () => {
      this.ready()
      if (!idSchema.safeParse(projectId).success || !idSchema.safeParse(assetId).success) throw new AppError('项目或素材标识不正确。')
      const record = this.findSource(projectId, assetId)
      return record ? structuredClone(record.item) : undefined
    })
  }
  private duplicate(kind: LibraryKind, sha256: string, except?: string): LibraryRecord | undefined {
    return [...this.records.values()].find(record => !record.aliasOf && record.item.id !== except && record.item.kind === kind && record.item.sha256 === sha256)
  }
  private async recoverPending(): Promise<void> {
    if (!this.pending) return
    try { await this.writeIndex([...this.records.keys(), this.pending.item.id]) } catch { throw new AppError('素材已保存，索引登记待恢复；请检查权限后刷新或重新启动。') }
    this.records.set(this.pending.item.id, this.pending)
    this.pending = undefined
    this.notify()
  }
  private async commit(record: LibraryRecord): Promise<void> {
    await this.recoverPending()
    const parsed = libraryRecordSchema.safeParse(record)
    if (!parsed.success) throw new AppError('素材记录不正确或来源数量超过 500，未保存更改。')
    const previous = this.records.get(record.item.id)
    if (previous && JSON.stringify(previous) === JSON.stringify(parsed.data)) return
    if (!previous && this.records.size >= LIBRARY_LIMITS.items) throw new AppError('素材库条目数量已达 50,000，请先备份整理。')
    const bytes = recordSize(parsed.data)
    const total = this.metadataBytes - (this.detailBytes.get(record.item.id) ?? 0) + bytes
    if (bytes > LIBRARY_LIMITS.recordBytes || total > LIBRARY_LIMITS.metadataBytes) throw new AppError('素材元数据超过上限（单条 2 MiB、总计 128 MiB），未保存更改。')
    try { await this.write(this.detailPath(record.item.id), parsed.data, LIBRARY_LIMITS.recordBytes) } catch { throw new AppError('素材详情保存失败；原文件保留，请检查存储空间和权限。') }
    this.detailBytes.set(record.item.id, bytes); this.metadataBytes = total
    if (!previous) {
      this.pending = parsed.data
      await this.recoverPending()
    } else { this.records.set(record.item.id, parsed.data); this.notify() }
  }

  private async resolveLocation(record: LibraryRecord, location: LibraryLocation): Promise<string> {
    const id = location.type === 'managed' ? record.item.id : location.assetId
    if (!libraryFileName(location.fileName, record.item.kind, id)) throw new AppError('素材路径不安全。')
    const expected = path.join(location.type === 'managed' ? this.config.root : location.directory, location.fileName)
    // Check the original registered path before calling older project resolvers, which canonicalize paths.
    await safeLibraryPath(expected)
    if (location.type === 'project') {
      const resolved = await this.options.projects.pathForAsset(location.projectId, record.item.kind, location.assetId)
      if (!samePath(expected, resolved)) throw new AppError('项目素材路径与登记来源不一致，已拒绝访问。')
    }
    return expected
  }
  async pathForAsset(id: string): Promise<string> {
    return this.queue.run(async () => {
      const record = this.current(id)
      if (!record.item.available) throw new AppError(record.item.problem ?? pendingProblem)
      for (const location of record.locations) {
        try { return await this.resolveLocation(record, location) } catch { /* A matching alternate project source may remain. */ }
      }
      throw new AppError('已登记素材文件缺失或路径不安全，请刷新素材库。')
    })
  }
  private validated(record: LibraryRecord, fingerprint: Fingerprint, metadata: MediaMetadata): LibraryRecord {
    const result = structuredClone(record)
    Object.assign(result.item, { sha256: fingerprint.sha256, bytes: fingerprint.bytes, ...metadata, available: true })
    delete result.item.problem
    return result
  }
  private async check(record: LibraryRecord, tools: ToolResolver): Promise<{ record: LibraryRecord; path?: string }> {
    let problem = '已登记素材文件缺失或不可读取。'
    for (const location of record.locations) {
      try {
        const file = await this.resolveLocation(record, location)
        const fingerprint = await fingerprintFile(file, record.item.kind)
        if (record.item.sha256 && (record.item.sha256 !== fingerprint.sha256 || record.item.bytes !== fingerprint.bytes)) {
          throw new AppError('原素材指纹已变化，与入库时的字节不一致；请恢复原文件或作为新素材导入。')
        }
        const metadata = await validateMedia(file, record.item.kind, fingerprint, tools)
        return { record: this.validated(record, fingerprint, metadata), path: file }
      } catch (error) { problem = error instanceof AppError ? error.message : '已登记素材文件缺失、路径不安全或不可读取。' }
    }
    const result = structuredClone(record)
    result.item.available = false; result.item.problem = problem
    return { record: result }
  }
  /** Old placeholder IDs remain valid aliases if a restored source proves to be an existing exact duplicate. */
  private async mergeRecovered(record: LibraryRecord): Promise<LibraryRecord> {
    const target = record.item.sha256 ? this.duplicate(record.item.kind, record.item.sha256, record.item.id) : undefined
    if (!target || record.locations.some(location => location.type === 'managed')) return record
    const combined = structuredClone(target)
    for (const origin of record.item.origins) {
      if (!combined.item.origins.some(existing => JSON.stringify(existing) === JSON.stringify(origin))) combined.item.origins.push(origin)
    }
    for (const source of record.locations) {
      if (source.type === 'project' && !combined.locations.some(existing => existing.type === 'project' && existing.projectId === source.projectId && existing.assetId === source.assetId)) combined.locations.push(source)
    }
    for (const source of record.importPaths) if (!combined.importPaths.includes(source)) combined.importPaths.push(source)
    if (record.item.available) {
      combined.item = { ...record.item, id: target.item.id, name: target.item.name, createdAt: target.item.createdAt, origins: combined.item.origins }
    }
    await this.commit(combined)
    await this.commit({ ...record, aliasOf: target.item.id })
    return this.current(target.item.id)
  }
  async verify(id: string): Promise<{ asset: LibraryItem; path: string }> {
    return this.queue.run(async () => {
      await this.recoverPending()
      const result = await this.check(this.current(id), libraryTools(this.options.getFFmpegPath))
      await this.commit(result.record)
      if (!result.path) throw new AppError(result.record.item.problem ?? pendingProblem)
      const merged = await this.mergeRecovered(result.record)
      return { asset: structuredClone(merged.item), path: result.path }
    })
  }

  async importFiles(paths: string[], kind: LibraryKind): Promise<ImportResult> {
    if (!Array.isArray(paths) || paths.length > LIBRARY_LIMITS.filesPerImport || !['audio', 'image'].includes(kind)) throw new AppError('一次最多导入 500 个文件，素材类型必须为音乐或图片。')
    const requested = paths.slice()
    return this.queue.run(async () => {
      this.ready()
      const result: ImportResult = { entries: [], cancelled: false }
      const tools = libraryTools(this.options.getFFmpegPath)
      for (const source of requested) {
        const name = typeof source === 'string' ? path.basename(source).slice(0, 512) || '未命名素材' : '无效文件'
        let stage: Awaited<ReturnType<typeof stageImport>> | undefined
        try {
          await this.recoverPending()
          stage = await stageImport(source, kind, this.config.root)
          const fingerprint = await fingerprintFile(stage.path, kind)
          if (fingerprint.sha256 !== stage.sha256 || fingerprint.bytes !== stage.bytes) throw new AppError('暂存副本发生变化，未导入。')
          const metadata = await validateMedia(stage.path, kind, fingerprint, tools)
          const duplicate = this.duplicate(kind, fingerprint.sha256)
          const record: LibraryRecord = duplicate ? structuredClone(duplicate) : {
            version: 1, item: { id: randomUUID(), kind, name, createdAt: new Date().toISOString(), available: false, problem: pendingProblem, origins: [] }, locations: [], importPaths: []
          }
          if (!record.importPaths.some(file => samePath(file, source))) {
            record.importPaths.push(path.resolve(source)); record.item.origins.push({ type: 'import', name })
          }
          if (!record.locations.some(location => location.type === 'managed')) {
            await assertFingerprint(stage.path, fingerprint)
            const saved = await stage.publish(record.item.id, metadata.format)
            record.locations.unshift({ type: 'managed', fileName: saved.fileName })
          } else {
            // Never overwrite a missing/changed managed original under the guise of a duplicate import.
            const managed = record.locations.find(location => location.type === 'managed')!
            const existing = await fingerprintFile(await this.resolveLocation(record, managed), kind)
            if (existing.sha256 !== fingerprint.sha256) throw new AppError('已登记的托管副本缺失或指纹变化，请先恢复原文件；重复导入不会覆盖。')
          }
          await this.commit(this.validated(record, fingerprint, metadata))
          result.entries.push({ name, status: duplicate ? 'duplicate' : 'imported', assetId: record.item.id })
        } catch (error) {
          result.entries.push({ name, status: 'failed', error: error instanceof AppError ? error.message : '素材复制或发布失败（不会覆盖已有文件），请检查源文件、存储空间、目录权限及同卷硬链接支持。' })
        }
        finally { await stage?.dispose() }
      }
      return result
    })
  }

  private async registerSource(source: ProjectLibrarySource, tools: ToolResolver): Promise<void> {
    if (this.findSource(source.location.projectId, source.location.assetId)) return
    let record: LibraryRecord = {
      version: 1, item: { id: randomUUID(), kind: source.kind, name: source.name, createdAt: source.createdAt, available: false, problem: pendingProblem, origins: [source.origin] },
      locations: [source.location], importPaths: []
    }
    if (!libraryRecordSchema.safeParse(record).success) throw new AppError('项目素材来源数据无效，未登记。')
    try {
      const file = await this.resolveLocation(record, source.location)
      const fingerprint = await fingerprintFile(file, source.kind)
      record.item.sha256 = fingerprint.sha256; record.item.bytes = fingerprint.bytes
      const duplicate = this.duplicate(source.kind, fingerprint.sha256)
      if (duplicate) {
        record = structuredClone(duplicate)
        record.item.origins.push(source.origin); record.locations.push(source.location)
        if (duplicate.item.available) { await assertFingerprint(file, fingerprint) }
        else record = this.validated(record, fingerprint, await validateMedia(file, source.kind, fingerprint, tools))
      } else record = this.validated(record, fingerprint, await validateMedia(file, source.kind, fingerprint, tools))
    } catch (error) {
      if (!record.item.available) record.item.problem = error instanceof AppError ? error.message : '项目素材缺失、损坏或路径不安全，原记录已保留。'
    }
    await this.commit(record)
  }
  private async sync(project: Project, tools: ToolResolver): Promise<void> {
    await this.recoverPending()
    const sources = projectLibrarySources(project)
    const signature = projectLibrarySignature(sources)
    if (this.signatures.get(project.id) === signature) return
    for (const source of sources) await this.registerSource(source, tools)
    this.signatures.set(project.id, signature)
  }
  async syncProject(project: Project): Promise<void> {
    const snapshot = structuredClone(project)
    return this.queue.run(async () => {
      this.ready()
      try { await this.sync(snapshot, libraryTools(this.options.getFFmpegPath)) } catch (error) {
        this.warn(`项目 ${snapshot.id} 生成成功，入库待恢复；请刷新重试本地登记，不要重新生成。`)
        throw error
      }
    })
  }
  async refresh(): Promise<void> {
    return this.queue.run(async () => {
      this.ready(); await this.recoverPending()
      const tools = libraryTools(this.options.getFFmpegPath)
      for (const project of await this.options.projects.all()) await this.sync(project, tools)
      for (const id of [...this.records.keys()]) {
        if (this.records.get(id)?.aliasOf) continue
        const checked = await this.check(this.current(id), tools)
        await this.commit(checked.record)
        if (checked.path) await this.mergeRecovered(checked.record)
      }
    })
  }

  private async hasEntries(directory: string): Promise<boolean> {
    try {
      await safeLibraryPath(directory, true)
      for await (const _entry of await opendir(directory)) return true
      return false
    } catch (error) { if (isMissing(error)) return false; throw new AppError('存储目录不可安全检查，不能更换素材库位置。') }
  }
  async configureRoot(root: string): Promise<LibraryConfig> {
    return this.queue.run(async () => {
      this.ready(); await this.recoverPending()
      const config = libraryConfigSchema.safeParse({ ...this.config, root })
      if (!config.success) throw new AppError('素材库目录必须是安全的本地绝对路径。')
      if (samePath(root, this.config.root)) return structuredClone(this.config)
      if ([...this.records.values()].some(record => record.locations.some(location => location.type === 'managed'))) throw new AppError('已有托管素材，不能更换素材库目录；不会移动或重定位现有文件。')
      for (const folder of ['audio', 'images', '.staging']) {
        if (await this.hasEntries(path.join(this.config.root, folder))) throw new AppError('已有托管文件或未完成导入，不能更换素材库目录。')
      }
      for (const folder of ['batches', 'video-batches']) {
        try { await safeLibraryPath(path.join(this.config.root, folder), true); throw new AppError('已有批量输出目录，不能更换素材库位置或重定位输出。') } catch (error) { if (!isMissing(error)) throw error }
      }
      await ensureLibraryDirectory(root)
      try { await this.write(this.configPath, config.data, LIBRARY_LIMITS.configBytes) } catch { throw new AppError('素材库配置保存失败，原目录未更改。') }
      this.config = config.data; this.notify()
      return structuredClone(this.config)
    })
  }
  async setGenerationProject(id: string): Promise<void> {
    return this.queue.run(async () => {
      this.ready()
      if (!idSchema.safeParse(id).success || (await this.options.projects.get(id)).id !== id) throw new AppError('素材生成项目标识无效或项目不存在。')
      if (this.config.generationProjectId === id) return
      const next = { ...this.config, generationProjectId: id }
      try { await this.write(this.configPath, next, LIBRARY_LIMITS.configBytes) } catch { throw new AppError('素材生成项目配置保存失败。') }
      this.config = next; this.notify()
    })
  }
}
