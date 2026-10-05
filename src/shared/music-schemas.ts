import { z } from 'zod'
import { INSTRUMENTAL_MODELS, SONG_MODELS, MUSIC_STYLES, MUSIC_PROVIDERS, musicPromptLimit, SUNO_MODELS, isMurekaProvider } from './music-capabilities'

export const musicProviderSchema = z.enum(MUSIC_PROVIDERS)
/** Frozen V1–V3 shape; never broaden historical model lists during migrations. */
export const legacyMusicDraftSchema = z.object({
  prompt: z.string().max(2000), mode: z.enum(['instrumental', 'song']), model: z.enum(SONG_MODELS),
  count: z.number().int().min(1).max(20), styles: z.array(z.enum(MUSIC_STYLES)).max(13)
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'instrumental' && value.prompt.length > 1024) ctx.addIssue({ code: 'custom', path: ['prompt'], message: '纯音乐提示词最多 1024 个字符' })
  if (value.mode === 'instrumental' && !INSTRUMENTAL_MODELS.includes(value.model as typeof INSTRUMENTAL_MODELS[number])) ctx.addIssue({ code: 'custom', path: ['model'], message: '纯音乐模式不支持这个模型' })
})
export const musicDraftSchema = z.object({
  provider: musicProviderSchema, prompt: z.string().max(4000), mode: z.enum(['instrumental', 'song']),
  model: z.string().min(1).max(200), count: z.number().int().min(1).max(20), styles: z.array(z.enum(MUSIC_STYLES)).max(13),
  title: z.string().max(80).optional(), lyrics: z.string().max(5000).optional(), inputMode: z.enum(['description', 'lyrics']).optional(),
  seconds: z.number().finite().min(10).max(600).optional(), outputFormat: z.enum(['original', 'mp3']).optional(),
  thinking: z.boolean().optional(), language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/).optional()
}).strict().superRefine((value, ctx) => {
  const issue = (field: string, message: string): void => { ctx.addIssue({ code: 'custom', path: [field], message }) }
  if (value.prompt.length > musicPromptLimit(value)) issue('prompt', `当前平台音乐描述最多 ${musicPromptLimit(value)} 个字符`)
  if (isMurekaProvider(value.provider)) {
    if (!(value.mode === 'instrumental' ? INSTRUMENTAL_MODELS : SONG_MODELS).includes(value.model as 'auto')) issue('model', 'Mureka 模型与模式不兼容')
    if (value.inputMode === 'lyrics' || value.thinking) issue('inputMode', 'Mureka 使用描述生成，不支持这些参数')
  } else {
    if (!value.inputMode) issue('inputMode', '请选择此平台的输入方式')
    if (value.styles.length) issue('styles', '请将风格写入音乐描述；此平台不使用 Mureka 风格枚举')
    if (value.provider === 'kie' || value.provider === 'reapi') {
      if (!SUNO_MODELS.includes(value.model as 'V6')) issue('model', '请选择当前支持的 V6 音乐版本')
      if (value.seconds !== undefined && value.seconds > 360) issue('seconds', '当前平台请求时长最多 360 秒')
      if (value.provider === 'reapi' && value.seconds !== undefined && !Number.isInteger(value.seconds)) issue('seconds', 'reAPI 请求时长须为整数秒')
    }
    if (value.provider === 'sunor' && value.model !== 'v6') issue('model', 'Sunor 仅支持本版登记的 v6')
    if (value.provider === 'acestep' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.model)) issue('model', 'ACE-Step 模型名称不正确')
    if (value.provider === 'kie' && value.inputMode !== 'lyrics') issue('inputMode', 'Kie 使用自定义模式')
    if (value.mode === 'song' && (value.provider === 'kie' || value.inputMode === 'lyrics') && !value.lyrics?.trim()) issue('lyrics', '自填歌词的人声歌曲需要歌词')
    if (value.provider !== 'acestep' && value.thinking) issue('thinking', 'LM 增强仅适用于 ACE-Step')
  }
})

/** Canonical root only. DNS hostnames (other than localhost) are deliberately unsupported. */
export function normalizedAceStepURL(value: string): string | undefined {
  try {
    if (value !== value.trim() || /[\\\s]/.test(value)) return undefined
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined
    if (url.port === '0') return undefined
    const host = url.hostname
    if (host === 'localhost') return `${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ''}`
    if (host === '[::1]' || /^\[(?:fc|fd)[0-9a-f]{2}:/i.test(host)) return url.origin
    const rawHost = value.match(/^https?:\/\/([^/:]+)(?::\d+)?\/?$/i)?.[1]
    if (!rawHost || rawHost !== host || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return undefined
    const p = host.split('.').map(Number)
    if (p.some(n => n > 255) || p[3] === 255 || p[3] === 0) return undefined
    if (p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return url.origin
    return undefined
  } catch { return undefined }
}
export function isLanAceStepURL(value: string): boolean {
  const valid = normalizedAceStepURL(value)
  if (!valid) return false
  const host = new URL(valid).hostname
  return host !== '[::1]' && !host.startsWith('127.')
}
export const aceStepAddressSchema = z.string().max(500).refine(value => !!normalizedAceStepURL(value), '请输入环回或私有 IP 的 HTTP(S) 服务根地址，不含路径、账号或查询参数').transform(value => normalizedAceStepURL(value)!)
export const localKeySchema = z.string().min(1).max(4096).regex(/^[\x21-\x7E]+$/, '本地密钥不能包含空白或非 ASCII 字符')
export const aceStepConfigurationSchema = z.object({
  baseUrl: aceStepAddressSchema, waitMinutes: z.number().int().min(5).max(180), allowLan: z.boolean()
}).strict().refine(value => !isLanAceStepURL(value.baseUrl) || value.allowLan, '局域网连接需要明确确认目标地址')
export const aceStepSettingsSchema = z.object({
  baseUrl: aceStepAddressSchema, connectionId: z.string().uuid(), waitMinutes: z.number().int().min(5).max(180), allowLan: z.boolean()
}).strict().refine(value => !isLanAceStepURL(value.baseUrl) || value.allowLan, '局域网连接需要明确确认目标地址')
export const musicBindingSchema = z.object({
  provider: musicProviderSchema, adapterVersion: z.literal(1),
  local: z.object({ baseUrl: aceStepAddressSchema, connectionId: z.string().uuid() }).strict().optional()
}).strict().refine(value => value.provider === 'acestep' ? !!value.local : !value.local, '任务连接与提供方不匹配')
