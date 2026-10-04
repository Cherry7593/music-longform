import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { makeBatchFixture } from './batch-test-utils.mjs'
import { checkStaticFrames } from './video-test-utils.mjs'

if (process.argv.includes('--help')) { console.log('node scripts/batch-video-smoke.mjs [--short]\nDefault: 60 distinct 185s tracks + 3 images, three >=1h 1080p videos. --short: 4 tracks + 2 images, >=1min. All data isolated in PI_SCRATCH_DIR.'); process.exit(0) }
const short = process.argv.includes('--short')
const started = Date.now()
const fixture = await makeBatchFixture(short ? { count: 4, seconds: 35, images: 2 } : undefined)
const { engine, library, batches, receipts, manager, tools, root, audioIds, imageIds, frequencies } = fixture
console.log(`BATCH_VIDEO_DIR=${root}`)
const minimumSeconds = short ? 60 : 3600
const plan = await manager.plan({ ...engine.DEFAULT_BATCH_OPTIONS, name: short ? '短批量验收' : '三个一小时批量验收', minimumSeconds, audioIds, imageIds })
assert.deepEqual(plan.issues, [])
assert.equal(new Set(plan.groups.flatMap(g => g.audioIds)).size, audioIds.length)
assert.equal(plan.groups.flatMap(g => g.audioIds).length, audioIds.length)
const progress = new Map()
batches.onChanged = batch => {
  for (const job of batch.jobs) {
    const key = `${job.status}:${Math.floor((job.progress ?? 0) / 10)}`
    if (progress.get(job.id) !== key) { progress.set(job.id, key); console.log(`${new Date().toISOString()} video ${job.index + 1}/${batch.jobs.length} ${job.status} ${job.progress ?? '-'}%`) }
  }
}
function amplitude(data, frequency) {
  let real = 0, imaginary = 0
  const n = data.length / 4
  for (let i = 0; i < n; i++) { const value = data.readFloatLE(i * 4), phase = 2 * Math.PI * frequency * i / 48000; real += value * Math.cos(phase); imaginary += value * Math.sin(phase) }
  return 2 * Math.hypot(real, imaginary) / n
}
try {
  const initial = await manager.start(plan.id)
  await manager.idle()
  const batch = await batches.get(initial.id)
  assert.equal(batch.state, 'completed', JSON.stringify(batch.jobs.map(j => ({ status: j.status, error: j.error }))))
  const evidence = []
  for (const job of batch.jobs) {
    const file = await batches.pathForAsset(batch.id, job.id)
    const info = await engine.probeMedia(tools, file)
    assert.ok(info.durationSeconds >= minimumSeconds)
    assert.ok(Math.abs(info.durationSeconds - (short ? 67 : 3643)) < 0.1)
    const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio')
    assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.r_frame_rate, '30/1'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(audio.codec_name, 'aac')
    const sampleDir = path.join(root, `视频${job.index + 1}证据`); await mkdir(sampleDir)
    const frameDifferences = await checkStaticFrames(engine, tools, file, sampleDir, [0.5, info.durationSeconds / 2, info.durationSeconds - 0.5])
    const expectedFrame = await sharp(await library.pathForAsset(job.group.imageId)).resize(480, 270).removeAlpha().raw().toBuffer()
    const actualFrame = await sharp(path.join(sampleDir, 'frame-0.png')).resize(480, 270).removeAlpha().raw().toBuffer()
    const sourceFrameDifference = actualFrame.reduce((sum, value, i) => sum + Math.abs(value - expectedFrame[i]), 0) / actualFrame.length
    assert.ok(sourceFrameDifference < 8, `Wrong source image: ${sourceFrameDifference}`)
    const timeline = engine.calculateTimeline(engine.batchDraft(plan.request, job.group), plan.assets.filter(a => a.kind === 'audio').map(a => ({ id: a.id, durationSeconds: a.durationSeconds })))
    const audioOrder = []
    for (const track of timeline.tracks) {
      const expectedIndex = audioIds.indexOf(track.id)
      const sample = path.join(sampleDir, 'sample.f32')
      await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String((track.startSeconds + track.endSeconds) / 2), '-protocol_whitelist', 'file,pipe', '-i', file, '-t', '0.2', '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', sample], { timeoutMs: 60000 })
      const values = await readFile(sample)
      const energies = frequencies.map(f => amplitude(values, f))
      const actualIndex = energies.indexOf(Math.max(...energies))
      assert.equal(actualIndex, expectedIndex, 'Audio order/reuse mismatch')
      assert.ok(energies[actualIndex] > 0.03, 'Audio unexpectedly silent')
      audioOrder.push({ assetId: track.id, sourceIndex: actualIndex, frequency: frequencies[actualIndex], sampledAt: (track.startSeconds + track.endSeconds) / 2 })
      await rm(sample)
    }
    evidence.push({ jobId: job.id, output: file, bytes: (await stat(file)).size, durationSeconds: info.durationSeconds, imageId: job.group.imageId,
      audioIds: job.group.audioIds, audioOrder, frameDifferences, sourceFrameDifference, streams: info.streams })
  }
  const publicAssets = engine.decorateLibrary(await library.all(), [], [batch], receipts.all())
  assert.equal(publicAssets.length, audioIds.length + imageIds.length)
  assert.ok(publicAssets.every(a => a.usages.length === 1 && a.queuedCount === 0))
  const receiptsAgain = new engine.ExportReceiptStore(fixture.dataDir); await receiptsAgain.init(); await receiptsAgain.recover()
  assert.equal(receiptsAgain.all().filter(r => r.state === 'committed').length, imageIds.length)
  const libraryAgain = new engine.LibraryStore({ dataDir: fixture.dataDir, defaultRoot: fixture.media, projects: { async all() { return [] }, async get() { throw new Error('no project') }, async pathForAsset() { throw new Error('no asset') } }, getFFmpegPath: () => tools.ffmpeg }); await libraryAgain.init()
  assert.ok(engine.decorateLibrary(await libraryAgain.all(), [], [batch], receiptsAgain.all()).every(a => a.usages.length === 1))
  const report = { passed: true, short, batchId: batch.id, minimumSeconds, audioCount: audioIds.length, imageCount: imageIds.length,
    elapsedSeconds: (Date.now() - started) / 1000, audioLooped: false, silencePadded: false, paidCalls: 0, plan, outputs: evidence,
    usageCounts: publicAssets.map(a => ({ id: a.id, count: a.usages.length })) }
  await writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, root, durations: evidence.map(e => e.durationSeconds), elapsedSeconds: report.elapsedSeconds }))
} catch (error) {
  console.error('BATCH_VIDEO_FAILED', error)
  process.exitCode = 1
} finally { await manager.shutdown() }
