// Targeted V4.0.2 -> V4.0.3 comparison. No real profile, network, credentials or hour-scale matrix.
const help = `Continuous-image video comparison (two isolated projects, 180s/output).
Usage: node scripts/continuous-video-check.mjs --phase=before [--encoder=qsv|cpu]
       node scripts/continuous-video-check.mjs --phase=after --root=<previous scratch run>
       node scripts/continuous-video-check.mjs --phase=verify --root=<existing measured run>
Verify rechecks existing outputs only; it never rerenders or changes recorded wall times.
Inputs, complete outputs, source snapshots and reports are retained under PI_SCRATCH_DIR.
The after run reuses the exact inputs/settings; each phase runs once in a fresh data directory.
Timed: both plans -> both confirmations -> shared pool -> publication, registration and usage.
Setup/import and independent frame/packet/audio verification are reported separately.
--help exits without file, tool or network access.`
if (process.argv.includes('--help')) { console.log(help); process.exit(0) }
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(phase|root|encoder)=(.+)$/.exec(arg)
  if (!match) throw new Error(`Unknown argument: ${arg}`)
  return [match[1], match[2]]
}))
if (!['before', 'after', 'verify'].includes(options.phase) || options.encoder && !['cpu', 'qsv'].includes(options.encoder)) throw new Error(help)
const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os')
const { createHash } = await import('node:crypto'), { createRequire } = await import('node:module')
const { AsyncLocalStorage } = await import('node:async_hooks'), { build } = await import('esbuild')
const { default: assert } = await import('node:assert/strict'), { default: sharp } = await import('sharp')
const require = createRequire(import.meta.url), childProcess = require('node:child_process')
const scratch = process.env.PI_SCRATCH_DIR
assert.ok(scratch && path.isAbsolute(scratch), 'PI_SCRATCH_DIR is required')
const root = options.phase === 'before' ? await fs.mkdtemp(path.join(scratch, 'continuous-v403-')) : path.resolve(options.root ?? '')
assert.ok(path.relative(scratch, root) && !path.relative(scratch, root).startsWith('..') && !path.isAbsolute(path.relative(scratch, root)))
assert.equal(await fs.realpath(root), root)
const phase = options.phase, directory = path.join(root, phase)
await fs.mkdir(directory) // exclusive: never overwrite an earlier measurement
console.log(`CONTINUOUS_CHECK_ROOT=${root}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = async file => hash(await fs.readFile(file))
const sharpEntry = require.resolve('sharp'), bundle = path.join(directory, 'engine.cjs')
await build({ stdin: { resolveDir: path.resolve('.'), contents: `
export * from './src/main/video/ffmpeg';
export {renderMedia} from './src/main/video/pipeline';
export {clearEncoderProbeCache, staticFilter} from './src/main/video/encoders';
export {WorkbenchDB} from './src/main/storage/workbench-db';
export {CompositionProjects} from './src/main/storage/workbench-projects';
export {AssetStore} from './src/main/storage/assets-v2';
export {DiagnosticStore} from './src/main/storage/diagnostics';
export {PublicationStore} from './src/main/storage/publications-v2';
export {ResourcePool} from './src/main/video/resource-pool';
export {CompositionQueue} from './src/main/video/composition-queue';
export {initialComposition} from './src/shared/workbench-schemas';
` }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
const engine = require(bundle), tools = await engine.requireTools(process.env.FFMPEG_PATH)
const abort = new AbortController(), base = ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-threads', '2', '-filter_threads', '2']
const report = { phase, passed: false, root, directory, createdAt: new Date().toISOString(), tools,
  machine: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
  boundaries: ['180-second synthetic detailed-image samples, NOT one-hour measurements.', 'Same encoder, threads, concurrency, inputs and output specification; no OS/driver cache flush.', 'Full plan-to-publication/registration/usage wall time; import/setup and independent output verification excluded.', 'No GUI rendering latency in full-process timing.'], sourceHashes: {}, outputs: [] }
const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
async function snapshotFiles(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) await snapshotFiles(file)
    else if (entry.isFile()) report.sourceHashes[file.replaceAll('\\', '/')] = await fileHash(file)
  }
}
await snapshotFiles('src'); await snapshotFiles('tests/fixtures')
report.harnessSha256 = await fileHash('scripts/continuous-video-check.mjs')
for (const file of ['src/main/video/encoders.ts', 'src/main/video/pipeline.ts', 'src/main/video/composition-queue.ts', 'src/shared/workbench-schemas.ts']) await fs.copyFile(file, path.join(directory, path.basename(file)))
let fixture, queue
const originalSpawn = childProcess.spawn, als = new AsyncLocalStorage(), processes = []
childProcess.spawn = function (file, args, config) {
  const owner = als.getStore(), startedMs = performance.now(), child = originalSpawn.call(this, file, args, config)
  if (owner && /^(ffmpeg|ffprobe)(\.exe)?$/i.test(path.basename(file))) {
    const row = { jobId: owner, pid: child.pid, file, args, startedMs, finishedMs: null, exitCode: null }
    processes.push(row)
    child.once('close', code => { row.finishedMs = performance.now(); row.exitCode = code })
  }
  return child
}
function overlap(rows) {
  const events = rows.flatMap(row => [{ at: row.startedMs, id: row.jobId, delta: 1 }, { at: row.finishedMs, id: row.jobId, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta)
  const active = new Map(); let previous = events[0]?.at ?? 0, overlapMs = 0, peak = 0
  for (const event of events) {
    if (active.size > 1) overlapMs += event.at - previous
    const count = (active.get(event.id) ?? 0) + event.delta
    if (count) active.set(event.id, count); else active.delete(event.id)
    peak = Math.max(peak, active.size); previous = event.at
  }
  return { overlapMs, peak }
}
async function detailedImage(file, variant) {
  let seed = 7103 + variant, shapes = ''
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 90; i++) {
    const x = random() * 1920, y = 440 + random() * 330, h = 90 + random() * 270, w = 25 + random() * 80
    shapes += `<rect x="${x}" y="${y-h}" width="${w}" height="${h}" fill="${i%2 ? '#866a59' : '#587b80'}" stroke="#333c47"/>`
    for (let dx = 4; dx < w - 5; dx += 9) for (let dy = 5; dy < h - 5; dy += 12) shapes += `<rect x="${x+dx}" y="${y-h+dy}" width="4" height="6" fill="${random() > 0.5 ? '#f4dda4' : '#273c54'}"/>`
  }
  for (let i = 0; i < 5000; i++) {
    const x = random() * 1920, y = 725 + random() * 355, length = 4 + random() * 24
    shapes += `<path d="M${x} ${y}l${random()*8-4} -${length}" stroke="${i%3 ? '#345548' : '#bbbc83'}" stroke-width="${0.6+random()*1.5}"/>`
  }
  for (let i = 0; i < 50; i++) shapes += `<path d="M0 ${210+i*4}Q480 ${60+i*5} 960 ${270+i*2}T1920 ${170+i*4}" fill="none" stroke="#819598" stroke-width="1"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#293f64"/><stop offset="1" stop-color="#ddbea0"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#s)"/><path d="M0 700L200 270 410 490 740 140 990 530 1250 330 1490 590 1740 220 1920 630V1080H0Z" fill="#445a61"/><rect y="720" width="1920" height="360" fill="#667a58"/>${shapes}<rect x="42" y="36" width="850" height="132" fill="#172235" fill-opacity="0.88"/><text x="62" y="83" font-family="Arial" font-size="32" fill="#ffffff">DETAILED LANDSCAPE ${variant+1} | 1920 x 1080</text><text x="62" y="117" font-family="Arial" font-size="22" fill="#eee8d9">Windows, roof edges, grass, contours and fine texture</text><text x="62" y="145" font-family="Arial" font-size="16" fill="#ddd">Small text 0123456789 ABCDEFG - continuous encoding quality check</text></svg>`
  const raw = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer()
  // Low-amplitude deterministic surface detail; this is an artificial landscape, not a solid-color fixture.
  for (let i = 0; i < raw.length; i += 3) { const noise = Math.round((random()-0.5)*8); for (let c = 0; c < 3; c++) raw[i+c] = Math.max(0, Math.min(255, raw[i+c]+noise)) }
  await sharp(raw, { raw: { width: 1920, height: 1080, channels: 3 } }).png().toFile(file)
}
async function checkOutput(file, group, index) {
  const info = await engine.probeMedia(tools, file, abort.signal), video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.r_frame_rate, '30/1')
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2)
  assert.ok(Math.abs(Number(video.duration) - 180) < 0.04 && Math.abs(Number(audio.duration) - 180) < 0.04)
  const packetData = JSON.parse((await engine.runTool(tools.ffprobe, ['-v', 'error', '-i', file, '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,dts_time,size,flags', '-of', 'json'], { maxOutputBytes: 4 * 1024 ** 2 })).stdout).packets
  assert.equal(packetData.length, 5400)
  const keyTimes = packetData.filter(p => p.flags.includes('K')).map(p => Number(p.pts_time)).sort((a, b) => a-b)
  const keyIntervals = keyTimes.slice(1).map((at, i) => at-keyTimes[i]), expectedGop = phase === 'before' ? 1 : 10
  assert.ok(keyIntervals.length > 10 && keyIntervals.every(value => Math.abs(value - expectedGop) < 0.00001), JSON.stringify(keyTimes))
  const referenceFile = path.join(directory, `reference-${index}.yuv`)
  await engine.runTool(tools.ffmpeg, [...base, '-i', group.imagePath, '-vf', engine.staticFilter('contain'), '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', referenceFile])
  const reference = await fs.readFile(referenceFile), frames = []
  for (const at of [0, 90.4, 179.9]) {
    const stem = `frame-${index}-${at}`, rawFile = path.join(directory, `${stem}.yuv`)
    const started = performance.now()
    await engine.runTool(tools.ffmpeg, [...base, '-ss', String(at), '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', rawFile])
    const seekDecodeMs = performance.now() - started, raw = await fs.readFile(rawFile)
    assert.equal(raw.length, reference.length)
    let error = 0, maxError = 0
    for (let i = 0; i < raw.length; i++) { const e = raw[i] - reference[i]; error += e*e; maxError = Math.max(maxError, Math.abs(e)) }
    const psnrDb = error === 0 ? 99 : 10 * Math.log10(255*255 / (error/raw.length))
    assert.ok(psnrDb > 30, `Unexpected image loss: ${psnrDb} dB`)
    const png = path.join(directory, `${stem}.png`)
    await engine.runTool(tools.ffmpeg, [...base, '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '1920x1080', '-i', rawFile, '-frames:v', '1', png])
    frames.push({ at, psnrDb, maxError, seekDecodeMs, png }); await fs.rm(rawFile)
  }
  await fs.rm(referenceFile)
  const pcm = path.join(directory, `audio-${index}.f32`)
  await engine.runTool(tools.ffmpeg, [...base, '-i', file, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', pcm])
  const audioDecodedSha256 = await fileHash(pcm), decodedAudioSamples = (await fs.stat(pcm)).size / 8
  await fs.rm(pcm)
  return { file, bytes: (await fs.stat(file)).size, sha256: await fileHash(file), durationSeconds: info.durationSeconds,
    videoDuration: Number(video.duration), audioDuration: Number(audio.duration), videoBitrate: packetData.reduce((n, p) => n+Number(p.size), 0)*8/180,
    packetVideoBitrate: packetData.reduce((n, p) => n+Number(p.size), 0)*8/180, frameCount: packetData.length,
    keyTimes, keyIntervalSeconds: { minimum: Math.min(...keyIntervals), maximum: Math.max(...keyIntervals) }, frames,
    audioDecodedSha256, decodedAudioSamples, productionFullDecode: true }
}
async function compareAudio(previous, current, index) {
  if (previous.audioDecodedSha256 === current.audioDecodedSha256) return { exact: true, maximumError: 0 }
  const pcm = [], packets = []
  for (const [name, item] of [['before', previous], ['after', current]]) {
    const output = path.join(directory, `compare-${name}-${index}.f32`)
    await engine.runTool(tools.ffmpeg, [...base, '-i', item.file, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', output])
    pcm.push(await fs.readFile(output)); await fs.rm(output)
    packets.push(JSON.parse((await engine.runTool(tools.ffprobe, ['-v', 'error', '-i', item.file, '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,dts_time,duration_time,size,data_hash', '-of', 'json'], { maxOutputBytes: 8 * 1024 ** 2 })).stdout).packets)
  }
  assert.equal(pcm[0].length, pcm[1].length); assert.equal(pcm[0].length/8, 180*48000)
  assert.equal(packets[0].length, packets[1].length)
  assert.deepEqual(packets[0].slice(1), packets[1].slice(1), 'All non-priming AAC packets must be identical')
  for (const packet of [packets[0][0], packets[1][0]]) {
    assert.equal(packet.pts_time, '-0.021333'); assert.equal(packet.dts_time, '-0.021333')
    assert.equal(packet.duration_time, '0.021333'); assert.equal(packet.side_data_list[0].skip_samples, 1024)
  }
  assert.deepEqual(pcm[0].subarray(1024*8), pcm[1].subarray(1024*8), 'All samples after AAC priming overlap must be identical')
  let maximumError = 0, squared = 0
  for (let at = 0; at < 1024*8; at += 4) { const error = Math.abs(pcm[0].readFloatLE(at)-pcm[1].readFloatLE(at)); maximumError = Math.max(maximumError, error); squared += error*error }
  assert.ok(maximumError < 1/32768, 'AAC priming error must stay below one 16-bit PCM step')
  return { exact: false, samples: pcm[0].length/8, identicalPacketsAfterPriming: packets[0].length-1, differingFirstSamples: 1024,
    maximumError, wholeTrackRmsError: Math.sqrt(squared/(pcm[0].length/4)), identicalAfterFirstSamples: true }
}
async function comparison(previous, current) {
  assert.ok(previous.passed); assert.equal(current.fixtureSha256, previous.fixtureSha256)
  const rows = []
  for (const [index, output] of current.outputs.entries()) {
    const old = previous.outputs[index], audio = await compareAudio(old, output, index)
    rows.push({ index, bytesBefore: old.bytes, bytesAfter: output.bytes, sizeRatio: output.bytes/old.bytes,
      videoBitrateBefore: old.packetVideoBitrate, videoBitrateAfter: output.packetVideoBitrate,
      pipelineMsBefore: old.pipelineMs, pipelineMsAfter: output.pipelineMs, audio,
      minimumPsnrBefore: Math.min(...old.frames.map(f => f.psnrDb)), minimumPsnrAfter: Math.min(...output.frames.map(f => f.psnrDb)) })
  }
  assert.equal(rows.length, 2)
  assert.ok(rows.every(item => item.sizeRatio < 0.8), 'Inspect bitrate/GOP before accepting insufficient size improvement')
  return rows
}
try {
  if (phase === 'verify') {
    fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'))
    const measuredFile = path.join(root, 'after', 'report.json'), measured = JSON.parse(await fs.readFile(measuredFile, 'utf8'))
    report.timingCopiedFrom = { file: measuredFile, sha256: await fileHash(measuredFile), originalError: measured.error?.message }
    report.fixtureSha256 = await fileHash(path.join(root, 'fixture.json')); report.settings = fixture.render
    assert.equal(report.fixtureSha256, measured.fixtureSha256); assert.equal(measured.outputs.length, 2)
    report.endToEndMs = measured.endToEndMs; report.encodeOverlap = measured.encodeOverlap; report.mediaOverlap = measured.mediaOverlap
    assert.equal(report.encodeOverlap.peak, 2); assert.ok(report.encodeOverlap.overlapMs > 0)
    for (const [i, output] of measured.outputs.entries()) {
      assert.equal(await fileHash(output.file), output.sha256)
      assert.equal(output.metrics.encoder, fixture.render.encoder); assert.equal(output.metrics.staticVideo, false)
      report.outputs.push({ ...output, ...await checkOutput(output.file, fixture.groups[i], i) })
    }
    const recordedProcesses = JSON.parse(await fs.readFile(path.join(root, 'after', 'processes.json'), 'utf8'))
    assert.ok(recordedProcesses.every(p => !p.args.includes('-stream_loop') && !p.args.some(arg => /music-static-v4|segment\.mp4/.test(arg))))
    for (const group of fixture.groups) {
      assert.equal(await fileHash(group.imagePath), group.imageSha256)
      for (const track of group.tracks) assert.equal(await fileHash(track.file), track.sha256)
    }
    report.comparison = await comparison(JSON.parse(await fs.readFile(path.join(root, 'before', 'report.json'), 'utf8')), report)
    report.inputsUnchanged = true; report.passed = true
    console.log(JSON.stringify({ passed: true, phase, endToEndMs: report.endToEndMs, comparison: report.comparison }, null, 2))
  } else {
  if (phase === 'before') {
    const source = path.join(root, 'sources'); await fs.mkdir(source)
    fixture = { seconds: 180, trackSeconds: 91.5, render: { concurrency: 2, threads: 2, encoder: options.encoder ?? 'qsv', staticVideo: true }, groups: [] }
    for (let i = 0; i < 2; i++) {
      const imagePath = path.join(source, `detail-${i}.png`), tracks = []
      await detailedImage(imagePath, i)
      for (let j = 0; j < 2; j++) {
        const file = path.join(source, `song-${i}-${j}.flac`), frequency = 220 + i*220 + j*110
        await engine.runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `aevalsrc=0.15*sin(2*PI*${frequency}*t)*(0.75+0.25*sin(2*PI*0.8*t))+0.04*sin(2*PI*${frequency*1.5}*t):s=48000:d=91.5`, '-ac', '2', '-c:a', 'flac', file])
        tracks.push({ file, sha256: await fileHash(file), frequency })
      }
      fixture.groups.push({ imagePath, imageSha256: await fileHash(imagePath), tracks })
    }
    await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture, null, 2), { flag: 'wx' })
  } else fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'))
  for (const group of fixture.groups) {
    assert.equal(await fileHash(group.imagePath), group.imageSha256)
    for (const track of group.tracks) assert.equal(await fileHash(track.file), track.sha256)
  }
  report.fixtureSha256 = await fileHash(path.join(root, 'fixture.json')); report.settings = fixture.render
  const setupAt = performance.now(), dataDir = path.join(directory, 'data'), mediaRoot = path.join(directory, 'media')
  const assets = new engine.AssetStore({ dataDir, root: mediaRoot, getFFmpegPath: () => tools.ffmpeg }); await assets.init()
  const db = new engine.WorkbenchDB(dataDir); await db.init()
  // Deliberately use the legacy true setting in BOTH phases to prove it cannot enable reuse after the change.
  await db.put('settings', 'current', { version: 5, mediaRoot, ffmpegPath: tools.ffmpeg, page: 'composition', render: fixture.render })
  const projects = new engine.CompositionProjects(db), selected = []
  for (const group of fixture.groups) {
    const ar = await assets.importFiles(group.tracks.map(t => t.file), 'audio'), ir = await assets.importFiles([group.imagePath], 'image')
    assert.ok([...ar.entries, ...ir.entries].every(e => e.status === 'imported'))
    const audioIds = ar.entries.map(e => e.assetId), imageIds = ir.entries.map(e => e.assetId)
    let project = await projects.create()
    project = await projects.update(project.id, project.revision, { draft: { ...engine.initialComposition(), minimumSeconds: 180, transition: 'crossfade', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain', audioIds, imageIds, groups: [{ audioIds, imageId: imageIds[0] }] } })
    selected.push(project)
  }
  const diagnostics = new engine.DiagnosticStore(dataDir); await diagnostics.init()
  const publications = new engine.PublicationStore(dataDir, assets); await publications.init()
  const pool = new engine.ResourcePool(() => db.get('settings', 'current').render), errors = [], rendered = new Map()
  queue = new engine.CompositionQueue({ db, assets, diagnostics, publications, pool, onError: error => errors.push(error), render: request => {
    const id = path.basename(request.taskDirectory).replace(/^\.work-/, ''), at = performance.now()
    return als.run(id, async () => { const result = await engine.renderMedia(request); rendered.set(id, { pipelineMs: performance.now()-at, metrics: result.metrics }); return result })
  } })
  report.setupMs = performance.now()-setupAt; engine.clearEncoderProbeCache(); await save()
  const begin = performance.now(), plans = []
  for (const project of selected) { const plan = await queue.plan(project.id, project.revision); assert.deepEqual(plan.issues, []); plans.push(plan) }
  const batches = await Promise.all(plans.map((plan, i) => queue.start(selected[i].id, plan.id)))
  await queue.idle()
  const finals = batches.map(batch => db.get('executions', batch.id))
  for (const final of finals) assert.equal(final.state, 'completed', JSON.stringify(final.jobs))
  assert.deepEqual(errors, []); assert.equal((await assets.allUsage()).length, 2)
  for (const final of finals) assert.equal(publications.get(final.jobs[0].id).state, 'committed')
  report.endToEndMs = performance.now()-begin
  report.mediaOverlap = overlap(processes)
  report.encodeOverlap = overlap(processes.filter(p => path.basename(p.args.at(-1)) === 'video.partial.mp4'))
  assert.equal(report.encodeOverlap.peak, 2); assert.ok(report.encodeOverlap.overlapMs > 0)
  const verifyAt = performance.now()
  for (const [i, final] of finals.entries()) {
    const job = final.jobs[0], timing = rendered.get(job.id)
    assert.equal(timing.metrics.encoder, fixture.render.encoder, 'Comparison must use exactly the requested encoder, not a fallback')
    assert.equal(timing.metrics.staticVideo, phase === 'before')
    const output = await checkOutput(path.join(mediaRoot, 'videos', `${job.id}.mp4`), fixture.groups[i], i)
    report.outputs.push({ projectId: selected[i].id, jobId: job.id, ...output, ...timing, attemptElapsedMs: job.attempts[0].elapsedMs })
    await save()
  }
  if (phase === 'after') {
    const previous = JSON.parse(await fs.readFile(path.join(root, 'before', 'report.json'), 'utf8'))
    report.comparison = await comparison(previous, report)
    assert.ok(processes.every(p => !p.args.includes('-stream_loop') && !p.args.some(arg => /music-static-v4|segment\.mp4/.test(arg))))
  }
  for (const group of fixture.groups) {
    assert.equal(await fileHash(group.imagePath), group.imageSha256)
    for (const track of group.tracks) assert.equal(await fileHash(track.file), track.sha256)
  }
  report.independentVerificationMs = performance.now()-verifyAt; report.inputsUnchanged = true; report.passed = true
  console.log(JSON.stringify({ passed: true, phase, root, endToEndMs: report.endToEndMs, encodeOverlap: report.encodeOverlap, outputs: report.outputs.map(o => ({ bytes: o.bytes, videoBitrate: o.videoBitrate, gop: o.keyIntervalSeconds, pipelineMs: o.pipelineMs })) }, null, 2))
  }
} catch (error) { report.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1 }
finally {
  await queue?.shutdown(); childProcess.spawn = originalSpawn
  await fs.writeFile(path.join(directory, 'processes.json'), JSON.stringify(processes, null, 2)); await save()
}
