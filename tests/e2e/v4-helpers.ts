import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ApiConfigurationInput, CompositionProject, GenerationEntry, GenerationKind, GenerationProject, WorkbenchAPI, WorkbenchSnapshot } from '../../src/shared/workbench-types'
import type { Provider } from '../../src/shared/types'
import { WorkbenchDB, type Table, type Tables } from '../../src/main/storage/workbench-db'

/** Fail closed: every profile, source, export and disk mutation belongs to this session's scratch. */
export function scratchPath(...parts: string[]): string {
  const scratch = process.env.PI_SCRATCH_DIR
  if (!scratch || !path.isAbsolute(scratch)) throw new Error('E2E requires an absolute PI_SCRATCH_DIR; never use a real profile')
  const target = path.resolve(scratch, ...parts)
  const relative = path.relative(path.resolve(scratch), target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path escaped PI_SCRATCH_DIR')
  return target
}
export function assertScratch(target: string): void {
  if (!path.isAbsolute(target) || scratchPath(path.relative(scratchPath(), target)) !== path.resolve(target) || path.resolve(target) === scratchPath()) {
    throw new Error('Refusing a non-fixture path')
  }
}
export async function createProfile(label: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid fixture label')
  return mkdtemp(scratchPath(`v4-e2e-${label}-`))
}
export async function removeProfile(directory: string): Promise<void> {
  assertScratch(directory)
  await rm(directory, { recursive: true, force: true })
}
export async function launch(directory: string): Promise<{ app: ElectronApplication; page: Page }> {
  assertScratch(directory)
  assertScratch(await realpath(directory))
  // Optional fresh production bundle in scratch avoids changing out/ while another delegate is active.
  const appDirectory = process.env.MUSIC_CANVAS_E2E_APP_DIR ?? path.resolve('.')
  if (process.env.MUSIC_CANVAS_E2E_APP_DIR) { assertScratch(appDirectory); assertScratch(await realpath(appDirectory)) }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL // Never load a development/deployed renderer instead of the built, real UI.
  for (const name of Object.keys(env)) if (name.startsWith('MUSIC_CANVAS_')) delete env[name]
  env.MUSIC_CANVAS_E2E = '1'
  env.MUSIC_CANVAS_TEST_DIR = directory
  const app = await electron.launch({ args: [appDirectory, `--user-data-dir=${path.join(directory, 'appdata')}`], env, timeout: 30000 })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('nav-generation')).toBeEnabled()
    const state = await snapshot(page)
    expect(state.testMode).toBe(true)
    assertScratch(state.settings.mediaRoot)
    expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData') })))
      .toEqual({ packaged: false, userData: path.join(directory, 'appdata') })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}
export async function close(app?: ElectronApplication): Promise<void> { if (app) await app.close() }
export const snapshot = (page: Page): Promise<WorkbenchSnapshot> => page.evaluate(() => window.canvas.bootstrap())
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export async function fileDigest(file: string): Promise<string | undefined> {
  assertScratch(file)
  try { return digest(await readFile(file)) }
  catch (error) { if (['ENOENT', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error }
}

export async function assertV4Isolation(app: ElectronApplication, page: Page): Promise<void> {
  expect(await page.evaluate(() => ({ require: typeof (window as unknown as { require?: unknown }).require, process: typeof (window as unknown as { process?: unknown }).process })))
    .toEqual({ require: 'undefined', process: 'undefined' })
  const methods = await page.evaluate(() => Object.keys(window.canvas))
  const required: Array<keyof WorkbenchAPI> = ['bootstrap', 'createGenerationProject', 'updateEntry', 'submitEntries', 'saveApi', 'createCompositionProject', 'planComposition', 'startComposition', 'getAssets', 'onChanged']
  expect(methods).toEqual(expect.arrayContaining(required))
  for (const legacy of ['ipcRenderer', 'invoke', 'getSettings', 'getLibrary', 'getGenerationProject', 'updateProject', 'generateMusic', 'generateImage', 'exportVideo', 'previewTransition', 'listVideoBatches']) expect(methods).not.toContain(legacy)
  const main = await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const preferences = (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
    // Read the real handler registry, never install a shim or expose ipcRenderer to the renderer.
    const channels = [...(ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers.keys()].filter(name => name.startsWith('canvas:'))
    return { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity, channels }
  })
  expect(main).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
  expect(main.channels).toContain('canvas:workbench:bootstrap')
  expect(main.channels.filter(name => !name.startsWith('canvas:workbench:'))).toEqual([])
  const state = await snapshot(page)
  await expect(page.evaluate(async () => window.canvas.updateSettings({ mediaRoot: 'C:\\not-a-fixture' } as unknown as Parameters<WorkbenchAPI['updateSettings']>[0]))).rejects.toThrow('参数')
  expect((await snapshot(page)).settings.mediaRoot).toBe(state.settings.mediaRoot)
}
export async function renameCurrent(page: Page, name: string): Promise<void> {
  await page.getByTestId('project-rename').click()
  const dialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
  await dialog.getByTestId('rename-input').fill(name)
  await dialog.getByTestId('rename-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('project-name')).toHaveText(name)
}
export async function createGeneration(page: Page, name: string): Promise<GenerationProject> {
  await page.getByTestId('nav-generation').click()
  const before = new Set((await snapshot(page)).generationProjects.map(project => project.id))
  await page.getByTestId('generation-create').click()
  await expect.poll(async () => (await snapshot(page)).generationProjects.filter(project => !before.has(project.id)).length).toBe(1)
  const project = (await snapshot(page)).generationProjects.find(project => !before.has(project.id))!
  await expect(page.getByTestId(`generation-project-${project.id}`)).toHaveAttribute('aria-current', 'true')
  await renameCurrent(page, name)
  return (await snapshot(page)).generationProjects.find(value => value.id === project.id)!
}
export async function createComposition(page: Page, name: string): Promise<CompositionProject> {
  await page.getByTestId('nav-composition').click()
  const before = new Set((await snapshot(page)).compositionProjects.map(project => project.id))
  await page.getByTestId('composition-create').click()
  await expect.poll(async () => (await snapshot(page)).compositionProjects.filter(project => !before.has(project.id)).length).toBe(1)
  const project = (await snapshot(page)).compositionProjects.find(project => !before.has(project.id))!
  await expect(page.getByTestId(`composition-project-${project.id}`)).toHaveAttribute('aria-current', 'true')
  await renameCurrent(page, name)
  return (await snapshot(page)).compositionProjects.find(value => value.id === project.id)!
}
export async function deleteCurrent(page: Page): Promise<void> {
  await page.getByTestId('project-delete').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('全部保留')
  await dialog.getByTestId('delete-confirm').click()
  await expect(dialog).toHaveCount(0)
}
export async function addEntry(page: Page, projectId: string, kind: GenerationKind, copyId?: string): Promise<GenerationEntry> {
  await page.getByTestId(`generation-tab-${kind}`).click()
  const before = new Set((await snapshot(page)).entries.map(entry => entry.id))
  await page.getByTestId(copyId ? `entry-copy-${copyId}` : 'entry-add').click()
  await expect.poll(async () => (await snapshot(page)).entries.filter(entry => entry.projectId === projectId && !before.has(entry.id)).length).toBe(1)
  const entry = (await snapshot(page)).entries.find(entry => entry.projectId === projectId && !before.has(entry.id))!
  await expect(page.getByTestId(`entry-${entry.id}`).getByTestId('entry-prompt')).toBeVisible()
  return entry
}
export async function expandEntry(page: Page, id: string): Promise<Locator> {
  const button = page.getByTestId(`entry-expand-${id}`)
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  return page.getByTestId(`entry-${id}`)
}
export async function openAdvanced(entry: Locator): Promise<void> {
  const details = entry.locator('details.advanced').first()
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
}
export async function confirmAction(page: Page, title: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  const acknowledge = dialog.getByTestId('confirm-acknowledge')
  if (await acknowledge.count()) {
    await expect(dialog.getByTestId('confirm-action')).toBeDisabled()
    await acknowledge.check()
  }
  await dialog.getByTestId('confirm-action').click()
  await expect(dialog).toHaveCount(0)
}
export async function submitAll(page: Page, total: number, labels: string[] = []): Promise<void> {
  await page.getByTestId('generate-all').click()
  const dialog = page.getByRole('dialog', { name: '确认本批生成请求', exact: true })
  await expect(dialog).toContainText(`本次提交 ${total} 个条目，每条只创建 1 个请求`)
  for (const label of labels) await expect(dialog).toContainText(label)
  await confirmAction(page, '确认本批生成请求')
}
export async function addApi(page: Page, input: ApiConfigurationInput, checkMessage?: RegExp): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-tab-apis').click()
  await page.getByTestId('api-add').click()
  const dialog = page.getByRole('dialog', { name: '添加 API', exact: true })
  await dialog.getByTestId('api-provider').selectOption(input.provider)
  if (input.local) await dialog.getByTestId('api-local-url').fill(input.local.baseUrl)
  if (input.key) await dialog.getByTestId('api-key').fill(input.key)
  if (checkMessage) {
    const before = (await snapshot(page)).requests.length
    await dialog.getByTestId('api-test').click()
    await expect(dialog.locator('.banner-success')).toContainText(checkMessage)
    expect((await snapshot(page)).requests).toHaveLength(before)
  }
  await dialog.getByTestId('api-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId(`api-edit-${input.provider}`)).toBeVisible()
  expect((await snapshot(page)).apis.find(api => api.provider === input.provider)?.hasKey).toBe(Boolean(input.key))
}
export async function expectApiChoices(entry: Locator, providers: Provider[]): Promise<void> {
  expect(await entry.getByTestId('entry-provider').locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean))).toEqual(providers)
}
export async function nativeOpen(app: ElectronApplication, files: string[]): Promise<void> {
  files.forEach(assertScratch)
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }) }, files)
}
export async function nativeSave(app: ElectronApplication, filePath: string): Promise<void> {
  assertScratch(filePath)
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, filePath)
}
export async function importFiles(app: ElectronApplication, page: Page, kind: GenerationKind, files: string[], counts: [number, number, number]): Promise<void> {
  await page.getByTestId('nav-library').click()
  await page.getByTestId(`library-tab-${kind}`).click()
  await nativeOpen(app, files)
  await page.getByTestId('library-import').click()
  const dialog = page.getByRole('dialog', { name: '导入结果', exact: true })
  await expect(dialog).toContainText(`${counts[0]} 已导入 · ${counts[1]} 重复 · ${counts[2]} 失败`, { timeout: 60000 })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
export async function selectAssets(page: Page, kind: GenerationKind, ids: string[]): Promise<void> {
  await page.getByTestId(`composition-select-${kind}`).click()
  const dialog = page.getByRole('dialog', { name: kind === 'audio' ? '选择音乐' : '选择图片', exact: true })
  const clear = dialog.getByRole('button', { name: '清空', exact: true })
  if (await clear.isEnabled()) await clear.click()
  for (const id of ids) await dialog.getByTestId(`selector-toggle-${id}`).click()
  await dialog.getByTestId('selector-apply').click()
  await expect(dialog).toHaveCount(0)
}
/** Mutate only stopped synthetic profiles; use the real schema/transaction implementation. */
export async function updateStored<K extends Table>(directory: string, table: K, id: string, change: (record: Tables[K]) => void): Promise<Tables[K]> {
  assertScratch(directory)
  const db = new WorkbenchDB(path.join(directory, 'appdata'))
  await db.init()
  return db.update(table, id, change)
}
export async function assetBytes(app: ElectronApplication, id: string): Promise<Buffer> {
  // Test the actual protocol from Electron main; renderer CSP intentionally forbids fetch to this media-only scheme.
  const bytes = await app.evaluate(async ({ net }, assetId) => {
    const response = await net.fetch(`canvas-media://library/${encodeURIComponent(assetId)}`)
    if (!response.ok) throw new Error(`Media unavailable: ${response.status}`)
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  }, id)
  return Buffer.from(bytes)
}
export async function expectSecretAbsent(directory: string, page: Page, secrets: string[]): Promise<void> {
  assertScratch(directory)
  const encrypted = await readFile(path.join(directory, 'appdata', 'secrets.json'), 'utf8')
  const visible = await page.evaluate(async () => JSON.stringify({ bootstrap: await window.canvas.bootstrap(), local: Object.entries(localStorage), session: Object.entries(sessionStorage), dom: document.body.textContent }))
  for (const secret of secrets) { expect(encrypted).not.toContain(secret); expect(visible).not.toContain(secret) }
}
/** Pure PCM fixture generation: no inference, network or video encoder. */
export async function writeTone(file: string, seconds: number, frequency: number, rate = 48000, channels = 1): Promise<void> {
  assertScratch(file)
  const samples = Math.round(rate * seconds), dataBytes = samples * channels * 2
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40)
  for (let sample = 0; sample < samples; sample++) for (let channel = 0; channel < channels; channel++) bytes.writeInt16LE(Math.round(Math.sin(sample / rate * Math.PI * 2 * frequency) * 1600), 44 + (sample * channels + channel) * 2)
  await writeFile(file, bytes)
}
