import { dialog, shell, type BrowserWindow } from 'electron'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { idSchema } from '../../../../../src/shared/schemas'
import { batchGroupInputSchema, batchRequestSchema } from '../../../../../src/shared/batch-schemas'
import type { LibrarySnapshot } from '../../../../../src/shared/library-types'
import type { LibraryStore } from '../storage/library'
import type { ProjectStore } from '../storage/projects'
import type { SettingsStore } from '../storage/settings'
import type { VideoBatchStore } from '../storage/video-batches'
import type { ExportReceiptStore } from '../storage/export-receipts'
import type { BatchJobManager } from '../video/batch-jobs'
import { AppError } from '../../../../../src/main/providers/http'
import { SerialQueue } from '../../../../../src/main/storage/atomic'
import { managedDirectory } from '../../../../../src/main/storage/managed'
import { decorateLibrary } from './usage'

export interface LibraryServices {
  library: LibraryStore; projects: ProjectStore; settings: SettingsStore; batches: VideoBatchStore
  receipts: ExportReceiptStore; batchJobs: BatchJobManager
  work: LocalLibraryWork
}
/** Close waits for owned disk transactions; it never terminates unknown processes. */
export class LocalLibraryWork {
  private operations = new Set<Promise<unknown>>()
  private closing = false
  get busy(): boolean { return !!this.operations.size }
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AppError('软件正在关闭'))
    const work = action()
    this.operations.add(work)
    void work.finally(() => this.operations.delete(work)).catch(() => undefined)
    return work
  }
  async idle(): Promise<void> { while (this.operations.size) await Promise.allSettled([...this.operations]) }
  async shutdown(): Promise<void> { this.closing = true; await this.idle() }
}
export async function librarySnapshot(services: LibraryServices): Promise<LibrarySnapshot> {
  const { library, projects, batches, receipts } = services
  return { config: library.getConfig(), assets: decorateLibrary(await library.all(), await projects.all(), await batches.all(), receipts.all()),
    warnings: [...projects.warnings, ...library.warnings, ...receipts.warnings] }
}
type Handle = <A extends unknown[]>(name: string, schema: z.ZodType<A>, fn: (...args: A) => unknown) => void
export function registerLibraryIPC(window: BrowserWindow, handle: Handle, services: LibraryServices): void {
  const { library, projects, settings, batches, batchJobs, work } = services
  const none = z.tuple([]); const one = z.tuple([idSchema]); const two = z.tuple([idSchema, idSchema])
  const generation = new SerialQueue()
  let importing = false
  handle('canvas:library:get', none, () => librarySnapshot(services))
  handle('canvas:library:refresh', none, () => work.run(async () => { await library.refresh(); return librarySnapshot(services) }))
  handle('canvas:library:import', z.tuple([z.enum(['audio', 'image'])]), kind => work.run(async () => {
    if (importing) throw new AppError('已有素材导入正在处理')
    importing = true
    try {
      const selected = await dialog.showOpenDialog(window, { title: kind === 'audio' ? '导入音乐到总素材库' : '导入图片到总素材库', properties: ['openFile', 'multiSelections'],
        filters: [{ name: kind === 'audio' ? '音乐' : '图片', extensions: kind === 'audio' ? ['mp3', 'wav', 'flac', 'm4a'] : ['png', 'jpg', 'jpeg', 'webp'] }] })
      if (selected.canceled) return { entries: [], cancelled: true }
      return await library.importFiles(selected.filePaths, kind)
    } finally { importing = false }
  }))
  handle('canvas:library:choose-root', none, () => work.run(async () => {
    if ((await batches.all()).length) throw new AppError('已有批量成片记录，不能更改素材库根目录')
    if (importing) throw new AppError('请等待导入完成后再设置目录')
    const selected = await dialog.showOpenDialog(window, { title: '选择首次导入的素材库位置', properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return null
    return library.configureRoot(selected.filePaths[0])
  }))
  handle('canvas:generation:project', none, () => work.run(() => generation.run(async () => {
    const id = library.getConfig().generationProjectId
    if (id) return projects.get(id)
    const created = await projects.create(settings.get())
    const project = await projects.patch(created.id, { name: '素材生成' })
    await library.setGenerationProject(project.id)
    return project
  })))
  async function saveAs(source: string, name: string, type: string): Promise<string | null> {
    const selected = await dialog.showSaveDialog(window, { title: '另存为', defaultPath: name, filters: [{ name: type, extensions: [path.extname(source).slice(1)] }] })
    if (selected.canceled || !selected.filePath) return null
    if (path.resolve(source).toLowerCase() !== path.resolve(selected.filePath).toLowerCase()) await copyFile(source, selected.filePath)
    return selected.filePath
  }
  handle('canvas:library:export', one, id => work.run(async () => {
    const asset = await library.get(id)
    const source = await library.pathForAsset(id)
    const name = `${path.parse(asset.name).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}${path.extname(source)}`
    return saveAs(source, name, asset.kind === 'audio' ? '音乐' : '图片')
  }))
  handle('canvas:library:reveal', one, async id => { shell.showItemInFolder(await library.pathForAsset(id)) })
  handle('canvas:batch:plan', z.tuple([batchRequestSchema]), input => batchJobs.plan(input))
  handle('canvas:batch:revise', z.tuple([idSchema, z.array(batchGroupInputSchema).min(1).max(100)]), (id, groups) => batchJobs.revise(id, groups))
  handle('canvas:batch:start', one, id => batchJobs.start(id))
  handle('canvas:batch:list', none, () => batches.all())
  handle('canvas:batch:pause', one, id => batchJobs.pause(id))
  handle('canvas:batch:continue', one, id => batchJobs.continue(id))
  handle('canvas:batch:cancel', one, id => batchJobs.cancel(id))
  handle('canvas:batch:export', two, (id, jobId) => work.run(async () => {
    const batch = await batches.get(id)
    const job = batch.jobs.find(j => j.id === jobId)!
    const source = await batches.pathForAsset(id, jobId)
    return saveAs(source, `${batch.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-${String(job.index + 1).padStart(2, '0')}.mp4`, '视频')
  }))
  handle('canvas:batch:reveal', z.tuple([idSchema, idSchema.optional()]), async (id: string, jobId?: string) => {
    if (jobId) shell.showItemInFolder(await batches.pathForAsset(id, jobId))
    else {
      const directory = await managedDirectory((await batches.get(id)).directory)
      if (await shell.openPath(directory)) throw new AppError('无法打开批次输出目录')
    }
  })
}
