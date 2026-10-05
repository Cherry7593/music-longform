import { expect, test, type ElectronApplication } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startAceStepFixture } from '../fixtures/acestep-server'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'
import { addApi, addEntry, assetBytes, close, confirmAction, createGeneration, createProfile, digest, fileDigest, expectApiChoices, expectSecretAbsent, expandEntry, launch, nativeSave, openAdvanced, removeProfile, snapshot, submitAll } from './v4-helpers'

// Production cloud adapters use the unpackaged, isolated main/testing.ts transport and synthetic tones.
test('V4 cloud providers: added-only APIs, independent encrypted keys/alternatives, one request per prompt, all returned versions and restart', async () => {
  const directory = await createProfile('cloud-providers')
  let app: ElectronApplication | undefined
  try {
    let running = await launch(directory); app = running.app; let page = running.page
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    expect((await snapshot(page)).apis).toEqual([])
    const keys = ['fixture-kie-independent-key', 'fixture-reapi-independent-key', 'fixture-sunor-independent-key']
    for (const [index, provider] of (['kie', 'reapi', 'sunor'] as const).entries()) await addApi(page, { provider, key: keys[index] }, /999/)
    await expectSecretAbsent(directory, page, keys)
    const project = await createGeneration(page, '三厂商独立条目')
    const kie = await addEntry(page, project.id, 'audio'), first = page.getByTestId(`entry-${kie.id}`)
    await expectApiChoices(first, ['kie', 'reapi', 'sunor'])
    await first.getByTestId('entry-prompt').fill('Kie 专用器乐与编曲描述')
    await page.getByTestId('generate-all').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('generation-workspace').getByRole('alert')).toContainText('歌词')
    expect((await snapshot(page)).requests).toEqual([])
    await first.getByTestId('entry-lyrics').fill('[Verse]\n仅用于接口夹具的自填歌词')
    await openAdvanced(first)
    await first.getByLabel('曲名 · 可选', { exact: true }).fill('多结果接口测试')
    await first.getByTestId('entry-model').selectOption('V6_MINI')
    await first.getByTestId('entry-provider').selectOption('sunor')
    await first.getByTestId('entry-prompt').fill('Sunor 暂存的独立描述')
    await first.getByLabel(/^输出格式/).selectOption('original')
    await expect(first.getByTestId('entry-model')).toHaveValue('v6')
    await first.getByTestId('entry-provider').selectOption('kie')
    await expect(first.getByTestId('entry-prompt')).toHaveValue('Kie 专用器乐与编曲描述')
    await expect(first.getByTestId('entry-model')).toHaveValue('V6_MINI')
    await expect(first.getByTestId('entry-lyrics')).toHaveValue('[Verse]\n仅用于接口夹具的自填歌词')
    const reapi = await addEntry(page, project.id, 'audio'), second = page.getByTestId(`entry-${reapi.id}`)
    await second.getByTestId('entry-provider').selectOption('reapi')
    await second.getByTestId('entry-input-mode').selectOption('description')
    await second.getByTestId('entry-prompt').fill('reAPI 描述生成，不作为歌词发送')
    const sunor = await addEntry(page, project.id, 'audio'), third = page.getByTestId(`entry-${sunor.id}`)
    await third.getByTestId('entry-provider').selectOption('sunor')
    await third.getByTestId('entry-mode').selectOption('instrumental')
    await third.getByTestId('entry-prompt').fill('Sunor 第三条描述，与前两条不同')
    await openAdvanced(third)
    await third.getByLabel(/^输出格式/).selectOption('original')
    await submitAll(page, 3, ['Kie.ai', 'reAPI', 'Sunor'])
    await expect.poll(async () => (await snapshot(page)).requests.filter(request => request.status === 'succeeded').length).toBe(3)
    let state = await snapshot(page)
    expect(state.requests.map(request => [request.entryId, request.binding.provider, request.snapshot.prompt])).toEqual([
      [kie.id, 'kie', 'Kie 专用器乐与编曲描述'], [reapi.id, 'reapi', 'reAPI 描述生成，不作为歌词发送'], [sunor.id, 'sunor', 'Sunor 第三条描述，与前两条不同']
    ])
    expect(state.requests.every(request => request.taskId && request.submittedAt && request.outputs?.length === 2 && request.outputs.every(output => output.status === 'saved'))).toBe(true)
    expect(new Set(state.requests.map(request => request.taskId)).size).toBe(3)
    expect(new Set(state.requests.flatMap(request => request.outputs!.map(output => output.id))).size).toBe(6)
    for (const entry of [kie, reapi, sunor]) await expect((await expandEntry(page, entry.id)).getByTestId('entry-result')).toHaveCount(2)
    expect(state.entries.find(entry => entry.id === kie.id)?.alternatives.sunor).toMatchObject({ prompt: 'Sunor 暂存的独立描述', outputFormat: 'original' })
    // Exact-byte dedup is allowed, but neither two returned versions nor any entry origin may disappear.
    expect(state.assets).toHaveLength(1)
    expect(state.assets[0].origins).toHaveLength(3)
    expect(state.assets[0].origins.map(origin => origin.provider).sort()).toEqual(['kie', 'reapi', 'sunor'])
    expect(state.requests.every(request => request.outputs!.every(output => output.libraryAssetId === state.assets[0].id))).toBe(true)
    const selection = { projectId: project.id, submissionId: state.requests[0].submissionId, entries: [kie, reapi, sunor].map(entry => ({ id: entry.id, revision: state.entries.find(value => value.id === entry.id)!.revision })) }
    await page.evaluate(value => Promise.all([window.canvas.submitEntries(value), window.canvas.submitEntries(value)]), selection)
    expect((await snapshot(page)).requests.map(request => request.taskId)).toEqual(state.requests.map(request => request.taskId))
    await (await expandEntry(page, kie.id)).getByRole('button', { name: '试听', exact: true }).first().click()
    const player = page.getByRole('dialog', { name: '试听音乐', exact: true }).locator('audio')
    await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
    await player.evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play(); audio.currentTime = 2; audio.pause() })
    await page.keyboard.press('Escape')
    await page.getByTestId('nav-library').click()
    await expect(page.locator('article.asset-row')).toHaveCount(1)
    await page.getByTestId('library-refresh').click()
    expect((await snapshot(page)).assets[0].usedCount).toBe(0)
    expect(errors).toEqual([])
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    state = await snapshot(page)
    expect(state.requests).toHaveLength(3); expect(state.requests.every(request => request.outputs?.length === 2 && request.status === 'succeeded')).toBe(true)
    expect(state.assets[0].origins).toHaveLength(3)
    expect(state.apis.map(api => [api.provider, api.hasKey])).toEqual([['kie', true], ['reapi', true], ['sunor', true]])
    await expectSecretAbsent(directory, page, keys)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('api-delete-reapi').click()
    const removal = page.getByRole('dialog')
    await removal.getByTestId('delete-confirm').click()
    await expect(removal).toHaveCount(0)
    expect((await snapshot(page)).apis.map(api => api.provider)).toEqual(['kie', 'sunor'])
    expect((await snapshot(page)).assets).toHaveLength(1)
    await page.getByTestId('nav-generation').click()
    const copy = await addEntry(page, project.id, 'audio')
    await expectApiChoices(page.getByTestId(`entry-${copy.id}`), ['kie', 'sunor'])
  } finally { await close(app); await removeProfile(directory) }
})

for (const key of [undefined, 'x']) {
  test(`V4 ACE-Step: real loopback HTTP, ${key ? 'one-character key and original-ID recovery' : 'no key'}, decoded FLAC and restart without duplicate POST`, async () => {
    const directory = await createProfile(key ? 'ace-short-key' : 'ace-no-key')
    let app: ElectronApplication | undefined
    let server: Awaited<ReturnType<typeof startAceStepFixture>> | undefined
    try {
      const tools = await requireTools(), file = path.join(directory, '人工音频.flac')
      await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3:sample_rate=48000', '-c:a', 'flac', file])
      server = await startAceStepFixture({ audio: await readFile(file), key, durationSeconds: 999, failDownloads: key ? 1 : 0 })
      let running = await launch(directory); app = running.app; let page = running.page
      expect((await snapshot(page)).apis).toEqual([])
      await addApi(page, { provider: 'acestep', ...(key ? { key } : {}), local: { baseUrl: server.baseUrl, waitMinutes: 5, allowLan: false } }, /语言模型未就绪/)
      expect(server.tasks.size).toBe(0)
      expect(server.requests.every(request => request.method === 'GET' && request.authorized)).toBe(true)
      const readOnlyCount = server.requests.length
      const project = await createGeneration(page, '人工 ACE 协议测试 · 非神经推理')
      const entry = await addEntry(page, project.id, 'audio'), row = page.getByTestId(`entry-${entry.id}`)
      await expectApiChoices(row, ['acestep'])
      await row.getByTestId('entry-mode').selectOption('instrumental')
      await row.getByTestId('entry-prompt').fill('人工测试音频，只验证协议，不代表神经模型推理')
      await openAdvanced(row)
      await row.getByTestId('entry-seconds').fill('10')
      expect(server.requests).toHaveLength(readOnlyCount) // Adding/selecting a local API must not auto-query models.
      await row.getByTestId('ace-models-refresh').click()
      await expect(row.locator('.ace-status')).toContainText('模型已初始化')
      await expect(row.locator('.ace-status')).toContainText('语言模型：未就绪')
      await expect(row.getByTestId('entry-model')).toContainText('acestep-v15-turbo')
      await expect(row.getByTestId('entry-model')).toHaveValue('default')
      await expect(row.getByRole('checkbox', { name: /LM 增强/ })).toBeDisabled()
      await expect.poll(() => row.getByTestId('entry-input-mode').locator('option[value=description]').evaluate(option => (option as HTMLOptionElement).disabled)).toBe(true)
      await submitAll(page, 1, ['ACE-Step 本地', '本地 GPU / CPU'])
      let originalTaskId: string | undefined
      let outputIds: string[] | undefined
      if (key) {
        await expect.poll(async () => (await snapshot(page)).requests[0]?.status).toBe('failed')
        const failed = (await snapshot(page)).requests[0]
        expect(failed.recoverable).toBe(true); expect(failed.outputs).toHaveLength(1)
        originalTaskId = failed.taskId; outputIds = failed.outputs!.map(output => output.id)
        expect(server.tasks.size).toBe(1)
        const beforeRestart = server.requests.length
        await close(app); app = undefined
        running = await launch(directory); app = running.app; page = running.page
        expect(server.requests).toHaveLength(beforeRestart)
        expect((await snapshot(page)).requests[0].taskId).toBe(originalTaskId)
        // A recoverable request still owns the original local connection and credentials.
        await page.getByTestId('nav-settings').click(); await page.getByTestId('api-edit-acestep').click()
        const editor = page.getByRole('dialog', { name: '编辑 ACE-Step 本地', exact: true })
        await expect(editor.getByTestId('api-key')).toHaveValue('')
        await editor.getByTestId('api-local-url').fill('http://127.0.0.1:9')
        await expect(editor.getByTestId('api-save')).toBeDisabled()
        await editor.getByRole('checkbox', { name: '确认更换连接并清除旧地址凭据', exact: true }).check()
        await editor.getByTestId('api-save').click()
        await expect(editor.getByRole('alert')).toContainText('原连接仍有未完成请求')
        expect((await snapshot(page)).apis[0].local?.baseUrl).toBe(server.baseUrl)
        await page.keyboard.press('Escape'); await editor.getByRole('button', { name: '放弃并关闭', exact: true }).click()
        await page.getByTestId('nav-generation').click()
        await (await expandEntry(page, entry.id)).getByTestId(`request-resume-${failed.id}`).click()
        await confirmAction(page, '恢复查询与保存')
      }
      await expect.poll(async () => (await snapshot(page)).requests[0]?.status).toBe('succeeded')
      const state = await snapshot(page), request = state.requests[0], asset = state.assets[0]
      expect(state.requests).toHaveLength(1); expect(state.assets).toHaveLength(1)
      if (originalTaskId) { expect(request.taskId).toBe(originalTaskId); expect(request.outputs!.map(output => output.id)).toEqual(outputIds) }
      expect(asset).toMatchObject({ kind: 'audio', format: 'flac', available: true, usedCount: 0 })
      expect(asset.durationSeconds).toBeCloseTo(3, 1) // Decode the real file, never trust remote 999s metadata.
      expect(await assetBytes(app, asset.id)).toEqual(await readFile(file))
      await (await expandEntry(page, entry.id)).getByRole('button', { name: '试听', exact: true }).click()
      const preview = page.getByRole('dialog', { name: '试听音乐', exact: true }), player = preview.locator('audio')
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
      await player.evaluate(async (audio: HTMLAudioElement) => { audio.volume = 0; await audio.play(); audio.currentTime = 1; audio.pause() })
      expect(await player.evaluate((audio: HTMLAudioElement) => audio.duration)).toBeCloseTo(3, 1)
      const exportPath = path.join(directory, '另存 原始FLAC.flac'); await nativeSave(app, exportPath)
      await preview.getByRole('button', { name: '另存为', exact: true }).click()
      await expect.poll(() => fileDigest(exportPath)).toBe(digest(await readFile(file)))
      await page.keyboard.press('Escape')
      expect(server.tasks.size).toBe(1)
      expect(server.requests.filter(value => value.method === 'POST' && value.route === '/release_task')).toHaveLength(1)
      expect(server.requests.every(value => value.authorized)).toBe(true)
      expect(server.requests.filter(value => value.route === '/v1/audio')).toHaveLength(key ? 2 : 1)
      expect(server.tasks.get(request.taskId!)!.body).toMatchObject({ audio_duration: 10, batch_size: 1, thinking: false, use_cot_caption: false, use_cot_language: false, use_format: false, lyrics: '[Instrumental]' })
      const serverRequests = server.requests.length
      await close(app); app = undefined
      running = await launch(directory); app = running.app; page = running.page
      const restored = await snapshot(page)
      expect(restored.requests[0]).toMatchObject({ id: request.id, taskId: request.taskId, status: 'succeeded' })
      expect(restored.assets[0].id).toBe(asset.id)
      expect(restored.apis[0].hasKey).toBe(Boolean(key))
      expect(server.requests).toHaveLength(serverRequests)
      expect(server.tasks.size).toBe(1)
      if (key) {
        expect(await readFile(path.join(directory, 'appdata', 'secrets.json'), 'utf8')).not.toContain('"x"')
        await page.getByTestId('nav-settings').click(); await page.getByTestId('api-edit-acestep').click()
        const editor = page.getByRole('dialog', { name: '编辑 ACE-Step 本地', exact: true })
        await expect(editor.getByTestId('api-key')).toHaveValue('')
        await editor.getByTestId('api-clear-key').check(); await editor.getByTestId('api-save').click()
        await expect(editor).toHaveCount(0)
        expect((await snapshot(page)).apis[0].hasKey).toBe(false)
      }
    } finally { await close(app); await server?.close(); await removeProfile(directory) }
  })
}

test('V4 ACE-Step unknown acceptance: one real POST despite a lost response; restart/abandon never resubmits', async () => {
  const directory = await createProfile('ace-unknown-post')
  const upstream = await startAceStepFixture({ audio: Buffer.alloc(0), durationSeconds: 10 }) // Never downloaded: only the accepted-create ambiguity is under test.
  const posts: string[] = []
  const proxy = createServer((request, response) => {
    void (async () => {
      const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (!['/health', '/v1/models', '/release_task', '/query_result'].includes(route)) { response.writeHead(404); response.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (request.method === 'POST') posts.push(route)
      const result = await fetch(`${upstream.baseUrl}${route}`, { method: request.method, ...(request.method === 'POST' ? { body: Buffer.concat(chunks), headers: { 'Content-Type': 'application/json' } } : {}) })
      const bytes = Buffer.from(await result.arrayBuffer())
      if (route === '/release_task') { response.destroy(); return } // Server accepted it, but no task ID reaches the desktop.
      response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(bytes)
    })().catch(() => response.destroy())
  })
  let app: ElectronApplication | undefined
  try {
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind')
    let running = await launch(directory); app = running.app; let page = running.page
    await addApi(page, { provider: 'acestep', local: { baseUrl: `http://127.0.0.1:${address.port}`, waitMinutes: 5, allowLan: false } })
    const project = await createGeneration(page, '受理未知不能重发')
    const entry = await addEntry(page, project.id, 'audio'), row = page.getByTestId(`entry-${entry.id}`)
    await row.getByTestId('entry-mode').selectOption('instrumental'); await row.getByTestId('entry-prompt').fill('接受 POST 后丢失响应的人工夹具')
    await openAdvanced(row); await row.getByTestId('entry-seconds').fill('10')
    await submitAll(page, 1)
    await expect.poll(async () => (await snapshot(page)).requests[0]?.status).toBe('unknown')
    const unknown = (await snapshot(page)).requests[0]
    expect(unknown.taskId).toBeUndefined(); expect(upstream.tasks.size).toBe(1); expect(posts).toEqual(['/release_task'])
    await expect((await expandEntry(page, entry.id)).getByTestId(`request-resume-${unknown.id}`)).toHaveCount(0)
    await expect(page.evaluate(id => window.canvas.resumeRequest(id), unknown.id)).rejects.toThrow('不能恢复')
    await expect(page.evaluate(async ({ projectId, entryId }) => {
      const state = await window.canvas.bootstrap(), entry = state.entries.find(value => value.id === entryId)!
      await window.canvas.submitEntries({ projectId, submissionId: crypto.randomUUID(), entries: [{ id: entryId, revision: entry.revision }] })
    }, { projectId: project.id, entryId: entry.id })).rejects.toThrow('已提交')
    await close(app); app = undefined
    running = await launch(directory); app = running.app; page = running.page
    expect((await snapshot(page)).requests[0]).toMatchObject({ id: unknown.id, status: 'unknown' })
    expect(posts).toEqual(['/release_task'])
    await (await expandEntry(page, entry.id)).getByTestId(`request-abandon-${unknown.id}`).click()
    await confirmAction(page, '放弃追踪此请求？')
    expect((await snapshot(page)).requests[0].status).toBe('abandoned')
    expect(posts).toEqual(['/release_task']); expect(upstream.tasks.size).toBe(1)
    expect((await snapshot(page)).assets).toEqual([])
    // Even a different submission ID cannot silently turn this same entry into another paid/local create.
    await expect(page.evaluate(async ({ projectId, entryId, submissionId }) => {
      const entry = (await window.canvas.bootstrap()).entries.find(value => value.id === entryId)!
      await window.canvas.submitEntries({ projectId, submissionId, entries: [{ id: entryId, revision: entry.revision }] })
    }, { projectId: project.id, entryId: entry.id, submissionId: randomUUID() })).rejects.toThrow('已提交')
  } finally {
    await close(app)
    await new Promise<void>((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections() })
    await upstream.close(); await removeProfile(directory)
  }
})
