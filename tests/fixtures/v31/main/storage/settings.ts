import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AceStepConfiguration } from '../../../../../src/shared/music-types'
import { aceStepConfigurationSchema } from '../../../../../src/shared/music-schemas'
import { DEFAULT_IMAGE, DEFAULT_MUSIC, settingsPatchSchema } from '../../../../../src/shared/schemas'
import type { Settings, SettingsPatch } from '../../../../../src/shared/types'
import { AppError } from '../../../../../src/main/providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from '../../../../../src/main/storage/atomic'
import { settingsSchema } from '../../../../../src/main/storage/validation'
import { migrateSettings, defaultAceStepSettings, aceStepConnectionId } from '../../../../../src/main/storage/migrations'

export class SettingsStore {
  private value?: Settings
  private readonly queue = new SerialQueue()
  private readonly path: string

  constructor(private readonly dataDir: string, private readonly defaultProjectRoot: string) {
    this.path = join(dataDir, 'settings.json')
  }

  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.value) return
      try { await mkdir(this.dataDir, { recursive: true }) } catch { throw new AppError('无法创建设置目录，请检查存储权限。') }
      let data: unknown
      try { data = await readJson(this.path, 256 * 1024) } catch (error) {
        if (!isMissing(error)) throw new AppError('设置文件损坏、不可读取或格式不兼容；请先备份并修复，原文件未被覆盖。')
        const defaults = settingsSchema.safeParse({ version: 4, aceStep: defaultAceStepSettings(), projectRoot: this.defaultProjectRoot, musicDefaults: DEFAULT_MUSIC, imageDefaults: DEFAULT_IMAGE })
        if (!defaults.success) throw new AppError('默认项目目录必须是有效的绝对路径。')
        try { await atomicJson(this.path, defaults.data) } catch { throw new AppError('设置保存失败，请检查存储位置和权限。') }
        data = defaults.data
      }
      this.value = await migrateSettings(this.path, data)
    })
  }

  get(): Settings {
    if (!this.value) throw new AppError('设置尚未初始化。')
    return structuredClone(this.value)
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const parsed = settingsPatchSchema.safeParse(patch)
    if (!parsed.success) throw new AppError('设置参数不正确。')
    return this.queue.run(async () => {
      const next = settingsSchema.safeParse({ ...this.get(), ...parsed.data })
      if (!next.success) throw new AppError('设置参数不正确，项目目录必须是绝对路径。')
      try { await atomicJson(this.path, next.data) } catch { throw new AppError('设置保存失败，请检查存储位置和权限。') }
      this.value = next.data
      return this.get()
    })
  }

  async configureAceStep(value: AceStepConfiguration): Promise<Settings> {
    const parsed = aceStepConfigurationSchema.safeParse(value)
    if (!parsed.success) throw new AppError('ACE-Step 地址或等待时间不正确；局域网地址需要明确确认。')
    return this.queue.run(async () => {
      const previous = this.get()
      const same = previous.aceStep.baseUrl === parsed.data.baseUrl
      const next = settingsSchema.parse({ ...previous, aceStep: { ...parsed.data, connectionId: same ? previous.aceStep.connectionId : aceStepConnectionId(parsed.data.baseUrl) } })
      try { await atomicJson(this.path, next) } catch { throw new AppError('本地接口设置保存失败，原设置未被替换。') }
      this.value = next
      return this.get()
    })
  }

  /** Native chooser only. This field is deliberately not exposed through arbitrary settings patches. */
  async setFFmpeg(path?: string): Promise<Settings> {
    return this.queue.run(async () => {
      const next = settingsSchema.safeParse({ ...this.get(), ffmpegPath: path })
      if (!next.success) throw new AppError('FFmpeg 路径不正确')
      try { await atomicJson(this.path, next.data) } catch { throw new AppError('工具设置保存失败，请检查存储权限') }
      this.value = next.data
      return this.get()
    })
  }
}
