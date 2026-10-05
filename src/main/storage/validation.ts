import { z } from 'zod'
import { idSchema, imageDraftSchema, musicDraftSchema, videoDraftSchema } from '../../shared/schemas'
import { legacyMusicDraftSchema, musicProviderSchema, musicBindingSchema, aceStepSettingsSchema } from '../../shared/music-schemas'
import { validAbsolutePath, validAssetName } from './paths'

export const absolutePathSchema = z.string().min(1).max(2000).refine(validAbsolutePath)
// Frozen legacy image shape: current model changes must never make old projects unreadable.
export const legacyImageDraftSchema = z.object({
  prompt: z.string().max(32000), model: z.literal('gpt-image-2.5-flare'),
  size: z.enum(['1536x864', '1024x1024', '864x1536']), quality: z.enum(['low', 'medium', 'high']), format: z.literal('png')
}).strict()
export const settingsV1Schema = z.object({
  version: z.literal(1), projectRoot: absolutePathSchema,
  musicDefaults: legacyMusicDraftSchema, imageDefaults: legacyImageDraftSchema, lastProjectId: idSchema.optional()
}).strict()
export const settingsV2Schema = settingsV1Schema.extend({ version: z.literal(2), ffmpegPath: absolutePathSchema.optional() }).strict()
export const settingsV3Schema = settingsV2Schema.extend({ version: z.literal(3), imageDefaults: imageDraftSchema }).strict()
export const settingsSchema = settingsV3Schema.extend({ version: z.literal(4), musicDefaults: musicDraftSchema, aceStep: aceStepSettingsSchema }).strict()
const date = z.iso.datetime()
const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/)
const model = z.string().min(1).max(200)
const error = z.string().max(2000).optional()
const musicJob = z.object({
  id: idSchema, batchId: idSchema, index: z.number().int().min(0).max(20), createdAt: date,
  status: z.enum(['pending', 'submitting', 'preparing', 'queued', 'running', 'streaming', 'downloading', 'succeeded', 'failed', 'unknown', 'cancelled']),
  snapshot: legacyMusicDraftSchema, taskId: taskId.optional(), actualModel: model.optional(), error, recoverable: z.boolean().optional()
}).strict()
const batch = z.object({
  id: idSchema, total: z.number().int().min(1).max(20), createdAt: date,
  state: z.enum(['running', 'stopping', 'paused', 'completed']), message: z.string().max(2000).optional()
}).strict()
const legacyImageJob = z.object({
  id: idSchema, createdAt: date, status: z.enum(['submitting', 'downloading', 'succeeded', 'failed', 'unknown']), snapshot: legacyImageDraftSchema, error
}).strict()
const imageJob = z.discriminatedUnion('provider', [
  legacyImageJob.extend({ provider: z.literal('openai') }).strict(),
  legacyImageJob.extend({ provider: z.literal('siliconflow'), snapshot: imageDraftSchema }).strict()
])
const audioBase = z.object({
  id: idSchema, jobId: idSchema, taskId, remoteId: taskId, title: z.string().max(200), fileName: z.string().max(200),
  durationMs: z.number().finite().nonnegative(), createdAt: date, model, prompt: z.string().max(2000),
  mode: z.enum(['instrumental', 'song']), kept: z.boolean()
}).strict()
const audio = audioBase.refine(asset => asset.fileName === `audio/${asset.id}.mp3` || asset.fileName === `audio/${asset.id}.wav`)
const imageBase = z.object({
  id: idSchema, jobId: idSchema, fileName: z.string().max(200), createdAt: date, model, prompt: z.string().max(32000),
  size: z.string().min(1).max(50)
})
const legacyImage = imageBase.extend({ quality: z.enum(['low', 'medium', 'high']) }).strict()
  .refine(asset => asset.fileName === `images/${asset.id}.png`)
const image = z.discriminatedUnion('provider', [
  imageBase.extend({ provider: z.literal('openai'), format: z.literal('png'), quality: z.enum(['low', 'medium', 'high']) }).strict(),
  imageBase.extend({ provider: z.literal('siliconflow'), format: z.enum(['png', 'jpeg', 'webp']) }).strict()
]).refine(asset => validAssetName(asset.fileName, 'image', asset.id) && asset.fileName === `images/${asset.id}.${asset.format === 'jpeg' ? 'jpg' : asset.format}`)
const projectBase = z.object({
  version: z.literal(1), id: idSchema, name: z.string().trim().min(1).max(80), directory: absolutePathSchema,
  createdAt: date, updatedAt: date, music: legacyMusicDraftSchema, image: legacyImageDraftSchema,
  musicJobs: z.array(musicJob).max(20000), batches: z.array(batch).max(20000), imageJobs: z.array(legacyImageJob).max(20000),
  audio: z.array(audio).max(20000), images: z.array(legacyImage).max(20000), selectedImageId: idSchema.optional()
}).strict()
interface BaseReferences {
  musicJobs: { id: string }[]; batches: { id: string }[]; imageJobs: { id: string }[]
  audio: { id: string }[]; images: { id: string }[]; selectedImageId?: string
}
function validateBase(project: BaseReferences, ctx: z.RefinementCtx): void {
  for (const field of ['musicJobs', 'batches', 'imageJobs', 'audio', 'images'] as const) {
    const ids = project[field].map(item => item.id)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: [field], message: '记录标识重复' })
  }
  if (project.selectedImageId && !project.images.some(image => image.id === project.selectedImageId)) ctx.addIssue({ code: 'custom', path: ['selectedImageId'], message: '所选图片不存在' })
}
export const projectV1Schema = projectBase.superRefine(validateBase)
const videoJob = z.object({
  id: idSchema, kind: z.enum(['video', 'preview']),
  status: z.enum(['analyzing', 'processing', 'mixing', 'encoding', 'validating', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  snapshot: videoDraftSchema, createdAt: date, finishedAt: date.optional(),
  progress: z.number().finite().min(0).max(100).optional(), detail: z.string().max(2000).optional(), error,
  fileName: z.string().max(200).optional(), durationSeconds: z.number().finite().positive().max(21600.1).optional(),
  boundaryIndex: z.number().int().min(0).max(98).optional()
}).strict().superRefine((job, ctx) => {
  if (job.fileName && !validAssetName(job.fileName, job.kind, job.id)) ctx.addIssue({ code: 'custom', message: '视频素材路径不正确' })
  if (job.status === 'succeeded' && (!job.fileName || !job.durationSeconds)) ctx.addIssue({ code: 'custom', message: '完成记录缺少视频文件或时长' })
})
const projectV2Base = projectBase.extend({ version: z.literal(2), video: videoDraftSchema, videoJobs: z.array(videoJob).max(20000) }).strict()
function validateVideo(project: BaseReferences & { video: z.infer<typeof videoDraftSchema>; videoJobs: { id: string }[] }, ctx: z.RefinementCtx): void {
  validateBase(project, ctx)
  if (new Set(project.videoJobs.map(job => job.id)).size !== project.videoJobs.length) ctx.addIssue({ code: 'custom', message: '导出记录标识重复' })
  if (project.video.audioIds.some(id => !project.audio.some(asset => asset.id === id))) ctx.addIssue({ code: 'custom', message: '合成音乐不存在' })
  if (project.video.imageId && !project.images.some(image => image.id === project.video.imageId)) ctx.addIssue({ code: 'custom', message: '合成图片不存在' })
}
export const projectV2Schema = projectV2Base.superRefine(validateVideo)
const projectV3Base = projectV2Base.extend({
  version: z.literal(3), image: imageDraftSchema, imageJobs: z.array(imageJob).max(20000), images: z.array(image).max(20000)
}).strict()
const currentTaskId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
export const projectV3Schema = projectV3Base.superRefine(validateVideo)
const musicOutput = z.object({
  id: idSchema, assetId: idSchema, index: z.number().int().min(0).max(19), remoteId: currentTaskId.optional(),
  locator: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(500).optional(), status: z.enum(['pending', 'saved'])
}).strict()
const currentMusicJob = musicJob.extend({
  snapshot: musicDraftSchema, binding: musicBindingSchema, taskId: currentTaskId.optional(), outputs: z.array(musicOutput).max(20).optional(), detail: z.string().max(2000).optional()
}).strict().superRefine((job, ctx) => {
  if (job.snapshot.provider !== job.binding.provider) ctx.addIssue({ code: 'custom', message: '任务参数与提供方不匹配' })
  for (const key of ['id', 'assetId', 'index'] as const) {
    const values = (job.outputs ?? []).map(output => output[key])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: '任务结果标识重复' })
  }
})
const currentAudio = audioBase.extend({
  provider: musicProviderSchema, taskId: currentTaskId, remoteId: currentTaskId.optional(), title: z.string().max(500), resultId: idSchema.optional(), prompt: z.string().max(4000),
  originalFileName: z.string().max(200).optional(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict().superRefine((asset, ctx) => {
  if (!validAssetName(asset.fileName, 'audio', asset.id)) ctx.addIssue({ code: 'custom', message: '音频路径不正确' })
  if (Boolean(asset.originalFileName) !== Boolean(asset.originalSha256)) ctx.addIssue({ code: 'custom', message: '原始音频指纹缺失' })
  if (asset.originalFileName && !['mp3', 'wav', 'flac', 'm4a', 'mp4', 'ogg', 'opus'].some(ext => asset.originalFileName === `audio-originals/${asset.id}.${ext}`)) ctx.addIssue({ code: 'custom', message: '原始音频路径不正确' })
})
export const projectSchema = projectV3Base.extend({
  version: z.literal(4), music: musicDraftSchema, musicJobs: z.array(currentMusicJob).max(20000), audio: z.array(currentAudio).max(20000)
}).strict().superRefine(validateVideo)
export const projectIndexSchema = z.object({
  version: z.literal(1), projects: z.array(z.object({ id: idSchema, directory: absolutePathSchema }).strict()).max(10000)
}).strict().refine(index => new Set(index.projects.map(project => project.id)).size === index.projects.length)
