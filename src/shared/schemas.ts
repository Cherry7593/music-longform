import { z } from 'zod'
import type { ImageDraft, MusicDraft, VideoDraft } from './types'

export const INSTRUMENTAL_MODELS = ['auto', 'mureka-7.6', 'mureka-8', 'mureka-9', 'mureka-9.5'] as const
export const SONG_MODELS = ['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5'] as const
export const IMAGE_MODELS = ['Qwen/Qwen-Image'] as const
export const IMAGE_SIZES = ['1664x928', '1328x1328', '928x1664'] as const
export const MUSIC_STYLES = ['pop', 'rock', 'jazz', 'r&b', 'edm', 'ambient', 'folk', 'latin', 'k-pop', 'j-pop', 'house', 'gospel', 'lo-fi'] as const
export const DEFAULT_MUSIC: MusicDraft = { prompt: '', mode: 'instrumental', model: 'auto', count: 1, styles: [] }
export const DEFAULT_IMAGE: ImageDraft = { prompt: '', model: 'Qwen/Qwen-Image', size: '1664x928' }
export const idSchema = z.string().uuid()
export const providerSchema = z.enum(['mureka', 'siliconflow'])
export const musicDraftSchema = z.object({
  prompt: z.string().max(2000, '音乐提示词最多 2000 个字符'),
  mode: z.enum(['instrumental', 'song']),
  model: z.enum(SONG_MODELS),
  count: z.number().int().min(1).max(20),
  styles: z.array(z.enum(MUSIC_STYLES)).max(13)
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'instrumental' && value.prompt.length > 1024) ctx.addIssue({ code: 'custom', path: ['prompt'], message: '纯音乐提示词最多 1024 个字符' })
  if (value.mode === 'instrumental' && !INSTRUMENTAL_MODELS.includes(value.model as typeof INSTRUMENTAL_MODELS[number])) ctx.addIssue({ code: 'custom', path: ['model'], message: '纯音乐模式不支持这个模型' })
})
export const imageDraftSchema = z.object({
  prompt: z.string().max(32000, '图片提示词过长'),
  model: z.enum(IMAGE_MODELS),
  size: z.enum(IMAGE_SIZES)
}).strict()
export const DEFAULT_VIDEO: VideoDraft = {
  initialized: false, audioIds: [], durationMode: 'target', targetSeconds: 3600,
  transition: 'crossfade', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2,
  normalize: false, fit: 'contain'
}
export const videoDraftSchema = z.object({
  initialized: z.boolean(),
  audioIds: z.array(idSchema).max(100, '最多选择 100 首音乐').refine(ids => new Set(ids).size === ids.length, '同一首音乐只能选择一次'),
  imageId: idSchema.optional(),
  durationMode: z.enum(['all', 'target']),
  targetSeconds: z.number().finite().min(60, '目标时长至少 1 分钟').max(21600, '目标时长最长 6 小时'),
  transition: z.enum(['cut', 'fade', 'crossfade']),
  transitionSeconds: z.number().finite().min(0.5).max(10),
  fadeInSeconds: z.number().finite().min(0).max(10),
  fadeOutSeconds: z.number().finite().min(0).max(10),
  normalize: z.boolean(), fit: z.enum(['contain', 'cover'])
}).strict()
export const activeVideoStatuses = new Set(['analyzing', 'processing', 'mixing', 'encoding', 'validating'])
export const projectPatchSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(80),
  music: musicDraftSchema,
  image: imageDraftSchema,
  video: videoDraftSchema
}).partial().strict()
export const settingsPatchSchema = z.object({
  projectRoot: z.string().min(1).max(2000),
  musicDefaults: musicDraftSchema,
  imageDefaults: imageDraftSchema,
  lastProjectId: idSchema
}).partial().strict()
export const keySchema = z.string().trim().min(8, '密钥过短').max(4096).regex(/^[\x21-\x7E]+$/, '密钥不能包含空白或非 ASCII 字符')
export const activeMusicStatuses = new Set(['submitting', 'preparing', 'queued', 'running', 'streaming', 'downloading'])
