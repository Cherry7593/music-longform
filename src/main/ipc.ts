import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { idSchema, keySchema, projectPatchSchema, providerSchema, settingsPatchSchema } from '../shared/schemas'
import type { ImageProvider, MusicProvider, PublicSettings } from '../shared/types'
import type { ProjectStore } from './storage/projects'
import type { SettingsStore } from './storage/settings'
import type { SecretStore } from './storage/secrets'
import type { JobManager } from './jobs'
import { AppError, safeError } from './providers/http'
import type { VideoJobManager } from './video/jobs'
import { discoverTools } from './video/ffmpeg'
import { registerLibraryIPC, type LibraryServices } from './library/ipc'

interface Services { projects: ProjectStore; settings: SettingsStore; secrets: SecretStore; jobs: JobManager; video: VideoJobManager; music: MusicProvider; images: ImageProvider; testMode: boolean; libraryServices?: LibraryServices }
export function registerIPC(window: BrowserWindow, rendererURL: string, services: Services): void {
  const { projects, settings, secrets, jobs, video, music, images, testMode } = services
  const publicSettings = (): PublicSettings => ({ ...settings.get(), keys: { mureka: secrets.has('mureka'), siliconflow: secrets.has('siliconflow') }, encryptionAvailable: secrets.isAvailable() })
  function handle<A extends unknown[]>(name: string, schema: z.ZodType<A>, fn: (...args: A) => unknown): void {
    ipcMain.handle(name, async (event, ...args: unknown[]) => {
      try {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererURL.split('#')[0]) throw new AppError('拒绝来自非应用页面的操作')
        const values = schema.parse(args)
        return { ok: true, value: await fn(...values) }
      } catch (error) { return { ok: false, error: safeError(error) } }
    })
  }
  if (services.libraryServices) registerLibraryIPC(window, handle, services.libraryServices)
  const none = z.tuple([])
  const oneId = z.tuple([idSchema])
  const twoIds = z.tuple([idSchema, idSchema])
  const assetArgs = z.tuple([idSchema, z.enum(['audio', 'image', 'video', 'preview']), idSchema])
  handle('canvas:bootstrap', none, async () => {
    const list = await projects.list()
    const last = settings.get().lastProjectId
    const id = list.some(p => p.id === last) ? last : list[0]?.id
    return { projects: list, project: id ? await projects.get(id) : null, settings: publicSettings(), testMode, warnings: projects.warnings }
  })
  handle('canvas:projects:list', none, () => projects.list())
  handle('canvas:projects:create', none, async () => {
    const project = await projects.create(settings.get())
    await settings.update({ lastProjectId: project.id })
    return project
  })
  handle('canvas:projects:get', oneId, async id => {
    const project = await projects.get(id)
    await settings.update({ lastProjectId: id })
    return project
  })
  handle('canvas:projects:update', z.tuple([idSchema, projectPatchSchema]), (id, patch) => projects.patch(id, patch))
  handle('canvas:settings:get', none, publicSettings)
  // Storage root changes may only select a directory through the native chooser.
  let chosenDirectory: string | undefined
  handle('canvas:directory:choose', none, async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择新项目的保存位置', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled) return null
    chosenDirectory = result.filePaths[0]
    return chosenDirectory
  })
  handle('canvas:settings:update', z.tuple([settingsPatchSchema]), async patch => {
    if (patch.projectRoot && patch.projectRoot !== settings.get().projectRoot && patch.projectRoot !== chosenDirectory) throw new AppError('请使用“选择文件夹”更改保存位置')
    await settings.update(patch)
    return publicSettings()
  })
  handle('canvas:keys:set', z.tuple([providerSchema, keySchema]), async (provider, key) => { await secrets.set(provider, key); return publicSettings() })
  handle('canvas:keys:clear', z.tuple([providerSchema]), async provider => { await secrets.clear(provider); return publicSettings() })
  handle('canvas:keys:check', z.tuple([providerSchema]), provider => (provider === 'mureka' ? music : images).check(secrets.get(provider)))
  handle('canvas:music:start', oneId, id => jobs.startMusic(id))
  handle('canvas:music:stop', twoIds, (id, batchId) => jobs.stopMusic(id, batchId))
  handle('canvas:music:continue', twoIds, (id, batchId) => jobs.continueMusic(id, batchId))
  handle('canvas:music:retry-query', twoIds, (id, jobId) => jobs.retryMusicJob(id, jobId))
  handle('canvas:image:start', oneId, id => jobs.startImage(id))
  handle('canvas:audio:keep', z.tuple([idSchema, idSchema, z.boolean()]), (id, assetId, kept) => projects.mutate(id, p => {
    const asset = p.audio.find(a => a.id === assetId)
    if (!asset) throw new AppError('没有找到该音乐素材')
    asset.kept = kept
  }))
  handle('canvas:image:select', twoIds, (id, assetId) => projects.mutate(id, p => {
    if (!p.images.some(a => a.id === assetId)) throw new AppError('没有找到该图片素材')
    p.selectedImageId = assetId
  }))
  handle('canvas:directory:open', oneId, async id => {
    const error = await shell.openPath((await projects.get(id)).directory)
    if (error) throw new AppError('无法打开素材目录，请检查文件夹是否存在')
  })
  handle('canvas:asset:export', assetArgs, async (id, kind, assetId) => {
    const source = await projects.pathForAsset(id, kind, assetId)
    const extension = path.extname(source).slice(1)
    const result = await dialog.showSaveDialog(window, { title: '素材另存为', defaultPath: path.basename(source), filters: [{ name: kind === 'video' ? '视频' : kind === 'image' ? '图片' : '音频', extensions: [extension] }] })
    if (result.canceled || !result.filePath) return null
    if (path.resolve(result.filePath).toLowerCase() !== path.resolve(source).toLowerCase()) await copyFile(source, result.filePath)
    return result.filePath
  })
  handle('canvas:asset:reveal', assetArgs, async (id, kind, assetId) => { shell.showItemInFolder(await projects.pathForAsset(id, kind, assetId)) })
  handle('canvas:video:tools', none, () => video.checkTools())
  handle('canvas:video:choose-ffmpeg', none, async () => {
    const selected = await dialog.showOpenDialog(window, { title: '选择 FFmpeg（同目录须有 FFprobe）', properties: ['openFile'], filters: [{ name: 'FFmpeg 程序', extensions: ['exe'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const status = await discoverTools(selected.filePaths[0])
    if (!status.available || !status.ffmpeg) throw new AppError(status.message)
    await settings.setFFmpeg(status.ffmpeg)
    return publicSettings()
  })
  handle('canvas:video:reset-ffmpeg', none, async () => { await settings.setFFmpeg(); return publicSettings() })
  handle('canvas:video:analyze', oneId, id => video.analyze(id))
  handle('canvas:video:start', oneId, id => video.start(id))
  handle('canvas:video:preview', z.tuple([idSchema, z.number().int().min(0).max(98)]), (id, index) => video.start(id, 'preview', index))
  handle('canvas:video:cancel', twoIds, (id, jobId) => video.cancel(id, jobId))
}
