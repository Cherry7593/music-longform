// Full execution benchmark, independent from pipeline-only diagnostics. Never reads a user profile.
const help = `V4 composition end-to-end comparison (new isolated artificial media only).
Usage: node scripts/composition-performance.mjs [--quick] [--encoder=auto|cpu|qsv|nvenc]
  --mode=all|baseline|serial|parallel   Default all (global pool 1 / 2 for optimized)
  --suite=both|single|batch            Default both: one / three outputs
  --cache=both|cold                    Default both; application caches, never OS caches
  --quick                             Two 34s songs per output (65s, NOT hour evidence)
  --keep                              Keep this run's inputs/metadata (videos are checked then removed)
  --help                              Exit without files/tool access
Default: six 1805s FLACs + three pictures, 3607s/output. One entry point uses the frozen
V3.1 serial manager/pipeline; another uses production V4 DB/assets/pool/queue/publications.
Import/setup excluded and reported separately. Timed: plan -> confirm -> queue -> complete
publication/asset registration/usage. Extra output/order/frame verification is outside that
wall interval. No source is trimmed, looped or padded. Allow substantial time and disk.`
if (process.argv.includes('--help')) { console.log(help); process.exit(0) }
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  if (!/^--[a-z]+(?:=.*)?$/.test(value)) throw new Error(`Invalid option ${value}`)
  const [key, ...rest] = value.slice(2).split('='); return [key, rest.length ? rest.join('=') : true]
}))
for (const key of Object.keys(options)) if (!['quick', 'encoder', 'mode', 'suite', 'cache', 'keep'].includes(key)) throw new Error(`Unknown --${key}`)
for (const [key, allowed] of Object.entries({ encoder: ['auto', 'cpu', 'qsv', 'nvenc'], mode: ['all', 'baseline', 'serial', 'parallel'], suite: ['both', 'single', 'batch'], cache: ['both', 'cold'] })) if (options[key] !== undefined && !allowed.includes(options[key])) throw new Error(`Invalid --${key}`)
const { build } = await import('esbuild')
const fs = await import('node:fs/promises')
const { createHash, randomUUID } = await import('node:crypto')
const { default: path } = await import('node:path')
const { default: os } = await import('node:os')
const { createRequire } = await import('node:module')
const { AsyncLocalStorage } = await import('node:async_hooks')
const { default: assert } = await import('node:assert/strict')
const { default: sharp } = await import('sharp')
const require = createRequire(import.meta.url), childProcess = require('node:child_process')
const scratch = process.env.PI_SCRATCH_DIR ?? os.tmpdir()
assert.ok(path.isAbsolute(scratch)); assert.equal(path.relative(await fs.realpath(scratch), path.resolve(scratch)), '')
const root = await fs.mkdtemp(path.join(scratch, 'composition-performance-v4-')), source = path.join(root, 'sources')
await fs.mkdir(source); console.log(`COMPOSITION_PERFORMANCE_DIR=${root}`)
const sharpEntry = require.resolve('sharp'), bundle = path.join(root, 'engine.cjs')
await build({ stdin: { resolveDir: path.resolve('.'), contents: `
export * from './src/main/video/ffmpeg';
export {renderMedia} from './src/main/video/pipeline';
export {renderMedia as baselineRender} from './tests/fixtures/video-pipeline-v31';
export {probeEncoder, clearEncoderProbeCache} from './src/main/video/encoders';
export {WorkbenchDB} from './src/main/storage/workbench-db';
export {CompositionProjects} from './src/main/storage/workbench-projects';
export {AssetStore} from './src/main/storage/assets-v2';
export {DiagnosticStore} from './src/main/storage/diagnostics';
export {PublicationStore} from './src/main/storage/publications-v2';
export {ResourcePool} from './src/main/video/resource-pool';
export {CompositionQueue} from './src/main/video/composition-queue';
export {initialComposition} from './src/shared/workbench-schemas';
export {LibraryStore} from './tests/fixtures/v31/main/storage/library';
export {VideoBatchStore} from './tests/fixtures/v31/main/storage/video-batches';
export {ExportReceiptStore} from './tests/fixtures/v31/main/storage/export-receipts';
export {BatchJobManager} from './tests/fixtures/v31/main/video/batch-jobs';
export {RenderScheduler} from './tests/fixtures/v31/main/video/scheduler';
export {decorateLibrary} from './tests/fixtures/v31/main/library/usage';
` }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
const engine = require(bundle), tools = await engine.requireTools(process.env.FFMPEG_PATH)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const base = ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-threads', '2', '-filter_threads', '2']
const seconds = options.quick ? 34 : 1805, duration = seconds * 2 - 3, abort = new AbortController()
let currentQueue
process.once('SIGINT', () => { abort.abort(); void currentQueue?.shutdown() })
process.once('SIGTERM', () => { abort.abort(); void currentQueue?.shutdown() })
const report = { version: 1, createdAt: new Date().toISOString(), root, quick: !!options.quick, passed: false,
  machine: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, tools,
  parameters: { ...engine.initialComposition(), minimumSeconds: options.quick ? 60 : 3600 }, encoder: options.encoder ?? 'auto', threads: 2,
  baseline: { preset: 'ultrafast', tune: 'stillimage', threads: 4, pipeline: 'tests/fixtures/video-pipeline-v31.ts' }, codeHashes: {}, sources: [], experiments: [],
  boundaries: ['Import and setup excluded, planning through publication and usage included.', 'Baseline V3.1 has no video asset registration; V4 includes actual full video registration/decode.', 'Cold/warm mean application validation/static caches; OS/driver caches are not reset.', 'Additional independent output verification follows the timed end-to-end interval.', 'RSS/temp-disk peaks are sampled lower bounds; shared working-set pages may be double-counted; short-lived processes may be missed.', 'Per-job latency includes waiting from confirmation; running time begins at actual analyzing state. No GUI paint latency is included.'] }
for (const file of ['src/main/video/composition-queue.ts', 'src/main/video/resource-pool.ts', 'src/main/video/pipeline.ts', 'src/main/video/encoders.ts', 'src/main/video/encoder-device.ts', 'src/main/library/assets-v4-media.ts', 'src/main/storage/assets-v2.ts', 'tests/fixtures/video-pipeline-v31.ts', 'tests/fixtures/v31/main/video/batch-jobs.ts']) report.codeHashes[file] = hash(await fs.readFile(file))
report.harnessHashes = {}
for (const file of ['scripts/composition-performance.mjs', 'scripts/video-performance-monitor.ps1']) report.harnessHashes[file] = hash(await fs.readFile(file))
const save = async () => fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
await save()
const als = new AsyncLocalStorage(), originalSpawn = childProcess.spawn, intervals = []
const pidFile = path.join(root, 'active-media-pids.json'), activePids = new Set()
let pidWrites = Promise.resolve()
const savePids = () => { const json = JSON.stringify([...activePids].map(pid => ({ pid }))); pidWrites = pidWrites.then(() => fs.writeFile(pidFile, json)); void pidWrites.catch(() => undefined) }
await fs.writeFile(pidFile, '[]')
childProcess.spawn = function (file, argv, settings) {
  const owner = als.getStore(), started = performance.now(), process = originalSpawn.call(this, file, argv, settings)
  if (/^(ffmpeg|ffprobe)(\.exe)?$/i.test(path.basename(file)) && process.pid) {
    activePids.add(process.pid); savePids()
    process.once('close', () => { activePids.delete(process.pid); savePids() })
  }
  if (owner && /^(ffmpeg|ffprobe)(\.exe)?$/i.test(path.basename(file))) {
    const row = { jobId: owner.id, process: path.basename(file), started, finished: null }; intervals.push(row)
    if (owner.enter && /ffmpeg/i.test(file)) {
      const out = path.basename(argv.at(-1) ?? '')
      if (/^prepared-/.test(out)) owner.enter('audio')
      else if (/^(body-|join-|fade-|master\.wav)/.test(out)) owner.enter('mix')
      else if (out === 'video.partial.mp4') owner.enter('encode')
      else if (argv.includes('-xerror')) owner.enter('validate')
    }
    process.once('close', () => { row.finished = performance.now() })
  }
  return process
}
function overlap(rows) {
  const points = rows.filter(row => row.finished != null).flatMap(row => [{ at: row.started, id: row.jobId, delta: 1 }, { at: row.finished, id: row.jobId, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta)
  const active = new Map(); let previous = points[0]?.at ?? 0, overlapMs = 0, peak = 0
  for (const point of points) { if (active.size > 1) overlapMs += point.at - previous; const n = (active.get(point.id) ?? 0) + point.delta; if (n) active.set(point.id, n); else active.delete(point.id); peak = Math.max(peak, active.size); previous = point.at }
  return { overlapMs, peak }
}
async function tempBytes(directory, included = false) {
  let size = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(directory, entry.name), use = included || entry.name.startsWith('.work-') || entry.name === '.render-cache'
    if (entry.isDirectory()) size += await tempBytes(file, use)
    else if (use) size += (await fs.stat(file).catch(() => ({ size: 0 }))).size
  }
  return size
}
async function monitor(directory) {
  const rows = [], errors = [], stopFile = path.join(root, `stop-${randomUUID()}`)
  let bytesPeak = 0, diskSamples = 0, work = Promise.resolve(), buffer = ''
  const sample = () => { work = work.then(async () => { bytesPeak = Math.max(bytesPeak, await tempBytes(directory)); diskSamples++ }); return work }
  await sample(); const timer = setInterval(sample, 750)
  const process = originalSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/video-performance-monitor.ps1'), '-RootPid', String(globalThis.process.pid), '-StopFile', stopFile, '-PidFile', pidFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.setEncoding('utf8'); process.stdout.on('data', chunk => { const lines = (buffer + chunk).split(/\r?\n/); buffer = lines.pop(); for (const line of lines.filter(Boolean)) { try { const value = JSON.parse(line); if (value.error) errors.push(value.error); else rows.push(value) } catch { errors.push('counter parse failure') } } })
  process.stderr.on('data', () => errors.push('counter stderr'))
  const closed = new Promise(resolve => { process.once('close', resolve); process.once('error', () => { errors.push('counter spawn failure'); resolve() }) })
  for (let i = 0; i < 60 && !rows.length && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 100))
  return async () => {
    clearInterval(timer); await sample(); await pidWrites; await fs.writeFile(stopFile, ''); await closed; await fs.rm(stopFile, { force: true })
    return { method: '750ms+query Get-Process on held Node/FFmpeg/FFprobe PIDs; 750ms owned .work/static-cache scan', samples: rows.length, diskSamples, sampledTempDiskPeakBytes: bytesPeak,
      observedToolPidCount: new Set(rows.flatMap(row => row.observedToolPids ?? [])).size,
      sampledProcessTreeRssPeakBytes: rows.length ? Math.max(...rows.map(row => row.processTreeRssBytes)) : null, minimumFreeMemoryBytes: rows.length ? Math.min(...rows.map(row => row.freeMemoryBytes)) : null,
      sampledCpuSeconds: rows.at(-1)?.sampledCpuSeconds ?? null, errors }
  }
}
function renderWrapper(mode, jobs) {
  return async request => {
    const id = path.basename(request.taskDirectory).replace(/^\.work-/, ''), data = { id, pipelineStart: performance.now(), stages: [] }
    jobs.set(id, data); let stage = 'tools', since = performance.now()
    const enter = next => { const elapsedMs = performance.now() - since; const item = data.stages.find(item => item.stage === stage); if (item) item.elapsedMs += elapsedMs; else data.stages.push({ stage, elapsedMs }); since = performance.now(); stage = next }
    const output = await als.run({ id, enter: mode === 'baseline' ? enter : undefined }, () => (mode === 'baseline' ? engine.baselineRender : engine.renderMedia)({ ...request,
      onStage: next => { enter(next); request.onStage?.(next) },
      onProgress: event => { if (mode === 'baseline') { const next = { analyzing: 'probe', processing: 'audio', mixing: 'mix', encoding: 'encode', validating: 'validate' }[event.status]; if (next && next !== stage) enter(next) }; request.onProgress?.(event) } }))
    enter('done'); data.pipelineEnd = performance.now(); data.pipelineMs = data.pipelineEnd - data.pipelineStart
    data.metrics = output.metrics ?? { encoder: 'cpu/libx264', staticVideo: false, stages: data.stages }
    return output
  }
}
async function setup(mode, count) {
  const directory = await fs.mkdtemp(path.join(root, `${mode}-${count}-`)), dataDir = path.join(directory, 'data'), mediaRoot = path.join(directory, 'media')
  const started = performance.now(), events = new Map(), rendered = new Map(), errors = []
  let assets, manager, project, db, batches, receipts, publications
  const paths = report.sources.slice(0, count), songs = paths.flatMap(group => group.tracks.map(track => track.path)), images = paths.map(group => group.imagePath)
  const observe = batch => { for (const job of batch.jobs) { const event = events.get(job.id) ?? {}; if (!event.started && ['analyzing', 'processing', 'mixing', 'encoding', 'validating', 'publishing'].includes(job.status)) event.started = performance.now(); if (!event.finished && job.status === 'succeeded') event.finished = performance.now(); events.set(job.id, event) } }
  const emptyProjects = { async all() { return [] }, async get() { throw new Error('No legacy projects in synthetic benchmark') }, async pathForAsset() { throw new Error('No legacy project media') } }
  if (mode === 'baseline') {
    assets = new engine.LibraryStore({ dataDir, defaultRoot: mediaRoot, projects: emptyProjects, getFFmpegPath: () => tools.ffmpeg }); await assets.init()
  } else { assets = new engine.AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => tools.ffmpeg }); await assets.init() }
  const ar = await assets.importFiles(songs, 'audio'), ir = await assets.importFiles(images, 'image')
  assert.ok([...ar.entries, ...ir.entries].every(entry => entry.status === 'imported'))
  const audioIds = ar.entries.map(entry => entry.assetId), imageIds = ir.entries.map(entry => entry.assetId), groups = imageIds.map((imageId, i) => ({ imageId, audioIds: audioIds.slice(i * 2, i * 2 + 2) }))
  // Cold is explicit: discard only validation evidence in THIS generated fixture; never user data.
  if (mode !== 'baseline') for (const id of [...audioIds, ...imageIds]) {
    const file = path.join(dataDir, 'assets-v2', 'items', `${id}.json`), record = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(record.version, 2); assert.equal(record.asset.id, id)
    for (const location of record.locations) delete location.evidence
    await fs.writeFile(file, JSON.stringify(record))
  }
  // Reopen after removing persisted evidence, also resetting the tool/validation in-memory caches.
  if (mode === 'baseline') {
    assets = new engine.LibraryStore({ dataDir, defaultRoot: mediaRoot, projects: emptyProjects, getFFmpegPath: () => tools.ffmpeg }); await assets.init()
    batches = new engine.VideoBatchStore(dataDir, () => mediaRoot); await batches.init(); receipts = new engine.ExportReceiptStore(dataDir); await receipts.init()
    const mutate = batches.mutate.bind(batches); batches.mutate = async (...args) => { const batch = await mutate(...args); observe(batch); return batch }
    const prepare = receipts.prepare.bind(receipts); receipts.prepare = async record => { const event = events.get(record.id); if (event) event.publishStarted = performance.now(); return prepare(record) }
    const timedTools = async custom => { const at = performance.now(), tools = await engine.requireTools(custom); const event = [...events.values()].find(event => event.started && !event.finished); if (event) event.toolMs = (event.toolMs ?? 0) + performance.now() - at; return tools }
    manager = new engine.BatchJobManager({ library: assets, batches, receipts, scheduler: new engine.RenderScheduler(), getFFmpegPath: () => tools.ffmpeg, tools: timedTools, render: renderWrapper(mode, rendered), onError: error => errors.push(error) })
  } else {
    assets = new engine.AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => tools.ffmpeg }); await assets.init()
    db = new engine.WorkbenchDB(dataDir); await db.init()
    await db.put('settings', 'current', { version: 5, mediaRoot, ffmpegPath: tools.ffmpeg, page: 'composition', render: { concurrency: mode === 'parallel' ? 2 : 1, threads: 2, encoder: options.encoder ?? 'auto', staticVideo: true } })
    const projects = new engine.CompositionProjects(db); project = await projects.create()
    project = await projects.update(project.id, project.revision, { draft: { ...report.parameters, audioIds, imageIds, groups } })
    const update = db.update.bind(db); db.update = async (...args) => { const value = await update(...args); if (args[0] === 'executions') observe(value); return value }
    const diagnostics = new engine.DiagnosticStore(dataDir); await diagnostics.init(); publications = new engine.PublicationStore(dataDir, assets); await publications.init()
    const pool = new engine.ResourcePool(() => db.get('settings', 'current').render)
    manager = new engine.CompositionQueue({ db, assets, diagnostics, publications, pool, render: renderWrapper(mode, rendered), onError: error => errors.push(error) })
  }
  return { directory, dataDir, mediaRoot, assets, manager, project, db, batches, receipts, publications, audioIds, imageIds, groups, events, rendered, errors, setupMs: performance.now() - started }
}
function amplitude(data, hz) { let re = 0, im = 0; for (let i = 0; i < data.length / 4; i++) { const v = data.readFloatLE(i * 4), angle = 2 * Math.PI * hz * i / 48000; re += v * Math.cos(angle); im += v * Math.sin(angle) }; return 2 * Math.hypot(re, im) / (data.length / 4) }
async function verifyOutput(file, group, work) {
  const info = await engine.probeMedia(tools, file, abort.signal), video = info.streams.find(stream => stream.codec_type === 'video'), audio = info.streams.find(stream => stream.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.r_frame_rate, '30/1'); assert.equal(audio.codec_name, 'aac'); assert.ok(Math.abs(info.durationSeconds - duration) < 0.1)
  const order = []
  for (let index = 0; index < 2; index++) {
    const output = path.join(work, `${randomUUID()}.f32`), at = (index ? seconds - 3 : 0) + seconds / 2
    await engine.runTool(tools.ffmpeg, [...base, '-ss', String(at), '-i', file, '-t', '0.25', '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', output], { signal: abort.signal })
    const pcm = await fs.readFile(output), own = amplitude(pcm, group.frequencies[index]), other = amplitude(pcm, group.frequencies[1 - index]); await fs.rm(output)
    assert.ok(own > other * 10 && own > 0.01); order.push({ at, frequency: group.frequencies[index], own, other })
  }
  const frames = []
  for (const at of [0, duration / 2, duration - 1 / 30]) {
    const output = path.join(work, `${randomUUID()}.rgb`)
    await engine.runTool(tools.ffmpeg, [...base, '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=192:108', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output], { signal: abort.signal })
    frames.push(await fs.readFile(output)); await fs.rm(output)
  }
  const differences = frames.map(frame => frame.reduce((sum, value, i) => sum + Math.abs(value - frames[0][i]), 0) / frame.length)
  assert.ok(differences.every(value => value < 1.5))
  return { durationSeconds: info.durationSeconds, order, frameDifferences: differences, bytes: (await fs.stat(file)).size, sha256: hash(await fs.readFile(file)), productionFullDecode: true }
}
try {
  for (let index = 0; index < 3; index++) {
    const imagePath = path.join(source, `image-${index}.png`), frequencies = [220 + 220 * index, 330 + 220 * index], tracks = []
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${['#cc3366', '#3366cc', '#33aa66'][index]}"/><circle cx="180" cy="190" r="90" fill="#eeee99"/><path d="M300 70L570 400H340Z" fill="#333344"/></svg>`)).png().toFile(imagePath)
    for (let i = 0; i < 2; i++) {
      const file = path.join(source, `song-${index}-${i}.flac`)
      await engine.runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${frequencies[i]}:sample_rate=48000:duration=${seconds}`, '-ac', '2', '-c:a', 'flac', file], { signal: abort.signal })
      tracks.push({ path: file, durationSeconds: seconds, sha256: hash(await fs.readFile(file)) })
    }
    report.sources.push({ index, imagePath, imageSha256: hash(await fs.readFile(imagePath)), tracks, frequencies }); await save()
  }
  const modes = options.mode && options.mode !== 'all' ? [options.mode] : ['baseline', 'serial', 'parallel']
  const suites = options.suite && options.suite !== 'both' ? [options.suite] : ['single', 'batch']
  const states = options.cache && options.cache !== 'both' ? [options.cache] : ['cold', 'warm']
  for (const suite of suites) for (const mode of modes) {
    if (suite === 'single' && mode === 'parallel') continue // A single task cannot exercise parallelism.
    const count = suite === 'single' ? 1 : 3, ctx = await setup(mode, count); currentQueue = ctx.manager
    let iteration = 0
    for (const cache of states) {
      if (abort.signal.aborted) throw new Error('Benchmark cancelled')
      const experiment = { suite, mode, cache, setupMs: ctx.setupMs, startedAt: new Date().toISOString(), jobs: [] }; report.experiments.push(experiment)
      if (cache === 'warm' && iteration === 0) throw new Error('Warm-only needs a preceding same-context run; use --cache=both')
      if (cache === 'cold') engine.clearEncoderProbeCache()
      const stop = await monitor(ctx.directory), fromInterval = intervals.length, begin = performance.now()
      let batch, final, submitted, complete
      try {
        let plan
        if (mode === 'baseline') { plan = await ctx.manager.plan({ ...report.parameters, name: 'isolated full-process benchmark', audioIds: ctx.audioIds, imageIds: ctx.imageIds }); plan = await ctx.manager.revise(plan.id, ctx.groups) }
        else plan = await ctx.manager.plan(ctx.project.id, ctx.project.revision)
        assert.deepEqual(plan.issues, []); assert.deepEqual(plan.groups.map(group => group.audioIds), ctx.groups.map(group => group.audioIds))
        experiment.planMs = performance.now() - begin; submitted = performance.now()
        batch = mode === 'baseline' ? await ctx.manager.start(plan.id) : await ctx.manager.start(ctx.project.id, plan.id)
        experiment.confirmationMs = performance.now() - submitted
        await ctx.manager.idle()
        final = mode === 'baseline' ? await ctx.batches.get(batch.id) : ctx.db.get('executions', batch.id)
        assert.equal(final.state, 'completed', JSON.stringify(final.jobs.map(job => ({ status: job.status, error: job.error, detail: job.detail }))))
        assert.deepEqual(ctx.errors, [])
        // Both versions' own usage accounting is part of the measured interval.
        if (mode === 'baseline') {
          const snapshot = await engine.decorateLibrary(await ctx.assets.all(), [], await ctx.batches.all(), await ctx.receipts.all())
          assert.ok(snapshot.every(asset => asset.usages.length === iteration + 1)); experiment.usageCount = snapshot.reduce((n, a) => n + a.usages.length, 0)
        } else {
          const usage = await ctx.assets.allUsage(); assert.equal(usage.length, count * (iteration + 1)); experiment.usageCount = usage.reduce((n, use) => n + use.assetIds.length, 0)
          for (const job of final.jobs) assert.equal(ctx.publications.get(job.id).state, 'committed')
        }
        complete = performance.now(); experiment.endToEndMs = complete - begin; experiment.submissionToCompleteMs = complete - submitted
      } finally { experiment.resources = await stop() }
      for (const job of final.jobs) {
        const event = ctx.events.get(job.id), pipeline = ctx.rendered.get(job.id)
        if (mode === 'baseline') {
          const add = (stage, elapsedMs) => { const previous = pipeline.stages.find(value => value.stage === stage); if (previous) previous.elapsedMs += Math.max(0, elapsedMs); else pipeline.stages.push({ stage, elapsedMs: Math.max(0, elapsedMs) }) }
          add('tools', event.toolMs ?? 0)
          add('probe', pipeline.pipelineStart - event.started - (event.toolMs ?? 0))
          add('validate', event.publishStarted - pipeline.pipelineEnd)
          add('publish', event.finished - event.publishStarted)
        }
        const row = { id: job.id, index: job.index, queueMs: event.started - submitted, runningMs: event.finished - event.started, latencyFromConfirmationMs: event.finished - submitted, pipelineMs: pipeline.pipelineMs,
          stages: job.attempts?.at(-1)?.stages ?? pipeline.stages, encoder: pipeline.metrics.encoder, staticVideo: pipeline.metrics.staticVideo, cacheHit: pipeline.metrics.cacheHit, attempts: job.attempts?.length ?? 1 }
        const file = mode === 'baseline' ? path.join(final.directory, job.fileName) : await ctx.assets.pathForAsset(job.videoAssetId)
        const verifyAt = performance.now(); row.verification = await verifyOutput(file, report.sources[job.index], ctx.directory); row.externalVerificationMs = performance.now() - verifyAt
        experiment.jobs.push(row)
        if (mode === 'baseline') await fs.rm(file); else await ctx.assets.delete(job.videoAssetId)
      }
      experiment.pipelineProcessOverlap = overlap(intervals.slice(fromInterval)); experiment.taskOverlap = overlap([...ctx.events.entries()].filter(([id]) => final.jobs.some(job => job.id === id)).map(([jobId, event]) => ({ jobId, ...event })))
      if (mode === 'parallel') { assert.ok(experiment.pipelineProcessOverlap.overlapMs > 0, 'No real tool overlap'); assert.ok(experiment.taskOverlap.peak <= 2, 'Global cap exceeded') }
      assert.deepEqual(experiment.resources.errors, [], 'Resource monitor failed')
      assert.ok(experiment.resources.samples > 0 && experiment.resources.observedToolPidCount > 0, 'No real media process resource samples')
      experiment.passed = true; iteration++; await save()
      console.log(`${suite}/${mode}/${cache}: ${(experiment.endToEndMs / 1000).toFixed(3)}s plan-to-publication; peak=${experiment.taskOverlap.peak}, toolOverlap=${(experiment.pipelineProcessOverlap.overlapMs / 1000).toFixed(3)}s`)
    }
    await ctx.manager.shutdown(); currentQueue = undefined
    if (!options.keep) await fs.rm(ctx.directory, { recursive: true, force: true })
  }
  report.passed = true; report.finishedAt = new Date().toISOString(); await save()
  if (!options.keep) await fs.rm(source, { recursive: true, force: true })
  console.log(`PASS: ${report.experiments.length} actual composition experiments; ${path.join(root, 'report.json')}`)
} catch (error) { report.error = String(error?.message ?? error).slice(0, 5000); await save(); throw error }
finally { await currentQueue?.shutdown(); childProcess.spawn = originalSpawn }
