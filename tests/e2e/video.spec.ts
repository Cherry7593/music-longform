import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { seedVideoProfile } from './video-fixtures'
import { probeMedia } from '../../src/main/video/ffmpeg'
import type { Project } from '../../src/shared/types'

const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir()
async function launch(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  env.MUSIC_CANVAS_E2E = '1'; env.MUSIC_CANVAS_TEST_DIR = root
  const app = await electron.launch({ args: [path.resolve('.')], env, timeout: 30000 })
  const page = await app.firstWindow(); await page.waitForLoadState('networkidle')
  await page.getByTestId('nav-history').click()
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('合成回归测试')
  return { app, page }
}
const current = (page: Page): Promise<Project> => page.evaluate(async () => (await window.canvas.bootstrap()).project!)
async function close(app?: ElectronApplication) { if (app) await app.close().catch(() => undefined) }
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

test('V1 upgrade to real local video: selection, ordering, preview, export, playback and reopen', async () => {
  test.setTimeout(180000)
  const root = await mkdtemp(path.join(scratch, 'yt-desktop-video '))
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedVideoProfile(root)
    const originals = await Promise.all([...fixture.audio, ...fixture.images].map(a => readFile(path.join(fixture.directory, a.fileName)).then(digest)))
    let session = await launch(root); app = session.app; let page = session.page
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    expect(await page.title()).toBe('油管视频生成')
    expect((await current(page)).version).toBe(3)
    const backup = (await readdir(fixture.directory)).find(file => /^project\.json\.v1-.*\.bak$/.test(file))!
    expect(await readFile(path.join(fixture.directory, backup), 'utf8')).toBe(fixture.projectText)
    const settingsBackup = (await readdir(fixture.profile)).find(file => /^settings\.json\.v1-.*\.bak$/.test(file))!
    expect(await readFile(path.join(fixture.profile, settingsBackup), 'utf8')).toBe(fixture.settingsText)
    expect((await page.evaluate(() => window.canvas.getSettings())).keys).toEqual({ mureka: false, siliconflow: false })
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('旧音乐提示词')
    await page.getByRole('tab', { name: '视频合成', exact: true }).click()
    await expect(page.getByTestId('video-track-list').locator('li')).toHaveCount(2)
    await expect(page.getByTestId('video-image')).toHaveValue(fixture.images[0].id)
    await expect(page.getByTestId('video-export')).toBeDisabled()
    await expect(page.getByTestId('video-time-deficit')).not.toHaveText('0:00')
    await page.getByTestId('video-duration-mode').selectOption('all')
    await page.getByRole('button', { name: '上移 本地曲目 2', exact: true }).click()
    await expect(page.getByTestId('video-track-list').locator('li').first()).toHaveAttribute('data-audio-id', fixture.audio[1].id)
    await page.locator('summary').filter({ hasText: '从本项目勾选音乐' }).click()
    await page.locator(`input[data-audio-id="${fixture.audio[2].id}"]`).check()
    await expect(page.getByTestId('video-track-list').locator('li')).toHaveCount(3)
    await page.getByTestId('video-image').selectOption(fixture.images[1].id)
    await page.getByTestId('video-fit-cover').click()
    await expect(page.getByTestId('video-frame')).toHaveClass(/fit-cover/)
    await page.getByTestId('video-analyze').click()
    await expect(page.getByTestId('video-analysis-state')).toContainText('真实文件时长')
    await expect(page.getByTestId('video-time-output')).toHaveText('0:24')
    await page.getByTestId('video-preview-transition').click()
    await expect(page.getByTestId('preview-history').locator('[data-status="succeeded"]')).toHaveCount(1, { timeout: 60000 })
    const preview = page.getByTestId('preview-history').locator('audio')
    await expect.poll(() => preview.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0)
    await preview.evaluate(async (a: HTMLAudioElement) => { a.volume = 0; await a.play(); a.pause() })
    await page.getByTestId('video-export').click()
    // Draft changes are allowed while rendering; the export keeps its original snapshot.
    await page.getByTestId('video-fit-contain').click()
    await expect(page.getByTestId('video-history').locator('[data-status="succeeded"]')).toHaveCount(1, { timeout: 60000 })
    const project = await current(page)
    const job = project.videoJobs.find(job => job.kind === 'video')!
    expect(job.snapshot.fit).toBe('cover'); expect(project.video.fit).toBe('contain')
    expect(job.snapshot.audioIds).toEqual([fixture.audio[1].id, fixture.audio[0].id, fixture.audio[2].id])
    expect(project.musicJobs).toHaveLength(0); expect(project.imageJobs).toHaveLength(0)
    const file = path.join(project.directory, job.fileName!)
    const info = await probeMedia(fixture.tools, file)
    expect(Math.abs(info.durationSeconds - 24)).toBeLessThanOrEqual(0.1)
    expect(info.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p', r_frame_rate: '30/1' })
    expect(info.streams.find(s => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    await page.getByTestId('video-history').getByRole('button', { name: '播放成片', exact: true }).click()
    await expect(page.getByTestId('video-player')).toBeVisible()
    await expect.poll(() => page.getByTestId('video-player').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0)
    await page.getByTestId('video-player').evaluate(async (v: HTMLVideoElement) => { v.volume = 0; await v.play(); v.currentTime = 8 })
    await expect.poll(() => page.getByTestId('video-player').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(8)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('video-player')).toHaveCount(0)
    const exportPath = path.join(root, '另存 成片.mp4')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exportPath)
    await page.getByTestId('video-history').getByRole('button', { name: '另存为', exact: true }).click()
    await expect.poll(async () => digest(await readFile(exportPath))).toBe(digest(await readFile(file)))
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('.main-scroll').evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path: path.join(scratch, `yt-video-${width}.png`) })
    }
    await page.getByRole('tab', { name: '素材生成', exact: true }).click()
    await expect(page.getByLabel('音乐描述', { exact: true })).toHaveValue('旧音乐提示词')
    const after = await Promise.all([...fixture.audio, ...fixture.images].map(a => readFile(path.join(fixture.directory, a.fileName)).then(digest)))
    expect(after).toEqual(originals)
    expect(errors).toEqual([])
    await close(app); app = undefined
    session = await launch(root); app = session.app; page = session.page
    await page.getByRole('tab', { name: '视频合成', exact: true }).click()
    const reopened = await current(page)
    expect(reopened.videoJobs.filter(j => j.status === 'succeeded')).toHaveLength(2)
    expect(reopened.video.audioIds).toEqual(project.video.audioIds)
    expect(await readdir(path.join(project.directory, 'videos'))).toEqual([`${job.id}.mp4`])
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})

test('real export cancellation and restart interruption do not repeat generation or publish partial output', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(path.join(scratch, 'yt-desktop-cancel '))
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedVideoProfile(root, [120, 125])
    let session = await launch(root); app = session.app; let page = session.page
    await page.getByRole('tab', { name: '视频合成', exact: true }).click()
    await page.getByTestId('video-duration-mode').selectOption('all')
    await page.getByTestId('video-export').click()
    await page.getByTestId('video-history').getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(page.getByTestId('video-history').locator('[data-status="cancelled"]')).toHaveCount(1, { timeout: 20000 })
    const project = await current(page)
    expect(project.videoJobs[0].fileName).toBeUndefined()
    expect(project.musicJobs).toHaveLength(0)
    await close(app); app = undefined
    const interruptedId = randomUUID()
    project.videoJobs.push({ id: interruptedId, kind: 'video', snapshot: project.video, status: 'encoding', createdAt: new Date().toISOString(), progress: 12 })
    await writeFile(path.join(fixture.directory, 'project.json'), JSON.stringify(project))
    session = await launch(root); app = session.app; page = session.page
    await page.getByRole('tab', { name: '视频合成', exact: true }).click()
    await expect(page.getByTestId('video-history').locator('[data-status="interrupted"]')).toHaveCount(1)
    const restored = await current(page)
    expect(restored.videoJobs).toHaveLength(2)
    expect(restored.videoJobs.every(j => !j.fileName)).toBe(true)
    await expect(page.getByTestId('video-export')).toBeEnabled()
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})

test('an insufficient target permits boundary audition but still blocks complete export', async () => {
  const root = await mkdtemp(path.join(scratch, 'yt-desktop-audition '))
  let app: ElectronApplication | undefined
  try {
    await seedVideoProfile(root, [8, 12])
    const session = await launch(root); app = session.app
    const page = session.page
    await page.getByRole('tab', { name: '视频合成', exact: true }).click()
    await expect(page.getByTestId('video-duration-mode')).toHaveValue('target')
    await expect(page.getByTestId('video-export')).toBeDisabled()
    await page.getByTestId('video-preview-transition').click()
    await expect(page.getByTestId('preview-history').locator('[data-status="succeeded"]')).toHaveCount(1, { timeout: 60000 })
    await expect(page.getByTestId('video-export')).toBeDisabled()
    const p = await current(page)
    expect(p.video.targetSeconds).toBe(3600)
    expect(p.videoJobs[0].durationSeconds).toBeLessThan(30)
    expect(p.musicJobs).toHaveLength(0)
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})
