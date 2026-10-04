import type { ImageAsset, JobStatus } from '../shared/types'
import type { ZodError } from 'zod'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}

export function validationMessage(error: ZodError): string {
  return error.issues.map(issue => {
    const field = String(issue.path[issue.path.length - 1] ?? '')
    if (/[\u4e00-\u9fff]/u.test(issue.message)) return issue.message
    if (field === 'count') return '每批首数必须为 1–20 的整数'
    if (field === 'name') return '项目名称须为 1–80 个字符，不能只有空格'
    if (field === 'model') return '请选择当前模式支持的模型'
    if (field === 'styles') return '请选择支持的歌曲风格'
    if (field === 'size') return '请选择支持的图片尺寸'
    if (field === 'projectRoot') return '请选择有效的保存目录'
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
export const modelLabel = (model: string): string => model === 'auto' ? '自动 · auto' : model === 'Qwen/Qwen-Image' ? 'Qwen-Image' : model
