import { z } from 'zod'
import type { ImageDraft, MusicDraft, Provider, VideoDraft } from './types'
import { localKeySchema, musicDraftSchema } from './music-schemas'
import { defaultMusicDraft } from './music-capabilities'
export { musicDraftSchema } from './music-schemas'
export { INSTRUMENTAL_MODELS, SONG_MODELS, MUSIC_STYLES } from './music-capabilities'
export const IMAGE_MODELS = ['Qwen/Qwen-Image'] as const
export const IMAGE_SIZES = ['1664x928', '1328x1328', '928x1664'] as const
export const DEFAULT_MUSIC: MusicDraft = defaultMusicDraft()
export const DEFAULT_IMAGE: ImageDraft = { prompt: '', model: 'Qwen/Qwen-Image', size: '1664x928' }
export const idSchema = z.string().uuid()
export const providerSchema = z.enum(['mureka', 'mureka-cn', 'siliconflow', 'kie', 'reapi', 'sunor', 'acestep'])
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
/** Domestic Mureka documents an opaque Bearer key, not an eight-character minimum or prefix. */
export const providerKeySchema = (provider: Provider) => provider === 'acestep' || provider === 'mureka-cn' ? localKeySchema : keySchema
export const activeMusicStatuses = new Set(['submitting', 'preparing', 'queued', 'running', 'streaming', 'downloading'])
