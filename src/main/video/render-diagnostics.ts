import { performance } from 'node:perf_hooks'
import type { RenderMetrics, RenderStage, VideoDiagnostic } from '../../shared/video-diagnostics'
import { AppError } from '../providers/http'

export function redactDiagnostic(text: string, limit = 8192): string {
  // Scrub before truncating: a truncated URL or authorization line must not reveal its tail.
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=][^\r\n]*/gi, '[authorization redacted]')
    .replace(/\b(?:bearer|basic)\s+[\w+/=.-]+/gi, '[credential redacted]')
    .replace(/\b(?:api[-_]?key|access[-_]?token|token|password|secret|signature)["']?\s*[=:]\s*[^\s,;]+/gi, '[credential redacted]')
    .replace(/\b(?:sk|rk)-[a-z0-9_-]{8,}/gi, '[key redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(-limit)
}

export function diagnosticFor(error: unknown, context: Partial<VideoDiagnostic> = {}): VideoDiagnostic {
  const existing = (error as { diagnostic?: VideoDiagnostic } | undefined)?.diagnostic
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const text = `${context.stderr ?? existing?.stderr ?? ''} ${error instanceof Error ? error.message : ''}`
  const osCode = context.osCode ?? existing?.osCode ?? (typeof code === 'string' ? code : undefined)
  let category = 'unknown', suggestion = '原因未确定；请保留本次诊断，核对工具版本、输入文件及可用资源。'
  if (osCode === 'ENOSPC' || /no space left|disk full|磁盘空间不足/i.test(text)) { category = 'space'; suggestion = '释放任务磁盘空间，降低并行数后重试。' }
  else if (['EACCES', 'EPERM'].includes(osCode ?? '') || /permission denied|access is denied|权限/i.test(text)) { category = 'permission'; suggestion = '检查工具、素材和任务目录的读取/写入权限。' }
  else if (osCode === 'ENOENT' && context.stage === 'tools' || /可执行文件不存在|未找到 FFmpeg/i.test(text)) { category = 'tool-missing'; suggestion = '选择本地完整 FFmpeg，确认相邻 ffprobe 存在。' }
  else if (/unknown encoder|unknown option|unrecognized option|no such filter|not supported|缺少必要|版本无效/i.test(text)) { category = 'incompatible'; suggestion = '当前工具不支持所需功能；选择兼容的完整 FFmpeg。' }
  else if (/nvenc|qsv|cuda|mfx|initializ|no capable device|cannot load|openencodesession/i.test(text)) { category = 'encoder-initialization'; suggestion = '硬件编码初始化失败；可回退已实测的 CPU 编码，不需自动安装驱动。' }
  else if (osCode === 'ENOENT' || /invalid data|error opening input|无法读取|媒体文件不存在|not a file/i.test(text)) { category = 'unreadable'; suggestion = '检查对应素材是否存在且可读；证据不足时不要删除原文件。' }
  const message = redactDiagnostic(context.message ?? existing?.message ?? (error instanceof AppError ? error.message : '本地视频处理失败；原因未确定。'), 1000)
  return { stage: 'tools', category, suggestion, ...existing, ...context, osCode,
    message, stderr: context.stderr || existing?.stderr ? redactDiagnostic(context.stderr ?? existing!.stderr!) : undefined }
}

export function withDiagnostic(error: unknown, context: Partial<VideoDiagnostic>): AppError & { diagnostic: VideoDiagnostic } {
  const diagnostic = diagnosticFor(error, context)
  const safe = error instanceof AppError ? error : new AppError(diagnostic.message)
  // Never retain an arbitrary Error/cause/command string from a child process.
  safe.message = diagnostic.message
  safe.cause = undefined
  return Object.assign(safe, { diagnostic })
}

export class RenderClock {
  readonly started = performance.now()
  private since = this.started
  stage: RenderStage = 'tools'
  readonly metrics: RenderMetrics = { stages: [], encoder: 'cpu', staticVideo: false, elapsedMs: 0, fallbacks: [] }
  constructor(private readonly listener?: (stage: RenderStage) => void) { this.notify() }
  private notify(): void { try { this.listener?.(this.stage) } catch { /* Observers do not own the render. */ } }
  enter(stage: RenderStage): void {
    if (stage === this.stage) return
    this.flush(); this.stage = stage; this.notify()
  }
  private flush(): void {
    const now = performance.now(), elapsedMs = now - this.since
    const timing = this.metrics.stages.find(item => item.stage === this.stage)
    if (timing) timing.elapsedMs += elapsedMs
    else this.metrics.stages.push({ stage: this.stage, elapsedMs })
    this.since = now
  }
  finish(): RenderMetrics { this.flush(); this.metrics.elapsedMs = performance.now() - this.started; return this.metrics }
}
