import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Project } from '../../src/shared/types'

const root = path.resolve('.')
const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir()
async function launch(directory: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  env.MUSIC_CANVAS_E2E = '1'
  env.MUSIC_CANVAS_TEST_DIR = directory
  const app = await electron.launch({ args: [root], env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeEnabled()
  await page.getByTestId('nav-history').click()
  return { app, page }
}
async function setup(page: Page) {
  await page.getByRole('button', { name: '新建第一个项目', exact: true }).click()
  await expect(page.getByLabel('音乐描述', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  for (const [name, key] of [['Mureka', 'fixture-mureka-key-123456789'], ['硅基流动', 'fixture-siliconflow-key-123456789']]) {
    const form = dialog.locator('form').filter({ hasText: name })
    await form.locator('input[type="password"]').fill(key)
    await form.getByRole('button', { name: '保存密钥', exact: true }).click()
    await expect(form.locator('input[type="password"]')).toHaveValue('')
    await expect(form.getByText('已配置', { exact: true })).toBeVisible()
    await form.getByRole('button', { name: '检查连接', exact: true }).click()
    await expect(dialog.getByText(/测试凭证可用/)).toBeVisible()
  }
  await page.screenshot({ path: path.join(scratch, 'canvas-settings-1366.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
}
async function generate(page: Page, kind: 'music' | 'image') {
  await page.getByRole('button', { name: kind === 'music' ? '生成音乐' : '生成图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: kind === 'music' ? '确认生成音乐' : '确认生成图片', exact: true })
  await expect(dialog.getByRole('button', { name: '确认付费并生成', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认付费并生成', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
async function getCurrent(page: Page): Promise<Project> {
  return page.evaluate(async () => (await window.canvas.bootstrap()).project!)
}
async function close(app: ElectronApplication | undefined) { if (app) await app.close().catch(() => undefined) }

test('desktop workflow: keys, independent prompts, media playback, export, project persistence and layout', async () => {
  const dir = await mkdtemp(path.join(scratch, 'canvas-desktop-'))
  let app: ElectronApplication | undefined
  try {
    let running = await launch(dir); app = running.app
    let page = running.page
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 768))
    await setup(page)
    const secretFile = await readFile(path.join(dir, 'appdata', 'secrets.json'), 'utf8')
    expect(secretFile).not.toContain('fixture-mureka-key')
    expect(secretFile).not.toContain('fixture-siliconflow-key')
    const bootstrap = await page.evaluate(() => window.canvas.bootstrap())
    expect(JSON.stringify(bootstrap)).not.toContain('fixture-mureka-key')
    expect(bootstrap.settings.keys).toEqual({ mureka: true, siliconflow: true })
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined')
    expect(await page.evaluate(() => Object.keys(window.canvas))).not.toContain('ipcRenderer')

    await page.getByLabel('项目名称', { exact: true }).fill('雨夜 书房')
    await page.getByLabel('音乐描述', { exact: true }).fill('温柔的钢琴纯音乐，适合雨夜阅读')
    await page.getByLabel('画面描述', { exact: true }).fill('窗边书桌，夜雨，温暖的台灯')
    await page.getByLabel('每批首数', { exact: true }).fill('2')
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(scratch, 'canvas-workspace-1366.png') })
    await generate(page, 'music')
    // Editing the other prompt while polling must not be overwritten by task events.
    await page.getByLabel('画面描述', { exact: true }).fill('窗边书桌，夜雨，温暖的台灯，柔和油画风格')
    await expect(page.locator('audio')).toHaveCount(2)
    await expect(page.getByLabel('画面描述', { exact: true })).toHaveValue('窗边书桌，夜雨，温暖的台灯，柔和油画风格')
    await expect.poll(() => page.locator('audio').first().evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
    await page.locator('audio').first().evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play(); audio.currentTime = 3 })
    await expect.poll(() => page.locator('audio').first().evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(3)
    await page.locator('audio').nth(1).evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play() })
    expect(await page.locator('audio').first().evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    await page.locator('audio').nth(1).evaluate((audio: HTMLAudioElement) => audio.pause())
    await page.getByRole('button', { name: '保留 曲目 01', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消保留 曲目 01', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await generate(page, 'image')
    await expect.poll(async () => (await getCurrent(page)).images.length).toBe(1)
    await expect.poll(() => page.locator('.image-preview img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    expect((await getCurrent(page)).images[0]).toMatchObject({ provider: 'siliconflow', model: 'Qwen/Qwen-Image', format: 'png' })
    await expect(page.getByLabel('质量', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('温柔的钢琴纯音乐，适合雨夜阅读')
    await page.getByRole('button', { name: '放大当前图片', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '放大当前图片', exact: true })).toBeFocused()
    const exported = path.join(dir, '导出 图片.png')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exported)
    await page.locator('.image-workspace').getByRole('button', { name: '另存为', exact: true }).click()
    await expect.poll(async () => (await readFile(exported)).subarray(1, 4).toString()).toBe('PNG')
    const original = await getCurrent(page)
    expect(original.audio.filter(a => a.kept)).toHaveLength(1)
    expect(original.images).toHaveLength(1)
    // Flush immediately on project switch; no delay after editing.
    await page.getByLabel('音乐描述', { exact: true }).fill('修改后立即切换项目，不能丢失')
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: /雨夜 书房/ }).click()
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('修改后立即切换项目，不能丢失')
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.getByLabel('音乐描述', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      expect(await page.getByLabel('画面描述', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      expect(await page.getByLabel('项目名称', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('24px')
      await page.screenshot({ path: path.join(scratch, `canvas-results-${width}.png`) })
    }
    expect(errors).toEqual([])
    await close(app); app = undefined
    running = await launch(dir); app = running.app; page = running.page
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('雨夜 书房')
    await expect(page.locator('audio')).toHaveCount(2)
    const restored = await getCurrent(page)
    expect(restored.musicJobs).toHaveLength(2)
    expect(restored.images).toHaveLength(1)
    expect(restored.audio.filter(a => a.kept)).toHaveLength(1)
    expect((await page.evaluate(() => window.canvas.getSettings())).keys.mureka).toBe(true)
  } finally { await close(app); await rm(dir, { recursive: true, force: true }) }
})

test('unknown requests and interruption: no duplicate creation; recover existing music task only', async () => {
  const dir = await mkdtemp(path.join(scratch, 'canvas-recovery-'))
  let app: ElectronApplication | undefined
  try {
    let running = await launch(dir); app = running.app; let page = running.page
    await setup(page)
    await page.getByLabel('音乐描述', { exact: true }).fill('[unknown] 网络中断测试')
    await page.getByLabel('每批首数', { exact: true }).fill('3')
    await generate(page, 'music')
    await expect(page.getByText('状态未知', { exact: true })).toBeVisible()
    let project = await getCurrent(page)
    expect(project.musicJobs.map(j => j.status)).toEqual(['unknown', 'pending', 'pending'])
    await page.getByRole('button', { name: '停止后续任务', exact: true }).click()
    await expect.poll(async () => (await getCurrent(page)).musicJobs.filter(j => j.status === 'pending').length).toBe(0)
    await page.getByLabel('画面描述', { exact: true }).fill('[unknown] 图片中断测试')
    await generate(page, 'image')
    await expect.poll(async () => (await getCurrent(page)).imageJobs[0]?.status).toBe('unknown')
    project = await getCurrent(page)
    await close(app); app = undefined
    const batchId = randomUUID()
    const snapshot = { ...project.music, count: 1, prompt: '已提交音乐任务' }
    project.batches.push({ id: batchId, total: 2, state: 'running', createdAt: new Date().toISOString() })
    project.musicJobs.push({ id: randomUUID(), batchId, status: 'running', taskId: 'fixture-restored', createdAt: new Date().toISOString(), index: 0, snapshot }, { id: randomUUID(), batchId, status: 'pending', createdAt: new Date().toISOString(), index: 1, snapshot })
    await writeFile(path.join(project.directory, 'project.json'), JSON.stringify(project))
    running = await launch(dir); app = running.app; page = running.page
    await expect.poll(async () => (await getCurrent(page)).audio.length).toBe(1)
    const recovered = await getCurrent(page)
    expect(recovered.musicJobs).toHaveLength(5)
    expect(recovered.musicJobs[3].status).toBe('succeeded')
    expect(recovered.musicJobs[4].status).toBe('pending')
    expect(recovered.imageJobs).toHaveLength(1)
    expect(recovered.imageJobs[0].status).toBe('unknown')
    await expect(page.getByRole('button', { name: '继续剩余 1 首', exact: true })).toBeVisible()
    // Chooser-controlled root changes preserve existing projects.
    const newRoot = path.join(dir, '新 保存位置'); await mkdir(newRoot)
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, newRoot)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '本地存储', exact: true }).click()
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await page.getByRole('button', { name: '保存位置', exact: true }).click()
    await page.keyboard.press('Escape')
    expect((await page.evaluate(() => window.canvas.getSettings())).projectRoot).toBe(newRoot)
    expect((await getCurrent(page)).directory).toBe(project.directory)
  } finally { await close(app); await rm(dir, { recursive: true, force: true }) }
})
