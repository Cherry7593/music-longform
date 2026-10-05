import { _electron as electron, expect } from '@playwright/test'
import { mkdir, readFile, readdir, writeFile, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { workspaceRoot, scratchPath, createFixtureRoot, loadV4Fixtures, createCurrentProfile, makeSyntheticMedia, seedLegacyProfile, digest } from './v4-package-fixtures.mjs'

const { values } = parseArgs({ options: { help: { type: 'boolean' }, exe: { type: 'string' }, output: { type: 'string' }, keep: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: node scripts/smoke-package.mjs [--exe dist/win-unpacked/油管视频生成.exe] [--output <scratch report directory>] [--keep]\nRequires a built V4.0.1 package and PI_SCRATCH_DIR. Tests isolated V1/V4 migration, real safeStorage/sharp, local synthetic ACE HTTP and one 65s composition. Never builds or calls a paid API.')
} else await main()

async function main() {
  const executablePath = path.resolve(workspaceRoot, values.exe ?? 'dist/win-unpacked/油管视频生成.exe')
  if (!(await lstat(executablePath)).isFile()) throw new Error(`V4 packaged executable is missing: ${executablePath}; run packaging separately`)
  const root = await createFixtureRoot(), output = values.output ? scratchPath(values.output) : await createFixtureRoot('v4-package-report-')
  await mkdir(output, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL' && value !== undefined))
  const ignoredDirectory = path.join(root, 'dev-flags-must-not-be-used')
  Object.assign(env, { MUSIC_CANVAS_E2E: '1', MUSIC_CANVAS_TEST_DIR: ignoredDirectory, TEMP: root, TMP: root })
  let app, page, aceServer, stage = 'fixture setup', passed = false
  const checks = [], record = check => { checks.push(check); console.log(`CHECK: ${check}`) }
  const boot = () => page.evaluate(() => window.canvas.bootstrap())
  async function close() { if (app) { await app.close(); app = undefined; page = undefined } }
  async function launch(profile) {
    scratchPath(profile)
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 60000 })
    const actual = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), version: app.getVersion() }))
    expect(actual).toMatchObject({ packaged: true, version: '4.0.1' }); expect(path.resolve(actual.profile)).toBe(path.resolve(profile))
    // Only the explicit isolated close choice is answered. Native import/save dialogs are patched per operation below.
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox.bind(dialog)
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        if (options?.title === '仍有任务在处理' && options.buttons?.[1] === '取消本地任务并关闭') return { response: 1, checkboxChecked: false }
        return original(...args)
      }
    })
    page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('nav-generation')).toBeEnabled({ timeout: 60000 })
    expect(await page.title()).toBe('油管视频生成')
    const snapshot = await boot()
    expect(snapshot.testMode).toBe(false); expect(snapshot.settings.version).toBe(5); expect(snapshot.encryptionAvailable).toBe(true)
    scratchPath(snapshot.settings.mediaRoot)
    const methods = await page.evaluate(() => Object.keys(window.canvas))
    for (const name of ['createGenerationProject', 'updateEntry', 'submitEntries', 'saveApi', 'createCompositionProject', 'planComposition', 'startComposition', 'getAssets', 'exportAsset']) expect(methods).toContain(name)
    for (const name of ['getGenerationProject', 'getProject', 'updateProject', 'startMusic', 'startImage', 'setKey', 'getSettings', 'configureAceStep', 'getLibrary', 'planBatch', 'startBatch', 'startVideo', 'updateDefaults']) expect(methods).not.toContain(name)
    const channels = await app.evaluate(({ ipcMain }) => {
      if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('Cannot inspect packaged IPC whitelist')
      return [...ipcMain._invokeHandlers.keys()].filter(channel => channel.startsWith('canvas:'))
    })
    expect(channels.length).toBeGreaterThan(30)
    expect(channels.every(channel => channel.startsWith('canvas:workbench:'))).toBe(true)
    await expect(page.locator('[data-testid="nav-history"], [data-testid="nav-batch"], [data-testid="video-export"]')).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button')).toHaveCount(4)
    return snapshot
  }
  async function mediaBytes(id, range = false) {
    // Production CSP intentionally permits media elements, not renderer fetch(). Keep that policy unchanged.
    return app.evaluate(async ({ net }, { id, range }) => {
      const response = await net.fetch(`canvas-media://library/${id}`, range ? { headers: { Range: 'bytes=0-15' } } : undefined)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: Array.from(bytes) }
    }, { id, range })
  }
  async function preview(id, kind) {
    await page.getByTestId('nav-library').click(); await page.getByTestId(`library-tab-${kind}`).click()
    await page.getByTestId(`asset-preview-${id}`).click()
    const dialog = page.getByRole('dialog', { name: kind === 'audio' ? '试听音乐' : kind === 'image' ? '查看图片' : '播放成片', exact: true })
    await expect(dialog).toBeVisible()
    if (kind === 'image') await expect.poll(() => dialog.locator('img.library-full-image').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
    else {
      const player = dialog.locator(kind === 'audio' ? 'audio' : 'video')
      await expect.poll(() => player.evaluate(media => media.readyState), { timeout: 15000 }).toBeGreaterThan(0)
      await player.evaluate(async media => { media.volume = 0; await media.play(); media.currentTime = Math.min(2, media.duration / 2); media.pause() })
    }
    return dialog
  }
  async function unchangedMedia(legacy) {
    for (const expected of legacy.stamps) {
      const actual = await lstat(expected.file)
      expect({ bytes: actual.size, mtimeMs: actual.mtimeMs, ino: actual.ino, sha256: digest(await readFile(expected.file)) }).toEqual({ bytes: expected.bytes, mtimeMs: expected.mtimeMs, ino: expected.ino, sha256: expected.sha256 })
    }
  }
  async function migrationEvidence(legacy) {
    const manifest = JSON.parse(await readFile(path.join(legacy.profile, 'migration-v4', 'backup', 'manifest.json'), 'utf8'))
    for (const [file, bytes] of legacy.oldFiles) {
      const source = manifest.sources.find(source => path.resolve(source.source) === path.resolve(file) && source.sha256 === digest(bytes))
      // SecretStore V1 upgrade archives its exact old bytes under secrets.json.v1-*.bak, never as a fictitious current path.
      const secretBackup = path.basename(file) === 'secrets.json' && legacy.version === 1
        ? manifest.sources.find(source => source.sha256 === digest(bytes) && /^secrets\.json\.v1-.*\.bak$/.test(path.basename(source.source))) : source
      expect(secretBackup, `Exact migration backup missing: ${file}`).toBeTruthy()
      expect(await readFile(path.join(legacy.profile, 'migration-v4', 'backup', secretBackup.backup))).toEqual(bytes)
      if (!['settings.json', 'secrets.json'].includes(path.basename(file))) expect(await readFile(file)).toEqual(bytes)
    }
    await unchangedMedia(legacy)
  }
  async function assertMigration(legacy, ciphertext, local) {
    const snapshot = await launch(legacy.profile), project = snapshot.generationProjects.find(project => project.id === legacy.project.id)
    expect(project).toMatchObject({ version: 1, name: legacy.project.name, id: legacy.project.id, createdAt: legacy.project.createdAt })
    expect(snapshot.settings.mediaRoot).toBe(legacy.mediaRoot)
    expect(snapshot.entries).toHaveLength(7); expect(snapshot.entries.every(entry => !('count' in entry.draft))).toBe(true)
    expect(snapshot.requests).toHaveLength(5)
    const requests = legacy.jobs.map(job => snapshot.requests.find(request => request.id === job.id))
    expect(requests.map(request => request.status)).toEqual(['succeeded', 'paused', 'paused', 'unknown'])
    expect(requests[0].taskId).toBe(legacy.jobs[0].taskId); expect(requests[1].taskId).toBe(legacy.jobs[1].taskId)
    expect(requests[0].assetIds).toEqual([legacy.audioLibraryId])
    const audio = snapshot.assets.find(asset => asset.id === legacy.audioLibraryId), image = snapshot.assets.find(asset => asset.id === legacy.imageLibraryId)
    expect(audio).toMatchObject({ name: legacy.records[0].item.name, available: true, sha256: legacy.records[0].item.sha256 })
    expect(image).toMatchObject({ name: legacy.records[2].item.name, available: true, sha256: legacy.records[2].item.sha256 })
    expect(audio.origins.some(origin => origin.name === legacy.project.name && origin.legacyAssetId === legacy.audioId && origin.provider === (legacy.version === 1 ? 'mureka' : 'acestep'))).toBe(true)
    const diskAudio = JSON.parse(await readFile(path.join(legacy.profile, 'assets-v2', 'items', `${audio.id}.json`), 'utf8'))
    expect(diskAudio.aliases).toContain(legacy.aliasId)
    expect(diskAudio.locations.some(location => location.fileName === legacy.project.audio[0].fileName)).toBe(true)
    expect(Buffer.from((await mediaBytes(legacy.aliasId)).bytes)).toEqual(await readFile(path.join(legacy.directory, legacy.project.audio[0].fileName)))
    expect((await mediaBytes(image.id, true)).status).toBe(206)
    expect((await mediaBytes(image.id, true)).bytes).toHaveLength(16)
    const secretsText = await readFile(path.join(legacy.profile, 'secrets.json'), 'utf8'), secrets = JSON.parse(secretsText)
    expect(secrets.version).toBe(3); expect(secrets.keys.mureka).toBe(ciphertext.mureka)
    expect(await app.evaluate(({ safeStorage }, encrypted) => Object.entries(encrypted).every(([provider, value]) => safeStorage.decryptString(Buffer.from(value, 'base64')) === `fixture-${provider}-never-sent-to-api`), secrets.keys)).toBe(true)
    if (legacy.version === 1) {
      expect(secrets.keys).toEqual({ mureka: ciphertext.mureka }); expect(secretsText).not.toContain(ciphertext.openai)
      const backups = (await readdir(legacy.profile)).filter(name => /^secrets\.json\.v1-.*\.bak$/.test(name))
      expect(backups).toHaveLength(1); expect(await readFile(path.join(legacy.profile, backups[0]))).toEqual(legacy.secretsBytes)
      expect(snapshot.apis.map(api => api.provider)).toEqual(['mureka']); expect(snapshot.compositionProjects).toEqual([])
      expect(snapshot.requests.find(request => request.kind === 'image')).toMatchObject({ binding: { provider: 'openai' }, legacyImage: true, status: 'succeeded' })
    } else {
      expect(await readFile(path.join(legacy.profile, 'secrets.json'))).toEqual(legacy.secretsBytes)
      expect(secrets.keys.siliconflow).toBe(ciphertext.siliconflow)
      expect(snapshot.apis.map(api => api.provider).sort()).toEqual(['acestep', 'mureka', 'siliconflow'])
      expect(snapshot.apis.find(api => api.provider === 'acestep')).toMatchObject({ hasKey: false, local })
      expect(snapshot.compositionProjects).toHaveLength(2)
      expect(snapshot.batches.find(batch => batch.id === legacy.legacyBatchId)).toMatchObject({ version: 2, state: 'completed', name: '不可改写的历史批次名' })
      expect(requests[0].outputs[0]).toMatchObject({ id: legacy.project.musicJobs[0].outputs[0].id, remoteId: 'synthetic-old-result', assetId: audio.id, status: 'saved' })
      const videos = snapshot.assets.filter(asset => asset.kind === 'video'); expect(videos).toHaveLength(1)
      const diskVideo = JSON.parse(await readFile(path.join(legacy.profile, 'assets-v2', 'items', `${videos[0].id}.json`), 'utf8'))
      expect([videos[0].id, ...diskVideo.aliases]).toEqual(expect.arrayContaining([legacy.videoId, legacy.batchVideoId]))
      expect(videos[0].origins.some(origin => origin.name === legacy.project.name)).toBe(true)
      expect(Buffer.from((await mediaBytes(videos[0].id)).bytes)).toEqual(await readFile(path.join(legacy.directory, `videos/${legacy.videoId}.mp4`)))
      expect(audio.usedCount).toBe(2); expect(audio.usages.map(use => use.id).sort()).toEqual([legacy.videoId, legacy.batchVideoId].sort())
      const rootRecord = JSON.parse(await readFile(path.join(legacy.profile, 'assets-v2', 'roots', `${diskAudio.locations[0].rootId}.json`), 'utf8'))
      expect(rootRecord.directory).toBe(legacy.directory)
      expect(diskAudio.locations.some(location => location.related.some(file => file.fileName === legacy.project.audio[0].originalFileName))).toBe(true)
      await preview(videos[0].id, 'video'); await page.keyboard.press('Escape')
    }
    for (const api of snapshot.apis.filter(api => api.provider !== 'acestep')) expect(api.hasKey).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(ciphertext.mureka)
    expect(JSON.stringify(snapshot)).not.toContain('fixture-mureka-never-sent')
    await migrationEvidence(legacy)
    record(`legacy V${legacy.version}: original IDs/names/origins, ciphertext/backups, paused/unknown requests, byte-identical in-place media and no old API/IPC`)
    return snapshot
  }
  async function deleteProjectsKeepMedia(legacy) {
    const before = await boot(), audio = before.assets.find(asset => asset.id === legacy.audioLibraryId)
    expect((await page.evaluate(id => window.canvas.generationProjectImpact(id), legacy.project.id)).blocked).toBe(true)
    for (const request of before.requests.filter(request => !['succeeded', 'cancelled', 'abandoned'].includes(request.status))) await page.evaluate(id => window.canvas.abandonRequest(id), request.id)
    expect((await page.evaluate(id => window.canvas.generationProjectImpact(id), legacy.project.id)).blocked).toBe(false)
    await page.evaluate(id => window.canvas.deleteGenerationProject(id), legacy.project.id)
    for (const project of before.compositionProjects) {
      expect((await page.evaluate(id => window.canvas.compositionProjectImpact(id), project.id)).blocked).toBe(false)
      await page.evaluate(id => window.canvas.deleteCompositionProject(id), project.id)
    }
    const after = await boot()
    expect(after.generationProjects).toHaveLength(0); expect(after.compositionProjects).toHaveLength(0)
    expect(after.assets.map(asset => asset.id).sort()).toEqual(before.assets.map(asset => asset.id).sort())
    expect(after.assets.find(asset => asset.id === audio.id).usages).toEqual(audio.usages)
    for (const asset of before.assets) { await preview(asset.id, asset.kind); await page.keyboard.press('Escape') }
    await unchangedMedia(legacy)
    record(`legacy V${legacy.version}: project deletion retains playable audio/images/video, source snapshots and usage`)
  }
  try {
    const engine = await loadV4Fixtures(root), seedRoot = path.join(root, 'encryption-seed'); await mkdir(seedRoot)
    const seed = await createCurrentProfile(seedRoot, engine)
    await launch(seed.profile)
    expect((await boot()).apis).toEqual([])
    const ciphertext = await app.evaluate(({ safeStorage }) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Real Electron safeStorage is required')
      return Object.fromEntries(['mureka', 'siliconflow', 'openai'].map(provider => {
        const synthetic = `fixture-${provider}-never-sent-to-api`, bytes = safeStorage.encryptString(synthetic)
        if (safeStorage.decryptString(bytes) !== synthetic) throw new Error('safeStorage round-trip failed')
        return [provider, bytes.toString('base64')]
      }))
    })
    await close()
    record('real V4 package, empty added APIs, explicit isolated profile; safeStorage encrypts synthetic keys before legacy files exist')
    const media = await makeSyntheticMedia(root, engine)
    aceServer = await engine.startAceStepFixture({ audio: await readFile(media.httpAudio), key: 'x', durationSeconds: 999 })
    const localHash = digest(`music-canvas/acestep/v1:${aceServer.baseUrl}`)
    const local = { baseUrl: aceServer.baseUrl, connectionId: `${localHash.slice(0, 8)}-${localHash.slice(8, 12)}-5${localHash.slice(13, 16)}-8${localHash.slice(17, 20)}-${localHash.slice(20, 32)}`, waitMinutes: 5, allowLan: false }
    const migrations = []
    for (const version of [1, 4]) {
      stage = `legacy V${version} migration`
      const legacy = await seedLegacyProfile(root, engine, media, version, ciphertext, local); migrations.push(legacy)
      // Only our synthetic profiles: preserve the same encryption context as an in-place upgrade.
      await writeFile(path.join(legacy.profile, 'Local State'), await readFile(path.join(seed.profile, 'Local State')), { flag: 'wx' })
      const beforeRequests = aceServer.requests.length
      await assertMigration(legacy, ciphertext, local)
      expect(aceServer.requests).toHaveLength(beforeRequests); expect(aceServer.tasks.size).toBe(0)
      await deleteProjectsKeepMedia(legacy)
      await close(); await launch(legacy.profile)
      expect((await boot()).generationProjects).toHaveLength(0); expect((await boot()).compositionProjects).toHaveLength(0)
      expect((await boot()).assets.find(asset => asset.id === legacy.audioLibraryId).usedCount).toBe(version === 4 ? 2 : 0)
      expect(aceServer.requests).toHaveLength(beforeRequests)
      await migrationEvidence(legacy)
      await close()
    }
    const legacy = migrations[1]
    stage = 'packaged sharp / native import'
    await launch(legacy.profile)
    const encoded = await app.evaluate(async ({ app }, input) => {
      const { createRequire } = process.getBuiltinModule('module'), sharp = createRequire(app.getAppPath() + '/package.json')('sharp'), results = []
      for (const format of ['png', 'jpeg', 'webp']) {
        const bytes = await sharp(Buffer.from(input, 'base64')).toFormat(format).toBuffer()
        const meta = await sharp(bytes, { failOn: 'warning', limitInputPixels: 16777216 }).metadata(); await sharp(bytes).raw().toBuffer()
        results.push({ format, width: meta.width, height: meta.height, bytes: bytes.toString('base64') })
      }
      return results
    }, (await readFile(media.imagePath)).toString('base64'))
    const imageIds = []
    for (const item of encoded) {
      expect(item).toMatchObject({ width: 1280, height: 720 })
      const file = path.join(root, `packaged-sharp.${item.format === 'jpeg' ? 'jpg' : item.format}`); await writeFile(file, Buffer.from(item.bytes, 'base64'), { flag: 'wx' })
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
      const imported = await page.evaluate(() => window.canvas.importAssets('image'))
      expect(['imported', 'duplicate']).toContain(imported.entries[0].status)
      const id = imported.entries[0].assetId; imageIds.push({ id, format: item.format })
      await preview(id, 'image'); await page.keyboard.press('Escape')
    }
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, media.httpAudio)
    const imported = await page.evaluate(() => window.canvas.importAssets('audio')); expect(imported.entries[0].status).toBe('imported')
    record('packaged sharp PNG/JPEG/WebP encoding + full raw decode, native media imports and production canvas-media image decode')
    stage = 'authenticated synthetic ACE HTTP generation'
    await page.evaluate(local => window.canvas.saveApi({ provider: 'acestep', key: 'x', local }), { baseUrl: local.baseUrl, waitMinutes: 5, allowLan: false })
    const status = await page.evaluate(() => window.canvas.getAceStepModels())
    expect(status.models[0].name).toBe('acestep-v15-turbo'); expect(status.llmInitialized).toBe(false); expect(aceServer.tasks.size).toBe(0)
    const generation = await page.evaluate(() => window.canvas.createGenerationProject())
    let entry = await page.evaluate(id => window.canvas.addEntry(id, 'audio'), generation.id)
    const draft = { ...engine.initialEntry('audio', 'acestep'), mode: 'instrumental', inputMode: 'lyrics', prompt: 'Packaged synthetic HTTP acceptance; not model inference', seconds: 10, title: '人工65秒HTTP音乐' }
    entry = await page.evaluate(({ id, revision, draft }) => window.canvas.updateEntry(id, revision, draft, {}), { id: entry.id, revision: entry.revision, draft })
    const selection = { projectId: generation.id, submissionId: randomUUID(), entries: [{ id: entry.id, revision: entry.revision }] }
    await page.evaluate(selection => window.canvas.submitEntries(selection), selection)
    // The durable idempotency token must not create a second remote request, even on a repeated IPC.
    await page.evaluate(selection => window.canvas.submitEntries(selection), selection)
    await expect.poll(async () => (await boot()).requests.find(request => request.entryId === entry.id)?.status, { timeout: 90000 }).toBe('succeeded')
    const generatedRequest = (await boot()).requests.find(request => request.entryId === entry.id)
    expect(generatedRequest.assetIds).toHaveLength(1)
    const generated = (await boot()).assets.find(asset => asset.id === generatedRequest.assetIds[0])
    expect(generated).toMatchObject({ id: imported.entries[0].assetId, format: 'flac', durationSeconds: 65, available: true })
    expect(generated.origins.some(origin => origin.type === 'generation' && origin.projectId === generation.id && origin.requestId === generatedRequest.id && origin.provider === 'acestep')).toBe(true)
    expect(Buffer.from((await mediaBytes(generated.id)).bytes)).toEqual(await readFile(media.httpAudio))
    expect(aceServer.tasks.size).toBe(1); expect(aceServer.requests.every(request => request.authorized)).toBe(true)
    expect(aceServer.requests.filter(request => request.method === 'POST' && request.route === '/release_task')).toHaveLength(1)
    expect(aceServer.requests.some(request => request.route === '/v1/audio')).toBe(true)
    const audioDialog = await preview(generated.id, 'audio')
    expect(await audioDialog.locator('audio').evaluate(audio => audio.duration)).toBeCloseTo(65, 1); await page.keyboard.press('Escape')
    record('short local key x, actual authenticated TCP POST/poll/download, measured 65s FLAC (remote 999s ignored), byte equality, playback and asset deduplication')
    stage = 'V4 single-output composition'
    await page.evaluate(() => window.canvas.updateSettings({ render: { concurrency: 1, threads: 2, encoder: 'cpu', staticVideo: true } }))
    let composition = await page.evaluate(() => window.canvas.createCompositionProject())
    const jpeg = imageIds.find(item => item.format === 'jpeg')
    composition = await page.evaluate(({ project, draft }) => window.canvas.updateCompositionProject(project.id, project.revision, { name: 'V4 打包·单输出合成', draft }),
      { project: composition, draft: { ...engine.initialComposition(), minimumSeconds: 60, audioIds: [generated.id], imageIds: [jpeg.id] } })
    const plan = await page.evaluate(project => window.canvas.planComposition(project.id, project.revision), composition)
    expect(plan.issues).toEqual([]); expect(plan.groups).toHaveLength(1); expect(plan.groups[0].issues).toEqual([])
    const batch = await page.evaluate(({ projectId, planId }) => window.canvas.startComposition(projectId, planId), { projectId: composition.id, planId: plan.id })
    await expect.poll(async () => (await boot()).batches.find(value => value.id === batch.id)?.state, { timeout: 240000 }).toBe('completed')
    const completed = (await boot()).batches.find(value => value.id === batch.id)
    expect(completed.jobs).toHaveLength(1); expect(completed.jobs[0].status, JSON.stringify(completed.jobs[0])).toBe('succeeded')
    const videoId = completed.jobs[0].videoAssetId, savedVideo = path.join(root, 'V4成片另存.mp4')
    const videoDialog = await preview(videoId, 'video')
    await page.screenshot({ path: path.join(output, 'v4-packaged-single-output-player.png') })
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, savedVideo)
    await videoDialog.getByRole('button', { name: '另存为', exact: true }).click()
    const protocolVideo = Buffer.from((await mediaBytes(videoId)).bytes)
    await expect.poll(async () => {
      try { return (await readFile(savedVideo)).equals(protocolVideo) }
      catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error }
    }, { timeout: 30000 }).toBe(true)
    const savedBytes = await readFile(savedVideo)
    const info = await engine.probeMedia(media.tools, savedVideo)
    expect(Math.abs(info.durationSeconds - 65)).toBeLessThanOrEqual(0.1)
    expect(info.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, r_frame_rate: '30/1', codec_name: 'h264' })
    expect(info.streams.find(stream => stream.codec_type === 'audio').codec_name).toBe('aac')
    await engine.runTool(media.tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', savedVideo, '-f', 'null', '-'], { timeoutMs: 120000 })
    await page.keyboard.press('Escape')
    const used = (await boot()).assets.find(asset => asset.id === generated.id)
    expect(used.usedCount).toBe(1); expect(used.usages).toHaveLength(1)
    const usage = used.usages[0]
    expect(usage).toMatchObject({ id: completed.jobs[0].id, videoId, projectId: composition.id }); expect(usage.durationSeconds).toBeCloseTo(65, 1)
    record('new immutable composition plan, one output, actual 65s 1080p30 H.264/AAC full decode/playback/save-as byte equality and one usage')
    stage = 'deletion / restart reconciliation'
    const requestCount = aceServer.requests.length, createCount = aceServer.tasks.size
    await close(); await launch(legacy.profile)
    const retained = await boot()
    expect(retained.requests.find(request => request.id === generatedRequest.id).status).toBe('succeeded')
    expect(retained.batches.find(value => value.id === batch.id).state).toBe('completed')
    expect(retained.assets.find(asset => asset.id === generated.id).usages).toEqual([usage])
    await page.waitForTimeout(5500)
    expect(aceServer.requests).toHaveLength(requestCount); expect(aceServer.tasks.size).toBe(createCount)
    record('completed generation/batch survive a real restart with their projects present, without repeated POST or poll')
    await page.evaluate(id => window.canvas.deleteGenerationProject(id), generation.id)
    await page.evaluate(id => window.canvas.deleteCompositionProject(id), composition.id)
    await preview(generated.id, 'audio'); await page.keyboard.press('Escape')
    await preview(videoId, 'video'); await page.keyboard.press('Escape')
    expect((await boot()).assets.find(asset => asset.id === generated.id).usages).toEqual([usage])
    await close(); await launch(legacy.profile)
    const restarted = await boot()
    expect(restarted.generationProjects).toHaveLength(0); expect(restarted.compositionProjects).toHaveLength(0)
    expect(restarted.assets.find(asset => asset.id === generated.id).usages).toEqual([usage])
    expect(restarted.assets.find(asset => asset.id === legacy.audioLibraryId).usedCount).toBe(2)
    expect(restarted.assets.filter(asset => asset.id === videoId)).toHaveLength(1)
    const persistedBatch = JSON.parse(await readFile(path.join(legacy.profile, 'workbench', 'executions', `${batch.id}.json`), 'utf8'))
    expect(persistedBatch.state).toBe('completed'); expect(persistedBatch.jobs[0].videoAssetId).toBe(videoId)
    const persistedRequest = JSON.parse(await readFile(path.join(legacy.profile, 'workbench', 'requests', `${generatedRequest.id}.json`), 'utf8'))
    expect(persistedRequest.status).toBe('succeeded'); expect(persistedRequest.assetIds).toEqual([generated.id])
    await page.waitForTimeout(5500) // Beyond the production poll interval; not merely a startup snapshot.
    expect(aceServer.requests).toHaveLength(requestCount); expect(aceServer.tasks.size).toBe(createCount)
    expect(await lstat(ignoredDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })).toBe(false)
    await migrationEvidence(legacy)
    record('deleted generation/composition projects remain playable; durable success/usage, no repeated POST or poll on restart, packaged dev flags ignored')
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, version: '4.0.1', executablePath, synthetic: true, fixture: root, checks, historicalVersions: [1, 4], secretVersion: 3,
      actualInference: false, paidCalls: 0, createRequests: createCount, generatedAudioSeconds: generated.durationSeconds, outputSeconds: info.durationSeconds, outputSHA256: digest(savedBytes), usageAfterRestart: 1, testMode: false }, null, 2))
    passed = true
    console.log(`PASS: V4 real packaged migration/HTTP/one-output composition/deletion/restart; synthetic only. Report: ${path.join(output, 'report.json')}`)
  } catch (error) {
    console.error(`FAIL at ${stage}; isolated fixture retained: ${root}`)
    if (page) await page.screenshot({ path: path.join(output, 'v4-package-failure.png') }).catch(() => undefined)
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, version: '4.0.1', stage, fixture: root, checks, error: String(error), actualInference: false, paidCalls: 0 }, null, 2)).catch(() => undefined)
    throw error
  } finally {
    await app?.close().catch(() => undefined); await aceServer?.close()
    if (passed && !values.keep && process.env.PACKAGE_KEEP !== '1') await rm(root, { recursive: true, force: true })
  }
}
