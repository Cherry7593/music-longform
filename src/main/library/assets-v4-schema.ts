import path from 'node:path'
import { z } from 'zod'
import type { AssetOrigin, MediaKind, UsageRecord } from '../../shared/workbench-types'
import { localLibraryPath, LIBRARY_LIMITS } from '../storage/library-validation'

export const LIMITS = { ...LIBRARY_LIMITS, videoBytes: 128 * 1024 ** 3, roots: 10000, usages: 100000 }
export const uuid = z.string().uuid()
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const timeSchema = z.iso.datetime()
export const nameSchema = z.string().min(1).max(512)
export const kindSchema = z.enum(['audio', 'image', 'video'])
export function relativeFile(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\\') && !path.posix.isAbsolute(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[\x00-\x1f:<>"|?*]|[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
export const relativeSchema = z.string().refine(relativeFile, '素材相对路径不安全')
export function mediaFile(file: string, kind: MediaKind): boolean {
  return relativeFile(file) && (kind === 'audio' ? /\.(?:mp3|wav|flac|m4a)$/i : kind === 'image' ? /\.(?:png|jpe?g|webp)$/i : /\.mp4$/i).test(file)
}
export function ownerFor(id: string, fileName: string): string {
  const stem = path.posix.basename(fileName).split('.')[0]
  return uuid.safeParse(stem).success ? stem : id
}
export function relatedFile(file: string, owner: string): boolean {
  if (!relativeFile(file) || !uuid.safeParse(owner).success) return false
  return new RegExp(`^\\.generated-audio/${owner}/(?:source\\.bin|compatible\\.flac|manifest\\.json|download\\.part)$`, 'i').test(file)
    || new RegExp(`^(?:audio|images|videos|exports)/${owner}(?:\\.[a-z0-9_-]+){1,3}$`, 'i').test(file)
    || new RegExp(`^audio-originals/${owner}\\.(?:mp4|ogg|opus|mp3|wav|flac|m4a)$`, 'i').test(file)
}
export const originSchema: z.ZodType<AssetOrigin> = z.object({
  type: z.enum(['import', 'generation', 'composition', 'legacy']), name: z.string().max(512),
  projectId: uuid.optional(), entryId: uuid.optional(), requestId: uuid.optional(), batchId: uuid.optional(), legacyAssetId: uuid.optional(),
  provider: z.string().max(200).optional(), model: z.string().max(200).optional(), prompt: z.string().max(32000).optional()
}).strict()
export const metadataSchema = z.object({
  format: z.string().max(30), durationSeconds: z.number().positive().max(LIMITS.durationSeconds).optional(),
  width: z.number().int().positive().max(32768).optional(), height: z.number().int().positive().max(32768).optional()
}).strict()
export type Metadata = z.infer<typeof metadataSchema>
function validMetadata(kind: MediaKind, value: { format?: string; durationSeconds?: number; width?: number; height?: number }): boolean {
  if (!value.format || !(kind === 'audio' ? ['mp3', 'wav', 'flac', 'm4a'] : kind === 'image' ? ['png', 'jpeg', 'webp'] : ['mp4']).includes(value.format)) return false
  if (kind !== 'image' && !value.durationSeconds) return false
  if (kind !== 'audio' && (!value.width || !value.height || value.width * value.height > (kind === 'image' ? LIMITS.imagePixels : 268435456))) return false
  return kind !== 'image' || (value.width! <= LIMITS.imageDimension && value.height! <= LIMITS.imageDimension)
}
const integer = z.string().regex(/^-?\d{1,40}$/)
export const stampSchema = z.object({
  dev: integer, ino: integer, birth: integer, size: z.number().int().nonnegative().max(LIMITS.videoBytes),
  mtime: integer, ctime: integer, links: z.number().int().nonnegative(), sha256: hashSchema
}).strict()
export type Stamp = z.infer<typeof stampSchema>
export const evidenceSchema = z.object({
  validator: z.string().max(100), tool: z.string().max(200), fingerprint: stampSchema, metadata: metadataSchema
}).strict()
export type Evidence = z.infer<typeof evidenceSchema>
const fileSchema = z.object({ fileName: relativeSchema, stamp: stampSchema.optional() }).strict()
export const locationSchema = z.object({
  rootId: uuid, fileName: relativeSchema, ownerId: uuid, stamp: stampSchema.optional(), evidence: evidenceSchema.optional(),
  related: z.array(fileSchema).max(20)
}).strict().refine(value => value.related.every(file => relatedFile(file.fileName, value.ownerId)), '附属文件不属于该 UUID')
export type Location = z.infer<typeof locationSchema>
const itemSchema = z.object({
  id: uuid, kind: kindSchema, name: nameSchema, createdAt: timeSchema, updatedAt: timeSchema,
  sha256: hashSchema.optional(), bytes: z.number().int().positive().max(LIMITS.videoBytes).optional(),
  format: z.string().max(30).optional(), durationSeconds: z.number().positive().max(LIMITS.durationSeconds).optional(),
  width: z.number().int().positive().max(32768).optional(), height: z.number().int().positive().max(32768).optional(),
  available: z.boolean(), problem: z.string().max(2000).optional(), origins: z.array(originSchema).min(1).max(LIMITS.origins), deletedAt: timeSchema.optional()
}).strict().refine(value => (!value.bytes || !!value.sha256)
  && (value.bytes ?? 0) <= (value.kind === 'audio' ? LIMITS.audioBytes : value.kind === 'image' ? LIMITS.imageBytes : LIMITS.videoBytes)
  && (!value.available || (!!value.sha256 && !!value.bytes && validMetadata(value.kind, value) && !value.deletedAt && !value.problem)))
export const deletionFileSchema = z.object({ rootId: uuid, fileName: relativeSchema, stamp: stampSchema.optional(), done: z.boolean() }).strict()
export type DeletionFile = z.infer<typeof deletionFileSchema>
export const recordSchema = z.object({
  version: z.literal(2), asset: itemSchema, aliases: z.array(uuid).max(LIMITS.items),
  locations: z.array(locationSchema).min(1).max(LIMITS.origins), importPaths: z.array(z.string().max(4096).refine(localLibraryPath)).max(LIMITS.origins),
  deletion: z.object({ state: z.enum(['pending', 'failed', 'done']), files: z.array(deletionFileSchema).max(LIMITS.origins * 21), problem: z.string().max(2000).optional() }).strict().optional()
}).strict().superRefine((record, context) => {
  if (record.aliases.includes(record.asset.id) || new Set(record.aliases).size !== record.aliases.length
    || !!record.deletion !== !!record.asset.deletedAt
    || record.locations.some(location => !mediaFile(location.fileName, record.asset.kind)
      || (location.evidence && (JSON.stringify(location.stamp) !== JSON.stringify(location.evidence.fingerprint)
        || location.evidence.fingerprint.sha256 !== record.asset.sha256 || !validMetadata(record.asset.kind, location.evidence.metadata))))) {
    context.addIssue({ code: 'custom', message: '资产记录关系无效' })
  }
  if (record.deletion?.files.some(file => !record.locations.some(location => location.rootId === file.rootId
    && (location.fileName === file.fileName ? JSON.stringify(location.stamp) === JSON.stringify(file.stamp)
      : location.related.some(related => related.fileName === file.fileName && JSON.stringify(related.stamp) === JSON.stringify(file.stamp)))))) {
    context.addIssue({ code: 'custom', message: '删除计划越出资产文件或登记指纹范围' })
  }
})
export type AssetRecord = z.infer<typeof recordSchema>
export const rootSchema = z.object({ version: z.literal(2), id: uuid, directory: z.string().max(4096).refine(localLibraryPath), owned: z.boolean() }).strict()
export type RootRecord = z.infer<typeof rootSchema>
export const indexSchema = z.object({ version: z.literal(2), ids: z.array(uuid).max(LIMITS.items) }).strict().refine(value => new Set(value.ids).size === value.ids.length)
export const usageSchema: z.ZodType<UsageRecord> = z.object({
  version: z.literal(2), id: uuid, videoId: uuid.optional(), projectId: uuid.optional(), name: z.string().max(512), finishedAt: timeSchema,
  durationSeconds: z.number().finite().nonnegative().max(LIMITS.durationSeconds), assetIds: z.array(uuid).max(1000), uncertainAssetIds: z.array(uuid).max(1000)
}).strict()
