// Isolated, test-only benchmark. --help exits before imports, filesystem access or tool discovery.
const help = `Video V4 real performance comparison (no profile, API, vendor tools or user media).
Usage: node scripts/video-performance.mjs [options]
  --help                    Print this text without touching files/tools
  --quick                   Six-second synthetic songs (development, NOT hour evidence)
  --mode=all|baseline|one|concurrency2|optimized   Default all; optimized runs one+2
  --suite=both|single|batch  Default both: one output and three outputs
  --cache=both|cold|warm     Default both; application segment cache, NOT OS cache
  --encoder=auto|cpu|nvenc|qsv          Default auto; actual initialization required
  --threads=2               Per optimized task, integer 1..8
  --scratch=ABSOLUTE         Existing isolated parent (default PI_SCRATCH_DIR / OS temp)
  --reference=ABSOLUTE_JSON  Prior report under scratch; require identical corpus/tools/code
  --keep                    Keep only this run's generated sources/cache after success
Default: six new 1805-second lossless songs, three pictures, 3607s/output, identical
parameters/material in all modes. Baseline remains old ultrafast+stillimage+4 threads.
Every completed task is validated, then its large work/output files are deleted.
Reports include sampled process-tree CPU/RSS/disk peaks (not fabricated exact peaks),
real child-process overlap, full decode/frame count, sample PCM hash, audio order,
first/middle/last image checks. Publishing/accounting belongs to the app, not this test.
The complete long matrix can take hours. Ctrl+C cancels only this run's active tools.`
if (process.argv.includes('--help')) { console.log(help); process.exit(0) }
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  if (!/^--[a-z]+(?:=.*)?$/.test(arg)) throw new Error(`Invalid option ${arg}`)
  const at = arg.indexOf('='); return at < 0 ? [arg.slice(2), true] : [arg.slice(2, at), arg.slice(at + 1)]
}))
for (const key of Object.keys(args)) if (!['quick', 'mode', 'suite', 'cache', 'encoder', 'threads', 'scratch', 'keep', 'reference'].includes(key)) throw new Error(`Unknown option --${key}`)
for (const [key, valid] of Object.entries({ mode: ['all', 'baseline', 'one', 'concurrency2', 'optimized'], suite: ['both', 'single', 'batch'], cache: ['both', 'cold', 'warm'], encoder: ['auto', 'cpu', 'nvenc', 'qsv'] })) {
  if (args[key] !== undefined && !valid.includes(args[key])) throw new Error(`Invalid --${key}`)
}
const threads = Number(args.threads ?? 2)
if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('--threads must be 1..8')

const { build } = await import('esbuild')
const fs = await import('node:fs/promises')
const { writeFileSync } = await import('node:fs')
const { createHash, randomUUID } = await import('node:crypto')
const { default: path } = await import('node:path')
const { default: os } = await import('node:os')
const { createRequire } = await import('node:module')
const { AsyncLocalStorage } = await import('node:async_hooks')
const { performance } = await import('node:perf_hooks')
const { default: assert } = await import('node:assert/strict')
const { default: sharp } = await import('sharp')
const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const parent = args.scratch ?? process.env.PI_SCRATCH_DIR ?? os.tmpdir()
if (typeof parent !== 'string' || !path.isAbsolute(parent) || /^[\\/]{2}/.test(parent) || /[\x00-\x1f]/.test(parent)
  || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(parent)
  || !(await fs.lstat(parent)).isDirectory() || path.relative(await fs.realpath(parent), path.resolve(parent))) throw new Error('Scratch must be an existing, nonredirected absolute local directory')
const root = await fs.mkdtemp(path.join(parent, 'video-performance-v4-'))
console.log(`VIDEO_PERFORMANCE_DIR=${root}`)
const workRoot = path.join(root, 'work'), sourceRoot = path.join(root, 'sources'), caches = path.join(root, 'caches')
for (const directory of [workRoot, sourceRoot, caches]) await fs.mkdir(directory)
const bundle = path.join(root, 'engine.cjs')
await build({ stdin: { contents: "export * from './src/main/video/ffmpeg'; export * from './src/main/video/encoders'; export {renderMedia} from './src/main/video/pipeline'; export {renderMedia as baseline} from './tests/fixtures/video-pipeline-v31';", resolveDir: path.resolve('.') }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
const engine = require(bundle)
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
const signal = controller.signal
const tools = await engine.requireTools(process.env.FFMPEG_PATH)
const identity = await engine.toolIdentity(tools, signal)
const base = ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-threads', '2', '-filter_threads', '2']
const seconds = args.quick ? 6 : 1805, transition = args.quick ? 0.75 : 3, expected = seconds * 2 - transition
const parameters = { initialized: true, durationMode: 'all', targetSeconds: 3600, transition: 'crossfade', transitionSeconds: transition, fadeInSeconds: 1, fadeOutSeconds: 1, normalize: false, fit: 'contain' }
const sha = value => createHash('sha256').update(value).digest('hex')
const report = {
  version: 1, createdAt: new Date().toISOString(), root, quick: !!args.quick,
  machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryAtStartBytes: os.freemem() },
  toolIdentity: identity, parameters, parameterHash: sha(JSON.stringify(parameters)),
  baseline: { sourceOriginalSha256: '708a31d572f658e05fe6fe68f5252157a09868456d7122f97466ee30bee0a48a', preset: 'ultrafast', tune: 'stillimage', encoderThreads: 4, filterThreads: 2, gop: 300 },
  optimized: { threads, requestedEncoder: args.encoder ?? 'auto', staticVideo: true },
  codeHashes: {}, fixtures: [], experiments: [], passed: false,
  limitations: ['cold/warm refer to this run\'s application cache, never flushed OS/driver caches', 'RSS sums process working sets (shared pages can be double-counted); CPU is sampled lower bound; short-lived children may be missed', 'peaks are sampled lower bounds, not continuous maxima; CPU percent is normalized by logical CPUs; monitor overhead applies to every mode', 'publish/asset registration/accounting are not exercised here; production pipeline does not publish', 'baseline stage timings inferred from unchanged progress and actual tool spawn boundaries; optimized fused audio decode is charged to mix', 'frozen baseline may round a fractional endpoint down by at most one video frame; V4 requires exactly ceil(duration*30) decoded frames']
}
for (const file of ['src/main/video/pipeline.ts', 'src/main/video/ffmpeg.ts', 'src/main/video/encoders.ts', 'src/main/video/encoder-device.ts', 'tests/fixtures/video-pipeline-v31.ts']) report.codeHashes[file] = sha(await fs.readFile(file))
report.harnessHashes = {}
for (const file of ['scripts/video-performance.mjs', 'scripts/video-performance-monitor.ps1']) report.harnessHashes[file] = sha(await fs.readFile(file))
let saveQueue = Promise.resolve()
const save = () => { const json = JSON.stringify(report, null, 2); saveQueue = saveQueue.then(() => fs.writeFile(path.join(root, 'report.json'), json)); return saveQueue }
await save()

// Test-only instrumentation: no command strings are recorded; association is captured before spawn.
const context = new AsyncLocalStorage(), intervals = []
const heldPids = new Map(), measurementErrors = [], pidFile = path.join(root, 'active-pids.json')
const recordPids = () => { try { writeFileSync(pidFile, JSON.stringify([...heldPids.values()])) } catch { measurementErrors.push('held-PID telemetry write failed') } }
recordPids()
const originalSpawn = childProcess.spawn
childProcess.spawn = function (file, argv, options) {
  const owner = context.getStore(), startMs = performance.now()
  if (owner?.onToolStage && /ffmpeg(?:\.exe)?$/i.test(path.basename(file))) {
    const output = path.basename(argv.at(-1) ?? '')
    if (/^prepared-/.test(output)) owner.onToolStage('audio')
    else if (/^(body-|join-|fade-|master\.wav)/.test(output)) owner.onToolStage('mix')
    else if (output === 'video.partial.mp4') owner.onToolStage('encode')
    else if (argv.includes('-xerror')) owner.onToolStage('validate')
  }
  const child = originalSpawn.call(this, file, argv, options)
  if (owner && child.pid && /ff(?:mpeg|probe)(?:\.exe)?$/i.test(path.basename(file))) {
    heldPids.set(child.pid, { pid: child.pid }); recordPids()
    child.once('close', () => { heldPids.delete(child.pid); recordPids() })
  }
  if (owner && /ffmpeg(?:\.exe)?$/i.test(path.basename(file))) {
    const interval = { id: owner.id, phase: owner.phase, pid: child.pid, startMs, endMs: null }
    intervals.push(interval)
    child.once('close', () => { interval.endMs = performance.now() })
  }
  return child
}
function overlap(items) {
  const points = items.filter(i => i.endMs !== null).flatMap(i => [{ t: i.startMs, id: i.id, delta: 1 }, { t: i.endMs, id: i.id, delta: -1 }]).sort((a, b) => a.t - b.t || a.delta - b.delta)
  let previous = points[0]?.t ?? 0, overlapMs = 0, peakActiveTasks = 0
  const active = new Map()
  for (const point of points) {
    if (active.size >= 2) overlapMs += point.t - previous
    const value = (active.get(point.id) ?? 0) + point.delta
    if (value) active.set(point.id, value); else active.delete(point.id)
    peakActiveTasks = Math.max(peakActiveTasks, active.size); previous = point.t
  }
  return { overlapMs, peakActiveTasks }
}
async function bytes(directory) {
  let total = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await bytes(file)
    else total += (await fs.stat(file).catch(() => ({ size: 0 }))).size
  }
  return total
}
async function monitor() {
  const samples = [], errors = [], stopFile = path.join(root, `stop-${randomUUID()}`)
  let child, closed = Promise.resolve(), buffer = '', diskPeak = 0, diskSamples = 0, sampling = Promise.resolve()
  const sampleDisk = () => { sampling = sampling.then(async () => { diskPeak = Math.max(diskPeak, await bytes(workRoot) + await bytes(caches)); diskSamples++ }); return sampling }
  await sampleDisk()
  const timer = setInterval(sampleDisk, 750)
  if (process.platform === 'win32') {
    child = originalSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/video-performance-monitor.ps1'), '-RootPid', String(process.pid), '-StopFile', stopFile, '-PidFile', pidFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', text => { const lines = (buffer + text).split(/\r?\n/); buffer = lines.pop(); for (const line of lines) { if (!line) continue; try { const row = JSON.parse(line); if (row.error) errors.push(row.error); else samples.push(row) } catch { errors.push('invalid monitor row') } } })
    child.stderr.on('data', () => { errors.push('monitor stderr; counters may be incomplete') })
    closed = new Promise(resolve => { child.once('error', () => { errors.push('monitor spawn failed'); resolve() }); child.once('close', resolve) })
    // Establish a counter baseline before any render, rather than counting old parent CPU time.
    for (let i = 0; i < 60 && !samples.length && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 100))
  } else errors.push('process-tree CPU/RSS unavailable on this platform')
  return async () => {
    clearInterval(timer); await sampleDisk(); await sampling
    await fs.writeFile(stopFile, '')
    await closed; await fs.rm(stopFile, { force: true })
    const cpuPercent = samples.slice(1).map((row, index) => 100000 * (row.sampledCpuSeconds - samples[index].sampledCpuSeconds) / ((row.at - samples[index].at) * os.cpus().length)).filter(Number.isFinite)
    const countersValid = !errors.length && !measurementErrors.length && samples.length > 1 && samples.some(row => row.observedToolPids?.length)
    if (!countersValid && !errors.length) errors.push('insufficient held-process samples; CPU/RSS are unavailable')
    return { method: 'Windows Get-Process held Node/FFmpeg/FFprobe PIDs / 750ms + query time; disk lstat 750ms', samples: samples.length, diskSamples,
      observedToolPids: [...new Set(samples.flatMap(row => row.observedToolPids ?? []))],
      sampledTempDiskPeakBytes: diskPeak, sampledProcessTreeRssPeakBytes: countersValid ? Math.max(...samples.map(s => s.processTreeRssBytes)) : null,
      sampledProcessTreeCpuSeconds: countersValid ? samples.at(-1).sampledCpuSeconds : null,
      sampledProcessTreeCpuPercentPeak: countersValid && cpuPercent.length ? Math.max(...cpuPercent) : null,
      minimumFreeMemoryBytes: samples.length ? Math.min(...samples.map(s => s.freeMemoryBytes)) : null, errors: [...errors, ...measurementErrors] }
  }
}
async function frame(file, time, output) {
  await engine.runTool(tools.ffmpeg, [...base, ...(time === null ? [] : ['-ss', String(time)]), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', `${time === null ? engine.staticFilter('contain') + ',' : ''}scale=192:108`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', output], { signal })
  return fs.readFile(output)
}
function difference(a, b) { assert.equal(a.length, b.length); return a.reduce((total, value, i) => total + Math.abs(value - b[i]), 0) / a.length }
function amplitude(data, hz) {
  let re = 0, im = 0
  for (let i = 0; i < data.length / 4; i++) { const phase = 2 * Math.PI * hz * i / 48000, value = data.readFloatLE(i * 4); re += value * Math.cos(phase); im += value * Math.sin(phase) }
  return Math.hypot(re, im) * 2 / (data.length / 4)
}
const pcmHashes = new Map()
async function validate(result, fixture, taskDirectory, mode) {
  const info = await engine.probeMedia(tools, result.filePath, signal, true)
  const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio')
  assert.equal(info.streams.length, 2); assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1920); assert.equal(video.height, 1080)
  assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.r_frame_rate, '30/1')
  // The frozen -t/-shortest baseline rounds fractional video frames down; V4 covers the last audio sample.
  if (mode === 'baseline') assert.ok(Math.abs(Number(video.nb_read_frames) - expected * 30) <= 1)
  else assert.equal(Number(video.nb_read_frames), Math.ceil(expected * 30))
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2)
  assert.ok(Math.abs(info.durationSeconds - expected) <= 0.1)
  const staticDifferences = [], sourceDifferences = []
  let first
  for (const [index, time] of [0, expected / 2, Math.max(0, (Number(video.nb_read_frames) - 1) / 30 - 0.000001)].entries()) {
    const values = await frame(result.filePath, time, path.join(taskDirectory, `frame-${index}.rgb`))
    first ??= values
    staticDifferences.push(difference(first, values)); sourceDifferences.push(difference(fixture.reference, values))
  }
  assert.ok(staticDifferences.every(value => value < 1.5), 'first/middle/last frames differ')
  assert.ok(sourceDifferences.every(value => value < 6), 'decoded frames differ from the input picture')
  const order = []
  for (let i = 0; i < 2; i++) {
    const output = path.join(taskDirectory, `tone-${i}.f32`), time = i === 0 ? seconds / 2 : seconds - transition + seconds / 2
    await engine.runTool(tools.ffmpeg, [...base, '-ss', String(time), '-i', result.filePath, '-t', '0.25', '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', output], { signal })
    const data = await fs.readFile(output), own = amplitude(data, fixture.frequencies[i]), other = amplitude(data, fixture.frequencies[1 - i])
    assert.ok(own > other * 10 && own > 0.01, 'whole-song order/tone mismatch'); order.push({ time, frequency: fixture.frequencies[i], own, other })
  }
  const pcm = await engine.runTool(tools.ffmpeg, [...base, '-i', path.join(taskDirectory, 'master.wav'), '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'hash', '-hash', 'sha256', '-'], { signal })
  const pcmHash = /SHA256=([0-9a-f]{64})/i.exec(pcm.stdout)?.[1]
  assert.ok(pcmHash)
  if (mode === 'baseline') pcmHashes.set(fixture.index, pcmHash)
  const equalBaseline = pcmHashes.has(fixture.index) ? pcmHashes.get(fixture.index) === pcmHash : null
  assert.notEqual(equalBaseline, false, 'full master PCM differs from the frozen baseline')
  return { fullDecode: true, decodedFrames: Number(video.nb_read_frames), durationSeconds: info.durationSeconds, staticDifferences, sourceDifferences, order, pcmHash, equalBaseline, bytes: (await fs.stat(result.filePath)).size }
}

try {
  // Fixed synthetic six-song corpus; no music loop/tempo stretch/silence or input trimming.
  for (let group = 0; group < 3; group++) {
    const imagePath = path.join(sourceRoot, `image-${group}.png`)
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${['#cc3366', '#3366cc', '#33aa66'][group]}"/><circle cx="180" cy="190" r="90" fill="#eeee99"/><path d="M300 70L570 400H340Z" fill="#333344"/></svg>`)).png().toFile(imagePath)
    const tracks = [], frequencies = [220 + group * 220, 330 + group * 220]
    for (let index = 0; index < 2; index++) {
      const file = path.join(sourceRoot, `song-${group}-${index}.flac`)
      await engine.runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${frequencies[index]}:sample_rate=48000:duration=${seconds}`, '-ac', '2', '-c:a', 'flac', file], { signal })
      tracks.push({ id: `00000000-0000-4000-8000-${String(group * 2 + index + 1).padStart(12, '0')}`, path: file, durationSeconds: (await engine.probeMedia(tools, file, signal)).durationSeconds, sha256: await engine.hashMedia(file, signal) })
    }
    const referenceFile = path.join(sourceRoot, `reference-${group}.rgb`)
    const reference = await frame(imagePath, null, referenceFile)
    const fixture = { index: group, imagePath, imageId: `10000000-0000-4000-8000-${String(group + 1).padStart(12, '0')}`, imageHash: await engine.hashMedia(imagePath, signal), tracks, frequencies }
    report.fixtures.push(fixture)
    Object.defineProperty(fixture, 'reference', { value: reference, enumerable: false })
  }
  if (args.reference) {
    const relative = path.relative(parent, args.reference)
    assert.ok(path.isAbsolute(args.reference) && relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Reference must be a prior benchmark report under scratch')
    assert.equal(path.relative(await fs.realpath(args.reference), args.reference), '')
    assert.ok((await fs.stat(args.reference)).size < 8 * 1024 * 1024, 'Reference report is too large')
    const data = await fs.readFile(args.reference), reference = JSON.parse(data)
    assert.equal(reference.version, 1); assert.equal(reference.parameterHash, report.parameterHash); assert.equal(reference.toolIdentity, identity)
    for (const [file, hash] of Object.entries(report.codeHashes)) assert.equal(reference.codeHashes[file], hash, `Reference code changed: ${file}`)
    for (const fixture of report.fixtures) {
      const original = reference.fixtures.find(item => item.index === fixture.index)
      assert.equal(original.imageHash, fixture.imageHash)
      assert.deepEqual(original.tracks.map(t => t.sha256), fixture.tracks.map(t => t.sha256), 'Corpus bytes differ from reference')
    }
    for (const experiment of reference.experiments.filter(e => e.mode === 'baseline')) for (const job of experiment.jobs) {
      if (!job.error && job.verification?.fullDecode && /^[0-9a-f]{64}$/.test(job.verification.pcmHash)) pcmHashes.set(job.index, job.verification.pcmHash)
    }
    assert.equal(pcmHashes.size, 3, 'Reference needs three individually verified baseline jobs')
    report.reference = { path: args.reference, sha256: sha(data), createdAt: reference.createdAt, overallPassed: reference.passed, corpusByteIdentical: true }
  }
  report.encoderStatuses = []
  for (const encoder of ['nvenc', 'qsv', 'cpu']) report.encoderStatuses.push(await engine.probeEncoder(tools, encoder, workRoot, signal, threads, identity))
  await save()
  const suites = (args.suite ?? 'both') === 'both' ? ['single', 'batch'] : [args.suite]
  const modes = (args.mode ?? 'all') === 'all' ? ['baseline', 'one', 'concurrency2'] : args.mode === 'optimized' ? ['one', 'concurrency2'] : [args.mode]
  const cacheStates = (args.cache ?? 'both') === 'both' ? ['cold', 'warm'] : [args.cache]
  for (const suite of suites) for (const mode of modes) {
    const cacheDirectory = path.join(caches, `${suite}-${mode}`); await fs.mkdir(cacheDirectory)
    const fixtures = suite === 'single' ? report.fixtures.slice(0, 1) : report.fixtures
    for (const state of cacheStates) {
      const experiment = { suite, mode, cache: state, jobs: [], startedAt: new Date().toISOString(), concurrency: mode === 'concurrency2' ? 2 : 1, warmupMs: 0 }
      if (state === 'cold') engine.clearEncoderProbeCache()
      report.experiments.push(experiment)
      if (state === 'warm' && mode !== 'baseline') {
        const started = performance.now()
        const selection = await engine.selectEncoder(tools, args.encoder ?? 'auto', workRoot, signal, threads, identity)
        for (const fixture of fixtures) await engine.staticSegment({ tools, image: fixture.imagePath, imageHash: fixture.imageHash, fit: 'contain', encoder: selection.encoder, threads, identity, cacheDirectory, taskDirectory: workRoot, signal })
        experiment.warmupMs = performance.now() - started
      }
      const stopMonitor = await monitor(), batchStart = performance.now()
      let cursor = 0, failed
      const worker = async () => {
        while (cursor < fixtures.length && !failed) {
          const fixture = fixtures[cursor++], id = `${suite}-${mode}-${state}-${fixture.index}`
          const taskDirectory = await fs.mkdtemp(path.join(workRoot, 'task-'))
          const job = { id, index: fixture.index, startedAt: new Date().toISOString(), startMs: performance.now(), stages: [] }
          experiment.jobs.push(job)
          let stage = 'tools', since = job.startMs
          const enter = next => { if (next === stage) return; job.stages.push({ stage, elapsedMs: performance.now() - since }); stage = next; since = performance.now() }
          try {
            const request = { tools, tracks: fixture.tracks, imagePath: fixture.imagePath, taskDirectory, kind: 'video', signal,
              minimumSeconds: args.quick ? undefined : 3600,
              draft: { ...parameters, imageId: fixture.imageId, audioIds: fixture.tracks.map(t => t.id) },
              performance: { threads, encoder: args.encoder ?? 'auto', staticVideo: true, cacheDirectory },
              onProgress: event => { if (mode === 'baseline') enter({ analyzing: 'probe', processing: 'audio', mixing: 'mix', encoding: 'encode', validating: 'validate' }[event.status] ?? stage) },
              onStage: next => { if (mode !== 'baseline') enter(next) } }
            const result = await context.run({ id, phase: 'pipeline', onToolStage: mode === 'baseline' ? enter : undefined }, () => (mode === 'baseline' ? engine.baseline : engine.renderMedia)(request))
            job.endMs = performance.now(); job.elapsedMs = job.endMs - job.startMs; enter('done')
            job.metrics = result.metrics ?? { encoder: 'cpu/libx264', staticVideo: false, elapsedMs: job.elapsedMs, stages: job.stages }
            job.stages = job.metrics.stages
            const verificationStarted = performance.now()
            job.verification = await context.run({ id, phase: 'benchmark-validation' }, () => validate(result, fixture, taskDirectory, mode))
            job.verificationMs = performance.now() - verificationStarted
            console.log(`${id}: ${(job.elapsedMs / 1000).toFixed(2)}s + ${(job.verificationMs / 1000).toFixed(2)}s external verification, ${job.metrics.encoder}, cacheHit=${job.metrics.cacheHit ?? 'n/a'}`)
          } catch (error) {
            job.error = error.diagnostic ?? { message: String(error.message ?? error).slice(0, 1000) }; failed = error
          } finally {
            await fs.rm(taskDirectory, { recursive: true, force: true }) // only the directory this worker created
            await save()
          }
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(experiment.concurrency, fixtures.length) }, worker)) }
      finally { experiment.batchWallMs = performance.now() - batchStart; experiment.resources = await stopMonitor() }
      experiment.renderBatchWallMs = Math.max(...experiment.jobs.map(j => j.endMs ?? j.startMs)) - Math.min(...experiment.jobs.map(j => j.startMs))
      experiment.toolIntervals = intervals.filter(i => experiment.jobs.some(j => j.id === i.id))
      experiment.realPipelineOverlap = overlap(experiment.toolIntervals.filter(i => i.phase === 'pipeline'))
      experiment.taskOverlap = overlap(experiment.jobs.map(j => ({ id: j.id, startMs: j.startMs, endMs: j.endMs ?? null })))
      experiment.outputsPassed = !failed && experiment.jobs.length === fixtures.length
      experiment.resources.longToolsNotObserved = experiment.toolIntervals.filter(i => i.endMs - i.startMs >= 2000 && !experiment.resources.observedToolPids.includes(i.pid)).map(i => i.pid)
      experiment.measurementComplete = !experiment.resources.errors.length && !experiment.resources.longToolsNotObserved.length
      experiment.passed = experiment.outputsPassed && experiment.measurementComplete
      await save()
      if (failed) throw failed
      if (suite === 'batch' && mode === 'concurrency2') assert.ok(experiment.realPipelineOverlap.overlapMs > 0, 'No real simultaneous FFmpeg tasks observed')
    }
  }
  report.outputsPassed = report.experiments.every(e => e.outputsPassed)
  report.measurementComplete = report.experiments.every(e => e.measurementComplete)
  report.passed = report.outputsPassed && report.measurementComplete
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.error = error.diagnostic ?? { message: String(error.message ?? error).slice(0, 1000) }
  process.exitCode = 1
} finally {
  childProcess.spawn = originalSpawn
  report.finishedAt = new Date().toISOString()
  await save()
  await fs.rm(pidFile, { force: true })
  if (!args.keep) for (const directory of [sourceRoot, caches, workRoot]) await fs.rm(directory, { recursive: true, force: true })
  await fs.rm(bundle, { force: true })
  console.log(`REPORT=${path.join(root, 'report.json')} passed=${report.passed}`)
}
