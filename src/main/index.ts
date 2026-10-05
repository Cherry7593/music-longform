import { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { SecretStore } from './storage/secrets'
import { resolveDataDirectory } from './storage/data-directory'
import { MurekaProvider } from './providers/mureka'
import { MusicRegistry } from './providers/music-registry'
import { SiliconFlowImagesProvider } from './providers/siliconflow-images'
import { mediaResponse } from './media-protocol'
import { AppError, safeError } from './providers/http'
import { APP_NAME } from '../shared/branding'
import { WorkbenchDB } from './storage/workbench-db'
import { AssetStore } from './storage/assets-v2'
import { inspectV4Migration, migrateV4 } from './storage/migration-v4'
import { WorkbenchService } from './workbench-service'
import { registerWorkbenchIPC } from './workbench-ipc'

const legacyDefault = app.getPath('userData')
const explicit = app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined
app.setName(APP_NAME)
const testMode = !app.isPackaged && process.env.MUSIC_CANVAS_E2E === '1'
let testDirectory: string | undefined
if (testMode) {
  if (!process.env.MUSIC_CANVAS_TEST_DIR || !path.isAbsolute(process.env.MUSIC_CANVAS_TEST_DIR)) throw new Error('测试必须使用独立绝对路径')
  testDirectory = path.join(process.env.MUSIC_CANVAS_TEST_DIR, 'appdata'); app.setPath('userData', testDirectory)
}
protocol.registerSchemesAsPrivileged([{ scheme: 'canvas-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
let window: BrowserWindow | null = null
let service: WorkbenchService | undefined
let allowClose = false, closePrompt = false
async function requestClose(quit: boolean): Promise<void> {
  if (closePrompt) return
  closePrompt = true
  try {
    if (!testMode) {
      const options: Electron.MessageBoxOptions = { type: 'warning', title: '仍有任务在处理', message: '关闭将停止本机视频任务，保留项目、素材和执行记录。',
        detail: '已受理的生成请求仍可能计费或占用本地推理资源。本软件不会停止 ACE-Step 服务；未完成视频下次需手动继续。正在保存的本地文件会完成事务后退出。',
        buttons: ['继续等待', '取消本地任务并关闭'], defaultId: 0, cancelId: 0 }
      const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      if (answer.response !== 1) return
    }
    await service?.shutdown(); allowClose = true
    if (quit) app.quit(); else window?.close()
  } finally { closePrompt = false }
}
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
void app.whenReady().then(async () => {
  const dataDir = await resolveDataDirectory({ appData: app.getPath('appData'), explicit: testDirectory ?? explicit, legacyDefault }, async paths => {
    const answer = await dialog.showMessageBox({ title: '选择已有数据', type: 'question', message: '找到多份历史数据，请选择要继续使用的一份。不会合并或覆盖。',
      detail: paths.map((directory, index) => `${index + 1}. ${directory}`).join('\n'), buttons: [...paths.map((directory, index) => `${index + 1}. ${path.basename(directory)}`), '取消启动'], cancelId: paths.length, defaultId: 0 })
    return paths[answer.response] ?? null
  })
  if (!dataDir) { app.quit(); return }
  await mkdir(dataDir, { recursive: true }); app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  const defaultMediaRoot = testMode ? path.join(process.env.MUSIC_CANVAS_TEST_DIR!, '素材库') : path.join(app.getPath('documents'), APP_NAME, '素材库')
  const inspected = await inspectV4Migration(dataDir, defaultMediaRoot)
  const db = new WorkbenchDB(dataDir); await db.init()
  const secrets = new SecretStore(dataDir, safeStorage); await secrets.init()
  const assets = new AssetStore({ dataDir, root: inspected.mediaRoot, getFFmpegPath: () => db.has('settings', 'current') ? db.get('settings', 'current').ffmpegPath : inspected.legacySettings?.ffmpegPath })
  await assets.init()
  const migration = await migrateV4({ dataDir, db, assets, secrets, defaultMediaRoot })
  const mocks = testMode ? await import('./testing') : null
  const music = mocks ? new mocks.TestMusicProvider() : new MurekaProvider()
  const images = mocks ? new mocks.TestImageProvider() : new SiliconFlowImagesProvider()
  const registry = new MusicRegistry(music, mocks?.testMusicFetch ?? fetch)
  service = new WorkbenchService({ dataDir, db, assets, secrets, registry, images, testMode, warnings: [...inspected.warnings, ...migration.warnings],
    ...(mocks ? { saveAudio: mocks.testSaveGeneratedAudio, saveImage: mocks.testDownloadImage, pollMs: 100 } : {}) })
  await service.init()
  // Legacy project/batch URL forms have no runtime resolver; migrated assets use their global ID.
  protocol.handle('canvas-media', request => mediaResponse(request, { pathForAsset: async () => { throw new AppError('请使用已迁移的全局资产标识') } },
    { library: assets, batches: { pathForAsset: async () => { throw new AppError('请使用视频库资产标识') } } }))
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 640, title: APP_NAME, backgroundColor: '#f5f6f8', show: false, autoHideMenuBar: true,
    ...(app.isPackaged ? { icon: path.join(process.resourcesPath, 'icon.ico') } : {}),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } })
  Menu.setApplicationMenu(null)
  const rendererURL = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  registerWorkbenchIPC(window, rendererURL, service)
  let notification: ReturnType<typeof setTimeout> | undefined
  service.onChanged = () => {
    if (notification) return
    notification = setTimeout(() => { notification = undefined; if (window && !window.isDestroyed()) window.webContents.send('canvas:workbench:changed') }, 100)
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('ready-to-show', () => window?.show())
  window.on('close', event => {
    if (allowClose || !service?.busy) return
    event.preventDefault(); void requestClose(false).catch(error => dialog.showErrorBox('关闭失败', safeError(error)))
  })
  window.on('closed', () => { window = null; if (notification) clearTimeout(notification) })
  await window.loadURL(rendererURL)
}).catch(error => { dialog.showErrorBox(`${APP_NAME}无法启动`, safeError(error)); app.exit(1) })
app.on('before-quit', event => {
  if (!allowClose && service?.busy) { event.preventDefault(); void requestClose(true).catch(error => dialog.showErrorBox('关闭失败', safeError(error))) }
})
app.on('window-all-closed', () => { void service?.shutdown().finally(() => { allowClose = true; app.quit() }); if (!service) app.quit() })
