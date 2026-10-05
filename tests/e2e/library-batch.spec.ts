import { expect, test, type ElectronApplication } from '@playwright/test'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { seedImportFiles } from './video-fixtures'
import { addApi, addEntry, assetBytes, close, createComposition, createGeneration, createProfile, deleteCurrent, digest, fileDigest, importFiles, launch, nativeSave, removeProfile, scratchPath, selectAssets, snapshot, submitAll } from './v4-helpers'

test('V4 library/batch: native codecs, partial failure, dedup, project-local selection, editable groups, stale plans and persistence', async () => {
  test.setTimeout(150000)
  const directory = await createProfile('library-batch')
  let app: ElectronApplication | undefined
  try {
    const fixture = await seedImportFiles(directory)
    const sourceHashes = await Promise.all([...fixture.audio, ...fixture.images].map(async file => digest(await readFile(file))))
    let running = await launch(directory); app = running.app; let page = running.page
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    expect((await snapshot(page)).generationProjects).toEqual([])
    await importFiles(app, page, 'audio', [...fixture.audio, fixture.broken, fixture.audio[0]], [4, 1, 1])
    await expect(page.locator('article.asset-row')).toHaveCount(4)
    await page.getByTestId('library-select-all').click()
    await importFiles(app, page, 'image', fixture.images, [3, 0, 0])
    await expect(page.locator('article.asset-row')).toHaveCount(3)
    let state = await snapshot(page)
    expect(state.assets).toHaveLength(7)
    expect(state.assets.filter(asset => asset.kind === 'audio').map(asset => asset.format).sort()).toEqual(['flac', 'm4a', 'mp3', 'wav'])
    expect(state.assets.filter(asset => asset.kind === 'image').map(asset => asset.format).sort()).toEqual(['jpeg', 'png', 'webp'])
    const songs = fixture.audio.map(file => state.assets.find(asset => asset.name === path.basename(file))!)
    const pictures = fixture.images.map(file => state.assets.find(asset => asset.name === path.basename(file))!)
    expect(songs.every(asset => asset.available && Math.abs(asset.durationSeconds! - 35) < 0.1)).toBe(true)
    // The managed copy remains usable after an external source is moved/deleted.
    await rm(fixture.audio[0])
    await page.getByTestId('library-tab-audio').click()
    await page.getByTestId('library-refresh').click()
    await expect(page.getByTestId(`asset-${songs[0].id}`)).not.toContainText('文件不可用')
    await page.getByTestId(`asset-preview-${songs[0].id}`).click()
    const media = page.getByRole('dialog', { name: '试听音乐', exact: true })
    await expect.poll(() => media.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
    await media.locator('audio').evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play(); audio.currentTime = 20; audio.pause() })
    await expect.poll(() => media.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(20)
    const saved = path.join(directory, '另存 音乐.mp3'); await nativeSave(app, saved)
    await media.getByRole('button', { name: '另存为', exact: true }).click()
    await expect.poll(() => fileDigest(saved)).toBe(sourceHashes[0])
    await page.keyboard.press('Escape')
    await expect(page.getByTestId(`asset-preview-${songs[0].id}`)).toBeFocused()

    const a = await createComposition(page, '合成 A · 手动导入')
    expect(a.draft.audioIds).toEqual([]); expect(a.draft.imageIds).toEqual([]) // Library checkboxes never leak into a draft.
    await selectAssets(page, 'audio', songs.map(asset => asset.id))
    await selectAssets(page, 'image', pictures.slice(0, 2).map(asset => asset.id))
    await page.getByTestId('composition-minimum-minutes').fill('1')
    await page.getByTestId('composition-plan-button').click()
    const preview = page.getByTestId('composition-plan')
    await expect(preview.locator('.plan-group')).toHaveCount(2)
    await expect(page.getByTestId('composition-start')).toBeEnabled()
    const openGroups = async (): Promise<void> => {
      for (const group of await preview.locator('.plan-group').all()) if (await group.getAttribute('open') === null) await group.locator('summary').click()
    }
    await openGroups()
    const firstGroup = preview.locator('.plan-group').nth(0), secondGroup = preview.locator('.plan-group').nth(1)
    const movedLabel = await firstGroup.locator('li select').first().getAttribute('aria-label')
    expect(movedLabel).toBeTruthy()
    await firstGroup.locator('li select').first().selectOption('1')
    await expect(page.getByTestId('composition-start')).toBeDisabled()
    await expect(preview).toContainText('时长不足')
    await openGroups()
    await secondGroup.getByLabel(movedLabel!, { exact: true }).selectOption('0')
    await expect(page.getByTestId('composition-start')).toBeEnabled()
    const beforeOrder = (await snapshot(page)).compositionProjects.find(project => project.id === a.id)!.draft.groups![0].audioIds
    await openGroups()
    await firstGroup.getByRole('button', { name: '曲目上移', exact: true }).nth(1).click()
    await expect.poll(async () => (await snapshot(page)).compositionProjects.find(project => project.id === a.id)!.draft.groups![0].audioIds).toEqual([...beforeOrder].reverse())
    await expect(page.getByTestId('composition-start')).toBeEnabled()
    state = await snapshot(page)
    const planned = state.compositionProjects.find(project => project.id === a.id)!
    expect(new Set(planned.draft.groups!.flatMap(group => group.audioIds)).size).toBe(4)
    expect(planned.draft.groups!.flatMap(group => group.audioIds)).toHaveLength(4)
    expect(state.assets.every(asset => asset.usedCount === 0 && asset.queuedCount === 0)).toBe(true) // Audition/plan/export do not count as successful use.
    const apiPlan = await page.evaluate(async projectId => {
      const current = (await window.canvas.bootstrap()).compositionProjects.find(project => project.id === projectId)!
      return window.canvas.planComposition(current.id, current.revision)
    }, a.id)
    await page.getByTestId('composition-minimum-minutes').fill('2')
    await expect(preview).toHaveCount(0)
    const b = await createComposition(page, '合成 B · 空白独立') // Immediate switch must flush A and invalidate its plan.
    expect(b.draft.audioIds).toEqual([]); expect(b.draft.imageIds).toEqual([])
    await expect(page.evaluate(({ id, planId }) => window.canvas.startComposition(id, planId), { id: a.id, planId: apiPlan.id })).rejects.toThrow('规划失效')
    expect((await snapshot(page)).batches).toEqual([])
    await page.getByTestId(`composition-project-${a.id}`).click()
    await expect(page.getByTestId('composition-minimum-minutes')).toHaveValue('2')
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: scratchPath(`v4-library-plan-${width}.png`) })
    }
    await page.getByTestId('nav-library').click()
    await page.getByTestId(`asset-rename-${songs[1].id}`).click()
    const rename = page.getByRole('dialog', { name: '重命名', exact: true })
    await rename.getByTestId('rename-input').fill('用户重命名 · 不改外部原件.wav')
    await rename.getByTestId('rename-save').click()
    await expect(rename).toHaveCount(0)
    await page.getByTestId('library-search').fill('用户重命名')
    await expect(page.locator('article.asset-row')).toHaveCount(1)
    await page.getByTestId('library-search').fill('')
    await page.getByLabel('按使用状态筛选', { exact: true }).selectOption('used')
    await expect(page.locator('article.asset-row')).toHaveCount(0)
    await page.getByLabel('按使用状态筛选', { exact: true }).selectOption('unused')
    await expect(page.locator('article.asset-row')).toHaveCount(4)
    expect(errors).toEqual([])
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    state = await snapshot(page)
    expect(state.compositionProjects).toHaveLength(2); expect(state.generationProjects).toEqual([]); expect(state.batches).toEqual([])
    expect(state.compositionProjects.find(project => project.id === a.id)?.draft).toMatchObject({ minimumSeconds: 120, groups: planned.draft.groups })
    expect(state.assets.find(asset => asset.id === songs[1].id)?.name).toBe('用户重命名 · 不改外部原件.wav')
    expect(state.assets.every(asset => asset.available && asset.usedCount === 0)).toBe(true)
    await page.getByTestId('library-tab-image').click()
    await page.getByTestId(`asset-delete-${pictures[2].id}`).click()
    const deletion = page.getByRole('dialog')
    await expect(deletion).toContainText('外部原件保留')
    await deletion.getByTestId('delete-confirm').click()
    await expect(deletion).toHaveCount(0)
    await expect(page.getByTestId(`asset-${pictures[2].id}`)).toHaveCount(0)
    expect(digest(await readFile(fixture.images[2]))).toBe(sourceHashes[6])
    expect(digest(await readFile(saved))).toBe(sourceHashes[0])
    await page.getByTestId('nav-composition').click(); await page.getByTestId(`composition-project-${a.id}`).click()
    await deleteCurrent(page)
    expect((await snapshot(page)).assets).toHaveLength(6)
    expect(digest(await assetBytes(app, songs[0].id))).toBe(sourceHashes[0])
    expect(await Promise.all([...fixture.audio.slice(1), ...fixture.images].map(async file => digest(await readFile(file))))).toEqual(sourceHashes.slice(1))
  } finally { await close(app); await removeProfile(directory) }
})

test('V4 library/batch: generated media is global; composition selects and auditions in-page without a library visit', async () => {
  const directory = await createProfile('generation-selector')
  let app: ElectronApplication | undefined
  try {
    let running = await launch(directory); app = running.app; let page = running.page
    await addApi(page, { provider: 'kie', key: 'fixture-selector-kie-key' })
    await addApi(page, { provider: 'siliconflow', key: 'fixture-selector-image-key' })
    const generation = await createGeneration(page, '选材来源生成项目')
    const entry = await addEntry(page, generation.id, 'audio')
    await page.getByTestId(`entry-${entry.id}`).getByTestId('entry-mode').selectOption('instrumental')
    await page.getByTestId(`entry-${entry.id}`).getByTestId('entry-prompt').fill('夹具音频：返回两版，不代表云端推理')
    await submitAll(page, 1)
    await expect.poll(async () => (await snapshot(page)).requests.find(request => request.entryId === entry.id)?.status).toBe('succeeded')
    const image = await addEntry(page, generation.id, 'image')
    await page.getByTestId(`entry-${image.id}`).getByTestId('entry-prompt').fill('夹具画面：直接供合成项目选取')
    await submitAll(page, 1)
    await expect.poll(async () => (await snapshot(page)).assets.length).toBe(2)
    const state = await snapshot(page), audio = state.assets.find(asset => asset.kind === 'audio')!, picture = state.assets.find(asset => asset.kind === 'image')!
    expect(state.requests.find(request => request.entryId === entry.id)?.outputs).toHaveLength(2)
    const composition = await createComposition(page, '页内直接选材')
    await page.getByTestId('composition-select-audio').click()
    const selector = page.getByRole('dialog', { name: '选择音乐', exact: true })
    await selector.getByRole('button', { name: '试听', exact: true }).click()
    await expect.poll(() => selector.locator('audio').evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0)
    await selector.locator('audio').evaluate(async (element: HTMLAudioElement) => { element.volume = 0; await element.play(); element.currentTime = 2 })
    await selector.getByTestId(`selector-toggle-${audio.id}`).click()
    await selector.getByTestId('selector-apply').click()
    await expect(page.locator('audio')).toHaveCount(0)
    await selectAssets(page, 'image', [picture.id])
    await page.getByTestId('composition-minimum-minutes').fill('1')
    await page.getByTestId('composition-plan-button').click()
    await expect(page.getByTestId('composition-plan')).toContainText('不足')
    await expect(page.getByTestId('composition-start')).toBeDisabled() // 8 seconds cannot satisfy a 1-minute whole-song batch.
    expect((await snapshot(page)).settings.page).toBe('composition')
    expect((await snapshot(page)).assets.every(asset => asset.usedCount === 0)).toBe(true)
    await page.getByTestId('nav-generation').click()
    await deleteCurrent(page)
    expect((await snapshot(page)).assets.map(asset => asset.id).sort()).toEqual([audio.id, picture.id].sort())
    await page.getByTestId('nav-composition').click()
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    await expect(page.getByTestId(`composition-project-${composition.id}`)).toHaveAttribute('aria-current', 'true')
    expect((await snapshot(page)).compositionProjects[0].draft).toMatchObject({ audioIds: [audio.id], imageIds: [picture.id], minimumSeconds: 60 })
    expect((await snapshot(page)).batches).toEqual([])
  } finally { await close(app); await removeProfile(directory) }
})
