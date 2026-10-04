import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../providers/http'
import { assertLocalMediaFile } from '../video/ffmpeg'
import { isMissing } from './atomic'

export async function managedDirectory(directory: string, create = false): Promise<string> {
  if (!path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory) || /^[\\/]{2}/.test(directory)
    || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(directory))) throw new AppError('保存目录必须是本地绝对路径')
  const resolved = path.resolve(directory)
  let current = resolved
  for (;;) {
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('保存目录不能是符号链接、重定向或普通文件')
    } catch (error) { if (!isMissing(error)) throw error }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (create) await mkdir(resolved, { recursive: true })
  if (path.relative(resolved, await realpath(resolved))) throw new AppError('保存目录被重定向，已停止操作')
  return resolved
}
export async function hashMedia(file: string, maximum = 32 * 1073741824): Promise<{ sha256: string; bytes: number }> {
  await assertLocalMediaFile(file)
  const before = await stat(file)
  if (before.size <= 0 || before.size > maximum) throw new AppError('媒体文件大小无效或超出限制')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const value of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const chunk = value as Buffer
    bytes += chunk.length
    if (bytes > maximum) throw new AppError('媒体文件超出大小限制')
    hash.update(chunk)
  }
  await assertLocalMediaFile(file)
  const after = await stat(file)
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new AppError('检查期间文件发生改变，请重新规划')
  return { sha256: hash.digest('hex'), bytes }
}
