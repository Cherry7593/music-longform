import { expect, test, type ElectronApplication } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { seedExecutionBatch, seedVideoProfile } from './video-fixtures'
import { probeMedia } from '../../src/main/video/ffmpeg'
import { assertScratch, assertV4Isolation, assetBytes, close, confirmAction, createComposition, createProfile, deleteCurrent, digest, fileDigest, expandEntry, launch, nativeSave, removeProfile, scratchPath, selectAssets, snapshot } from './v4-helpers'

/** Heavy render acceptance is intentionally runnable, never skipped/excluded; parent schedules it after the video delegate. */
test('V4 legacy migration to one real FFmpeg output: in-page selection, 65 seconds, immutable batch, playback/export, usage once and no success rerun', async () => {
  test.setTimeout(240000)
  const directory = await createProfile('video-output')
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedVideoProfile(directory)
    const originalHashes = await Promise.all([...fixture.audio, ...fixture.images].map(async asset => digest(await readFile(path.join(fixture.directory, asset.fileName)))))
    let running = await launch(directory); app = running.app; let page = running.page
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await assertV4Isolation(app, page)
    expect(await page.title()).toBe('油管视频生成')
    let state = await snapshot(page)
    expect(state.settings.version).toBe(5); expect(state.apis).toEqual([]); expect(state.requests).toEqual([]); expect(state.batches).toEqual([])
    expect(state.generationProjects[0].id).toBe(fixture.id)
    const migrated = state.compositionProjects[0]
    expect(migrated.migrationNote).toContain('旧单视频选材与顺序')
    expect(migrated.draft.minimumSeconds).toBe(60)
    const legacyMusic = state.entries.find(entry => entry.kind === 'audio')!, legacyImage = state.entries.find(entry => entry.kind === 'image')!
    expect(legacyMusic.draft.prompt).toBe('旧音乐提示词'); expect(legacyImage.draft.prompt).toBe('旧图片提示词')
    expect(legacyMusic.draft).not.toHaveProperty('count')
    expect(await readFile(path.join(fixture.directory, 'project.json'), 'utf8')).toBe(fixture.projectText)
    const archive = path.join(fixture.profile, 'migration-v4', 'backup')
    const manifest = JSON.parse(await readFile(path.join(archive, 'manifest.json'), 'utf8')) as { version: number; sources: Array<{ source: string; backup: string; sha256: string }> }
    expect(manifest.version).toBe(4)
    for (const [source, expected] of [[path.join(fixture.profile, 'settings.json'), fixture.settingsText], [path.join(fixture.directory, 'project.json'), fixture.projectText]]) {
      const entry = manifest.sources.find(value => value.source === source)!
      expect(entry).toBeTruthy(); expect(entry.backup).toMatch(/^[a-f0-9-]{36}\.[a-f0-9]{64}\.bak$/)
      const backup = path.join(archive, entry.backup); assertScratch(backup)
      expect(await readFile(backup, 'utf8')).toBe(expected)
      expect(digest(await readFile(backup))).toBe(entry.sha256)
    }
    expect(JSON.parse(await readFile(path.join(fixture.profile, 'migration-v4', 'complete.json'), 'utf8')).version).toBe(4)
    const songs = fixture.audio.map(old => state.assets.find(asset => asset.origins.some(origin => origin.legacyAssetId === old.id))!)
    const pictures = fixture.images.map(old => state.assets.find(asset => asset.origins.some(origin => origin.legacyAssetId === old.id))!)
    expect(state.assets.every(asset => asset.available && asset.usedCount === 0)).toBe(true)
    expect(migrated.draft.audioIds).toEqual(songs.slice(0, 2).map(asset => asset.id))
    expect(migrated.draft.imageIds).toEqual([pictures[0].id])
    await expect((await expandEntry(page, legacyMusic.id)).getByTestId('entry-prompt')).toHaveValue('旧音乐提示词')

    await page.getByTestId('nav-settings').click(); await page.getByTestId('settings-tab-render').click()
    await page.getByTestId('render-concurrency').fill('1'); await page.getByTestId('render-threads').fill('2')
    await page.getByTestId('render-encoder').selectOption('cpu'); await page.getByTestId('render-static-video').check()
    await page.getByTestId('render-save').click()
    await expect.poll(async () => (await snapshot(page)).settings.render).toEqual({ concurrency: 1, threads: 2, encoder: 'cpu', staticVideo: true })
    await page.getByTestId('nav-composition').click()
    await expect(page.getByTestId('composition-workspace')).toContainText('未完成导出不会自动重跑')
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-plan')).toContainText('不足')
    await expect(page.getByTestId('composition-start')).toBeDisabled() // The migrated kept-only selection is under 60 seconds.
    // All selection happens inside composition; the library page has never been visited.
    await selectAssets(page, 'audio', songs.map(asset => asset.id))
    await page.getByTestId('composition-select-audio').click()
    const selector = page.getByRole('dialog', { name: '选择音乐', exact: true })
    await selector.getByRole('button', { name: `上移 ${songs[1].name}`, exact: true }).click()
    await selector.getByTestId('selector-apply').click()
    const order = [songs[1].id, songs[0].id, songs[2].id]
    await selectAssets(page, 'image', [pictures[1].id])
    await page.getByTestId('composition-workspace').locator('details.advanced > summary').click()
    await page.getByTestId('composition-transition').selectOption('cut')
    await page.getByLabel(/^画面适配/).selectOption('cover')
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-plan').locator('.plan-group')).toHaveCount(1)
    await expect(page.getByTestId('composition-plan')).toContainText('01:05')
    await expect(page.getByTestId('composition-start')).toBeEnabled()
    await page.getByTestId('composition-start').click(); await confirmAction(page, '确认开始本批合成')
    await expect.poll(async () => (await snapshot(page)).batches.length).toBe(1)
    const submitted = (await snapshot(page)).batches[0]
    expect(submitted.plan.request.fit).toBe('cover'); expect(submitted.plan.groups[0].audioIds).toEqual(order)
    await page.getByLabel(/^画面适配/).selectOption('contain') // Mutable draft must not change the in-flight snapshot.
    const b = await createComposition(page, '合成 B · 后台 A 不抢当前页')
    await page.getByTestId('composition-minimum-minutes').fill('2')
    await expect.poll(async () => (await snapshot(page)).batches.find(batch => batch.id === submitted.id)?.state, { timeout: 180000 }).toBe('completed')
    await expect(page.getByTestId(`composition-project-${b.id}`)).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('composition-minimum-minutes')).toHaveValue('2')
    state = await snapshot(page)
    const batch = state.batches[0], job = batch.jobs[0], video = state.assets.find(asset => asset.id === job.videoAssetId)!
    expect(batch.state).toBe('completed'); expect(batch.jobs).toHaveLength(1); expect(job.attempts).toHaveLength(1)
    expect(job.status).toBe('succeeded'); expect(job.attempts[0].finishedAt).toBeTruthy()
    expect(job.attempts[0].staticVideo).toBe(true)
    expect(job.attempts[0].stages?.some(stage => stage.stage === 'publish')).toBe(true)
    expect(batch.plan.request.fit).toBe('cover')
    expect(state.compositionProjects.find(project => project.id === migrated.id)?.draft.fit).toBe('contain')
    expect(video).toMatchObject({ kind: 'video', available: true, format: 'mp4' })
    expect(video.durationSeconds).toBeCloseTo(65, 1)
    expect(video.origins[0]).toMatchObject({ type: 'composition', projectId: migrated.id, batchId: batch.id })
    const usedIds = [...order, pictures[1].id]
    expect(state.assets.filter(asset => asset.usedCount === 1).map(asset => asset.id).sort()).toEqual([...usedIds].sort())
    expect(state.assets.every(asset => asset.usedCount <= 1 && !asset.historyUncertain)).toBe(true)
    expect(state.assets.find(asset => asset.id === pictures[0].id)?.usedCount).toBe(0)
    await page.getByTestId(`composition-project-${migrated.id}`).click()
    const record = page.getByTestId(`batch-${batch.id}`)
    if (await record.getAttribute('open') === null) await record.locator('summary').click()
    await expect(record.getByTestId(`batch-continue-${batch.id}`)).toHaveCount(0)
    await record.getByTestId(`render-play-${job.id}`).click()
    const player = page.getByTestId('asset-video-player')
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0)
    await player.evaluate(async (element: HTMLVideoElement) => { element.volume = 0; await element.play(); element.currentTime = 20; element.pause() })
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(20)
    const exported = path.join(directory, '另存 新批量成片.mp4'); await nativeSave(app, exported)
    await page.getByRole('dialog', { name: '播放成片', exact: true }).getByRole('button', { name: '另存为', exact: true }).click()
    await expect.poll(() => fileDigest(exported)).toBe(video.sha256)
    const info = await probeMedia(fixture.tools, exported)
    expect(Math.abs(info.durationSeconds - 65)).toBeLessThanOrEqual(0.1)
    expect(info.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p', r_frame_rate: '30/1' })
    expect(info.streams.find(stream => stream.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    await page.keyboard.press('Escape')
    await expect(record.getByTestId(`render-play-${job.id}`)).toBeFocused()
    await page.evaluate(id => window.canvas.continueBatch(id), batch.id) // Even a direct completed-batch continue is idempotent.
    expect((await snapshot(page)).batches[0].jobs[0].attempts).toEqual(job.attempts)
    await record.getByTestId(`render-diagnostics-${job.id}`).click()
    await expect(page.getByRole('dialog', { name: '任务诊断', exact: true })).toContainText('尚无诊断记录')
    await page.keyboard.press('Escape')
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: scratchPath(`v4-video-${width}.png`) })
    }
    expect(await Promise.all([...fixture.audio, ...fixture.images].map(async asset => digest(await readFile(path.join(fixture.directory, asset.fileName)))))).toEqual(originalHashes)
    expect(errors).toEqual([])
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    const reopened = await snapshot(page)
    expect(reopened.batches).toHaveLength(1); expect(reopened.batches[0].jobs[0]).toEqual(job)
    expect(reopened.assets.filter(asset => asset.kind === 'video')).toHaveLength(1)
    expect(reopened.assets.filter(asset => usedIds.includes(asset.id)).every(asset => asset.usedCount === 1)).toBe(true)
    const same = await page.evaluate(({ projectId, planId }) => window.canvas.startComposition(projectId, planId), { projectId: migrated.id, planId: batch.planId })
    expect(same.id).toBe(batch.id); expect((await snapshot(page)).batches[0].jobs[0].attempts).toHaveLength(1)
    await page.getByTestId('nav-generation').click(); await deleteCurrent(page)
    await page.getByTestId('nav-composition').click(); await page.getByTestId(`composition-project-${migrated.id}`).click(); await deleteCurrent(page)
    expect((await snapshot(page)).assets.filter(asset => usedIds.includes(asset.id)).every(asset => asset.available && asset.usedCount === 1)).toBe(true)
    expect(digest(await assetBytes(app, songs[0].id))).toBe(originalHashes[0])
    await page.getByTestId('nav-library').click(); await page.getByTestId('library-tab-video').click()
    await expect(page.locator('article.asset-row')).toHaveCount(1)
    await page.getByTestId(`asset-delete-${video.id}`).click(); await page.getByRole('dialog').getByTestId('delete-confirm').click()
    await expect(page.getByTestId(`asset-${video.id}`)).toHaveCount(0)
    expect((await snapshot(page)).assets.filter(asset => usedIds.includes(asset.id)).every(asset => asset.usedCount === 1)).toBe(true)
    expect(digest(await readFile(exported))).toBe(video.sha256) // Asset removal never deletes the separately exported copy.
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    expect((await snapshot(page)).assets.filter(asset => usedIds.includes(asset.id)).every(asset => asset.usedCount === 1 && !asset.historyUncertain)).toBe(true)
  } finally { await close(app); await removeProfile(directory) }
})

test('V4 real render cancellation: no partial publication; crash recovery pauses attempts and project cancellation stays isolated', async () => {
  test.setTimeout(150000)
  const directory = await createProfile('video-cancel')
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedVideoProfile(directory)
    let running = await launch(directory); app = running.app; let page = running.page
    let state = await snapshot(page)
    const a = state.compositionProjects[0]
    const songs = state.assets.filter(asset => asset.kind === 'audio'), picture = state.assets.find(asset => asset.kind === 'image')!
    await page.getByTestId('nav-composition').click()
    await selectAssets(page, 'audio', songs.map(asset => asset.id))
    await selectAssets(page, 'image', [picture.id])
    await page.getByTestId('composition-workspace').locator('details.advanced > summary').click()
    await page.getByTestId('composition-transition').selectOption('cut')
    await page.getByTestId('composition-plan-button').click(); await page.getByTestId('composition-start').click()
    await confirmAction(page, '确认开始本批合成')
    const batch = (await snapshot(page)).batches[0], job = batch.jobs[0]
    await page.getByTestId(`render-cancel-${job.id}`).click(); await confirmAction(page, '取消这一条任务？')
    await expect.poll(async () => (await snapshot(page)).batches[0].jobs[0].status).toBe('cancelled')
    state = await snapshot(page)
    expect(state.batches[0].jobs[0].videoAssetId).toBeUndefined()
    expect(state.assets.some(asset => asset.kind === 'video')).toBe(false)
    expect(state.assets.every(asset => asset.usedCount === 0)).toBe(true); expect(state.requests).toEqual([])
    const plan = await page.evaluate(async id => { const project = (await window.canvas.bootstrap()).compositionProjects.find(value => value.id === id)!; return window.canvas.planComposition(id, project.revision) }, a.id)
    const b = await createComposition(page, '取消隔离 B')
    await selectAssets(page, 'audio', songs.map(asset => asset.id)); await selectAssets(page, 'image', [picture.id])
    await page.getByTestId('composition-minimum-minutes').fill('1')
    await page.getByTestId('composition-workspace').locator('details.advanced > summary').click()
    await page.getByTestId('composition-transition').selectOption('cut')
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-start')).toBeEnabled()
    const planB = await page.evaluate(async id => { const project = (await window.canvas.bootstrap()).compositionProjects.find(value => value.id === id)!; return window.canvas.planComposition(id, project.revision) }, b.id)
    await close(app); app = undefined
    const interrupted = await seedExecutionBatch(directory, a.id, plan)
    const waiting = await seedExecutionBatch(directory, b.id, planB, 'pending')
    running = await launch(directory); app = running.app; page = running.page
    state = await snapshot(page)
    expect(state.batches.find(value => value.id === interrupted.id)?.state).toBe('paused')
    expect(state.batches.find(value => value.id === interrupted.id)?.jobs[0]).toMatchObject({ status: 'interrupted', attempts: [{ id: interrupted.jobs[0].attempts[0].id, finishedAt: expect.any(String) }] })
    expect(state.batches.find(value => value.id === waiting.id)?.jobs[0]).toMatchObject({ status: 'pending', attempts: [] })
    expect(state.assets.some(asset => asset.kind === 'video')).toBe(false)
    await page.getByTestId(`composition-project-${a.id}`).click()
    const record = page.getByTestId(`batch-${interrupted.id}`)
    await record.locator('summary').click(); await record.getByTestId(`batch-continue-${interrupted.id}`).click()
    await expect(page.getByRole('dialog', { name: '确认继续未成功任务？', exact: true }).getByTestId('confirm-action')).toBeDisabled()
    await page.keyboard.press('Escape') // Opening a confirmation is not permission to re-encode.
    await page.getByTestId(`composition-project-${b.id}`).click()
    await page.getByTestId('composition-cancel-project').click(); await confirmAction(page, '取消本项目所有未完成任务？')
    state = await snapshot(page)
    expect(state.batches.find(value => value.id === waiting.id)?.state).toBe('cancelled')
    expect(state.batches.find(value => value.id === interrupted.id)?.jobs[0].status).toBe('interrupted')
    expect(state.batches.find(value => value.id === interrupted.id)?.jobs[0].attempts).toHaveLength(1)
    expect(state.assets.every(asset => asset.usedCount === 0)).toBe(true)
    expect(await readFile(path.join(fixture.directory, 'project.json'), 'utf8')).toBe(fixture.projectText)
  } finally { await close(app); await removeProfile(directory) }
})

test('V4 legacy short selection: actual audition remains available, but under-one-minute whole-song plan cannot start', async () => {
  const directory = await createProfile('video-short-plan')
  let app: ElectronApplication | undefined
  try {
    await seedVideoProfile(directory, [8, 12])
    const running = await launch(directory); app = running.app; const page = running.page
    await page.getByTestId('nav-composition').click()
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-plan')).toContainText('不足')
    await expect(page.getByTestId('composition-start')).toBeDisabled()
    await page.getByTestId('composition-select-audio').click()
    const selector = page.getByRole('dialog', { name: '选择音乐', exact: true })
    await selector.getByRole('button', { name: '试听', exact: true }).first().click()
    const player = selector.locator('audio')
    await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
    await player.evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play(); audio.pause() })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composition-start')).toBeDisabled()
    const state = await snapshot(page)
    expect(state.compositionProjects[0].draft.minimumSeconds).toBe(60)
    expect(state.batches).toEqual([]); expect(state.requests).toEqual([]); expect(state.assets.every(asset => asset.usedCount === 0)).toBe(true)
    await expect(page.getByTestId('video-export')).toHaveCount(0)
    await expect(page.getByTestId('video-preview-transition')).toHaveCount(0)
  } finally { await close(app); await removeProfile(directory) }
})

test('V4 V1 migration: draft prompts and original assets survive without inventing an old single-video execution', async () => {
  const directory = await createProfile('video-v1-migration')
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedVideoProfile(directory, [8, 12], 1)
    const running = await launch(directory); app = running.app; const page = running.page
    const state = await snapshot(page)
    expect(state.settings.version).toBe(5); expect(state.generationProjects[0].id).toBe(fixture.id)
    expect(state.entries.map(entry => entry.draft.prompt)).toEqual(['旧音乐提示词', '旧图片提示词'])
    expect(state.assets).toHaveLength(4); expect(state.assets.every(asset => asset.available && asset.usedCount === 0)).toBe(true)
    expect(state.compositionProjects).toEqual([]); expect(state.batches).toEqual([]); expect(state.apis).toEqual([])
    expect(await readFile(path.join(fixture.directory, 'project.json'), 'utf8')).toBe(fixture.projectText)
    const composition = await createComposition(page, 'V1 迁移后显式新合成')
    await selectAssets(page, 'audio', state.assets.filter(asset => asset.kind === 'audio').map(asset => asset.id))
    await selectAssets(page, 'image', [state.assets.find(asset => asset.kind === 'image')!.id])
    await page.getByTestId('composition-minimum-minutes').fill('1')
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-start')).toBeDisabled()
    expect((await snapshot(page)).compositionProjects[0].id).toBe(composition.id)
    expect((await snapshot(page)).requests).toEqual([])
  } finally { await close(app); await removeProfile(directory) }
})
