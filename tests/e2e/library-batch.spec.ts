import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { requireTools, runTool, probeMedia } from '../../src/main/video/ffmpeg'

const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir()
async function launch(directory: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  env.MUSIC_CANVAS_E2E = '1'; env.MUSIC_CANVAS_TEST_DIR = directory
  const app = await electron.launch({ args: [path.resolve('.')], env, timeout: 30000 })
  const page = await app.firstWindow(); await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await expect(page.getByTestId('library-import')).toBeEnabled()
  return { app, page }
}
async function close(app?: ElectronApplication) { await app?.close().catch(() => undefined) }
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test('global library: native imports, partial failure, non-project batch, edits, usage, playback and restart', async () => {
  test.setTimeout(300000)
  const directory = await mkdtemp(path.join(scratch, 'v3-desktop-library '))
  let app: ElectronApplication | undefined
  try {
    const tools = await requireTools()
    const source = path.join(directory, '导入 原始'); await mkdir(source)
    const audio: string[] = []
    for (const [i, [extension, codec]] of [['mp3', 'libmp3lame'], ['wav', 'pcm_s16le'], ['flac', 'flac'], ['m4a', 'aac']].entries()) {
      const file = path.join(source, `手动音乐 ${i + 1} ${'长中文名称'.repeat(i === 0 ? 5 : 1)}.${extension}`)
      await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 60}:duration=35:sample_rate=48000`, '-ac', '2', '-c:a', codec, file])
      audio.push(file)
    }
    const broken = path.join(source, '损坏音乐.wav'); await writeFile(broken, 'not audio')
    const images: string[] = []
    for (const [i, format] of (['png', 'jpeg', 'webp'] as const).entries()) {
      const file = path.join(source, `手动图片 ${i + 1}.${format === 'jpeg' ? 'jpg' : format}`)
      await sharp({ create: { width: 640, height: 360, channels: 3, background: ['#517999', '#9b7157', '#648967'][i] } }).toFormat(format).toFile(file)
      images.push(file)
    }
    let session = await launch(directory); app = session.app; let page = session.page
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    expect((await page.evaluate(() => window.canvas.bootstrap())).projects).toHaveLength(0)
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, [...audio, broken, audio[0]])
    await page.getByTestId('library-import').click()
    await expect(page.getByText(/导入完成：新增 4 个，重复 1 个，失败 1 个/)).toBeVisible({ timeout: 60000 })
    await expect(page.getByTestId('library-audio-table').locator('tbody tr')).toHaveCount(4)
    await page.getByTestId('library-select-all').check()
    await page.getByTestId('library-tab-image').click()
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, images)
    await page.getByTestId('library-import').click()
    await expect(page.getByTestId('library-image-grid').locator('article')).toHaveCount(3)
    const initialLibrary = await page.evaluate(() => window.canvas.getLibrary())
    const chosenImages = initialLibrary.assets.filter(a => a.kind === 'image' && /[12]\./.test(a.name))
    expect(chosenImages).toHaveLength(2)
    for (const image of chosenImages) await page.getByTestId(`library-select-${image.id}`).check()
    // Originals are not the managed copies: moving a source after import must not break playback/export.
    await rm(audio[0])
    await page.getByTestId('nav-batch').click()
    await page.getByTestId('batch-name').fill('桌面批量测试')
    await page.getByTestId('batch-minimum-minutes').fill('1')
    await page.getByTestId('batch-plan-button').click()
    await expect(page.getByTestId('batch-group-0')).toBeVisible({ timeout: 60000 })
    await expect(page.getByTestId('batch-start')).toBeEnabled()
    const firstGroup = page.getByTestId('batch-group-0')
    const firstSong = await firstGroup.locator('[data-song-id]').first().getAttribute('data-song-id')
    await firstGroup.locator('select').first().selectOption('1')
    await expect(page.getByTestId('batch-start')).toBeDisabled()
    const secondGroup = page.getByTestId('batch-group-1')
    await secondGroup.locator('summary').click()
    await secondGroup.locator(`[data-song-id="${firstSong}"] select`).selectOption('0')
    await expect(page.getByTestId('batch-start')).toBeEnabled()
    await firstGroup.locator('[data-song-id]').nth(1).getByRole('button', { name: /^上移/ }).click()
    await expect(page.getByTestId('batch-start')).toBeEnabled()
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: path.join(scratch, `v3-e2e-plan-${width}.png`) })
    }
    await page.getByTestId('batch-start').click()
    await expect(page.getByTestId('batch-history').locator('[data-state="completed"]')).toHaveCount(1, { timeout: 150000 })
    const batch = (await page.evaluate(() => window.canvas.listVideoBatches()))[0]
    expect(batch.jobs.map(j => j.status)).toEqual(['succeeded', 'succeeded'])
    expect(new Set(batch.jobs.flatMap(j => j.group.audioIds)).size).toBe(4)
    expect((await page.evaluate(() => window.canvas.bootstrap())).projects).toHaveLength(0)
    for (const job of batch.jobs) {
      const probe = await probeMedia(tools, path.join(batch.directory, job.fileName!))
      expect(probe.durationSeconds).toBeGreaterThanOrEqual(60)
      expect(probe.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, r_frame_rate: '30/1' })
    }
    const finalLibrary = await page.evaluate(() => window.canvas.getLibrary())
    expect(finalLibrary.assets.filter(a => a.usages.length === 1)).toHaveLength(6)
    expect(finalLibrary.assets.filter(a => !a.usages.length)).toHaveLength(1)
    const record = page.getByTestId('batch-history').locator('[data-batch-id]')
    await record.locator('.batch-output-details > summary').click()
    await record.getByRole('button', { name: '播放成片', exact: true }).first().click()
    const player = page.getByTestId('batch-video-player')
    await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0)
    await player.evaluate(async (el: HTMLVideoElement) => { el.volume = 0; await el.play(); el.currentTime = 20; el.pause() })
    await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(20)
    await page.keyboard.press('Escape')
    await expect(record.getByRole('button', { name: '播放成片', exact: true }).first()).toBeFocused()
    const saved = path.join(directory, '另存批量成片.mp4')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, saved)
    await record.getByRole('button', { name: '另存为', exact: true }).first().click()
    await expect.poll(async () => hash(await readFile(saved))).toBe(hash(await readFile(path.join(batch.directory, batch.jobs[0].fileName!))))
    expect((await page.evaluate(() => window.canvas.getLibrary())).assets.filter(a => a.usages.length === 1)).toHaveLength(6)
    await page.getByTestId('nav-library').click()
    await page.getByRole('button', { name: '已使用', exact: true }).click()
    await expect(page.getByTestId('library-audio-table').locator('tbody tr')).toHaveCount(4)
    expect(errors).toEqual([])
    await close(app); app = undefined
    session = await launch(directory); app = session.app; page = session.page
    const restored = await page.evaluate(() => window.canvas.getLibrary())
    expect(restored.assets.filter(a => a.usages.length === 1)).toHaveLength(6)
    expect((await page.evaluate(() => window.canvas.listVideoBatches()))[0].jobs).toHaveLength(2)
    await page.getByTestId('library-tab-image').click()
    await page.getByRole('button', { name: '未使用', exact: true }).click()
    await expect(page.getByTestId('library-image-grid').locator('article')).toHaveCount(1)
  } finally { await close(app); await rm(directory, { recursive: true, force: true }) }
})

test('generation session is automatic and generated media enters global library without a new-project step', async () => {
  const directory = await mkdtemp(path.join(scratch, 'v3-desktop-auto-generation '))
  let app: ElectronApplication | undefined
  try {
    const session = await launch(directory); app = session.app; const page = session.page
    await page.getByTestId('nav-generation').click()
    await expect(page.getByLabel('音乐描述', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    for (const [name, key] of [['Mureka', 'fixture-local-mureka-12345'], ['硅基流动', 'fixture-local-siliconflow-12345']]) {
      const form = dialog.locator('form').filter({ hasText: name })
      await form.locator('input[type="password"]').fill(key)
      await form.getByRole('button', { name: '保存密钥', exact: true }).click()
      await expect(form.getByText('已配置', { exact: true })).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await page.getByLabel('音乐描述', { exact: true }).fill('模拟纯音乐自动入库')
    await page.getByLabel('画面描述', { exact: true }).fill('模拟画面自动入库')
    for (const type of ['音乐', '图片']) {
      await page.getByRole('button', { name: `生成${type}`, exact: true }).click()
      const confirm = page.getByRole('dialog', { name: `确认生成${type}`, exact: true })
      await expect(confirm.getByRole('button', { name: '确认付费并生成', exact: true })).toBeDisabled()
      await confirm.getByRole('checkbox').check(); await confirm.getByRole('button', { name: '确认付费并生成', exact: true }).click()
    }
    await expect.poll(async () => (await page.evaluate(() => window.canvas.getLibrary())).assets.length).toBe(2)
    const generation = await page.evaluate(() => window.canvas.getGenerationProject())
    expect(generation.musicJobs).toHaveLength(1); expect(generation.imageJobs).toHaveLength(1)
    await page.getByTestId('nav-library').click()
    await expect(page.getByTestId('library-audio-table').locator('tbody tr')).toHaveCount(1)
    await page.getByTestId('library-tab-image').click()
    await expect(page.getByTestId('library-image-grid').locator('article')).toHaveCount(1)
    const image = page.getByTestId('library-image-grid').locator('img')
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await page.getByTestId('nav-generation').click()
    expect((await page.evaluate(() => window.canvas.getGenerationProject())).id).toBe(generation.id)
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('模拟纯音乐自动入库')
  } finally { await close(app); await rm(directory, { recursive: true, force: true }) }
})
