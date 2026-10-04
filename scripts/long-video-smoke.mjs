import { rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { baseVideoDraft, checkStaticFrames, makeVideoFixture } from './video-test-utils.mjs'

// Real 1080p/30fps hour-long encode, no audio looping and no generation API calls.
const fixture = await makeVideoFixture({ seconds: [1805, 1805] })
const { engine, tools, tracks, imagePath, imageId, work, root } = fixture
const started = Date.now()
console.log(`LONG_VIDEO_DIR=${root}`)
let last = ''
try {
  const result = await engine.renderMedia({ tools, tracks, imagePath, taskDirectory: work, kind: 'video', signal: new AbortController().signal,
    draft: { ...baseVideoDraft, imageId, audioIds: tracks.map(t => t.id) },
    onProgress: event => {
      const percent = (event.progress ?? 0) * 100
      const marker = `${event.status}-${Math.floor(percent / 10)}`
      if (marker !== last) { console.log(`${new Date().toISOString()} ${event.status} ${percent.toFixed(1)}% ${event.detail}`); last = marker }
    }
  })
  const output = path.join(root, '一小时实际测试.mp4')
  await rename(result.filePath, output)
  const info = await engine.probeMedia(tools, output)
  const video = info.streams.find(s => s.codec_type === 'video')
  const audio = info.streams.find(s => s.codec_type === 'audio')
  assert.equal(video?.width, 1920); assert.equal(video?.height, 1080)
  assert.equal(video.codec_name, 'h264'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.r_frame_rate, '30/1')
  assert.equal(audio?.codec_name, 'aac'); assert.equal(audio.channels, 2); assert.equal(Number(audio.sample_rate), 48000)
  assert.ok(Math.abs(info.durationSeconds - 3600) <= 0.1, `Unexpected duration ${info.durationSeconds}`)
  const frameDifferences = await checkStaticFrames(engine, tools, output, root, [0.5, 1800, 3599.5])
  const report = { passed: true, output, durationSeconds: info.durationSeconds, bytes: (await stat(output)).size,
    elapsedSeconds: (Date.now() - started) / 1000, sourceDurations: tracks.map(t => t.durationSeconds),
    transitionSeconds: 3, frameDifferences, streams: info.streams, audioLooped: false, paidCalls: 0 }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await rm(work, { recursive: true, force: true })
  for (const track of tracks) await rm(track.path)
} catch (error) {
  console.error('LONG_VIDEO_FAILED', error)
  process.exitCode = 1
}
