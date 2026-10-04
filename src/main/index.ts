import { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { SettingsStore } from './storage/settings'
import { ProjectStore } from './storage/projects'
import { SecretStore } from './storage/secrets'
import { resolveDataDirectory } from './storage/data-directory'
import { MurekaProvider } from './providers/mureka'
import { SiliconFlowImagesProvider } from './providers/siliconflow-images'
import { JobManager } from './jobs'
import { VideoJobManager } from './video/jobs'
import { registerIPC } from './ipc'
import { mediaResponse } from './media-protocol'
import { safeError } from './providers/http'
import { APP_NAME } from '../shared/branding'
import { LibraryStore } from './storage/library'
import { VideoBatchStore } from './storage/video-batches'
import { ExportReceiptStore } from './storage/export-receipts'
import { BatchJobManager } from './video/batch-jobs'
import { RenderScheduler } from './video/scheduler'
import { projectPublication } from './library/usage'
import { LocalLibraryWork } from './library/ipc'

const legacyDefault = app.getPath('userData')
const explicitDirectory = app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined
app.setName(APP_NAME)
const testMode = !app.isPackaged && process.env.MUSIC_CANVAS_E2E === '1'
let testDirectory: string | undefined
if (testMode) {
  if (!process.env.MUSIC_CANVAS_TEST_DIR || !path.isAbsolute(process.env.MUSIC_CANVAS_TEST_DIR)) throw new Error('测试必须使用独立绝对路径')
  testDirectory = path.join(process.env.MUSIC_CANVAS_TEST_DIR, 'appdata')
  app.setPath('userData', testDirectory)
}
protocol.registerSchemesAsPrivileged([{ scheme: 'canvas-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
let window: BrowserWindow | null = null
let jobs: JobManager | undefined
let video: VideoJobManager | undefined
let batchJobs: BatchJobManager | undefined
const libraryWork = new LocalLibraryWork()
let allowClose = false
let closePrompt = false
const busy = (): boolean => !!(jobs?.busy || video?.busy || batchJobs?.busy || libraryWork.busy)
async function requestClose(quit: boolean): Promise<void> {
  if (closePrompt) return
  closePrompt = true
  try {
    if (!testMode) {
      const options: Electron.MessageBoxOptions = {
        type: 'warning', title: '仍有任务在处理', message: '关闭将停止本地视频处理；服务商已接收的生成请求仍可能计费。',
        detail: '本地合成会停止，批量队列下次需手动继续，成功成片和原素材保留。正在导入的本地文件会完成保存后关闭。音乐任务可恢复查询，图片请求中断后可能无法恢复。',
        buttons: ['继续等待', '取消本地任务并关闭'], defaultId: 0, cancelId: 0
      }
      const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      if (result.response !== 1) return
    }
    jobs?.shutdown()
    await video?.shutdown()
    await batchJobs?.shutdown()
    await libraryWork.shutdown()
    allowClose = true
    if (quit) app.quit(); else window?.close()
  } finally { closePrompt = false }
}
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
void app.whenReady().then(async () => {
  const dataDir = await resolveDataDirectory({ appData: app.getPath('appData'), explicit: testDirectory ?? explicitDirectory, legacyDefault }, async paths => {
    const answer = await dialog.showMessageBox({
      title: '选择已有数据', type: 'question', message: '找到多份历史数据，请选择要继续使用的一份。不会合并、搬移或覆盖。',
      detail: paths.map((p, i) => `${i + 1}. ${p}`).join('\n'), buttons: [...paths.map((p, i) => `${i + 1}. ${path.basename(p)}`), '取消启动'],
      cancelId: paths.length, defaultId: 0
    })
    return paths[answer.response] ?? null
  })
  if (!dataDir) { app.quit(); return }
  await mkdir(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  const root = testMode ? path.join(process.env.MUSIC_CANVAS_TEST_DIR!, '项目 素材') : path.join(app.getPath('documents'), APP_NAME)
  const settings = new SettingsStore(dataDir, root)
  const secrets = new SecretStore(dataDir, safeStorage)
  const projects = new ProjectStore(dataDir)
  await settings.init(); await secrets.init(); await projects.init()
  const library = new LibraryStore({ dataDir, defaultRoot: path.join(settings.get().projectRoot, '总素材库'), projects, getFFmpegPath: () => settings.get().ffmpegPath })
  await library.init()
  const batches = new VideoBatchStore(dataDir, () => library.getConfig().root)
  const receipts = new ExportReceiptStore(dataDir)
  await batches.init(); await receipts.init(); await receipts.recover()
  const scheduler = new RenderScheduler()
  const mocks = testMode ? await import('./testing') : null
  const music = mocks ? new mocks.TestMusicProvider() : new MurekaProvider()
  const images = mocks ? new mocks.TestImageProvider() : new SiliconFlowImagesProvider()
  const onError = (message: string): void => { if (!testMode && !allowClose) dialog.showErrorBox('任务需要处理', message) }
  jobs = new JobManager({ projects, keys: secrets, music, images, ...(mocks ? { download: mocks.testDownload, downloadImage: mocks.testDownloadImage, pollIntervalMs: 100 } : {}), onError })
  video = new VideoJobManager({ projects, settings, onError, scheduler, publication: projectPublication(library, receipts) })
  batchJobs = new BatchJobManager({ library, batches, receipts, scheduler, getFFmpegPath: () => settings.get().ffmpegPath, onError })
  await video.recover(); await batchJobs.recover()
  await jobs.recover()
  protocol.handle('canvas-media', request => mediaResponse(request, projects, { library, batches }))
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: APP_NAME, backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: true,
    ...(app.isPackaged ? { icon: path.join(process.resourcesPath, 'icon.ico') } : {}),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false }
  })
  Menu.setApplicationMenu(null)
  const rendererURL = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  registerIPC(window, rendererURL, { projects, settings, secrets, jobs, video, music, images, testMode,
    libraryServices: { library, projects, settings, batches, receipts, batchJobs, work: libraryWork } })
  const libraryChanged = (): void => { if (window && !window.isDestroyed()) window.webContents.send('canvas:library-changed') }
  library.onChanged = libraryChanged
  receipts.onChanged = libraryChanged
  batches.onChanged = batch => { if (window && !window.isDestroyed()) window.webContents.send('canvas:batch-changed', batch); libraryChanged() }
  projects.onChanged = p => {
    if (window && !window.isDestroyed()) window.webContents.send('canvas:project-changed', p)
    void libraryWork.run(() => library.syncProject(p)).then(libraryChanged).catch(() => {
      const message = '生成成功的素材已保留，入库待恢复；请刷新素材库，不要重新生成。'
      if (!library.warnings.includes(message)) library.warnings.push(message)
      libraryChanged()
    })
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('ready-to-show', () => window?.show())
  window.on('close', event => {
    if (allowClose || !busy()) return
    event.preventDefault()
    void requestClose(false).catch(error => onError(safeError(error)))
  })
  window.on('closed', () => { window = null })
  await window.loadURL(rendererURL)
  void libraryWork.run(() => library.refresh()).then(libraryChanged).catch(() => {
    const message = '部分历史素材入库待恢复，请刷新素材库；原项目和文件未改动。'
    if (!library.warnings.includes(message)) library.warnings.push(message)
    libraryChanged()
  })
}).catch(error => { dialog.showErrorBox(`${APP_NAME}无法启动`, safeError(error)); app.exit(1) })
app.on('before-quit', event => {
  if (!allowClose && busy()) { event.preventDefault(); void requestClose(true).catch(error => dialog.showErrorBox('关闭失败', safeError(error))) }
  else jobs?.shutdown()
})
app.on('window-all-closed', () => { jobs?.shutdown(); void Promise.all([video?.shutdown(), batchJobs?.shutdown(), libraryWork.shutdown()]).finally(() => app.quit()) })
