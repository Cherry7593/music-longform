import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { idSchema } from '../../shared/schemas'
import type { DiagnosticRecord } from '../../shared/workbench-types'
import { atomicJson, readJson } from './atomic'
import { managedDirectory } from './managed'
import { AppError } from '../providers/http'

const schema = z.object({ version: z.literal(1), id: idSchema, taskId: idSchema, attemptId: idSchema, createdAt: z.iso.datetime(),
  stage: z.string().max(40), category: z.string().max(80), message: z.string().max(4000), suggestion: z.string().max(4000),
  assetId: idSchema.optional(), assetName: z.string().max(500).optional(), toolVersion: z.string().max(1000).optional(), encoder: z.string().max(100).optional(),
  exitCode: z.number().int().nullable().optional(), osCode: z.string().max(50).optional(), stderr: z.string().max(16384).optional() }).strict()
export function redactDiagnostic(value: string): string {
  return value.replace(/(?:https?|ftp):\/\/[^\s<>"']+/gi, '[地址已脱敏]')
    .replace(/(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi, '[鉴权信息已移除]')
    .replace(/(?:x-api-key|api[_-]?key|access[_-]?token|bearer|password)\s*[:=]?\s*[^\s,;"']+/gi, '[鉴权信息已移除]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(-16384)
}
export function diagnosticFor(error: unknown, stage: string): Pick<DiagnosticRecord, 'stage' | 'category' | 'message' | 'suggestion'> & Partial<DiagnosticRecord> {
  const object = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; cause?: unknown; diagnostic?: unknown } : undefined
  const detail = object?.diagnostic && typeof object.diagnostic === 'object' ? object.diagnostic as Record<string, unknown> : {}
  const cause = object?.cause && typeof object.cause === 'object' ? object.cause as Record<string, unknown> : {}
  const code = typeof detail.osCode === 'string' ? detail.osCode : typeof object?.code === 'string' ? object.code : undefined
  const stderr = typeof detail.stderr === 'string' ? detail.stderr : typeof cause.stderr === 'string' ? cause.stderr : ''
  const message = typeof detail.message === 'string' ? detail.message : error instanceof AppError ? error.message : code === 'ENOSPC' ? '保存磁盘空间不足。' : code === 'EACCES' || code === 'EPERM' ? '当前目录没有所需读写权限。' : '此阶段未能完成，原因尚未确定。'
  let category = typeof detail.category === 'string' ? detail.category : 'unknown'
  if (code === 'ENOSPC' || /No space left|磁盘空间不足/i.test(stderr + message)) category = 'disk-space'
  else if (code === 'EACCES' || code === 'EPERM' || /Permission denied|没有.*权限/i.test(stderr + message)) category = 'permission'
  else if (/未找到.*FFmpeg|工具.*不存在/i.test(message)) category = 'tool-missing'
  else if (/Unknown encoder|No such filter|缺少.*编码器|缺少.*滤镜/i.test(stderr + message)) category = 'unsupported'
  else if (/cannot init|initializ.*fail|No capable devices|编码器.*初始化/i.test(stderr + message)) category = 'encoder-init'
  else if (code === 'ENOENT' || /素材.*缺失|素材.*不可读|No such file/i.test(stderr + message)) category = 'unreadable'
  const suggestions: Record<string, string> = { 'disk-space': '释放输出磁盘空间或降低并行数，再重试未完成项；成功成片不会重跑。', permission: '检查素材与输出目录权限及占用，勿覆盖原素材。', 'tool-missing': '在设置中检查本机 FFmpeg / FFprobe 路径。', unsupported: '检查所选工具版本和必要编码器、滤镜；不要重复提交相同失败任务。', 'encoder-init': '检查硬件编码状态，可选择 CPU 回退后重试。', unreadable: '根据关联素材定位文件，恢复可读取的原件后重新校验。', unknown: '保留本次诊断，核对阶段、退出码和相关素材；不要将未知原因直接认定为素材损坏。' }
  const exitCode = typeof detail.exitCode === 'number' || detail.exitCode === null ? detail.exitCode : typeof cause.code === 'number' || cause.code === null ? cause.code : undefined
  return { stage: typeof detail.stage === 'string' ? detail.stage : stage, category, message: redactDiagnostic(message).slice(0, 4000),
    suggestion: redactDiagnostic(typeof detail.suggestion === 'string' ? detail.suggestion : suggestions[category] ?? suggestions.unknown).slice(0, 4000),
    ...(idSchema.safeParse(detail.assetId).success ? { assetId: detail.assetId as string } : {}),
    ...(typeof detail.encoder === 'string' ? { encoder: redactDiagnostic(detail.encoder).slice(0, 100) } : {}),
    ...(code ? { osCode: code.slice(0, 50) } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(stderr ? { stderr: redactDiagnostic(stderr) } : {}) }
}
export class DiagnosticStore {
  private records = new Map<string, DiagnosticRecord>()
  private directory: string
  constructor(dataDir: string) { this.directory = path.join(dataDir, 'diagnostics') }
  async init(): Promise<void> {
    await managedDirectory(this.directory, true)
    const files = (await readdir(this.directory)).filter(file => file.endsWith('.json'))
    if (files.length > 100000) throw new AppError('诊断记录数量超限')
    for (const file of files) {
      const record = schema.parse(await readJson(path.join(this.directory, file), 64 * 1024))
      if (file !== `${record.id}.json`) throw new AppError('诊断记录标识不一致')
      this.records.set(record.id, record)
    }
  }
  async save(error: unknown, context: { taskId: string; attemptId: string; stage: string; assetId?: string; assetName?: string; toolVersion?: string; encoder?: string }): Promise<DiagnosticRecord> {
    const record = schema.parse({ ...context, ...diagnosticFor(error, context.stage), id: randomUUID(), version: 1, createdAt: new Date().toISOString() })
    if (record.assetName) record.assetName = redactDiagnostic(record.assetName).slice(0, 500)
    if (record.toolVersion) record.toolVersion = redactDiagnostic(record.toolVersion).slice(0, 1000)
    await atomicJson(path.join(this.directory, `${record.id}.json`), record, 64 * 1024)
    this.records.set(record.id, record); return structuredClone(record)
  }
  list(taskId: string): DiagnosticRecord[] { idSchema.parse(taskId); return structuredClone([...this.records.values()].filter(record => record.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) }
  get(id: string): DiagnosticRecord { const item = this.records.get(idSchema.parse(id)); if (!item) throw new AppError('诊断记录不存在'); return structuredClone(item) }
}
