import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadMusicEngine } from './music-test-utils.mjs'

// Only ephemeral loopback fixtures and FFmpeg-generated sine-wave FLAC. No real model or paid API.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repository, 'scripts/acestep-live-smoke.mjs')
const parent = process.env.PI_SCRATCH_DIR || os.tmpdir()
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, 'acestep-cli-test-'))
const cwd = path.join(root, 'isolated cwd 中文')
await mkdir(cwd)
const previous = process.cwd()
let engine
try { process.chdir(repository); engine = await loadMusicEngine(root, true) } finally { process.chdir(previous) }
const tools = await engine.requireTools()
const source = path.join(root, 'synthetic 10.25 seconds.flac')
await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10.25', '-ac', '2', '-c:a', 'flac', source])
const audio = await readFile(source)
const key = `fixture-key-${randomUUID()}`
const fixture = await engine.startAceStepFixture({ audio, durationSeconds: 10, key, lm: false })
const anonymous = await engine.startAceStepFixture({ audio, durationSeconds: 10 })
const runs = []
const results = []
function environment() {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return { ...env, PI_SCRATCH_DIR: root, TEMP: root, TMP: root, TMPDIR: root, ACESTEP_API_KEY: key }
}
async function run(args, { env = {}, nodeArgs = [] } = {}) {
  const childEnv = { ...environment(), ...env }
  for (const name of Object.keys(childEnv)) if (childEnv[name] === undefined) delete childEnv[name]
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture CLI process exceeded 90 seconds')) }, 90000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  // This unique long marker detects credential leakage; short keys are checked by field below,
  // not by banning ordinary characters in paths, model names or task IDs.
  assert.ok(!(result.stdout + result.stderr).includes(key), 'key must not appear in CLI output')
  const marker = result.stdout.match(/^REPORT_JSON=(.+)$/m)
  if (marker) {
    result.reportFile = JSON.parse(marker[1])
    result.report = JSON.parse(await readFile(result.reportFile, 'utf8'))
    result.work = path.dirname(result.reportFile)
  }
  runs.push(result)
  return result
}
const passed = name => { results.push(name); console.log(`PASS: ${name}`) }
let uncertain, shortKeyFixture
try {
  const beforeHelp = await readdir(root)
  const help = await run(['--help', '--url', fixture.baseUrl, '--generate'], { env: { ACESTEP_API_KEY: 'invalid key ignored by help' } })
  assert.equal(help.code, 0); assert.equal(fixture.requests.length, 0)
  assert.deepEqual(await readdir(root), beforeHelp)
  assert.equal((await run([])).code, 1)
  passed('help/missing URL: zero network; help creates no files, even with --generate')

  const invalid = [
    ['--wait-minutes', '4'], ['--wait-minutes', '181'], ['--wait-minutes', '5.5'], ['--wait-minutes', 'NaN'],
    ['--model', '../bad'], ['--model', 'bad model'], ['--url', fixture.baseUrl],
    ['--task-id', 'unbound-task'], ['--key', 'do-not-accept-cli-keys']
  ]
  for (const args of invalid) assert.equal((await run(['--url', fixture.baseUrl, ...args])).code, 1)
  for (const url of [`${fixture.baseUrl}/v1`, `${fixture.baseUrl}?key=not-a-key`, 'http://8.8.8.8:8001', 'http://192.168.1.2:8001', 'http://user:password@127.0.0.1:8001']) {
    assert.equal((await run(['--url', url])).code, 1)
  }
  assert.equal((await run(['--url', fixture.baseUrl], { env: { ACESTEP_API_KEY: 'bad key' } })).code, 1)
  assert.equal(fixture.requests.length, 0)
  passed('production URL/key/model/wait/LAN validation and CLI exclusivity reject before HTTP')

  const read = await run(['--url', fixture.baseUrl])
  assert.equal(read.code, 0, read.stderr)
  assert.equal(read.report.status, 'readonly-passed'); assert.equal(read.report.createAttempted, false)
  assert.equal(read.report.connection.llmInitialized, false); assert.equal(read.report.taskId, null)
  assert.equal(path.dirname(read.work), root)
  assert.deepEqual(fixture.requests.map(request => [request.method, request.route]), [['GET', '/health'], ['GET', '/v1/models']])
  assert.equal(fixture.tasks.size, 0)
  const noKey = await run(['--url', anonymous.baseUrl, '--wait-minutes', '180'], { env: { ACESTEP_API_KEY: undefined } })
  assert.equal(noKey.code, 0); assert.ok(anonymous.requests.every(request => request.authorized))
  passed('readonly: health/models only, optional env key, no task, default scratch and non-repository cwd')

  const generation = await run(['--url', fixture.baseUrl, '--generate', '--model', 'acestep-v15-turbo', '--wait-minutes', '5', '--ffmpeg', tools.ffmpeg, '--work-dir', cwd])
  assert.ok([0, 3].includes(generation.code), generation.stderr)
  assert.equal(path.dirname(generation.work), cwd)
  assert.equal(fixture.tasks.size, 1); assert.equal(generation.report.createAttempted, true)
  assert.equal(fixture.requests.filter(request => request.route === '/release_task').length, 1)
  const body = fixture.tasks.get(generation.report.taskId).body
  assert.equal(body.audio_duration, 10); assert.equal(body.batch_size, 1); assert.equal(body.audio_format, 'flac')
  assert.equal(body.lyrics, '[Instrumental]'); assert.equal(body.model, 'acestep-v15-turbo')
  for (const flag of ['thinking', 'sample_mode', 'use_format', 'use_cot_caption', 'use_cot_language']) assert.equal(body[flag], false)
  assert.equal(generation.report.actualModel, 'acestep-v15-turbo')
  assert.equal(generation.report.files.length, 1)
  assert.equal(generation.report.files[0].serverDurationMs, 10000)
  assert.equal(generation.report.files[0].durationMs, 10250, 'must use real FFmpeg decoded duration, not remote metadata')
  assert.deepEqual(await readFile(generation.report.files[0].path), audio)
  assert.ok(fixture.requests.every(request => request.authorized))
  if (generation.code === 0) {
    assert.equal(generation.report.playback.status, 'passed')
    assert.equal(generation.report.playback.method, 'isolated-electron-production-media-protocol')
    assert.ok(generation.report.playback.samples[0].playedSeconds >= 1)
    passed('generate: exactly one POST, authenticated original FLAC, actual 10.25s, isolated Electron media playback advances')
  } else {
    assert.equal(generation.report.playback.status, 'needs-manual-audition')
    assert.match(generation.stdout, /尚需在应用试听/)
    passed('generate: exactly one POST, original FLAC + actual duration; player unavailable honestly marked manual (not passed)')
  }
  assert.equal(generation.report.manualAuditionRequired, true)
  const generatedCalls = fixture.requests.length
  for (const args of [
    ['--url', anonymous.baseUrl, '--resume', generation.work],
    ['--url', fixture.baseUrl, '--resume', generation.work, '--task-id', 'wrong-task'],
    ['--url', fixture.baseUrl, '--resume', generation.work, '--model', 'another-model'],
    ['--url', fixture.baseUrl, '--resume', generation.work, '--generate'],
    // --allow-lan accepts the production config; the old binding still prevents ANY LAN request.
    ['--url', 'http://192.168.1.2:8001', '--allow-lan', '--resume', generation.work]
  ]) assert.equal((await run(args)).code, 1)
  assert.equal(fixture.requests.length, generatedCalls); assert.equal(anonymous.requests.length, 2)
  passed('resume refuses changed service/task/model and generate combination before sending credentials')

  const downloadsBefore = fixture.requests.filter(request => request.route === '/v1/audio').length
  const resume = await run(['--url', fixture.baseUrl, '--resume', generation.work, '--task-id', generation.report.taskId, '--skip-playback'])
  assert.equal(resume.code, 3); assert.equal(resume.report.createAttempted, false)
  assert.equal(resume.report.taskId, generation.report.taskId)
  assert.equal(resume.report.files[0].path, generation.report.files[0].path)
  assert.equal(fixture.requests.filter(request => request.route === '/release_task').length, 1)
  assert.equal(fixture.requests.filter(request => request.route === '/v1/audio').length, downloadsBefore)
  assert.equal(resume.report.playback.status, 'needs-manual-audition')
  assert.match(resume.stdout, /尚需在应用试听/)
  passed('resume: original task + idempotent production save, no recreate/download; skip playback is explicitly unverified')

  // Test-only Node preload accelerates ONLY the validated five-minute polling deadline.
  // No test clock/shortened-wait switch is added to the production CLI.
  const clockHook = path.join(root, 'accelerate-poll-deadline.mjs')
  await writeFile(clockHook, 'const original = globalThis.setTimeout; globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 300000 ? 250 : ms, ...args);\n')
  const timeout = await run(['--url', fixture.baseUrl, '--generate', '--wait-minutes', '5', '--skip-playback'], { nodeArgs: ['--import', pathToFileURL(clockHook).href] })
  assert.equal(timeout.code, 2, timeout.stderr); assert.equal(timeout.report.status, 'timed-out')
  assert.ok(fixture.tasks.has(timeout.report.taskId))
  assert.equal(JSON.parse(await readFile(path.join(timeout.work, 'task.json'), 'utf8')).taskId, timeout.report.taskId)
  const createCount = fixture.requests.filter(request => request.route === '/release_task').length
  const afterTimeout = await run(['--url', fixture.baseUrl, '--resume', timeout.work, '--skip-playback'])
  assert.equal(afterTimeout.code, 3, afterTimeout.stderr)
  assert.equal(afterTimeout.report.taskId, timeout.report.taskId)
  assert.equal(fixture.requests.filter(request => request.route === '/release_task').length, createCount)
  assert.equal(afterTimeout.report.files[0].durationMs, 10250)
  passed('accelerated polling timeout retains taskID/checkpoint; recovery only queries/saves the original task')

  // An additional local fixture forwards to the same official-shape fixture, then corrupts only
  // the accepted create response. It checks ambiguous submission and redaction, not real inference.
  let createResponses = 0
  uncertain = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const upstream = await fetch(fixture.baseUrl + request.url, { method: request.method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      if (request.url === '/release_task') {
        createResponses++
        await upstream.arrayBuffer()
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ code: 200, data: { task_id: `https://media.invalid/signed?key=${key}`, debug: key } }))
      } else { response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(Buffer.from(await upstream.arrayBuffer())) }
    })().catch(() => response.destroy())
  })
  await new Promise(resolve => uncertain.listen(0, '127.0.0.1', resolve))
  const unknown = await run(['--url', `http://127.0.0.1:${uncertain.address().port}`, '--generate', '--skip-playback'])
  assert.equal(unknown.code, 1); assert.equal(createResponses, 1)
  assert.equal(unknown.report.status, 'submission-unknown'); assert.equal(unknown.report.taskId, null)
  assert.ok(unknown.report.submissionWarning)
  assert.ok(!(unknown.stdout + unknown.stderr + JSON.stringify(unknown.report)).includes('media.invalid'))
  passed('ambiguous create response: one accepted POST, no retry, explicit unknown outcome, no response key/signed URL leaked')

  shortKeyFixture = await engine.startAceStepFixture({ audio, durationSeconds: 10, key: 'a', lm: false })
  const shortKeyOptions = { env: { ACESTEP_API_KEY: 'a' } }
  const shortGenerate = await run(['--url', shortKeyFixture.baseUrl, '--generate', '--model', 'acestep-v15-turbo', '--skip-playback'], shortKeyOptions)
  assert.equal(shortGenerate.code, 3, shortGenerate.stderr)
  const originalTaskId = [...shortKeyFixture.tasks.keys()][0]
  const checkpointPath = path.join(shortGenerate.work, 'task.json')
  const checkpointBytes = await readFile(checkpointPath, 'utf8')
  const checkpoint = JSON.parse(checkpointBytes)
  const expectedDraft = { ...engine.defaultMusicDraft('acestep'), prompt: 'A gentle ambient piano instrumental, calm sustained chords, no vocals.', title: 'ACE-Step explicit smoke test', model: 'acestep-v15-turbo', seconds: 10, count: 1, thinking: false }
  assert.deepEqual(Object.keys(checkpoint).sort(), ['kind', 'version', 'baseUrl', 'taskId', 'draft', 'assetIds'].sort())
  assert.equal(checkpoint.kind, 'acestep-live-smoke-task'); assert.equal(checkpoint.version, 1)
  assert.equal(checkpoint.baseUrl, shortKeyFixture.baseUrl); assert.equal(checkpoint.taskId, originalTaskId)
  assert.deepEqual(checkpoint.draft, expectedDraft)
  assert.equal(checkpoint.assetIds.length, 20); assert.equal(new Set(checkpoint.assetIds).size, 20)
  for (const id of [checkpoint.taskId, ...checkpoint.assetIds]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(shortGenerate.report.taskId, originalTaskId)
  assert.equal(shortGenerate.report.requestedModel, expectedDraft.model)
  assert.equal(shortGenerate.report.files[0].assetId, checkpoint.assetIds[0])
  assert.equal(shortGenerate.report.files[0].path, path.join(shortGenerate.work, 'audio', `${checkpoint.assetIds[0]}.flac`))
  assert.deepEqual(await readFile(shortGenerate.report.files[0].path), audio)
  const originalBody = structuredClone(shortKeyFixture.tasks.get(originalTaskId).body)
  assert.equal(originalBody.model, expectedDraft.model); assert.equal(originalBody.prompt, expectedDraft.prompt)
  const shortResume = await run(['--url', shortKeyFixture.baseUrl, '--resume', shortGenerate.work, '--task-id', originalTaskId, '--skip-playback'], shortKeyOptions)
  assert.equal(shortResume.code, 3, shortResume.stderr); assert.equal(shortResume.report.createAttempted, false)
  assert.equal(shortResume.report.taskId, originalTaskId)
  assert.deepEqual(shortResume.report.files, shortGenerate.report.files)
  assert.equal(await readFile(checkpointPath, 'utf8'), checkpointBytes, 'UUIDs, draft and taskID must remain byte-for-byte unchanged on resume')
  assert.deepEqual(shortKeyFixture.tasks.get(originalTaskId).body, originalBody)
  assert.equal(shortKeyFixture.tasks.size, 1)
  assert.equal(shortKeyFixture.requests.filter(request => request.route === '/release_task').length, 1)
  assert.equal(shortKeyFixture.requests.filter(request => request.route === '/v1/audio').length, 1)
  assert.ok(shortKeyFixture.requests.every(request => request.authorized))
  for (const result of [shortGenerate, shortResume]) {
    assert.equal(JSON.parse(result.stdout.match(/^WORK_DIR=(.+)$/m)[1]), shortGenerate.work)
    assert.equal(JSON.parse(result.stdout.match(/^TASK_ID=("[^"]*")/m)[1]), originalTaskId)
    assert.equal(result.report.resume.directory, shortGenerate.work)
    assert.equal(result.report.resume.taskId, originalTaskId)
    assert.deepEqual(Object.keys(result.report.connection).sort(), ['modelsInitialized', 'llmInitialized', 'defaultModel', 'loadedLmModel', 'models'].sort())
    assert.ok(!(result.stdout + result.stderr).includes('Bearer a'))
  }
  for (const state of [checkpoint, shortGenerate.report, shortResume.report]) {
    const text = JSON.stringify(state)
    assert.ok(text.includes('a'), 'ordinary characters matching a short key are not credential fields')
    assert.ok(!text.includes('[REDACTED]'), 'operational state must not be substring-redacted')
    assert.doesNotMatch(text, /"(?:key|apiKey|ACESTEP_API_KEY|authorization|headers|rawResponse|url)"\s*:/i)
  }
  passed('single-character key: authenticated generate/resume, exact taskID/draft/UUIDs and usable paths, one create; credential fields absent, ordinary characters preserved')

  for (const result of runs) {
    const text = result.stdout + result.stderr + (result.report ? await readFile(result.reportFile, 'utf8') : '')
    assert.ok(!text.includes(key)); assert.ok(!text.includes('/v1/audio?path=')); assert.ok(!text.includes('/server-only/'))
    if (result.report?.taskId) {
      const checkpoint = await readFile(path.join(result.work, 'task.json'), 'utf8')
      assert.ok(!checkpoint.includes(key)); assert.ok(!checkpoint.includes('/v1/audio?path='))
    }
  }
  assert.ok(fixture.requests.every(request => ['/health', '/v1/models', '/release_task', '/query_result', '/v1/audio'].includes(request.route)))
  passed('reports/checkpoints/stdout/stderr contain no key or remote media locator; no management/model-download endpoints')
  const report = { kind: 'synthetic-http-fixture-only', neuralInferenceTested: false, root, results, playback: generation.report.playback, runReports: runs.filter(run => run.reportFile).map(run => run.reportFile) }
  await writeFile(path.join(root, 'test-report.json'), JSON.stringify(report, null, 2))
  console.log(`TEST_REPORT=${JSON.stringify(path.join(root, 'test-report.json'))}`)
  console.log('真实神经推理、真实用户服务和收费 API：未测试、未访问。')
} finally {
  await fixture.close(); await anonymous.close()
  await shortKeyFixture?.close()
  if (uncertain) await new Promise(resolve => { uncertain.close(resolve); uncertain.closeAllConnections() })
  console.log(`Fixture artifacts retained: ${root}`)
}
