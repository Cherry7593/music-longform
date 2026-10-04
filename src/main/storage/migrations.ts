import { copyFile, constants } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ImageDraft, LegacyImageDraft, Project, Settings } from '../../shared/types'
import { DEFAULT_IMAGE, DEFAULT_VIDEO } from '../../shared/schemas'
import { AppError } from '../providers/http'
import { atomicJson } from './atomic'
import { projectSchema, projectV1Schema, projectV2Schema, settingsSchema, settingsV1Schema, settingsV2Schema } from './validation'

/** No secret is decrypted or copied to a log; backups preserve the exact original bytes. */
export async function commitUpgrade(path: string, value: unknown, sourceVersion: number): Promise<void> {
  const backup = `${path}.v${sourceVersion}-${randomUUID()}.bak`
  try { await copyFile(path, backup, constants.COPYFILE_EXCL) } catch {
    throw new AppError('无法备份旧数据，升级已停止，原文件未修改。请检查权限和空间。')
  }
  try { await atomicJson(path, value) } catch {
    throw new AppError('数据升级写入失败，原文件及备份已保留。请检查磁盘后重试。')
  }
}
function upgradeImage(draft: LegacyImageDraft): ImageDraft {
  const sizes: Record<string, string> = { '1536x864': '1664x928', '1024x1024': '1328x1328', '864x1536': '928x1664' }
  return { ...DEFAULT_IMAGE, prompt: draft.prompt, size: sizes[draft.size] }
}
export async function migrateSettings(path: string, raw: unknown): Promise<Settings> {
  const modern = settingsSchema.safeParse(raw)
  if (modern.success) return modern.data
  const legacy = settingsV2Schema.safeParse(raw)
  const parsed = legacy.success ? legacy : settingsV1Schema.safeParse(raw)
  if (!parsed.success) throw new AppError('设置文件损坏或格式不兼容；原文件未被覆盖。')
  const next = settingsSchema.parse({ ...parsed.data, version: 3, imageDefaults: upgradeImage(parsed.data.imageDefaults) })
  await commitUpgrade(path, next, parsed.data.version)
  return next
}
export async function migrateProject(path: string, raw: unknown, directory: string, expectedId: string): Promise<Project> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('项目文件格式不正确')
  const trusted = { ...raw, directory }
  if (!('id' in raw) || raw.id !== expectedId) throw new AppError('项目与索引标识不一致，未升级')
  const modern = projectSchema.safeParse(trusted)
  if (modern.success) return modern.data
  const v2 = projectV2Schema.safeParse(trusted)
  const legacy = v2.success ? v2 : projectV1Schema.safeParse(trusted)
  if (!legacy.success) throw new AppError('项目数据损坏或格式不兼容，未覆盖原文件。')
  const previous = legacy.data
  const next = projectSchema.parse({
    video: structuredClone(DEFAULT_VIDEO), videoJobs: [], ...previous, version: 3,
    image: upgradeImage(previous.image),
    images: previous.images.map(asset => ({ ...asset, provider: 'openai', format: 'png' })),
    imageJobs: previous.imageJobs.map(job => ({
      ...job, provider: 'openai',
      ...(['submitting', 'downloading'].includes(job.status) ? {
        status: 'unknown', error: '旧 OpenAI 图片请求已中断，可能已计费。请核对原服务商后台；不会转到硅基流动重新生成。'
      } : {})
    }))
  })
  await commitUpgrade(path, next, previous.version)
  return next
}
