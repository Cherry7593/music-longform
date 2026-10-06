import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { VideoDiagnostic } from '../../src/shared/video-diagnostics'
import { CancelledError, probeMedia, requireTools, runTool, type VideoTools } from '../../src/main/video/ffmpeg'
import * as ffmpeg from '../../src/main/video/ffmpeg'
import { hashMedia, probeEncoder, toolIdentity } from '../../src/main/video/encoders'
import { renderMedia, type RenderRequest, type RenderTrack } from '../../src/main/video/pipeline'
import { renderMedia as baseline } from '../fixtures/video-pipeline-v31'

let root: string, image: string, tools: VideoTools, tracks: RenderTrack[]
const base = ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-threads', '2', '-filter_threads', '2']
async function request(patch: Partial<RenderRequest> = {}): Promise<RenderRequest> {
  return { tools, tracks, imagePath: image, taskDirectory: await mkdtemp(path.join(root, 'task-')), signal: new AbortController().signal, kind: 'video',
    draft: { ...DEFAULT_VIDEO, initialized: true, durationMode: 'all', audioIds: tracks.map(t => t.id), imageId: randomUUID(), transition: 'crossfade', transitionSeconds: 0.5, fadeInSeconds: 0.25, fadeOutSeconds: 0.25 },
    performance: { threads: 2, encoder: 'cpu' }, ...patch }
}
// Keep obsolete fields at runtime without adding them back to RenderRequest's public type.
function legacyPerformance(staticVideo: boolean, cacheDirectory: string): NonNullable<RenderRequest['performance']> {
  const legacy = { threads: 2, encoder: 'cpu' as const, staticVideo, cacheDirectory }
  return legacy
}
async function assertVideo(file: string, seconds: number, gop?: number): Promise<void> {
  const frames = Math.ceil(Math.round(seconds * 48000) * 30 / 48000)
  const info = await probeMedia(tools, file, undefined, true)
  expect(info.streams).toHaveLength(2)
  expect(info.streams.find(s => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '30/1', nb_read_frames: String(frames) })
  expect(info.streams.find(s => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
  expect(Math.abs(info.durationSeconds - seconds)).toBeLessThan(0.1)
  const { packets } = JSON.parse((await runTool(tools.ffprobe, ['-v', 'error', '-i', file, '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json'])).stdout) as { packets: Array<{ pts_time: string; dts_time: string; flags: string }> }
  expect(packets).toHaveLength(frames)
  // B-frame packets arrive in decode order; DTS must advance, but need not equal PTS.
  for (const [index, packet] of packets.entries()) {
    expect(Number.isFinite(Number(packet.pts_time))).toBe(true)
    expect(Number.isFinite(Number(packet.dts_time))).toBe(true)
    if (index) expect(Number(packet.dts_time)).toBeGreaterThan(Number(packets[index - 1].dts_time))
  }
  const displayed = [...packets].sort((a, b) => Number(a.pts_time) - Number(b.pts_time))
  for (const [index, packet] of displayed.entries()) expect(Math.abs(Number(packet.pts_time) - index / 30)).toBeLessThan(0.00001)
  expect(displayed[0].flags).toContain('K')
  if (gop) expect(displayed.flatMap((packet, index) => packet.flags.includes('K') ? [index] : []))
    .toEqual(Array.from({ length: Math.ceil(frames / gop) }, (_, index) => index * gop))
}
async function raw(file: string): Promise<Buffer> {
  const output = path.join(root, `${randomUUID()}.f32`)
  await runTool(tools.ffmpeg, [...base, '-i', file, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', output])
  return readFile(output)
}
beforeAll(async () => {
  tools = await requireTools(process.env.FFMPEG_PATH)
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'video-v4-'))
  image = path.join(root, 'image.png')
  await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30,drawgrid=w=37:h=29:t=2:c=white@0.4', '-frames:v', '1', image])
  tracks = []
  for (let i = 0; i < 3; i++) {
    const file = path.join(root, `source-${i}.flac`)
    // Non-video-frame-aligned endpoint catches accidental -shortest, AAC padding and GOP trimming.
    await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 110}:sample_rate=48000:duration=${2 + i / 48000}`, '-ac', '2', '-c:a', 'flac', file])
    tracks.push({ id: randomUUID(), path: file, durationSeconds: (await probeMedia(tools, file)).durationSeconds })
  }
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('V4.0.3 real continuous pipeline', () => {
  it.each(['cut', 'fade', 'crossfade'] as const)('matches frozen V3.1 %s master at every PCM sample, including boundary and final samples', async transition => {
    const req = await request()
    req.draft.transition = transition
    const original = await baseline({ ...req, taskDirectory: await mkdtemp(path.join(root, 'baseline-')) })
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, audioPath: 'bounded-direct', fallbacks: [] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    const old = await raw(path.join(path.dirname(original.filePath), 'master.wav'))
    const next = await raw(path.join(req.taskDirectory, 'master.wav'))
    expect(next.length).toBe(old.length)
    let maximumError = 0
    for (let i = 0; i < next.length; i += 4) maximumError = Math.max(maximumError, Math.abs(next.readFloatLE(i) - old.readFloatLE(i)))
    expect(maximumError).toBeLessThanOrEqual(0.0000001)
    const names = await readdir(req.taskDirectory)
    expect(names.some(name => /^(prepared|body|join|fade)-/.test(name))).toBe(false)
    await assertVideo(result.filePath, result.timeline.outputSeconds, 300)
    console.info(`${transition}: sample count ${next.length / 8}, max error ${maximumError}, ${JSON.stringify(result.metrics)}`)
  })

  it('continuously encodes independent overlapping legacy true/false tasks without reading or changing an existing cache', async () => {
    const isolated = path.join(root, 'untouched-cache'), key = 'f'.repeat(64)
    const entry = path.join(isolated, 'music-static-v4', key)
    await mkdir(entry, { recursive: true })
    const segment = path.join(entry, 'segment.mp4'), metadata = path.join(entry, 'entry.json')
    await writeFile(segment, 'existing corrupt cache sentinel'); await writeFile(metadata, 'foreign metadata sentinel')
    const original = await hashMedia(image)
    const requests = await Promise.all([true, false].map(staticVideo => request({ performance: legacyPerformance(staticVideo, isolated) })))
    const results = await Promise.all(requests.map(renderMedia))
    expect(new Set(results.map(result => result.filePath)).size).toBe(2)
    for (const [index, result] of results.entries()) {
      expect(path.dirname(result.filePath)).toBe(requests[index].taskDirectory)
      expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [] })
      expect(result.metrics).not.toHaveProperty('cacheHit')
      await assertVideo(result.filePath, result.timeline.outputSeconds, 300)
      expect((await readdir(requests[index].taskDirectory)).some(name => /^(static-|music-static-v4)/.test(name))).toBe(false)
    }
    expect(await readdir(isolated)).toEqual(['music-static-v4'])
    expect(await readdir(path.join(isolated, 'music-static-v4'))).toEqual([key])
    expect((await readdir(entry)).sort()).toEqual(['entry.json', 'segment.mp4'])
    expect(await readFile(segment, 'utf8')).toBe('existing corrupt cache sentinel')
    expect(await readFile(metadata, 'utf8')).toBe('foreign metadata sentinel')
    expect(await hashMedia(image)).toBe(original)
  })

  it.each([true, false])('does not create a missing legacy cacheDirectory with staticVideo=%s', async staticVideo => {
    const missing = path.join(root, `never-create-cache-${staticVideo}`), original = await hashMedia(image)
    const req = await request({ performance: legacyPerformance(staticVideo, missing) })
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    await assertVideo(result.filePath, result.timeline.outputSeconds, 300)
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await hashMedia(image)).toBe(original)
  })

  it('produces a real ten-second CPU GOP in one detailed-image 12-second output', async () => {
    const source = path.join(root, 'gop-12s.flac'), id = randomUUID()
    await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=12', '-ac', '2', '-c:a', 'flac', source])
    const req = await request({ tracks: [{ id, path: source, durationSeconds: 12 }] })
    req.draft = { ...req.draft, audioIds: [id], transition: 'cut', fadeInSeconds: 0, fadeOutSeconds: 0 }
    const result = await renderMedia(req)
    expect(result.timeline.outputSeconds).toBe(12)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [] })
    // Exactly 360 frames with keyframes 0 and 300, not an all-keyframe or one-second loop.
    await assertVideo(result.filePath, 12, 300)
  })

  it('reports actual NVENC, QSV and CPU initialization rather than advertised encoder names', async () => {
    const signal = new AbortController().signal, identity = await toolIdentity(tools, signal)
    const statuses = []
    for (const encoder of ['nvenc', 'qsv', 'cpu'] as const) statuses.push(await probeEncoder(tools, encoder, root, signal, 2, identity))
    expect(statuses.at(-1)?.available).toBe(true)
    console.info('V4_REAL_ENCODERS', JSON.stringify(statuses))
  })

  it('cancels during full-output validation without cancelling the other real task', async () => {
    const controller = new AbortController()
    const cancelled = await request({ signal: controller.signal, onStage: stage => { if (stage === 'validate') controller.abort() } })
    const other = await request()
    const outcomes = await Promise.allSettled([renderMedia(cancelled), renderMedia(other)])
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: expect.any(CancelledError) })
    expect(outcomes[1].status).toBe('fulfilled')
    await rm(cancelled.taskDirectory, { recursive: true, force: true })
  })

  it('refuses source mutations and attaches the actual asset/stage without exposing credentials', async () => {
    const copy = path.join(root, 'mutable.flac'); await writeFile(copy, await readFile(tracks[0].path))
    const mutable = { ...tracks[0], path: copy }
    const req = await request({ tracks: [mutable] })
    req.draft.audioIds = [mutable.id]
    let mutated: Promise<void> | undefined
    req.onStage = stage => { if (stage === 'validate') mutated = writeFile(copy, Buffer.from('changed')) }
    await expect(renderMedia(req)).rejects.toMatchObject({ diagnostic: { stage: 'validate', assetId: mutable.id, message: expect.stringContaining('发生变化') } })
    await mutated
    const bad = await request({ tracks: [{ ...tracks[0], path: path.join(root, 'missing.wav') }] })
    bad.draft.audioIds = [tracks[0].id]
    await expect(renderMedia(bad)).rejects.toMatchObject({ diagnostic: { stage: 'probe', category: 'unreadable', assetId: tracks[0].id } })
    try { await runTool(tools.ffmpeg, ['-v', 'error', '-unknown-v4-option', 'https://fake.invalid/?api_key=synthetic-secret'], { diagnostic: { stage: 'encode' } }) }
    catch (error) {
      const diagnostic = (error as { diagnostic: VideoDiagnostic }).diagnostic
      expect(diagnostic).toMatchObject({ stage: 'encode', category: 'incompatible', exitCode: expect.any(Number) })
      expect(JSON.stringify(error)).not.toContain('synthetic-secret')
    }
  })

  it('ignores an invalid legacy cache URL without fallback and never deletes a pre-existing output', async () => {
    const req = await request({ performance: legacyPerformance(true, 'https://fake.invalid/cache') })
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    await assertVideo(result.filePath, result.timeline.outputSeconds, 300)
    const occupied = await request()
    const output = path.join(occupied.taskDirectory, 'video.partial.mp4')
    await writeFile(output, 'user media sentinel')
    await expect(renderMedia(occupied)).rejects.toThrow('不会覆盖')
    expect(await readFile(output, 'utf8')).toBe('user media sentinel')
  })
})

it('explicit NVENC preference either really works or reports CPU fallback with exit evidence', async () => {
  const req = await request(); req.performance!.encoder = 'nvenc'
  const result = await renderMedia(req)
  expect(['cpu', 'nvenc']).toContain(result.metrics?.encoder)
  expect(result.metrics?.staticVideo).toBe(false)
  expect(result.metrics).not.toHaveProperty('cacheHit')
  if (result.metrics?.encoder === 'cpu') {
    expect(result.metrics.fallbacks).toHaveLength(1)
    const fallback = result.metrics.fallbacks![0]
    expect(fallback.encoder).toBe('nvenc')
    expect(['tools', 'encode', 'validate']).toContain(fallback.stage)
    if (fallback.stage !== 'validate') expect(fallback).toMatchObject({ exitCode: expect.any(Number), stderr: expect.any(String) })
  } else expect(result.metrics?.fallbacks).toEqual([])
  // Do not treat an unavailable NVENC device as a failure of the CPU fallback contract.
  await assertVideo(result.filePath, result.timeline.outputSeconds)
})

it('revalidates one real CPU re-encode after hardware output corruption when hardware is available', async context => {
  const controller = new AbortController(), identity = await toolIdentity(tools, controller.signal)
  let encoder: 'nvenc' | 'qsv' | undefined
  for (const candidate of ['nvenc', 'qsv'] as const) {
    if ((await probeEncoder(tools, candidate, root, controller.signal, 2, identity)).available) { encoder = candidate; break }
  }
  if (!encoder) return context.skip()
  const req = await request({ signal: controller.signal, performance: { threads: 2, encoder } })
  const output = path.join(req.taskDirectory, 'video.partial.mp4'), actualRun = ffmpeg.runTool
  const codecs: string[] = [], fullDecodes: string[][] = []
  let injected = false, validations = 0
  // Observe commands only; every encode/probe/decode still uses the real local tools.
  const observed = vi.spyOn(ffmpeg, 'runTool').mockImplementation(async (tool, args, options) => {
    if (args.at(-1) === output) {
      codecs.push(args[args.indexOf('-c:v') + 1])
      if (codecs.length > 2) { controller.abort(); throw new CancelledError() }
    }
    if (args.includes(output) && args.includes('-xerror')) fullDecodes.push([...args])
    return actualRun(tool, args, options)
  })
  req.onStage = stage => {
    if (stage !== 'validate') return
    validations++
    if (!injected && ['h264_nvenc', 'h264_qsv'].includes(codecs.at(-1) ?? '')) {
      injected = true; writeFileSync(output, 'isolated hardware output fault')
    }
  }
  try {
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    expect(result.metrics?.fallbacks).toHaveLength(1)
    if (injected) {
      expect(codecs).toEqual([encoder === 'nvenc' ? 'h264_nvenc' : 'h264_qsv', 'libx264'])
      expect(validations).toBe(2)
      expect(result.metrics?.fallbacks?.[0]).toMatchObject({ encoder, stage: 'validate' })
    } else {
      // A device can disappear between the short probe and actual encode; it must still fall back safely.
      expect(['tools', 'encode']).toContain(result.metrics?.fallbacks?.[0].stage)
      expect(validations).toBe(1)
    }
    expect(fullDecodes).toHaveLength(1)
    expect(fullDecodes[0]).toEqual(expect.arrayContaining(['-xerror', '-err_detect', 'explode', '0:a:0', '0:v:0', '-f', 'null']))
    await assertVideo(result.filePath, result.timeline.outputSeconds, 300)
  } finally { observed.mockRestore() }
})

it('rejects a corrupted CPU result immediately instead of retrying the removed stream-copy path', async () => {
  const req = await request()
  let encodes = 0, validations = 0
  req.onStage = stage => {
    if (stage === 'encode') encodes++
    if (stage === 'validate') { validations++; writeFileSync(path.join(req.taskDirectory, 'video.partial.mp4'), 'CPU fault injection only') }
  }
  await expect(renderMedia(req)).rejects.toMatchObject({ diagnostic: { stage: 'validate', encoder: 'cpu' } })
  expect(encodes).toBe(1); expect(validations).toBe(1)
  expect(await readFile(path.join(req.taskDirectory, 'video.partial.mp4'), 'utf8')).toBe('CPU fault injection only')
})
