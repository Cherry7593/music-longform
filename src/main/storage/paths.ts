import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { idSchema } from '../../shared/schemas'
import { AppError } from '../providers/http'
import type { AssetKind } from '../../shared/types'
export const assetDirectories: Record<AssetKind, string> = { audio: 'audio', image: 'images', video: 'videos', preview: 'previews' }

export function validAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !path.includes('\0') && path.length <= 2000
}

export function assertAssetId(id: string): void {
  if (!idSchema.safeParse(id).success) throw new AppError('素材标识不正确。')
}

export function validAssetName(fileName: string, kind: AssetKind, id: string): boolean {
  if (!idSchema.safeParse(id).success) return false
  if (kind === 'audio') return ['mp3', 'wav', 'flac', 'm4a'].some(extension => fileName === `audio/${id}.${extension}`)
  if (kind === 'image') return ['png', 'jpg', 'webp'].some(extension => fileName === `images/${id}.${extension}`)
  if (kind === 'video') return fileName === `videos/${id}.mp4`
  return kind === 'preview' && fileName === `previews/${id}.wav`
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Resolve the actual project root, then reject escaping or redirected child folders. */
export async function assetFolder(directory: string, kind: AssetKind, create = false): Promise<string> {
  if (!validAbsolutePath(directory)) throw new AppError('项目目录必须是有效的绝对路径。')
  try {
    const root = await realpath(directory)
    if (!(await stat(root)).isDirectory()) throw new AppError('项目目录不存在或不可访问。')
    if (!Object.hasOwn(assetDirectories, kind)) throw new AppError('不支持的素材类型')
    const folder = join(root, assetDirectories[kind])
    if (create) {
      try { await mkdir(folder) } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await lstat(folder)
    const actual = await realpath(folder)
    if (!info.isDirectory() || info.isSymbolicLink() || !within(root, actual) || relative(folder, actual) !== '') {
      throw new AppError('素材目录不安全，不能使用符号链接或越界目录。')
    }
    return actual
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('素材目录不存在或不可访问，请检查存储位置和权限。')
  }
}

export async function existingAssetPath(directory: string, kind: AssetKind, id: string, fileName: string): Promise<string> {
  if (!validAssetName(fileName, kind, id)) throw new AppError('素材路径不安全，已拒绝访问。')
  const folder = await assetFolder(directory, kind)
  const path = join(folder, fileName.slice(fileName.indexOf('/') + 1))
  try {
    const actual = await realpath(path)
    if (!within(folder, actual) || !(await lstat(path)).isFile() || !(await stat(actual)).isFile()) {
      throw new AppError('素材路径不安全，已拒绝访问。')
    }
    return actual
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('素材文件不存在或不可读取。')
  }
}
