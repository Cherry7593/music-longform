import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ImageDraft, MusicDraft, Project, Settings, VideoDraft } from '../../shared/types'
import type { VideoBatch, BatchPlan } from '../../shared/library-types'
import type { AssetOrigin, CompositionDraft, CompositionProject, EntryDraft, ExecutionBatch, GenerationEntry, GenerationProject, GenerationRequest, GenerationSubmission, UsageRecord, WorkbenchSettings } from '../../shared/workbench-types'
import { apiRecordSchema, compositionProjectSchema, entrySchema, executionBatchSchema, generationProjectSchema, requestSchema, submissionSchema, workbenchSettingsSchema } from '../../shared/workbench-schemas'
import { videoBatchSchema } from '../../shared/batch-schemas'
import { decodeLegacyProject, decodeLegacySettings, legacyDefaultAceStep, legacyProjectIndexSchema, legacyReceiptSchema, legacySecretsSchema, stableMigrationId, type DecodedProject, type LegacyReceipt } from '../migration/legacy-decode'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, SerialQueue } from './atomic'
import { libraryConfigSchema, libraryIndexSchema, libraryRecordSchema, localLibraryPath, type LibraryRecord } from './library-validation'
import type { AssetRegistration, AssetStore } from './assets-v2'
import type { SecretStore } from './secrets'
import type { Change, Table, WorkbenchDB } from './workbench-db'

export interface V4MigrationInspection { mediaRoot: string; legacySettings?: Settings; warnings: string[] }
export interface V4MigrationOptions {
  dataDir: string; defaultMediaRoot: string
  db: Pick<WorkbenchDB, 'commit' | 'get' | 'has' | 'list'>
  assets: Pick<AssetStore, 'registerRoot' | 'register' | 'alias' | 'get' | 'recordUsage' | 'allUsage'>
  secrets: Pick<SecretStore, 'has'>
}
const LIMIT = 32 * 1024 * 1024, TOTAL_LIMIT = 256 * 1024 * 1024
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/)
const localPath = z.string().refine(localLibraryPath)
const warningsSchema = z.array(z.string().max(2000)).max(2000)
const journalSchema = z.object({ version: z.literal(4), startedAt: z.iso.datetime(), mediaRoot: localPath, backupHash: digest,
  step: z.enum(['backed-up', 'assets', 'records', 'complete']), mappings: z.record(z.string(), uuid), canonical: z.record(z.string(), uuid),
  reconciled: z.array(uuid), warnings: warningsSchema }).strict()
const markerSchema = z.object({ version: z.literal(4), completedAt: z.iso.datetime(), mediaRoot: localPath, warnings: warningsSchema,
  counts: z.record(z.string(), z.number().int().nonnegative()) }).strict()
const manifestSchema = z.object({ version: z.literal(4), sources: z.array(z.object({ source: localPath,
  backup: z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9]{64}\.bak$/), sha256: digest, bytes: z.number().int().nonnegative().max(LIMIT) }).strict()).max(200000) }).strict()
type Journal = z.infer<typeof journalSchema>
interface Source { source: string; bytes: Buffer }
interface Snapshot extends V4MigrationInspection {
  sources: Source[]; projects: DecodedProject[]; records: LibraryRecord[]; batches: VideoBatch[]; receipts: LegacyReceipt[]
  config?: z.infer<typeof libraryConfigSchema>
}
const queues = new Map<string, SerialQueue>()
const inspectedSecrets = new Map<string, Source>()
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const unique = <T>(values: T[]): T[] => [...new Set(values)]
const keyPath = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const sourceError = (file: string, reason = '损坏、缺失或不可读取') => new AppError(`V4 迁移停止：${file} ${reason}；原数据未覆盖，不会替换为空库。`)
function warn(warnings: string[], text: string): void { if (!warnings.includes(text) && warnings.length < 2000) warnings.push(text.slice(0, 2000)) }

/** No symlink/junction traversal, including missing media descendants. No directory creation. */
async function safePath(file: string, directory = false): Promise<boolean> {
  if (!localLibraryPath(file)) throw sourceError(file, '路径不安全')
  const parent = path.dirname(file)
  if (parent !== file) await safePath(parent, true)
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw sourceError(file, '路径被重定向或类型不符')
    return true
  } catch (error) { if (isMissing(error)) return false; throw error }
}
async function bytesAt(file: string, maximum = LIMIT): Promise<Buffer | undefined> {
  if (!await safePath(file)) return undefined
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) throw sourceError(file, '文件超限')
    const chunks: Buffer[] = []; let total = 0
    for (;;) {
      const part = Buffer.alloc(Math.min(64 * 1024, maximum - total + 1)), read = await handle.read(part)
      if (!read.bytesRead) break
      total += read.bytesRead; if (total > maximum) throw sourceError(file, '文件超限')
      chunks.push(part.subarray(0, read.bytesRead))
    }
    const after = await handle.stat(), current = await lstat(file)
    if (total !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.isSymbolicLink()) throw sourceError(file, '读取时发生变化')
    return Buffer.concat(chunks, total)
  } finally { await handle.close() }
}
async function optional<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try { const bytes = await bytesAt(file); return bytes === undefined ? undefined : schema.parse(JSON.parse(bytes.toString('utf8'))) }
  catch { throw sourceError(file) }
}
class Sources {
  readonly files = new Map<string, Source>()
  private total = 0
  constructor(private readonly saved?: Map<string, Source>) { }
  async read(file: string, required = false): Promise<unknown | undefined> {
    try {
      const bytes = this.saved ? this.saved.get(keyPath(file))?.bytes : await bytesAt(file)
      if (bytes === undefined) { if (required) throw sourceError(file); return undefined }
      if (!this.files.has(keyPath(file))) {
        this.total += bytes.length; if (this.total > TOTAL_LIMIT) throw sourceError(file, '来源元数据总量超限')
        this.files.set(keyPath(file), { source: file, bytes })
      }
      return JSON.parse(bytes.toString('utf8')) as unknown
    } catch { throw sourceError(file) }
  }
  async names(directory: string): Promise<string[]> {
    if (this.saved) return [...this.saved.values()].filter(item => keyPath(path.dirname(item.source)) === keyPath(directory)).map(item => path.basename(item.source)).sort()
    try {
      if (!await safePath(directory, true)) return []
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.length > 101000) throw sourceError(directory, '记录数量超限')
      return entries.filter(entry => !(entry.name.startsWith('.') && entry.name.endsWith('.tmp'))).map(entry => entry.name).sort()
    } catch { throw sourceError(directory) }
  }
}
async function readSnapshot(dataDir: string, defaultMediaRoot: string, saved?: Map<string, Source>): Promise<Snapshot> {
  const source = new Sources(saved), warnings: string[] = []
  const parse = <T>(file: string, schema: z.ZodType<T>, value: unknown): T => { try { return schema.parse(value) } catch { throw sourceError(file, '结构或引用不兼容') } }
  const settingsFile = path.join(dataDir, 'settings.json'), rawSettings = await source.read(settingsFile)
  let legacySettings: Settings | undefined
  if (rawSettings !== undefined) { try { legacySettings = decodeLegacySettings(rawSettings) } catch { throw sourceError(settingsFile, '不是可解码的 V1–V4 设置（V5 必须有迁移日志）') } }
  const configFile = path.join(dataDir, 'library', 'config.json'), rawConfig = await source.read(configFile)
  const config = rawConfig === undefined ? undefined : parse(configFile, libraryConfigSchema, rawConfig)
  const mediaRoot = config?.root ?? (legacySettings ? path.join(legacySettings.projectRoot, '总素材库') : defaultMediaRoot)
  if (!localLibraryPath(mediaRoot)) throw sourceError(mediaRoot, '媒体根不安全')
  const projectIndex = path.join(dataDir, 'projects.json'), rawIndex = await source.read(projectIndex)
  const index = rawIndex === undefined ? { projects: [] } : parse(projectIndex, legacyProjectIndexSchema, rawIndex)
  const projects: DecodedProject[] = []
  for (const registration of index.projects) {
    const file = path.join(registration.directory, 'project.json'), raw = await source.read(file, true)
    try { projects.push(decodeLegacyProject(raw, registration.directory, registration.id)) } catch { throw sourceError(file, '项目结构、标识或引用不兼容') }
  }
  for (const reference of [config?.generationProjectId, legacySettings?.lastProjectId]) if (reference && !projects.some(item => item.project.id === reference)) throw sourceError(projectIndex, `项目 ${reference} 详情缺失`)
  const libraryIndex = path.join(dataDir, 'library', 'index.json'), rawLibraryIndex = await source.read(libraryIndex)
  const libraryIds = rawLibraryIndex === undefined ? [] : parse(libraryIndex, libraryIndexSchema, rawLibraryIndex).ids
  const records: LibraryRecord[] = []
  for (const name of await source.names(path.join(dataDir, 'library', 'items'))) {
    const file = path.join(dataDir, 'library', 'items', name)
    if (!name.endsWith('.json') || !uuid.safeParse(name.slice(0, -5)).success) throw sourceError(file, '详情文件名不安全')
    const record = parse(file, libraryRecordSchema, await source.read(file, true))
    if (record.item.id !== name.slice(0, -5)) throw sourceError(file, '详情标识不匹配')
    records.push(record)
  }
  if ((!config && (libraryIds.length || records.length)) || libraryIds.some(id => !records.some(record => record.item.id === id))) throw sourceError(libraryIndex, '配置或索引引用的详情缺失')
  const byId = new Map(records.map(record => [record.item.id, record]))
  for (const record of records) {
    const seen = new Set<string>(); let current = record
    while (current.aliasOf) {
      if (seen.has(current.item.id)) throw sourceError(libraryIndex, '资产别名循环')
      seen.add(current.item.id)
      const target = byId.get(current.aliasOf)
      if (!target || target.item.kind !== record.item.kind || !record.item.sha256 || target.item.sha256 !== record.item.sha256) throw sourceError(libraryIndex, '别名目标缺失或指纹冲突')
      current = target
    }
  }
  const batches: VideoBatch[] = [], batchDirectory = path.join(dataDir, 'video-batches')
  const batchIndexFile = path.join(batchDirectory, 'index.json'), rawBatchIndex = await source.read(batchIndexFile)
  const batchIds = rawBatchIndex === undefined ? [] : parse(batchIndexFile, libraryIndexSchema, rawBatchIndex).ids
  for (const name of (await source.names(batchDirectory)).filter(name => name !== 'index.json')) {
    const file = path.join(batchDirectory, name)
    if (!name.endsWith('.json') || !uuid.safeParse(name.slice(0, -5)).success) throw sourceError(file, '批次文件名不安全')
    const batch = parse(file, videoBatchSchema, await source.read(file, true))
    if (batch.id !== name.slice(0, -5) || !localLibraryPath(batch.directory) || !path.basename(batch.directory).endsWith(`-${batch.id}`)) throw sourceError(file, '批次标识或目录不安全')
    if (batch.plan.assets.some(asset => !byId.has(asset.id)) || [...batch.plan.request.audioIds, ...batch.plan.request.imageIds, ...batch.jobs.flatMap(job => [...job.group.audioIds, job.group.imageId])].some(id => !batch.plan.assets.some(asset => asset.id === id))) throw sourceError(file, '批次素材快照或库详情缺失')
    batches.push(batch)
  }
  if (batchIds.some(id => !batches.some(batch => batch.id === id))) throw sourceError(batchIndexFile, '批次详情缺失')
  const receipts: LegacyReceipt[] = []
  for (const name of await source.names(path.join(dataDir, 'export-receipts'))) {
    const file = path.join(dataDir, 'export-receipts', name), receipt = parse(file, legacyReceiptSchema, await source.read(file, true))
    if (name !== `${receipt.id}.json`) throw sourceError(file, '回执标识不一致')
    receipts.push(receipt)
  }
  const publications = new Map<string, string>()
  const claimPublication = (id: string, kind: 'batch' | 'project', ownerId: string, directory: string) => {
    const identity = `${kind}/${ownerId}/${keyPath(directory)}`, previous = publications.get(id)
    if (previous && previous !== identity) throw sourceError(directory, `成片发布 ID ${id} 的所有者或目录冲突`)
    publications.set(id, identity)
  }
  for (const { project } of projects) for (const job of project.videoJobs) if (job.kind === 'video') claimPublication(job.id, 'project', project.id, project.directory)
  for (const batch of batches) for (const job of batch.jobs) claimPublication(job.id, 'batch', batch.id, batch.directory)
  for (const receipt of receipts) claimPublication(receipt.id, receipt.kind, receipt.ownerId, receipt.directory)
  // SecretStore can upgrade V1/V2 before migrateV4. Preserve its exact originals too, never decrypt.
  const secretNames = ['secrets.json', ...(await source.names(dataDir)).filter(name => /^secrets\.json\.v[12]-[a-f0-9-]{36}\.bak$/.test(name))]
  for (const name of unique(secretNames)) {
    const file = path.join(dataDir, name), raw = await source.read(file)
    if (raw !== undefined) parse(file, legacySecretsSchema, raw)
  }
  if (!config && !legacySettings && (rawIndex !== undefined || rawLibraryIndex !== undefined || rawBatchIndex !== undefined || receipts.length)) throw sourceError(settingsFile, '已有旧数据但媒体根设置缺失，不能使用新安装默认目录')
  for (const { project } of projects) for (const job of project.musicJobs) for (const output of job.outputs ?? []) {
    if (output.status === 'saved' && !project.audio.some(asset => asset.id === output.assetId) && !records.some(record => record.item.origins.some(origin => origin.projectId === project.id && origin.assetId === output.assetId))) throw sourceError(project.directory, `已保存结果 ${output.assetId} 的素材详情缺失`)
  }
  if (records.some(record => !libraryIds.includes(record.item.id))) warn(warnings, '旧素材库存在已保存但未入索引的详情，已纳入迁移；旧索引保持原样。')
  if (batches.some(batch => !batchIds.includes(batch.id))) warn(warnings, '旧批次存在未入索引的详情，已纳入迁移；旧索引保持原样。')
  return { mediaRoot, legacySettings, config, projects, records, batches, receipts, warnings, sources: [...source.files.values()] }
}
const migrationDir = (dataDir: string) => path.join(dataDir, 'migration-v4')
async function readArchive(dataDir: string, journal: Journal): Promise<Map<string, Source>> {
  const directory = path.join(migrationDir(dataDir), 'backup'), manifestFile = path.join(directory, 'manifest.json'), bytes = await bytesAt(manifestFile)
  if (!bytes || sha(bytes) !== journal.backupHash) throw sourceError(manifestFile, '备份清单指纹不符')
  let manifest: z.infer<typeof manifestSchema>
  try { manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8'))) } catch { throw sourceError(manifestFile) }
  const saved = new Map<string, Source>(); let total = 0
  for (const entry of manifest.sources) {
    const file = path.join(directory, entry.backup), data = await bytesAt(file)
    if (!data || data.length !== entry.bytes || sha(data) !== entry.sha256 || saved.has(keyPath(entry.source))) throw sourceError(file, '备份内容或来源映射不符')
    total += data.length; if (total > TOTAL_LIMIT) throw sourceError(file, '备份总量超限')
    saved.set(keyPath(entry.source), { source: entry.source, bytes: data })
  }
  return saved
}
async function ensureDirectory(directory: string): Promise<void> { await safePath(directory, true); await mkdir(directory, { recursive: true }); await safePath(directory, true) }
async function exclusive(file: string, bytes: Buffer): Promise<void> {
  await safePath(file)
  try {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw sourceError(file, '独占备份失败')
    const existing = await bytesAt(file)
    if (!existing?.equals(bytes)) throw sourceError(file, '独占备份已存在且内容不一致')
  }
}
async function backup(dataDir: string, snapshot: Snapshot): Promise<string> {
  const directory = path.join(migrationDir(dataDir), 'backup'); await ensureDirectory(directory)
  const sources = snapshot.sources.slice()
  const originalSecret = inspectedSecrets.get(keyPath(dataDir))
  if (originalSecret && !sources.some(item => item.bytes.equals(originalSecret.bytes) && /secrets\.json(?:\.|$)/.test(path.basename(item.source)))) {
    throw sourceError(originalSecret.source, 'SecretStore 升级后的原始密文备份缺失，拒绝伪造来源路径')
  }
  const manifest: z.infer<typeof manifestSchema> = { version: 4, sources: [] }
  for (const source of sources.sort((a, b) => a.source.localeCompare(b.source))) {
    const hash = sha(source.bytes), name = `${stableMigrationId(keyPath(source.source))}.${hash}.bak`
    await exclusive(path.join(directory, name), source.bytes)
    manifest.sources.push({ source: source.source, backup: name, sha256: hash, bytes: source.bytes.length })
  }
  const bytes = Buffer.from(`${JSON.stringify(manifestSchema.parse(manifest), null, 2)}\n`)
  await exclusive(path.join(directory, 'manifest.json'), bytes)
  return sha(bytes)
}

/** Read-only preflight; call before constructing AssetStore. No ProjectStore, provider or media mutation. */
export async function inspectV4Migration(dataDir: string, defaultMediaRoot: string): Promise<V4MigrationInspection> {
  const directory = migrationDir(dataDir), marker = await optional(path.join(directory, 'complete.json'), markerSchema)
  if (marker) {
    const settings = await optional(path.join(dataDir, 'workbench', 'settings', 'current.json'), workbenchSettingsSchema)
    if (!settings) throw sourceError(path.join(dataDir, 'workbench', 'settings', 'current.json'), '已完成迁移但权威设置缺失')
    return { mediaRoot: settings.mediaRoot, warnings: marker.warnings }
  }
  const journal = await optional(path.join(directory, 'journal.json'), journalSchema)
  const snapshot = await readSnapshot(dataDir, journal?.mediaRoot ?? defaultMediaRoot, journal ? await readArchive(dataDir, journal) : undefined)
  if (journal && journal.mediaRoot !== snapshot.mediaRoot) throw sourceError(directory, '日志与备份媒体根不一致')
  const secret = snapshot.sources.find(source => keyPath(source.source) === keyPath(path.join(dataDir, 'secrets.json')))
  if (secret) inspectedSecrets.set(keyPath(dataDir), secret)
  return { mediaRoot: snapshot.mediaRoot, legacySettings: snapshot.legacySettings, warnings: journal?.warnings ?? snapshot.warnings }
}
function mapped(journal: Journal, key: string, preferred?: string): string { return journal.mappings[key] ??= preferred ?? stableMigrationId(key) }
function reserveIdentities(snapshot: Snapshot, journal: Journal): void {
  const counts = (ids: string[]) => { const result = new Map<string, number>(); for (const id of ids) result.set(id, (result.get(id) ?? 0) + 1); return result }
  const requests = counts(snapshot.projects.flatMap(({ project }) => [...project.musicJobs, ...project.imageJobs].map(job => job.id)))
  const submissions = counts(snapshot.projects.flatMap(({ project }) => project.batches.map(batch => batch.id)))
  for (const { project } of snapshot.projects) {
    mapped(journal, `generation/${project.id}`, project.id)
    for (const kind of ['audio', 'image']) mapped(journal, `draft/${project.id}/${kind}`)
    for (const job of [...project.musicJobs, ...project.imageJobs]) {
      mapped(journal, `request/${project.id}/${job.id}`, requests.get(job.id) === 1 ? job.id : undefined)
      mapped(journal, `entry/${project.id}/${job.id}`)
      if ('batchId' in job) mapped(journal, `submission/${project.id}/${job.batchId}`, submissions.get(job.batchId) === 1 ? job.batchId : undefined)
      else mapped(journal, `submission/image/${project.id}/${job.id}`)
    }
    for (const asset of [...project.audio, ...project.images]) mapped(journal, assetKey(project.id, asset.id))
  }
}
const assetKey = (project: string, id: string) => `asset/${project}/${id}`
const libraryKey = (id: string) => `library/${id}`
const videoKey = (id: string) => `video/${id}`
function baseLibrary(record: LibraryRecord, records: Map<string, LibraryRecord>): string { let current = record; while (current.aliasOf) current = records.get(current.aliasOf)!; return current.item.id }
function musicDraft(draft: MusicDraft): EntryDraft { const { count: _count, ...rest } = draft; void _count; return rest }
function imageDraft(draft: ImageDraft, provider?: 'siliconflow'): EntryDraft { return { model: draft.model, prompt: draft.prompt, size: draft.size, ...(provider ? { provider } : {}) } }
function relatedAudio(asset: Project['audio'][number]): string[] {
  return [...(asset.originalFileName ? [asset.originalFileName] : []), ...['manifest.json', 'source.bin', 'compatible.flac', 'download.part'].map(name => `.generated-audio/${asset.id}/${name}`)]
}
async function reconcileReceipts(snapshot: Snapshot, journal: Journal): Promise<void> {
  for (const receipt of snapshot.receipts) {
    if (receipt.state === 'committed') { journal.reconciled.push(receipt.id); continue }
    const file = path.join(receipt.directory, receipt.fileName)
    if (!await safePath(file)) { warn(journal.warnings, `成片回执 ${receipt.id} 尚未发现发布文件，保留待核对，不重新渲染。`); continue }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), hash = createHash('sha256'); let total = 0
    try {
      const before = await handle.stat(), buffer = Buffer.alloc(1024 * 1024)
      if (before.size !== receipt.bytes) throw sourceError(file, 'prepared 回执与文件大小不符')
      for (;;) { const read = await handle.read(buffer); if (!read.bytesRead) break; total += read.bytesRead; if (total > receipt.bytes) throw sourceError(file, '成片核对期间变更'); hash.update(buffer.subarray(0, read.bytesRead)) }
      const after = await handle.stat(), current = await lstat(file)
      if (total !== receipt.bytes || hash.digest('hex') !== receipt.sha256 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.isSymbolicLink()) throw sourceError(file, 'prepared 回执指纹不符')
    } finally { await handle.close() }
    journal.reconciled.push(receipt.id)
    warn(journal.warnings, `成片回执 ${receipt.id} 已按原文件指纹对账，仅登记资产和使用记录，不重新渲染。`)
  }
  journal.reconciled = unique(journal.reconciled)
}
async function registerAssets(snapshot: Snapshot, journal: Journal, assets: V4MigrationOptions['assets']): Promise<void> {
  const records = new Map(snapshot.records.map(record => [record.item.id, record])), roots = new Map<string, string>()
  const root = async (directory: string) => {
    const key = keyPath(directory)
    if (!roots.has(key)) roots.set(key, await assets.registerRoot(directory, true))
    return roots.get(key)!
  }
  const register = async (key: string, directory: string, input: Omit<AssetRegistration, 'rootId' | 'allowMissing'>) => {
    const asset = await assets.register({ ...input, rootId: await root(directory), allowMissing: true })
    journal.canonical[key] = asset.id
    if (!asset.available) warn(journal.warnings, `素材 ${input.id} 文件缺失或不可用；已保留原位占位记录和历史关系。`)
    return asset.id
  }
  await root(snapshot.mediaRoot)
  for (const record of snapshot.records.slice().sort((a, b) => Number(!!a.aliasOf) - Number(!!b.aliasOf) || a.item.id.localeCompare(b.item.id))) {
    const targetId = baseLibrary(record, records), target = records.get(targetId)!, item = record.item
    for (const location of record.locations) {
      const directory = location.type === 'managed' ? snapshot.mediaRoot : location.directory
      const audio = location.type === 'project' && item.kind === 'audio' ? snapshot.projects.find(p => p.project.id === location.projectId)?.project.audio.find(a => a.id === location.assetId) : undefined
      const matchingOrigins = item.origins.filter(origin => origin.type === 'import'
        ? location.type === 'managed' || location === record.locations[0] && !record.locations.some(candidate => candidate.type === 'managed')
        : location.type === 'project' && origin.projectId === location.projectId && origin.assetId === location.assetId)
      for (const oldOrigin of matchingOrigins.length ? matchingOrigins : [item.origins[0]]) {
        const { assetId: legacyAssetId, type, ...rest } = oldOrigin
        const origin: AssetOrigin = { ...rest, type: type === 'import' ? 'import' : 'legacy', ...(legacyAssetId ? { legacyAssetId } : {}) }
        await register(libraryKey(item.id), directory, { id: targetId, kind: item.kind, name: target.item.name, createdAt: target.item.createdAt, origin, fileName: location.fileName,
          expectedSha256: item.sha256, metadata: { format: item.format, durationSeconds: item.durationSeconds, width: item.width, height: item.height }, ...(audio ? { relatedFiles: relatedAudio(audio) } : {}) })
      }
    }
    if (item.id !== targetId) await assets.alias(item.id, journal.canonical[libraryKey(item.id)])
  }
  for (const record of snapshot.records) {
    const canonical = (await assets.get(record.item.id)).id; journal.canonical[libraryKey(record.item.id)] = canonical
    for (const origin of record.item.origins) if (origin.type === 'project') {
      const key = assetKey(origin.projectId!, origin.assetId!), previous = journal.canonical[key]
      if (previous && previous !== canonical) throw sourceError(origin.projectId!, '项目素材被多个不同库资产认领')
      journal.canonical[key] = canonical
    }
  }
  for (const { project } of snapshot.projects) {
    journal.canonical[`root/${project.id}`] = await root(project.directory)
    for (const kind of ['audio', 'image'] as const) for (const asset of kind === 'audio' ? project.audio : project.images) {
      const key = assetKey(project.id, asset.id), id = journal.canonical[key] ?? mapped(journal, key)
      const requestExists = (kind === 'audio' ? project.musicJobs : project.imageJobs).some(job => job.id === asset.jobId)
      const origin: AssetOrigin = { type: 'generation', name: project.name, projectId: project.id, legacyAssetId: asset.id, provider: asset.provider, model: asset.model, prompt: asset.prompt,
        ...(requestExists ? { requestId: mapped(journal, `request/${project.id}/${asset.jobId}`, asset.jobId), entryId: mapped(journal, `entry/${project.id}/${asset.jobId}`) } : {}) }
      await register(key, project.directory, { id, kind, name: ('title' in asset && asset.title) || path.posix.basename(asset.fileName), createdAt: asset.createdAt, origin, fileName: asset.fileName,
        ...(kind === 'audio' && 'durationMs' in asset ? { metadata: { durationSeconds: asset.durationMs > 0 ? asset.durationMs / 1000 : undefined }, relatedFiles: relatedAudio(asset) } : {}) })
    }
  }
  const videos = new Map<string, { directory: string; fileName: string; createdAt: string; durationSeconds: number; origin: AssetOrigin; sha256?: string }>()
  for (const batch of snapshot.batches) for (const job of batch.jobs) if (job.status === 'succeeded') videos.set(job.id, { directory: batch.directory, fileName: job.fileName!, createdAt: job.finishedAt ?? batch.updatedAt,
    durationSeconds: job.durationSeconds!, origin: { type: 'composition', name: batch.name, projectId: mapped(journal, `composition/batch/${batch.id}`), batchId: batch.id } })
  for (const { project } of snapshot.projects) for (const job of project.videoJobs) if (job.kind === 'video' && job.status === 'succeeded') videos.set(job.id, {
    directory: project.directory, fileName: job.fileName!, createdAt: job.finishedAt ?? project.updatedAt, durationSeconds: job.durationSeconds!, origin: { type: 'legacy', name: project.name, projectId: mapped(journal, `composition/single/${project.id}`) } })
  for (const receipt of snapshot.receipts.filter(receipt => journal.reconciled.includes(receipt.id))) videos.set(receipt.id, { directory: receipt.directory, fileName: receipt.fileName, createdAt: receipt.finishedAt,
    durationSeconds: receipt.durationSeconds, sha256: receipt.sha256, origin: { type: 'legacy', name: receipt.name,
      projectId: mapped(journal, receipt.kind === 'batch' ? `composition/batch/${receipt.ownerId}` : `composition/single/${receipt.ownerId}`), ...(receipt.kind === 'batch' ? { batchId: receipt.ownerId } : {}) } })
  for (const [id, video] of videos) await register(videoKey(id), video.directory, { id: mapped(journal, videoKey(id), records.has(id) ? undefined : id), kind: 'video',
    name: path.posix.basename(video.fileName), createdAt: video.createdAt, origin: video.origin, fileName: video.fileName, expectedSha256: video.sha256, metadata: { format: 'mp4', durationSeconds: video.durationSeconds } })
  // Later duplicate proofs can redirect earlier placeholders; persist final canonical IDs once.
  for (const [key, id] of Object.entries(journal.canonical)) if (!key.startsWith('root/')) journal.canonical[key] = (await assets.get(id)).id
}
function generationChanges(snapshot: Snapshot, journal: Journal): Change[] {
  const changes: Change[] = []
  for (const { project, sourceVersion } of snapshot.projects) {
    const entries: GenerationEntry[] = [], submissions = new Map<string, GenerationSubmission>()
    const base = { version: 1 as const, projectId: project.id, revision: 0, createdAt: project.createdAt, updatedAt: project.updatedAt, alternatives: {} }
    for (const kind of ['audio', 'image'] as const) entries.push({ ...base, id: mapped(journal, `draft/${project.id}/${kind}`), kind,
      draft: kind === 'audio' ? musicDraft(project.music) : imageDraft(project.image, sourceVersion >= 3 ? 'siliconflow' : undefined) })
    for (const kind of ['audio', 'image'] as const) for (const job of kind === 'audio' ? project.musicJobs : project.imageJobs) {
      const id = mapped(journal, `request/${project.id}/${job.id}`, job.id), entryId = mapped(journal, `entry/${project.id}/${job.id}`)
      const submissionId = 'batchId' in job ? mapped(journal, `submission/${project.id}/${job.batchId}`, job.batchId) : mapped(journal, `submission/image/${project.id}/${job.id}`)
      const taskId = 'taskId' in job ? job.taskId : undefined, oldImage = 'provider' in job && job.provider === 'openai'
      const draft = 'binding' in job ? musicDraft(job.snapshot) : imageDraft(job.snapshot, job.provider === 'siliconflow' ? 'siliconflow' : undefined)
      const terminal = ['succeeded', 'failed', 'unknown', 'cancelled'].includes(job.status)
      const status: GenerationRequest['status'] = terminal ? job.status as GenerationRequest['status'] : job.status === 'pending' || taskId ? 'paused' : 'unknown'
      const saved = (kind === 'audio' ? project.audio : project.images).filter(asset => asset.jobId === job.id).map(asset => journal.canonical[assetKey(project.id, asset.id)])
      if ('outputs' in job) for (const output of job.outputs ?? []) if (output.status === 'saved') saved.push(journal.canonical[assetKey(project.id, output.assetId)] ?? output.assetId)
      const request: GenerationRequest = { version: 1, id, entryId, projectId: project.id, submissionId, createdAt: job.createdAt, updatedAt: project.updatedAt, kind, status, snapshot: draft,
        binding: 'binding' in job ? job.binding : { provider: job.provider, adapterVersion: 1 }, taskId, actualModel: 'actualModel' in job ? job.actualModel : undefined,
        assetIds: unique(saved), error: job.error, ...('outputs' in job && job.outputs ? { outputs: job.outputs.map(output => ({ ...output, assetId: journal.canonical[assetKey(project.id, output.assetId)] ?? output.assetId })) } : {}),
        recoverable: taskId ? (!terminal || ('recoverable' in job && job.recoverable)) : false, storageRootId: journal.canonical[`root/${project.id}`], ...(oldImage ? { legacyImage: true } : {}) }
      if (!terminal) request.detail = job.status === 'pending' ? '旧队列尚未提交，迁移后暂停；必须明确确认才可提交。' : taskId ? '旧任务已受理，迁移后暂停；仅可查询原任务和保存结果，不能重新提交。' : '旧请求受理状态未知，可能已计费；请核对原服务商，不会自动重发。'
      else if ('detail' in job) request.detail = job.detail
      entries.push({ ...base, id: entryId, kind, createdAt: job.createdAt, draft, requestId: id })
      const submission = submissions.get(submissionId) ?? { version: 1, id: submissionId, projectId: project.id, createdAt: job.createdAt, entries: [] }
      submission.entries.push({ id: entryId, revision: 0, requestId: id }); submissions.set(submissionId, submission)
      changes.push({ table: 'requests', id, value: request })
    }
    const generation: GenerationProject = { version: 1, id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, page: 'audio', entryIds: entries.map(entry => entry.id) }
    mapped(journal, `generation/${project.id}`, project.id)
    changes.push(...entries.map(entry => ({ table: 'entries' as const, id: entry.id, value: entry })), ...[...submissions.values()].map(submission => ({ table: 'submissions' as const, id: submission.id, value: submission })), { table: 'generation', id: project.id, value: generation })
  }
  return changes
}
function compositionChanges(snapshot: Snapshot, journal: Journal): Change[] {
  const changes: Change[] = [], libraryId = (id: string) => journal.canonical[libraryKey(id)] ?? id
  for (const batch of snapshot.batches) {
    const id = mapped(journal, `composition/batch/${batch.id}`)
    const plan: BatchPlan = structuredClone(batch.plan)
    plan.request.audioIds = unique(plan.request.audioIds.map(libraryId)); plan.request.imageIds = unique(plan.request.imageIds.map(libraryId))
    plan.assets = [...new Map(plan.assets.map(asset => [libraryId(asset.id), { ...asset, id: libraryId(asset.id) }])).values()]
    plan.groups = plan.groups.map(group => ({ ...group, imageId: libraryId(group.imageId), audioIds: group.audioIds.map(libraryId) }))
    const { name: _name, ...options } = plan.request; void _name
    const project: CompositionProject = { version: 1, id, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt, revision: 0,
      draft: { ...options, groups: plan.groups.map(group => ({ imageId: group.imageId, audioIds: group.audioIds })) }, batchIds: [batch.id] }
    const unfinished = batch.jobs.some(job => !journal.reconciled.includes(job.id) && !['succeeded', 'failed', 'cancelled'].includes(job.status))
    const execution: ExecutionBatch = { version: 2, id: batch.id, projectId: id, planId: batch.planId, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
      state: batch.state === 'cancelled' ? 'cancelled' : batch.state === 'completed' && !unfinished ? 'partial' : 'paused', plan,
      jobs: batch.jobs.map(job => ({ id: job.id, index: job.index, group: { imageId: libraryId(job.group.imageId), audioIds: job.group.audioIds.map(libraryId) },
        status: journal.reconciled.includes(job.id) ? 'succeeded' : ['pending', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status) ? job.status as ExecutionBatch['jobs'][number]['status'] : 'interrupted',
        progress: job.progress, detail: job.detail, error: job.error, videoAssetId: journal.canonical[videoKey(job.id)], durationSeconds: job.durationSeconds ?? snapshot.receipts.find(receipt => receipt.id === job.id && journal.reconciled.includes(job.id))?.durationSeconds,
        finishedAt: job.finishedAt, attempts: [], queuedAt: batch.createdAt })), ...(unfinished ? { message: '旧批次已暂停，成功发布项不会重跑；请检查未完成项后明确继续。' } : batch.message ? { message: batch.message } : {}) }
    if (execution.state !== 'cancelled' && execution.jobs.every(job => job.status === 'succeeded')) execution.state = 'completed'
    changes.push({ table: 'composition', id, value: project }, { table: 'executions', id: batch.id, value: execution })
  }
  for (const { project } of snapshot.projects) {
    const meaningful = (draft: VideoDraft) => !!draft.audioIds.length || !!draft.imageId
    const candidates: Array<{ key: string; draft: VideoDraft }> = []
    if (meaningful(project.video)) candidates.push({ key: `composition/single/${project.id}`, draft: project.video })
    for (const job of project.videoJobs.filter(job => job.kind === 'video')) if (meaningful(job.snapshot)
      && (!candidates.length || !['succeeded', 'cancelled', 'failed'].includes(job.status)) && !candidates.some(candidate => isDeepStrictEqual(candidate.draft, job.snapshot))) {
      candidates.push({ key: candidates.length ? `composition/single/${project.id}/${job.id}` : `composition/single/${project.id}`, draft: job.snapshot })
    }
    for (const candidate of candidates) {
      const old = candidate.draft, resolve = (id: string) => journal.canonical[assetKey(project.id, id)]
      if (old.audioIds.some(id => !resolve(id)) || old.imageId && !resolve(old.imageId)) throw sourceError(project.directory, '旧单视频快照引用的素材详情缺失')
      const draft: CompositionDraft = { minimumSeconds: 60, transition: old.transition, transitionSeconds: old.transitionSeconds, fadeInSeconds: old.fadeInSeconds,
        fadeOutSeconds: old.fadeOutSeconds, normalize: old.normalize, fit: old.fit, audioIds: unique(old.audioIds.map(resolve)), imageIds: old.imageId ? [resolve(old.imageId)] : [] }
      const id = mapped(journal, candidate.key), value: CompositionProject = { version: 1, id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, revision: 0, draft, batchIds: [],
        migrationNote: '旧单视频选材与顺序已转为整首合成草稿，最短 1 分钟。旧精确裁切、目标时长和试听仅保留在迁移备份；未完成导出不会自动重跑，须重新规划。' }
      changes.push({ table: 'composition', id, value })
    }
  }
  return changes
}
function usageRecords(snapshot: Snapshot, journal: Journal): UsageRecord[] {
  const usages = new Map<string, UsageRecord>(), libraryId = (id: string) => journal.canonical[libraryKey(id)] ?? id
  for (const receipt of snapshot.receipts.filter(receipt => journal.reconciled.includes(receipt.id))) usages.set(receipt.id, {
    version: 2, id: receipt.id, videoId: journal.canonical[videoKey(receipt.id)], projectId: mapped(journal, receipt.kind === 'batch' ? `composition/batch/${receipt.ownerId}` : `composition/single/${receipt.ownerId}`),
    name: receipt.name, finishedAt: receipt.finishedAt, durationSeconds: receipt.durationSeconds, assetIds: unique(receipt.assetIds.map(id => journal.canonical[libraryKey(id)] ?? journal.canonical[assetKey(receipt.ownerId, id)] ?? id)), uncertainAssetIds: [] })
  for (const batch of snapshot.batches) for (const job of batch.jobs) if (job.status === 'succeeded' && !usages.has(job.id)) usages.set(job.id, { version: 2, id: job.id, videoId: journal.canonical[videoKey(job.id)],
    projectId: mapped(journal, `composition/batch/${batch.id}`), name: batch.name, finishedAt: job.finishedAt ?? batch.updatedAt, durationSeconds: job.durationSeconds!,
    assetIds: unique([...job.group.audioIds, job.group.imageId].map(libraryId)), uncertainAssetIds: [] })
  for (const { project } of snapshot.projects) for (const job of project.videoJobs) if (job.kind === 'video' && job.status === 'succeeded' && !usages.has(job.id)) {
    const draft = job.snapshot, resolve = (id: string) => journal.canonical[assetKey(project.id, id)] ?? id
    const certain = draft.durationMode === 'all' ? draft.audioIds : draft.audioIds.slice(0, 1)
    const assetIds = unique([...certain, ...(draft.imageId ? [draft.imageId] : [])].map(resolve))
    usages.set(job.id, { version: 2, id: job.id, videoId: journal.canonical[videoKey(job.id)], projectId: mapped(journal, `composition/single/${project.id}`), name: project.name,
      finishedAt: job.finishedAt ?? project.updatedAt, durationSeconds: job.durationSeconds!, assetIds,
      uncertainAssetIds: draft.durationMode === 'target' ? unique(draft.audioIds.slice(1).map(resolve)).filter(id => !assetIds.includes(id)) : [] })
  }
  return [...usages.values()].map(usage => ({ ...usage, assetIds: usage.assetIds.sort(), uncertainAssetIds: usage.uncertainAssetIds.sort() }))
}
function apiChanges(snapshot: Snapshot, journal: Journal, secrets: V4MigrationOptions['secrets']): Change[] {
  const changes: Change[] = [], stamp = journal.startedAt
  for (const provider of ['mureka', 'kie', 'reapi', 'sunor', 'siliconflow'] as const) if (secrets.has(provider)) changes.push({ table: 'apis', id: provider,
    value: { version: 1, provider, kind: provider === 'siliconflow' ? 'image' : 'audio', createdAt: stamp, updatedAt: stamp } })
  const trace = snapshot.projects.flatMap(({ project }) => project.musicJobs).find(job => job.binding.provider === 'acestep')
  const local = snapshot.legacySettings?.aceStep ?? (trace?.binding.local ? { ...trace.binding.local, waitMinutes: 60, allowLan: !/^http:\/\/127\.0\.0\.1(?::|$)/.test(trace.binding.local.baseUrl) } : legacyDefaultAceStep())
  const defaults = legacyDefaultAceStep(), used = !!trace || snapshot.projects.some(({ project }) => project.music.provider === 'acestep' || project.audio.some(asset => asset.provider === 'acestep'))
  if (used || secrets.has('acestep', local.connectionId) || local.baseUrl !== defaults.baseUrl || local.waitMinutes !== defaults.waitMinutes || local.allowLan) changes.push({ table: 'apis', id: 'acestep',
    value: { version: 1, provider: 'acestep', kind: 'audio', createdAt: stamp, updatedAt: stamp, local } })
  else if (snapshot.legacySettings) warn(journal.warnings, 'ACE-Step 只有旧版自动默认连接，无法判断是否曾配置；没有伪装成已添加 API，可在设置中手动添加。')
  return changes
}
const schemas: Record<Table, z.ZodType> = { generation: generationProjectSchema, entries: entrySchema, requests: requestSchema, submissions: submissionSchema,
  composition: compositionProjectSchema, executions: executionBatchSchema, apis: apiRecordSchema, settings: workbenchSettingsSchema }
async function performMigration(options: V4MigrationOptions): Promise<{ warnings: string[] }> {
  const { dataDir, defaultMediaRoot, db, assets, secrets } = options, directory = migrationDir(dataDir), markerFile = path.join(directory, 'complete.json')
  const marker = await optional(markerFile, markerSchema)
  if (marker) { if (!db.has('settings', 'current')) throw sourceError(directory, '完成标记存在但权威设置缺失'); return { warnings: marker.warnings } }
  const journalFile = path.join(directory, 'journal.json'); let journal = await optional(journalFile, journalSchema)
  const snapshot = await readSnapshot(dataDir, journal?.mediaRoot ?? defaultMediaRoot, journal ? await readArchive(dataDir, journal) : undefined)
  if (!journal) {
    if ((Object.keys(schemas) as Table[]).some(table => db.list(table).length)) throw sourceError(directory, '已有新工作区记录但缺少迁移日志，拒绝混入或覆盖')
    const backupHash = await backup(dataDir, snapshot)
    journal = { version: 4, startedAt: new Date().toISOString(), mediaRoot: snapshot.mediaRoot, backupHash, step: 'backed-up', mappings: {}, canonical: {}, reconciled: [], warnings: snapshot.warnings }
    await atomicJson(journalFile, journal, LIMIT)
  }
  if (journal.mediaRoot !== snapshot.mediaRoot) throw sourceError(journalFile, '媒体根与来源不一致')
  if (journal.step === 'backed-up') {
    reserveIdentities(snapshot, journal)
    await atomicJson(journalFile, journalSchema.parse(journal), LIMIT)
    await reconcileReceipts(snapshot, journal)
    await registerAssets(snapshot, journal, assets)
    journal.step = 'assets'; await atomicJson(journalFile, journalSchema.parse(journal), LIMIT)
  }
  const changes = [...generationChanges(snapshot, journal), ...compositionChanges(snapshot, journal), ...apiChanges(snapshot, journal, secrets)]
  const lastGenerationId = snapshot.legacySettings?.lastProjectId ?? snapshot.config?.generationProjectId
  const lastCompositionId = lastGenerationId ? changes.find(change => change.table === 'composition' && change.id === journal.mappings[`composition/single/${lastGenerationId}`])?.id : undefined
  const settings: WorkbenchSettings = { version: 5, mediaRoot: snapshot.mediaRoot, ffmpegPath: snapshot.legacySettings?.ffmpegPath,
    render: { concurrency: 2, threads: 4, encoder: 'auto' }, page: 'generation', lastGenerationId, lastCompositionId }
  changes.push({ table: 'settings', id: 'current', value: settings })
  const seen = new Set<string>()
  for (const change of changes) {
    const key = `${change.table}/${change.id}`
    if (seen.has(key)) throw sourceError(directory, `旧记录标识冲突 ${key}`)
    seen.add(key)
    try { change.value = clean(schemas[change.table].parse(change.value)) } catch { throw sourceError(directory, `转换后的 ${key} 超出新结构限制，未截断历史`) }
    if (db.has(change.table, change.id) && !isDeepStrictEqual(clean(db.get(change.table, change.id)), change.value)) throw sourceError(directory, `已有 ${key} 与迁移记录冲突，未覆盖`)
  }
  const usages = usageRecords(snapshot, journal)
  // Persist every chosen identity before publishing any workbench/usage row.
  await atomicJson(journalFile, journalSchema.parse(journal), LIMIT)
  for (const usage of usages) await assets.recordUsage(usage)
  const pending = changes.filter(change => !db.has(change.table, change.id))
  for (let start = 0; start < pending.length; start += 128) await db.commit(pending.slice(start, start + 128))
  for (const change of changes) if (!db.has(change.table, change.id) || !isDeepStrictEqual(clean(db.get(change.table, change.id)), change.value)) throw sourceError(directory, '提交后的数量或记录核对失败')
  const savedUsage = new Map((await assets.allUsage()).map(usage => [usage.id, usage]))
  for (const usage of usages) if (!savedUsage.has(usage.id) || !isDeepStrictEqual(clean(savedUsage.get(usage.id)), clean(usage))) throw sourceError(directory, '使用台账核对失败')
  journal.step = 'records'; await atomicJson(journalFile, journal, LIMIT)
  // Only after complete source backup and successful entity publication. DB current is authoritative thereafter.
  await atomicJson(path.join(dataDir, 'settings.json'), clean(settings))
  journal.step = 'complete'; await atomicJson(journalFile, journal, LIMIT)
  const counts: Record<string, number> = { usages: usages.length, legacyProjects: snapshot.projects.length, legacyLibraryRecords: snapshot.records.length }
  for (const change of changes) counts[change.table] = (counts[change.table] ?? 0) + 1
  await atomicJson(markerFile, markerSchema.parse({ version: 4, completedAt: new Date().toISOString(), mediaRoot: snapshot.mediaRoot, warnings: journal.warnings, counts }))
  inspectedSecrets.delete(keyPath(dataDir))
  return { warnings: journal.warnings }
}
/** Initialize DB, AssetStore and SecretStore first. Local-only, resumable and never submits/renders. */
export async function migrateV4(options: V4MigrationOptions): Promise<{ warnings: string[] }> {
  const key = keyPath(options.dataDir), queue = queues.get(key) ?? new SerialQueue(); queues.set(key, queue)
  return queue.run(() => performMigration(options))
}
