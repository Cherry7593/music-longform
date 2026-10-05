import { ipcMain, dialog, shell, clipboard, type BrowserWindow } from 'electron'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { idSchema, providerSchema } from '../shared/schemas'
import { alternativesSchema, apiInputSchema, compositionDraftSchema, entryDraftSchema, generationSelectionSchema, nameSchema, settingsUpdateSchema } from '../shared/workbench-schemas'
import { batchGroupInputSchema } from '../shared/batch-schemas'
import type { WorkbenchAPI } from '../shared/workbench-types'
import { AppError, safeError } from './providers/http'
import type { WorkbenchService } from './workbench-service'
import { atomicJson } from './storage/atomic'
import { managedDirectory } from './storage/managed'
import { discoverTools } from './video/ffmpeg'
import { probeEncoder, toolIdentity } from './video/encoders'

/** Explicit method whitelist and per-operation schemas; no arbitrary IPC or filesystem capability. */
export function registerWorkbenchIPC(window: BrowserWindow, rendererURL: string, service: WorkbenchService): void {
  function handle<A extends unknown[]>(method: Exclude<keyof WorkbenchAPI, 'onChanged'>, schema: z.ZodType<A>, action: (...args: A) => unknown, mutation = false) {
    ipcMain.handle(`canvas:workbench:${method}`, async (event, ...input: unknown[]) => {
      try {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererURL.split('#')[0]) throw new AppError('拒绝来自非应用页面的操作')
        const args = schema.parse(input)
        const value = mutation ? await service.track(async () => action(...args), true) : await action(...args)
        return { ok: true, value }
      } catch (error) { return { ok: false, error: error instanceof z.ZodError ? '参数不符合当前操作要求，请检查输入，未执行操作。' : safeError(error) } }
    })
  }
  const none = z.tuple([]), id = z.tuple([idSchema]), two = z.tuple([idSchema, idSchema]), revision = z.number().int().nonnegative()
  const { assets, db } = service.deps
  handle('bootstrap', none, () => service.snapshot())
  handle('createGenerationProject', none, async () => { const project = await service.generationProjects.create(); await service.updateSettings({ lastGenerationId: project.id }); return project }, true)
  handle('updateGenerationProject', z.tuple([idSchema, z.object({ name: nameSchema.optional(), page: z.enum(['audio', 'image']).optional() }).strict()]), (projectId, patch) => service.generationProjects.update(projectId, patch), true)
  handle('generationProjectImpact', id, projectId => service.generationProjects.impact(projectId))
  handle('deleteGenerationProject', id, projectId => service.generationProjects.delete(projectId), true)
  handle('addEntry', z.tuple([idSchema, z.enum(['audio', 'image']), z.union([idSchema, z.undefined()])]), (projectId, kind, copyId) => service.generationProjects.add(projectId, kind, copyId), true)
  handle('updateEntry', z.tuple([idSchema, revision, entryDraftSchema, alternativesSchema]), (entryId, version, draft, alternatives) => service.generationProjects.updateEntry(entryId, version, draft, alternatives), true)
  handle('deleteEntry', id, entryId => service.generationProjects.deleteEntry(entryId), true)
  handle('submitEntries', z.tuple([generationSelectionSchema]), selection => service.generation.submit(selection), true)
  handle('stopGeneration', id, projectId => service.generation.stop(projectId), true)
  handle('resumeRequest', id, requestId => service.generation.resume(requestId), true)
  handle('abandonRequest', id, requestId => service.generation.abandon(requestId), true)
  handle('listApis', none, () => service.apis.list())
  handle('saveApi', z.tuple([apiInputSchema]), input => service.apis.save(input), true)
  handle('apiImpact', z.tuple([providerSchema]), provider => service.apis.impact(provider))
  handle('deleteApi', z.tuple([providerSchema]), provider => service.apis.delete(provider), true)
  handle('testApi', z.tuple([apiInputSchema]), input => service.track(() => service.apis.test(input)))
  handle('getAceStepModels', none, () => service.track(() => service.deps.registry.getAceStepModels(service.apis.connection(service.apis.binding('acestep')))))
  handle('createCompositionProject', none, async () => { const project = await service.compositionProjects.create(); await service.updateSettings({ lastCompositionId: project.id }); return project }, true)
  handle('updateCompositionProject', z.tuple([idSchema, revision, z.object({ name: nameSchema.optional(), draft: compositionDraftSchema.optional() }).strict()]), (projectId, version, patch) => service.compositionProjects.update(projectId, version, patch), true)
  handle('compositionProjectImpact', id, projectId => service.compositionProjects.impact(projectId))
  handle('deleteCompositionProject', id, projectId => service.compositionProjects.delete(projectId), true)
  handle('planComposition', z.tuple([idSchema, revision]), (projectId, version) => service.track(() => service.composition.plan(projectId, version)))
  handle('reviseCompositionPlan', z.tuple([idSchema, idSchema, z.array(batchGroupInputSchema).min(1).max(100)]), (projectId, planId, groups) => service.composition.revise(projectId, planId, groups), true)
  handle('startComposition', two, (projectId, planId) => service.composition.start(projectId, planId), true)
  handle('pauseBatch', id, batchId => service.composition.pause(batchId), true)
  handle('continueBatch', id, batchId => service.composition.continue(batchId), true)
  handle('cancelBatch', id, batchId => service.composition.cancel(batchId), true)
  handle('cancelRenderJob', two, (batchId, jobId) => service.composition.cancelJob(batchId, jobId), true)
  handle('cancelComposition', id, projectId => service.composition.cancelProject(projectId), true)
  handle('getAssets', none, () => assets.all(service.composition.queuedIds()))
  handle('refreshAssets', none, () => service.track(async () => { await assets.refresh(); return assets.all(service.composition.queuedIds()) }))
  handle('importAssets', z.tuple([z.enum(['audio', 'image'])]), async kind => {
    const selected = await dialog.showOpenDialog(window, { title: kind === 'audio' ? '导入音乐到素材库' : '导入图片到素材库', properties: ['openFile', 'multiSelections'],
      filters: [{ name: kind === 'audio' ? '音乐' : '图片', extensions: kind === 'audio' ? ['mp3', 'wav', 'flac', 'm4a'] : ['png', 'jpg', 'jpeg', 'webp'] }] })
    return selected.canceled ? { entries: [], cancelled: true } : assets.importFiles(selected.filePaths, kind)
  }, true)
  handle('renameAsset', z.tuple([idSchema, nameSchema]), (assetId, name) => assets.rename(assetId, name), true)
  handle('assetImpact', id, assetId => service.assetImpact(assetId))
  handle('deleteAsset', id, assetId => service.deleteAsset(assetId), true)
  handle('exportAsset', id, async assetId => {
    const release = await assets.pin([assetId], `save-as:${assetId}`)
    try {
      const asset = await assets.get(assetId), source = await assets.pathForAsset(assetId), extension = path.extname(source)
      const selected = await dialog.showSaveDialog(window, { title: '素材另存为', defaultPath: asset.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) + extension, filters: [{ name: '素材文件', extensions: [extension.slice(1)] }] })
      if (selected.canceled || !selected.filePath) return null
      if (path.resolve(source).toLowerCase() !== path.resolve(selected.filePath).toLowerCase()) await copyFile(source, selected.filePath)
      return selected.filePath
    } finally { release() }
  }, true)
  handle('revealAsset', id, async assetId => { shell.showItemInFolder(await assets.pathForAsset(assetId)) })
  handle('updateSettings', z.tuple([settingsUpdateSchema]), patch => service.updateSettings(patch), true)
  handle('chooseMediaRoot', none, async () => {
    if ((await assets.all()).length || db.list('requests').length || db.list('executions').length) throw new AppError('已有素材或执行记录，不能直接换库根目录；请保留现有文件位置。')
    const selected = await dialog.showOpenDialog(window, { title: '选择新素材保存位置', properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return null
    const root = await managedDirectory(selected.filePaths[0])
    await assets.configureRoot(root)
    const settings = await db.update('settings', 'current', value => { value.mediaRoot = root })
    await atomicJson(path.join(service.deps.dataDir, 'settings.json'), settings, 256 * 1024)
    return settings
  }, true)
  handle('checkVideoTools', none, () => service.track(async () => {
    const status = await discoverTools(service.settings().ffmpegPath)
    if (!status.available || !status.ffmpeg || !status.ffprobe) return status
    const parent = await managedDirectory(path.join(service.settings().mediaRoot, '.tool-tests'), true), directory = await mkdtemp(path.join(parent, 'encoder-'))
    try {
      const tools = { ffmpeg: status.ffmpeg, ffprobe: status.ffprobe }, signal = new AbortController().signal, identity = await toolIdentity(tools, signal)
      const encoders = []
      for (const encoder of ['cpu', 'nvenc', 'qsv'] as const) encoders.push(await probeEncoder(tools, encoder, directory, signal, 2, identity))
      return { ...status, encoders: encoders.map(({ encoder, available, message }) => ({ encoder, available, message })) }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }))
  handle('chooseFFmpeg', none, async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 FFmpeg（同目录须有 FFprobe）', properties: ['openFile'], filters: [{ name: 'FFmpeg', extensions: ['exe'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const status = await discoverTools(result.filePaths[0]); if (!status.available || !status.ffmpeg) throw new AppError(status.message)
    const settings = await db.update('settings', 'current', value => { value.ffmpegPath = status.ffmpeg })
    await atomicJson(path.join(service.deps.dataDir, 'settings.json'), settings, 256 * 1024); return settings
  }, true)
  handle('resetFFmpeg', none, async () => { const settings = await db.update('settings', 'current', value => { delete value.ffmpegPath }); await atomicJson(path.join(service.deps.dataDir, 'settings.json'), settings, 256 * 1024); return settings }, true)
  handle('getDiagnostics', id, taskId => service.diagnostics.list(taskId))
  handle('copyDiagnostic', id, async diagnosticId => { clipboard.writeText(JSON.stringify(service.diagnostics.get(diagnosticId), null, 2)) })
}
