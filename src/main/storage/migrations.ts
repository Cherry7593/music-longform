import { copyFile, constants } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import type { ImageDraft, LegacyImageDraft, Project, Settings } from '../../shared/types'
import type { AceStepSettings } from '../../shared/music-types'
import { DEFAULT_IMAGE, DEFAULT_VIDEO } from '../../shared/schemas'
import { AppError } from '../providers/http'
import { atomicJson } from './atomic'
import { projectSchema, projectV1Schema, projectV2Schema, projectV3Schema, settingsSchema, settingsV1Schema, settingsV2Schema, settingsV3Schema } from './validation'

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
export function aceStepConnectionId(baseUrl: string): string {
  const hash = createHash('sha256').update(`music-canvas/acestep/v1:${baseUrl}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export function defaultAceStepSettings(): AceStepSettings {
  const baseUrl = 'http://127.0.0.1:8001'
  return { baseUrl, connectionId: aceStepConnectionId(baseUrl), waitMinutes: 60, allowLan: false }
}
function upgradeImage(draft: LegacyImageDraft): ImageDraft {
  const sizes: Record<string, string> = { '1536x864': '1664x928', '1024x1024': '1328x1328', '864x1536': '928x1664' }
  return { ...DEFAULT_IMAGE, prompt: draft.prompt, size: sizes[draft.size] }
}
export async function migrateSettings(path: string, raw: unknown): Promise<Settings> {
  const modern = settingsSchema.safeParse(raw)
  if (modern.success) return modern.data
  const v3 = settingsV3Schema.safeParse(raw)
  const v2 = settingsV2Schema.safeParse(raw)
  const parsed = v3.success ? v3 : v2.success ? v2 : settingsV1Schema.safeParse(raw)
  if (!parsed.success) throw new AppError('设置文件损坏或格式不兼容；原文件未被覆盖。')
  const previous = parsed.data
  const next = settingsSchema.parse({
    ...previous, version: 4, aceStep: defaultAceStepSettings(), musicDefaults: { ...previous.musicDefaults, provider: 'mureka' },
    imageDefaults: previous.version === 3 ? previous.imageDefaults : upgradeImage(previous.imageDefaults)
  })
  await commitUpgrade(path, next, previous.version)
  return next
}
export async function migrateProject(path: string, raw: unknown, directory: string, expectedId: string): Promise<Project> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('项目文件格式不正确')
  const trusted = { ...raw, directory }
  if (!('id' in raw) || raw.id !== expectedId) throw new AppError('项目与索引标识不一致，未升级')
  const modern = projectSchema.safeParse(trusted)
  if (modern.success) return modern.data
  const v3 = projectV3Schema.safeParse(trusted)
  const v2 = projectV2Schema.safeParse(trusted)
  const legacy = v3.success ? v3 : v2.success ? v2 : projectV1Schema.safeParse(trusted)
  if (!legacy.success) throw new AppError('项目数据损坏或格式不兼容，未覆盖原文件。')
  const previous = legacy.data
  const next = projectSchema.parse({
    video: structuredClone(DEFAULT_VIDEO), videoJobs: [], ...previous, version: 4,
    music: { ...previous.music, provider: 'mureka' },
    musicJobs: previous.musicJobs.map(job => ({
      ...job, snapshot: { ...job.snapshot, provider: 'mureka' }, binding: { provider: 'mureka', adapterVersion: 1 }
    })),
    audio: previous.audio.map(asset => ({ ...asset, provider: 'mureka' })),
    image: previous.version === 3 ? previous.image : upgradeImage(previous.image),
    images: previous.version === 3 ? previous.images : previous.images.map(asset => ({ ...asset, provider: 'openai', format: 'png' })),
    imageJobs: previous.version === 3 ? previous.imageJobs : previous.imageJobs.map(job => ({
      ...job, provider: 'openai',
      ...(['submitting', 'downloading'].includes(job.status) ? {
        status: 'unknown', error: '旧 OpenAI 图片请求已中断，可能已计费。请核对原服务商后台；不会转到硅基流动重新生成。'
      } : {})
    }))
  })
  await commitUpgrade(path, next, previous.version)
  return next
}
