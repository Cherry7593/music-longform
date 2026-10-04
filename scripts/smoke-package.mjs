import { _electron as electron, expect } from '@playwright/test'
import { mkdir, readFile, readdir, copyFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeVideoFixture, baseVideoDraft, scratchRoot } from './video-test-utils.mjs'

// Real packaged app, isolated V1/V2 migrations and real local render. Never contacts any API.
const fixture = await makeVideoFixture({ seconds: [8, 9] })
const { root, imageId, tracks, engine, tools } = fixture
const profile = path.join(root, '音乐画布'), id = randomUUID(), directory = path.join(root, '项目 素材', id)
await mkdir(profile); await mkdir(path.join(directory, 'audio'), { recursive: true }); await mkdir(path.join(directory, 'images'))
const now = new Date().toISOString()
const music = { prompt: '', mode: 'instrumental', model: 'auto', count: 1, styles: [] }
const image = { prompt: '保留旧图片描述', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'medium', format: 'png' }
const audio = []
for (const [i, track] of tracks.entries()) {
  const fileName = `audio/${track.id}.wav`; await copyFile(track.path, path.join(directory, fileName))
  audio.push({ id: track.id, jobId: randomUUID(), taskId: `test${i}`, remoteId: `test${i}`, title: `测试音频 ${i + 1}`, fileName, createdAt: now, durationMs: track.durationSeconds * 1000, prompt: '', model: 'local-test', mode: 'instrumental', kept: true })
}
await copyFile(fixture.imagePath, path.join(directory, 'images', `${imageId}.png`))
const legacyProject = { version: 1, id, name: '打包验证项目', directory, createdAt: now, updatedAt: now, music, image, audio, images: [{ id: imageId, jobId: randomUUID(), fileName: `images/${imageId}.png`, createdAt: now, prompt: '', model: 'local-test', size: '1280x720', quality: 'medium' }], musicJobs: [], imageJobs: [], batches: [], selectedImageId: imageId }
const legacySettings = { version: 1, projectRoot: path.dirname(directory), musicDefaults: music, imageDefaults: image, lastProjectId: id }
async function resetLegacy(version) {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ ...legacySettings, version }))
  await writeFile(path.join(directory, 'project.json'), JSON.stringify({ ...legacyProject, version,
    ...(version === 2 ? { video: { ...baseVideoDraft, audioIds: audio.map(a => a.id), imageId, durationMode: 'all' }, videoJobs: [] } : {}) }))
}
await resetLegacy(1)
const indexText = JSON.stringify({ version: 1, projects: [{ id, directory }] })
await writeFile(path.join(profile, 'projects.json'), indexText)
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined))
env.MUSIC_CANVAS_E2E = '1'; env.MUSIC_CANVAS_TEST_DIR = path.join(root, 'must-not-be-used')
let app
async function launch() {
  app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/油管视频生成.exe'), args: [`--user-data-dir=${profile}`], env, timeout: 30000 })
  const actual = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, data: app.getPath('userData'), version: app.getVersion() }))
  expect(actual.packaged).toBe(true); expect(actual.version).toBe('3.0.0'); expect(path.resolve(actual.data)).toBe(path.resolve(profile))
  const page = await app.firstWindow(); await page.waitForLoadState('networkidle')
  const boot = await page.evaluate(() => window.canvas.bootstrap())
  expect(boot.testMode).toBe(false); expect(boot.project.version).toBe(3); expect(boot.settings.version).toBe(3)
  expect(boot.settings.encryptionAvailable).toBe(true); expect(boot.project.directory).toBe(directory)
  expect(boot.project.music).toEqual(music); expect(boot.project.image).toEqual({ prompt: image.prompt, model: 'Qwen/Qwen-Image', size: '1664x928' })
  expect(await page.title()).toBe('油管视频生成')
  expect(await readFile(path.join(profile, 'projects.json'), 'utf8')).toBe(indexText)
  return page
}
try {
  let page = await launch()
  await page.evaluate(() => window.canvas.setKey('mureka', 'fixture-mureka-never-sent-to-api'))
  const ciphertext = JSON.parse(await readFile(path.join(profile, 'secrets.json'), 'utf8')).keys.mureka
  const oldImageKey = await app.evaluate(({ safeStorage }) => safeStorage.encryptString('fixture-openai-never-sent-to-api').toString('base64'))
  const legacySecrets = JSON.stringify({ version: 1, keys: { mureka: ciphertext, openai: oldImageKey } })
  await app.close(); app = undefined
  await resetLegacy(2)
  await writeFile(path.join(profile, 'secrets.json'), legacySecrets)
  page = await launch()
  const encrypted = await readFile(path.join(profile, 'secrets.json'), 'utf8')
  expect(JSON.parse(encrypted)).toEqual({ version: 2, keys: { mureka: ciphertext } })
  expect(encrypted).not.toContain(oldImageKey)
  const backups = (await readdir(profile)).filter(name => name.startsWith('secrets.json.v1-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(path.join(profile, backups[0]), 'utf8')).toBe(legacySecrets)
  expect(await app.evaluate(({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, 'base64')) === 'fixture-mureka-never-sent-to-api', ciphertext)).toBe(true)
  expect((await page.evaluate(() => window.canvas.getSettings())).keys).toEqual({ mureka: true, siliconflow: false })
  await page.evaluate(() => window.canvas.setKey('siliconflow', 'fixture-siliconflow-never-sent-to-api'))
  expect(await readFile(path.join(profile, 'secrets.json'), 'utf8')).not.toContain('fixture-siliconflow')
  // Load sharp from packaged dependencies, not the development node_modules tree.
  const encoded = await app.evaluate(async ({ app }, input) => {
    const { createRequire } = process.getBuiltinModule('module')
    const sharp = createRequire(app.getAppPath() + '/package.json')('sharp')
    const output = []
    for (const format of ['png', 'jpeg', 'webp']) {
      const bytes = await sharp(Buffer.from(input, 'base64')).toFormat(format).toBuffer()
      const meta = await sharp(bytes, { failOn: 'warning', limitInputPixels: 16777216 }).metadata()
      await sharp(bytes).raw().toBuffer()
      output.push({ format, width: meta.width, height: meta.height, bytes: bytes.toString('base64') })
    }
    return output
  }, (await readFile(fixture.imagePath)).toString('base64'))
  const project = await page.evaluate(async () => (await window.canvas.bootstrap()).project)
  await app.close(); app = undefined
  for (const record of encoded) {
    const assetId = randomUUID(), extension = record.format === 'jpeg' ? 'jpg' : record.format
    const fileName = `images/${assetId}.${extension}`
    await writeFile(path.join(directory, fileName), Buffer.from(record.bytes, 'base64'))
    project.images.push({ id: assetId, jobId: randomUUID(), fileName, createdAt: now, prompt: '打包图片格式测试', model: 'Qwen/Qwen-Image', provider: 'siliconflow', format: record.format, size: `${record.width}x${record.height}` })
  }
  project.selectedImageId = project.images.at(-1).id
  project.video = { ...baseVideoDraft, imageId: project.images.find(a => a.format === 'jpeg').id, audioIds: tracks.map(t => t.id), durationMode: 'all' }
  await writeFile(path.join(directory, 'project.json'), JSON.stringify(project))
  page = await launch()
  expect((await page.evaluate(() => window.canvas.getSettings())).keys).toEqual({ mureka: true, siliconflow: true })
  for (const asset of project.images) {
    expect(await page.evaluate(async ({ projectId, assetId }) => {
      const url = `canvas-media://asset/${projectId}/image/${assetId}`
      const img = new Image(); img.src = url; await img.decode()
      return img.naturalWidth
    }, { projectId: id, assetId: asset.id })).toBe(1280)
  }
  expect((await page.evaluate(() => window.canvas.checkVideoTools())).available).toBe(true)
  await page.getByTestId('nav-history').click()
  await page.getByRole('tab', { name: '视频合成', exact: true }).click()
  await page.getByTestId('video-export').click()
  await expect.poll(async () => {
    const current = await page.evaluate(async () => (await window.canvas.bootstrap()).project)
    return current.videoJobs.some(job => ['succeeded', 'failed', 'cancelled'].includes(job.status))
  }, { timeout: 60000 }).toBe(true)
  const rendered = await page.evaluate(async () => (await window.canvas.bootstrap()).project)
  expect(rendered.videoJobs[0].status, JSON.stringify(rendered.videoJobs[0])).toBe('succeeded')
  expect(rendered.musicJobs).toHaveLength(0); expect(rendered.imageJobs).toHaveLength(0)
  const info = await engine.probeMedia(tools, path.join(directory, rendered.videoJobs[0].fileName))
  expect(Math.abs(info.durationSeconds - 14)).toBeLessThanOrEqual(0.1)
  expect(info.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, codec_name: 'h264' })
  await page.getByTestId('video-history').getByRole('button', { name: '播放成片', exact: true }).click()
  await expect.poll(() => page.getByTestId('video-player').evaluate(v => v.readyState)).toBeGreaterThan(0)
  await page.screenshot({ path: path.join(scratchRoot, 'yt-v3-packaged-player.png') })
  await page.keyboard.press('Escape')
  const importAudio = path.join(root, '本地导入 65秒.flac')
  await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=990:duration=65:sample_rate=48000', '-c:a', 'flac', importAudio])
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, [importAudio])
  const imported = await page.evaluate(() => window.canvas.importLibrary('audio'))
  expect(imported.entries[0].status).toBe('imported')
  await page.evaluate(() => window.canvas.refreshLibrary())
  const global = await page.evaluate(() => window.canvas.getLibrary())
  expect(global.assets.filter(a => a.origins.some(o => o.type === 'project')).length).toBeGreaterThanOrEqual(4)
  const jpeg = global.assets.find(a => a.kind === 'image' && a.format === 'jpeg')
  expect(jpeg).toBeTruthy()
  const plan = await page.evaluate(async ({ audioId, imageId }) => window.canvas.planBatch({ name: '打包批量验收', audioIds: [audioId], imageIds: [imageId], minimumSeconds: 60, transition: 'crossfade', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain' }), { audioId: imported.entries[0].assetId, imageId: jpeg.id })
  expect(plan.issues).toEqual([])
  const batch = await page.evaluate(id => window.canvas.startBatch(id), plan.id)
  await expect.poll(async () => (await page.evaluate(() => window.canvas.listVideoBatches()))[0].state, { timeout: 120000 }).toBe('completed')
  expect((await page.evaluate(() => window.canvas.getLibrary())).assets.find(a => a.id === imported.entries[0].assetId).usages).toHaveLength(1)
  await page.getByTestId('nav-batch').click()
  const record = page.locator(`[data-batch-id="${batch.id}"]`)
  await record.locator('.batch-output-details > summary').click()
  await record.getByRole('button', { name: '播放成片', exact: true }).click()
  await expect.poll(() => page.getByTestId('batch-video-player').evaluate(v => v.readyState)).toBeGreaterThan(0)
  await page.screenshot({ path: path.join(scratchRoot, 'yt-v3-packaged-batch-player.png') })
  await app.close(); app = undefined
  page = await launch()
  expect((await page.evaluate(() => window.canvas.listVideoBatches()))[0].state).toBe('completed')
  expect((await page.evaluate(() => window.canvas.getLibrary())).assets.find(a => a.id === imported.entries[0].assetId).usages).toHaveLength(1)
  console.log('PASS: V3 packaged startup, V1/V2 migration, preserved keys, packaged sharp PNG/JPEG/WebP, legacy JPEG export, native FLAC import, >=60s batch export/player/usage and restart; no paid/API calls')
} catch (error) {
  console.error('Packaged smoke fixture:', root)
  if (app) {
    const page = await app.firstWindow().catch(() => null)
    if (page) {
      await page.screenshot({ path: path.join(scratchRoot, 'yt-v3-package-failure.png') }).catch(() => undefined)
      console.error(await page.evaluate(async () => (await window.canvas.bootstrap()).project?.videoJobs).catch(() => 'cannot read tasks'))
    }
  }
  throw error
} finally {
  await app?.close().catch(() => undefined)
  if (process.env.PACKAGE_KEEP !== '1') await rm(root, { recursive: true, force: true })
}
