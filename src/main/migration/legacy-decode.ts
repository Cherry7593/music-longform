import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Project, Settings, VideoDraft } from '../../shared/types'
import type { AceStepSettings } from '../../shared/music-types'
import { localLibraryPath } from '../storage/library-validation'

/** Frozen disk shapes, not current provider submission validators. Never writes old files. */
const id = z.string().uuid(), date = z.iso.datetime()
const absolute = z.string().max(4096).refine(localLibraryPath)
const provider = z.enum(['mureka', 'kie', 'reapi', 'sunor', 'acestep'])
const styles = z.array(z.enum(['pop', 'rock', 'jazz', 'r&b', 'edm', 'ambient', 'folk', 'latin', 'k-pop', 'j-pop', 'house', 'gospel', 'lo-fi'])).max(13)
const musicOld = z.object({ prompt: z.string().max(2000), mode: z.enum(['instrumental', 'song']),
  model: z.enum(['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5']), count: z.number().int().min(1).max(20), styles }).strict()
const music = z.object({ provider, prompt: z.string().max(4000), mode: z.enum(['instrumental', 'song']), model: z.string().min(1).max(200),
  count: z.number().int().min(1).max(20), styles, title: z.string().max(80).optional(), lyrics: z.string().max(5000).optional(),
  inputMode: z.enum(['description', 'lyrics']).optional(), seconds: z.number().finite().min(10).max(600).optional(),
  outputFormat: z.enum(['original', 'mp3']).optional(), thinking: z.boolean().optional(), language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/).optional() }).strict()
const imageOld = z.object({ prompt: z.string().max(32000), model: z.literal('gpt-image-2.5-flare'), size: z.enum(['1536x864', '1024x1024', '864x1536']),
  quality: z.enum(['low', 'medium', 'high']), format: z.literal('png') }).strict()
const image = z.object({ prompt: z.string().max(32000), model: z.literal('Qwen/Qwen-Image'), size: z.enum(['1664x928', '1328x1328', '928x1664']) }).strict()
const local = z.object({ baseUrl: z.string().min(1).max(500), connectionId: id }).strict()
const ace = local.extend({ waitMinutes: z.number().int().min(5).max(180), allowLan: z.boolean() }).strict()
const binding = z.object({ provider, adapterVersion: z.literal(1), local: local.optional() }).strict()
  .refine(value => value.provider === 'acestep' ? !!value.local : !value.local)
const settings1 = z.object({ version: z.literal(1), projectRoot: absolute, musicDefaults: musicOld, imageDefaults: imageOld, lastProjectId: id.optional() }).strict()
const settings2 = settings1.extend({ version: z.literal(2), ffmpegPath: absolute.optional() }).strict()
const settings3 = settings2.extend({ version: z.literal(3), imageDefaults: image }).strict()
const settings4 = settings3.extend({ version: z.literal(4), musicDefaults: music, aceStep: ace }).strict()
const settings = z.union([settings4, settings3, settings2, settings1])
const unique = (values: string[]) => new Set(values).size === values.length
export const legacyProjectIndexSchema = z.object({ version: z.literal(1), projects: z.array(z.object({ id, directory: absolute }).strict()).max(10000) }).strict()
  .refine(value => unique(value.projects.map(project => project.id)))
const video = z.object({ initialized: z.boolean(), audioIds: z.array(id).max(100).refine(unique), imageId: id.optional(),
  durationMode: z.enum(['all', 'target']), targetSeconds: z.number().finite().min(60).max(21600), transition: z.enum(['cut', 'fade', 'crossfade']),
  transitionSeconds: z.number().finite().min(0.5).max(10), fadeInSeconds: z.number().finite().min(0).max(10), fadeOutSeconds: z.number().finite().min(0).max(10),
  normalize: z.boolean(), fit: z.enum(['contain', 'cover']) }).strict()
const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), model = z.string().min(1).max(200), error = z.string().max(2000).optional()
const musicJobOld = z.object({ id, batchId: id, index: z.number().int().min(0).max(20), createdAt: date,
  status: z.enum(['pending', 'submitting', 'preparing', 'queued', 'running', 'streaming', 'downloading', 'succeeded', 'failed', 'unknown', 'cancelled']),
  snapshot: musicOld, taskId: taskId.optional(), actualModel: model.optional(), error, recoverable: z.boolean().optional() }).strict()
const output = z.object({ id, assetId: id, index: z.number().int().min(0).max(19), remoteId: taskId.optional(), locator: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(500).optional(), status: z.enum(['pending', 'saved']) }).strict()
const musicJob = musicJobOld.extend({ snapshot: music, binding, outputs: z.array(output).max(20).optional(), detail: z.string().max(2000).optional() }).strict()
  .refine(value => value.snapshot.provider === value.binding.provider && (['id', 'assetId', 'index'] as const).every(key => unique((value.outputs ?? []).map(item => String(item[key])))))
const batch = z.object({ id, total: z.number().int().min(1).max(20), createdAt: date, state: z.enum(['running', 'stopping', 'paused', 'completed']), message: z.string().max(2000).optional() }).strict()
const imageJobOld = z.object({ id, createdAt: date, status: z.enum(['submitting', 'downloading', 'succeeded', 'failed', 'unknown']), snapshot: imageOld, error }).strict()
const imageJob = z.discriminatedUnion('provider', [imageJobOld.extend({ provider: z.literal('openai') }).strict(), imageJobOld.extend({ provider: z.literal('siliconflow'), snapshot: image }).strict()])
const audioBase = z.object({ id, jobId: id, taskId, remoteId: taskId, title: z.string().max(200), fileName: z.string().max(200), durationMs: z.number().finite().nonnegative(),
  createdAt: date, model, prompt: z.string().max(2000), mode: z.enum(['instrumental', 'song']), kept: z.boolean() }).strict()
const audioOld = audioBase.refine(value => ['mp3', 'wav'].some(ext => value.fileName === `audio/${value.id}.${ext}`))
const audio = audioBase.extend({ provider, remoteId: taskId.optional(), title: z.string().max(500), resultId: id.optional(), prompt: z.string().max(4000),
  originalFileName: z.string().max(200).optional(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(value =>
  ['mp3', 'wav', 'flac', 'm4a'].some(ext => value.fileName === `audio/${value.id}.${ext}`) && Boolean(value.originalFileName) === Boolean(value.originalSha256)
  && (!value.originalFileName || ['mp3', 'wav', 'flac', 'm4a', 'mp4', 'ogg', 'opus'].some(ext => value.originalFileName === `audio-originals/${value.id}.${ext}`)))
const imageBase = z.object({ id, jobId: id, fileName: z.string().max(200), createdAt: date, model, prompt: z.string().max(32000), size: z.string().min(1).max(50) })
const imageAssetOld = imageBase.extend({ quality: z.enum(['low', 'medium', 'high']) }).strict().refine(value => value.fileName === `images/${value.id}.png`)
const imageAsset = z.discriminatedUnion('provider', [imageBase.extend({ provider: z.literal('openai'), format: z.literal('png'), quality: z.enum(['low', 'medium', 'high']) }).strict(),
  imageBase.extend({ provider: z.literal('siliconflow'), format: z.enum(['png', 'jpeg', 'webp']) }).strict()])
  .refine(value => value.fileName === `images/${value.id}.${value.format === 'jpeg' ? 'jpg' : value.format}`)
const videoJob = z.object({ id, kind: z.enum(['video', 'preview']), status: z.enum(['analyzing', 'processing', 'mixing', 'encoding', 'validating', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  snapshot: video, createdAt: date, finishedAt: date.optional(), progress: z.number().finite().min(0).max(100).optional(), detail: z.string().max(2000).optional(), error,
  fileName: z.string().max(200).optional(), durationSeconds: z.number().finite().positive().max(21600.1).optional(), boundaryIndex: z.number().int().min(0).max(98).optional() }).strict()
  .refine(value => (!value.fileName || value.fileName === `${value.kind === 'video' ? 'videos' : 'previews'}/${value.id}.${value.kind === 'video' ? 'mp4' : 'wav'}`)
    && (value.status !== 'succeeded' || !!value.fileName && !!value.durationSeconds))
const project1 = z.object({ version: z.literal(1), id, name: z.string().trim().min(1).max(80), directory: absolute, createdAt: date, updatedAt: date,
  music: musicOld, image: imageOld, musicJobs: z.array(musicJobOld).max(20000), batches: z.array(batch).max(20000), imageJobs: z.array(imageJobOld).max(20000),
  audio: z.array(audioOld).max(20000), images: z.array(imageAssetOld).max(20000), selectedImageId: id.optional() }).strict()
const project2 = project1.extend({ version: z.literal(2), video, videoJobs: z.array(videoJob).max(20000) }).strict()
const project3 = project2.extend({ version: z.literal(3), image, imageJobs: z.array(imageJob).max(20000), images: z.array(imageAsset).max(20000) }).strict()
const project4 = project3.extend({ version: z.literal(4), music, musicJobs: z.array(musicJob).max(20000), audio: z.array(audio).max(20000) }).strict()
const projects = z.union([project4, project3, project2, project1]).superRefine((value, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message })
  for (const field of ['musicJobs', 'batches', 'imageJobs', 'audio', 'images'] as const) if (!unique(value[field].map(item => item.id))) bad(`${field} 标识重复`)
  if (value.selectedImageId && !value.images.some(item => item.id === value.selectedImageId)) bad('所选图片详情缺失')
  if (value.musicJobs.some(job => !value.batches.some(batch => batch.id === job.batchId))) bad('音乐批次详情缺失')
  if ('video' in value) {
    if (!unique(value.videoJobs.map(job => job.id))) bad('导出记录标识重复')
    if (value.video.audioIds.some(id => !value.audio.some(asset => asset.id === id)) || value.video.imageId && !value.images.some(asset => asset.id === value.video.imageId)) bad('编排素材详情缺失')
  }
})
export const LEGACY_EMPTY_VIDEO: VideoDraft = { initialized: false, audioIds: [], durationMode: 'target', targetSeconds: 3600, transition: 'crossfade', transitionSeconds: 3,
  fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain' }
export function stableMigrationId(key: string): string {
  const hash = createHash('sha256').update(`music-canvas/migration-v4/${key}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export function legacyDefaultAceStep(): AceStepSettings {
  const baseUrl = 'http://127.0.0.1:8001'
  const hash = createHash('sha256').update(`music-canvas/acestep/v1:${baseUrl}`).digest('hex')
  return { baseUrl, connectionId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`, waitMinutes: 60, allowLan: false }
}
export function decodeLegacySettings(raw: unknown): Settings {
  const value = settings.parse(raw)
  if (value.version === 4) return value
  // Defaults are an archive only; returning Settings is for startup's FFmpeg/ACE/root compatibility.
  return { ...value, version: 4, aceStep: legacyDefaultAceStep(), musicDefaults: { ...value.musicDefaults, provider: 'mureka' } }
}
export interface DecodedProject { project: Project; sourceVersion: 1 | 2 | 3 | 4 }
export function decodeLegacyProject(raw: unknown, directory: string, expectedId: string): DecodedProject {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目详情不是对象')
  const value = projects.parse({ ...raw, directory })
  if (value.id !== expectedId) throw new Error('项目与索引标识不一致')
  if (value.version === 4) return { project: value, sourceVersion: 4 }
  return { sourceVersion: value.version, project: {
    video: structuredClone(LEGACY_EMPTY_VIDEO), videoJobs: [], ...value, version: 4,
    music: { ...value.music, provider: 'mureka' },
    musicJobs: value.musicJobs.map(job => ({ ...job, snapshot: { ...job.snapshot, provider: 'mureka' }, binding: { provider: 'mureka', adapterVersion: 1 } })),
    audio: value.audio.map(asset => ({ ...asset, provider: 'mureka' })),
    images: value.version === 3 ? value.images : value.images.map(asset => ({ ...asset, provider: 'openai', format: 'png' })),
    imageJobs: value.version === 3 ? value.imageJobs : value.imageJobs.map(job => ({ ...job, provider: 'openai' }))
  } }
}
export const legacyReceiptSchema = z.object({ version: z.literal(1), id, ownerId: id, kind: z.enum(['batch', 'project']), name: z.string().min(1).max(200),
  state: z.enum(['prepared', 'committed']), finishedAt: date, durationSeconds: z.number().finite().positive().max(21600.1), assetIds: z.array(id).min(1).max(101).refine(unique),
  directory: absolute, fileName: z.string().max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(32 * 1073741824) }).strict()
  .refine(value => value.fileName === `videos/${value.id}.mp4`)
export type LegacyReceipt = z.infer<typeof legacyReceiptSchema>
const encrypted = z.string().min(4).max(32768).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value)
export const legacySecretsSchema = z.union([
  z.object({ version: z.literal(1), keys: z.object({ mureka: encrypted.optional(), openai: encrypted.optional() }).strict() }).strict(),
  z.object({ version: z.literal(2), keys: z.object({ mureka: encrypted.optional(), siliconflow: encrypted.optional() }).strict() }).strict(),
  z.object({ version: z.literal(3), keys: z.object({ mureka: encrypted.optional(), siliconflow: encrypted.optional(), kie: encrypted.optional(), reapi: encrypted.optional(), sunor: encrypted.optional(), acestep: encrypted.optional() }).strict(),
    aceStepConnectionId: id.optional() }).strict().refine(value => Boolean(value.keys.acestep) === Boolean(value.aceStepConnectionId))
])
