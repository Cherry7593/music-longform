import type { ImageAsset, JobStatus, MusicDraft, MusicJob, MusicProviderId, PublicSettings } from '../shared/types'
import { defaultMusicDraft, MUSIC_PROVIDER_LABELS } from '../shared/music-capabilities'
import type { ZodError } from 'zod'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}

export function validationMessage(error: ZodError): string {
  return error.issues.map(issue => {
    const field = String(issue.path[issue.path.length - 1] ?? '')
    if (/[\u4e00-\u9fff]/u.test(issue.message)) return issue.message
    if (field === 'count') return '生成次数必须为 1–20 的整数'
    if (field === 'name') return '项目名称须为 1–80 个字符，不能只有空格'
    if (field === 'model') return '请选择当前模式支持的模型'
    if (field === 'styles') return '请选择支持的歌曲风格'
    if (field === 'size') return '请选择支持的图片尺寸'
    if (field === 'projectRoot') return '请选择有效的保存目录'
    if (field === 'provider') return '请选择音乐提供方'
    if (field === 'prompt') return '音乐描述超出当前平台长度限制'
    if (field === 'lyrics') return '歌词最多 5000 个字符；自填歌词的人声歌曲不能为空'
    if (field === 'title') return '曲名最多 80 个字符'
    if (field === 'seconds') return '请求时长须为 10–360 秒，ACE-Step 最多 600 秒'
    if (field === 'language') return '语言请填写代码，例如 zh、en、ja'
    if (field === 'waitMinutes') return '等待上限须为 5–180 分钟的整数'
    if (field === 'targetSeconds') return '目标时长须为 1–360 分钟'
    if (field === 'transitionSeconds') return '转场时长须为 0.5–10 秒'
    if (field === 'fadeInSeconds' || field === 'fadeOutSeconds') return '整段淡入淡出须为 0–10 秒，0 为关闭'
    if (field === 'audioIds' || issue.path.includes('audioIds')) return '请选择本项目登记的音乐，每首一次，最多 100 首'
    if (field === 'imageId') return '请选择本项目登记的图片'
    return '参数不符合要求，请检查输入'
  }).filter((value, index, list) => list.indexOf(value) === index).join('；')
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function dateLabel(value: string, full = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', full
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit' }).format(date)
}

export const statusLabels: Record<JobStatus, string> = {
  pending: '等待提交', submitting: '正在提交', preparing: '服务商准备中',
  queued: '服务商排队中', running: '正在生成', streaming: '服务商处理中',
  downloading: '下载到本机', succeeded: '已保存', failed: '失败',
  unknown: '状态未知', cancelled: '已停止',
}
export const qualityLabels = { low: '低', medium: '中', high: '高' } as const
export const sizeLabels: Record<string, string> = {
  '1664x928': '横屏 · 1664 × 928', '1328x1328': '方图 · 1328 × 1328', '928x1664': '竖图 · 928 × 1664',
  '1536x864': '横屏 · 1536 × 864', '1024x1024': '方图 · 1024 × 1024', '864x1536': '竖图 · 864 × 1536',
}
export const imageProviderLabel = (provider: ImageAsset['provider']): string => provider === 'openai' ? 'OpenAI（历史来源）' : '硅基流动'
export const imageQualityLabel = (quality: string): string => qualityLabels[quality as keyof typeof qualityLabels] ?? quality
export function imageMetadata(image: ImageAsset): string {
  return [image.size.replace('x', ' × '), image.quality ? `质量：${imageQualityLabel(image.quality)}` : null, image.format.toUpperCase()].filter(Boolean).join(' · ')
}
export const styleLabels: Record<string, string> = {
  pop: '流行', rock: '摇滚', jazz: '爵士', 'r&b': '节奏布鲁斯', edm: '电子舞曲',
  ambient: '氛围', folk: '民谣', latin: '拉丁', 'k-pop': '韩流', 'j-pop': '日系流行',
  house: '浩室', gospel: '福音', 'lo-fi': '低保真',
}
export const modelLabel = (model: string): string => model === 'auto' ? '自动 · auto' : model === 'default' ? '服务默认模型' : model === 'Qwen/Qwen-Image' ? 'Qwen-Image' : model

/** First visit to a provider copies text, never its model or unsupported switches. */
export function migrateMusicDraft(value: MusicDraft, provider: MusicProviderId): MusicDraft {
  const next = { ...defaultMusicDraft(provider), prompt: value.prompt, mode: value.mode, count: value.count }
  if (provider !== 'mureka') {
    next.title = value.title ?? ''
    next.lyrics = value.lyrics ?? ''
    if ((provider === 'reapi' || provider === 'sunor') && value.inputMode === 'lyrics') next.inputMode = 'lyrics'
  }
  return next
}

export function musicReadiness(provider: MusicProviderId, settings: PublicSettings | null): string | undefined {
  if (!settings) return '正在读取 API 配置'
  if (provider === 'acestep') return undefined // Optional key; backend performs safe generation preflight.
  if (!settings.keys[provider]) return `尚未配置 ${MUSIC_PROVIDER_LABELS[provider]} 密钥`
  return undefined
}

/** Recovery/continuation must be judged against the immutable job, not the open form. */
export function musicJobReadiness(job: MusicJob, settings: PublicSettings | null): string | undefined {
  const reason = musicReadiness(job.binding.provider, settings)
  if (reason) return reason
  if (job.binding.provider === 'acestep' && (job.binding.local?.connectionId !== settings?.aceStep.connectionId || job.binding.local?.baseUrl !== settings?.aceStep.baseUrl)) {
    return `此任务绑定的 ACE-Step 连接已变更（原地址 ${job.binding.local?.baseUrl ?? '未知'}）。请在设置中核对原连接；不能向旧地址发送新连接的密钥。`
  }
  return undefined
}
