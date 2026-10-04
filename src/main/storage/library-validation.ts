import path from 'node:path'
import { z } from 'zod'
import { idSchema } from '../../shared/schemas'

export const LIBRARY_LIMITS = {
  filesPerImport: 500, audioBytes: 1024 ** 3, imageBytes: 40 * 1024 ** 2,
  durationSeconds: 6 * 60 * 60, imagePixels: 16_777_216, imageDimension: 8192,
  items: 50_000, origins: 500, indexBytes: 4 * 1024 ** 2, recordBytes: 2 * 1024 ** 2,
  metadataBytes: 128 * 1024 ** 2, configBytes: 16 * 1024
} as const

/** Reject UNC/device paths, ADS, relative paths and ambiguous Windows names before any I/O. */
export function localLibraryPath(value: string): boolean {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || !path.isAbsolute(value)
    || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value)
    || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))) return false
  const rest = value.slice(path.parse(value).root.length)
  if (rest.includes(':')) return false
  return rest.split(/[\\/]/).every(part => !part || (part !== '.' && part !== '..'
    && (process.platform !== 'win32' || (!/[. ]$|[<>"|?*]/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))))
}

const localPath = z.string().max(4096).refine(localLibraryPath)
const kind = z.enum(['audio', 'image'])
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const origin = z.object({
  type: z.enum(['import', 'project']), name: z.string().max(512), projectId: idSchema.optional(), assetId: idSchema.optional(),
  provider: z.string().max(200).optional(), model: z.string().max(200).optional(), prompt: z.string().max(32000).optional()
}).strict().refine(value => value.type === 'project' ? !!value.projectId && !!value.assetId : !value.projectId && !value.assetId)
const item = z.object({
  id: idSchema, kind, name: z.string().min(1).max(512), createdAt: z.iso.datetime(),
  sha256: hash.optional(), bytes: z.number().int().positive().max(LIBRARY_LIMITS.audioBytes).optional(),
  format: z.enum(['mp3', 'wav', 'flac', 'm4a', 'png', 'jpeg', 'webp']).optional(),
  durationSeconds: z.number().finite().positive().max(LIBRARY_LIMITS.durationSeconds).optional(),
  width: z.number().int().positive().max(LIBRARY_LIMITS.imageDimension).optional(),
  height: z.number().int().positive().max(LIBRARY_LIMITS.imageDimension).optional(),
  available: z.boolean(), problem: z.string().min(1).max(2000).optional(), origins: z.array(origin).min(1).max(LIBRARY_LIMITS.origins)
}).strict().superRefine((value, ctx) => {
  const audio = value.kind === 'audio'
  if (!!value.sha256 !== !!value.bytes || (audio ? value.width !== undefined || value.height !== undefined : value.durationSeconds !== undefined)) ctx.addIssue({ code: 'custom', message: '素材指纹或元数据不完整/类型不符' })
  if (value.format && !(audio ? ['mp3', 'wav', 'flac', 'm4a'] : ['png', 'jpeg', 'webp']).includes(value.format)) ctx.addIssue({ code: 'custom', message: '素材格式和类型不符' })
  if (!audio && ((value.bytes ?? 0) > LIBRARY_LIMITS.imageBytes || (value.width ?? 0) * (value.height ?? 0) > LIBRARY_LIMITS.imagePixels)) ctx.addIssue({ code: 'custom', message: '图片超限' })
  if (value.available && (!value.sha256 || !value.bytes || !value.format || (audio ? !value.durationSeconds : !value.width || !value.height) || value.problem)) ctx.addIssue({ code: 'custom', message: '可用素材缺少校验信息' })
  if (!value.available && !value.problem) ctx.addIssue({ code: 'custom', message: '不可用素材缺少原因' })
})

export function libraryFileName(fileName: string, mediaKind: 'audio' | 'image', id: string): boolean {
  return idSchema.safeParse(id).success && (mediaKind === 'audio' ? ['mp3', 'wav', 'flac', 'm4a'] : ['png', 'jpg', 'webp'])
    .some(extension => fileName === `${mediaKind === 'audio' ? 'audio' : 'images'}/${id}.${extension}`)
}
const location = z.discriminatedUnion('type', [
  z.object({ type: z.literal('managed'), fileName: z.string().max(200) }).strict(),
  z.object({ type: z.literal('project'), projectId: idSchema, assetId: idSchema, directory: localPath, fileName: z.string().max(200) }).strict()
])
export const libraryRecordSchema = z.object({
  version: z.literal(1), item, locations: z.array(location).min(1).max(LIBRARY_LIMITS.origins),
  importPaths: z.array(localPath).max(LIBRARY_LIMITS.origins), aliasOf: idSchema.optional()
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>()
  for (const source of value.locations) {
    const id = source.type === 'managed' ? value.item.id : source.assetId
    const key = source.type === 'managed' ? 'managed' : `${source.projectId}/${source.assetId}`
    if (keys.has(key) || !libraryFileName(source.fileName, value.item.kind, id)) ctx.addIssue({ code: 'custom', message: '素材路径或来源重复/不正确' })
    keys.add(key)
    if (source.type === 'project' && !value.item.origins.some(origin => origin.type === 'project' && origin.projectId === source.projectId && origin.assetId === source.assetId)) ctx.addIssue({ code: 'custom', message: '缺少项目来源' })
    if (source.type === 'managed' && (!value.item.sha256 || !value.item.format || !source.fileName.endsWith(`.${value.item.format === 'jpeg' ? 'jpg' : value.item.format}`))) ctx.addIssue({ code: 'custom', message: '托管文件缺少已校验格式或指纹' })
  }
  const projectOrigins = value.item.origins.filter(origin => origin.type === 'project')
  const projectKeys = projectOrigins.map(origin => `${origin.projectId}/${origin.assetId}`)
  if (new Set(projectKeys).size !== projectKeys.length || projectKeys.some(key => !keys.has(key))
    || value.item.origins.length - projectOrigins.length !== value.importPaths.length) ctx.addIssue({ code: 'custom', message: '来源与登记位置不一致' })
  if (value.aliasOf === value.item.id || new Set(value.importPaths).size !== value.importPaths.length) ctx.addIssue({ code: 'custom', message: '素材别名或导入来源不正确' })
})
export type LibraryRecord = z.infer<typeof libraryRecordSchema>
export type LibraryLocation = LibraryRecord['locations'][number]
export const libraryConfigSchema = z.object({ version: z.literal(1), root: localPath, generationProjectId: idSchema.optional() }).strict()
export const libraryIndexSchema = z.object({ version: z.literal(1), ids: z.array(idSchema).max(LIBRARY_LIMITS.items) }).strict()
  .refine(value => new Set(value.ids).size === value.ids.length)
