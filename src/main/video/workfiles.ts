import { lstat, mkdir, realpath, rm, link, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { assertAssetId, assetDirectories, assetFolder } from '../storage/paths'
import { AppError } from '../providers/http'
import { isMissing } from '../storage/atomic'

export async function workDirectory(projectDirectory: string, kind: 'video' | 'preview', id: string, create: boolean): Promise<string> {
  assertAssetId(id)
  const folder = await assetFolder(projectDirectory, kind, create)
  const target = join(folder, `.work-${id}`)
  if (create) await mkdir(target) // exclusive: never adopt someone else's existing task directory
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || relative(target, await realpath(target)) !== '') throw new AppError('临时导出目录不安全，已停止处理')
  return target
}
export async function cleanupWork(projectDirectory: string, kind: 'video' | 'preview', id: string): Promise<void> {
  try {
    assertAssetId(id)
    await lstat(join(projectDirectory, assetDirectories[kind], `.work-${id}`))
    const target = await workDirectory(projectDirectory, kind, id, false)
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch (error) { if (!isMissing(error)) throw error }
}
/** Publish a completed file atomically without replacing an existing output. Same-volume NTFS link. */
export async function commitMedia(temporary: string, work: string, output: string): Promise<void> {
  const rel = relative(work, temporary)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new AppError('导出结果不在本任务临时目录中')
  const info = await lstat(temporary)
  if (!info.isFile() || info.isSymbolicLink() || relative(temporary, await realpath(temporary)) !== '') throw new AppError('导出结果不是安全的本地文件')
  if (relative(dirname(work), dirname(output)) !== '') throw new AppError('导出目标不在同一素材目录')
  try { await link(temporary, output) } catch {
    throw new AppError('无法安全提交成片。请确认保存磁盘支持硬链接（例如 NTFS），且目标文件未被占用；原素材未改动。')
  }
  // The output link is already complete; unlink failures can be handled by task cleanup.
  await unlink(temporary).catch(() => undefined)
}
