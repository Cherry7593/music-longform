// Targeted local-only UI check. Native file choices and one lost IPC reply are synthetic fixtures.
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/prompt-import-desktop.mjs [--exe <packaged unpacked EXE>]\nLaunches an isolated real Electron app, then native Python Playwright. No generation/network/video. Packaged mode checks embedded templates and startup only.')
  process.exit(0)
}
const { parseArgs } = await import('node:util')
const { values } = parseArgs({ options: { exe: { type: 'string' } } })
const { _electron: electron } = await import('playwright')
const { readFile, writeFile, mkdir } = await import('node:fs/promises')
const { default: path } = await import('node:path')
const { createHash } = await import('node:crypto')
const { spawn } = await import('node:child_process')
const { createServer } = await import('node:net')
const { default: assert } = await import('node:assert/strict')
const { createFixtureRoot, loadV4Fixtures, createCurrentProfile, workspaceRoot } = await import('./v4-package-fixtures.mjs')
const root = await createFixtureRoot('v402-prompt-ui-'), engine = await loadV4Fixtures(root)
const { profile, mediaRoot } = await createCurrentProfile(root, engine)
const downloads = path.join(root, 'templates'); await mkdir(downloads)
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port; await new Promise(resolve => server.close(resolve))
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSIC_CANVAS_E2E', 'MUSIC_CANVAS_TEST_DIR'].includes(key) && value !== undefined))
const flags = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']
let app
const report = { passed: false, root, profile, mediaRoot, mode: values.exe ? 'packaged-template-smoke' : 'targeted-ui', networkCalls: 0, generatedRequests: 0 }
try {
  app = await electron.launch({ ...(values.exe ? { executablePath: path.resolve(values.exe), args: flags } : { args: [workspaceRoot, ...flags] }), env, cwd: root, timeout: 60000 })
  const page = await app.firstWindow(); await page.getByTestId('nav-generation').waitFor({ state: 'visible', timeout: 30000 })
  const actual = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }))
  assert.equal(actual.version, '4.0.2'); assert.equal(actual.packaged, Boolean(values.exe)); assert.equal(path.resolve(actual.profile), path.resolve(profile))
  report.application = actual
  await app.evaluate(({ dialog, ipcMain }, { directory, loseReply }) => {
    globalThis.__promptImportFixture = { saves: [], creates: [], queries: 0, network: 0, lost: false }
    const fixture = globalThis.__promptImportFixture
    globalThis.fetch = async () => { fixture.network++; throw new Error('Synthetic fixture prohibits provider network') }
    dialog.showSaveDialog = async (_window, options) => {
      fixture.saves.push({ name: options.defaultPath, filters: options.filters })
      if (fixture.saves.length === 1) return { canceled: true }
      if (!['音乐提示词模板.md', '图片提示词模板.md'].includes(options.defaultPath)) throw new Error('Unexpected save dialog in fixture')
      return { canceled: false, filePath: `${directory}/${options.defaultPath}` }
    }
    // These wrappers exist only in this explicitly launched test process, never in production files.
    const handlers = ipcMain._invokeHandlers
    const createName = 'canvas:workbench:createPromptEntries', statusName = 'canvas:workbench:promptImportStatus'
    const originalCreate = handlers.get(createName), originalStatus = handlers.get(statusName)
    if (!originalCreate || !originalStatus) throw new Error('New IPC handlers missing')
    ipcMain.removeHandler(createName); ipcMain.removeHandler(statusName)
    ipcMain.handle(createName, async (...args) => {
      fixture.creates.push(args[1]); const result = await originalCreate(...args)
      if (loseReply && result.ok && !fixture.lost) { fixture.lost = true; throw new Error('Synthetic lost reply after committed draft batch') }
      return result
    })
    ipcMain.handle(statusName, async (...args) => { fixture.queries++; return originalStatus(...args) })
  }, { directory: downloads, loseReply: !values.exe })
  const runPython = args => new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(workspaceRoot, 'scripts/prompt-import-ui.py'), ...args], { cwd: workspaceRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk) }); child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk) })
    child.once('error', reject); child.once('close', async code => { await writeFile(path.join(root, 'python.log'), log); if (code === 0) resolve(); else reject(new Error(`Python UI exited ${code}`)) })
  })
  await runPython(['--help'])
  await runPython(['--endpoint', `http://127.0.0.1:${port}`, '--root', root, ...(values.exe ? ['--smoke'] : [])])
  const state = await page.evaluate(() => window.canvas.bootstrap())
  assert.equal(state.requests.length, 0); assert.equal(state.batches.length, 0); assert.equal(state.testMode, false)
  const fixture = await app.evaluate(() => globalThis.__promptImportFixture)
  assert.equal(fixture.network, 0); assert.equal(fixture.saves.length, 3)
  if (values.exe) assert.equal(fixture.creates.length, 0)
  else { assert.equal(fixture.creates.length, 3); assert.equal(new Set(fixture.creates.map(batch => batch.batchId)).size, 3); assert.equal(fixture.lost, true); assert.ok(fixture.queries >= 4) }
  report.templates = []
  for (const name of ['音乐提示词模板.md', '图片提示词模板.md']) {
    const source = await readFile(path.join(workspaceRoot, 'docs/templates', name)), saved = await readFile(path.join(downloads, name))
    assert(source.equals(saved)); report.templates.push({ name, bytes: saved.length, sha256: createHash('sha256').update(saved).digest('hex') })
  }
  report.fixture = { saveChoices: fixture.saves, createCalls: fixture.creates.length, statusQueries: fixture.queries, lostReplyRecovered: fixture.lost, networkCalls: fixture.network }
  report.ui = JSON.parse(await readFile(path.join(root, 'ui-report.json'), 'utf8'))
  assert(report.ui.passed)
  await app.close(); app = undefined
  // A real reopen must preserve order and exactly the same imported identities.
  app = await electron.launch({ ...(values.exe ? { executablePath: path.resolve(values.exe), args: [`--user-data-dir=${profile}`] } : { args: [workspaceRoot, `--user-data-dir=${profile}`] }), env, cwd: root, timeout: 60000 })
  const reopened = await app.firstWindow(); await reopened.getByTestId('nav-generation').waitFor({ state: 'visible', timeout: 30000 })
  const after = await reopened.evaluate(() => window.canvas.bootstrap())
  assert.equal(after.requests.length, 0); assert.equal(after.batches.length, 0)
  assert.deepEqual(after.entries.map(e => e.id).sort(), state.entries.map(e => e.id).sort())
  for (const project of state.generationProjects) assert.deepEqual(after.generationProjects.find(p => p.id === project.id).entryIds, project.entryIds)
  report.restartedWithoutDuplicates = true; report.passed = true
} catch (error) { report.error = String(error); throw error }
finally { await app?.close().catch(() => undefined); await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(`PROMPT_IMPORT_REPORT=${path.join(root, 'report.json')}`) }
