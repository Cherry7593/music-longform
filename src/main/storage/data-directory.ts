import { lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { APP_NAME, LEGACY_APP_NAMES } from '../../shared/branding'
import { AppError } from '../providers/http'
import { isMissing, readJson } from './atomic'
import { projectIndexSchema, settingsSchema, settingsV1Schema, settingsV2Schema, settingsV3Schema } from './validation'
import { workbenchSettingsSchema } from '../../shared/workbench-schemas'

interface DirectoryOptions { appData: string; explicit?: string; legacyDefault?: string }
/** Read-only detection: never creates a directory, merges data, or changes ciphertext. */
export async function dataCandidates(options: DirectoryOptions): Promise<string[]> {
  const paths = [...new Set([APP_NAME, ...LEGACY_APP_NAMES].map(name => join(options.appData, name)).concat(options.legacyDefault ?? []))]
  const present: string[] = []
  for (const path of paths) {
    let hasData = false, modern = false
    for (const file of ['settings.json', 'projects.json', 'secrets.json']) {
      if (file === 'projects.json' && modern) continue // Migration archives are no longer runtime project storage.
      const full = join(path, file)
      try {
        if (!(await lstat(full)).isFile()) throw new AppError(`历史数据文件不可读取：${full}。未建立空账户替代旧数据。`)
        const raw = await readJson(full, file === 'projects.json' ? 4 * 1024 * 1024 : 256 * 1024)
        if (file === 'settings.json' && !workbenchSettingsSchema.safeParse(raw).success && !settingsSchema.safeParse(raw).success && !settingsV1Schema.safeParse(raw).success && !settingsV2Schema.safeParse(raw).success && !settingsV3Schema.safeParse(raw).success) throw new Error('invalid settings')
        if (file === 'settings.json' && workbenchSettingsSchema.safeParse(raw).success) modern = true
        if (file === 'projects.json' && !projectIndexSchema.safeParse(raw).success) throw new Error('invalid index')
        if (file === 'secrets.json' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('invalid secrets')
        hasData = true
      } catch (error) {
        if (isMissing(error)) continue
        throw new AppError(`检测到旧数据但格式损坏或不可读取：${full}。请先备份并修复；未覆盖或跳过这些数据。`)
      }
    }
    if (hasData) present.push(resolve(path))
  }
  return present
}
export async function resolveDataDirectory(options: DirectoryOptions, choose: (paths: string[]) => Promise<string | null>): Promise<string | null> {
  if (options.explicit !== undefined) {
    if (!isAbsolute(options.explicit) || options.explicit.includes('\0')) throw new AppError('指定的用户数据目录必须是有效的绝对路径')
    return resolve(options.explicit)
  }
  const candidates = await dataCandidates(options)
  if (!candidates.length) return join(options.appData, APP_NAME)
  if (candidates.length === 1) return candidates[0]
  const chosen = await choose(candidates)
  if (chosen === null) return null
  if (!candidates.includes(chosen)) throw new AppError('数据目录选择不正确，未合并或修改任何历史目录')
  return chosen
}
