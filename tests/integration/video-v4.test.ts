import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { VideoDiagnostic } from '../../src/shared/video-diagnostics'
import { CancelledError, probeMedia, requireTools, runTool, type VideoTools } from '../../src/main/video/ffmpeg'
import { hashMedia, probeEncoder, toolIdentity } from '../../src/main/video/encoders'
import { renderMedia, type RenderRequest, type RenderTrack } from '../../src/main/video/pipeline'
import { renderMedia as baseline } from '../fixtures/video-pipeline-v31'

let root: string, image: string, cache: string, tools: VideoTools, tracks: RenderTrack[]
const base = ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-threads', '2', '-filter_threads', '2']
async function request(patch: Partial<RenderRequest> = {}): Promise<RenderRequest> {
  return { tools, tracks, imagePath: image, taskDirectory: await mkdtemp(path.join(root, 'task-')), signal: new AbortController().signal, kind: 'video',
    draft: { ...DEFAULT_VIDEO, initialized: true, durationMode: 'all', audioIds: tracks.map(t => t.id), imageId: randomUUID(), transition: 'crossfade', transitionSeconds: 0.5, fadeInSeconds: 0.25, fadeOutSeconds: 0.25 },
    performance: { threads: 2, encoder: 'cpu', cacheDirectory: cache, staticVideo: true }, ...patch }
}
async function raw(file: string): Promise<Buffer> {
  const output = path.join(root, `${randomUUID()}.f32`)
  await runTool(tools.ffmpeg, [...base, '-i', file, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', output])
  return readFile(output)
}
beforeAll(async () => {
  tools = await requireTools(process.env.FFMPEG_PATH)
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'video-v4-'))
  cache = path.join(root, 'cache'); await mkdir(cache)
  image = path.join(root, 'image.png')
  await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'color=c=0xCC3366:s=320x240,drawbox=x=30:y=30:w=60:h=90:color=green:t=fill', '-frames:v', '1', image])
  tracks = []
  for (let i = 0; i < 3; i++) {
    const file = path.join(root, `source-${i}.flac`)
    // Non-video-frame-aligned endpoint catches accidental -shortest, AAC padding and GOP trimming.
    await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 110}:sample_rate=48000:duration=${2 + i / 48000}`, '-ac', '2', '-c:a', 'flac', file])
    tracks.push({ id: randomUUID(), path: file, durationSeconds: (await probeMedia(tools, file)).durationSeconds })
  }
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('V4 real optimized pipeline', () => {
  it.each(['cut', 'fade', 'crossfade'] as const)('matches frozen V3.1 %s master at every PCM sample, including boundary and final samples', async transition => {
    const req = await request()
    req.draft.transition = transition
    const original = await baseline({ ...req, taskDirectory: await mkdtemp(path.join(root, 'baseline-')) })
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: true, audioPath: 'bounded-direct', fallbacks: [] })
    const old = await raw(path.join(path.dirname(original.filePath), 'master.wav'))
    const next = await raw(path.join(req.taskDirectory, 'master.wav'))
    expect(next.length).toBe(old.length)
    let maximumError = 0
    for (let i = 0; i < next.length; i += 4) maximumError = Math.max(maximumError, Math.abs(next.readFloatLE(i) - old.readFloatLE(i)))
    expect(maximumError).toBeLessThanOrEqual(0.0000001)
    const names = await readdir(req.taskDirectory)
    expect(names.some(name => /^(prepared|body|join|fade)-/.test(name))).toBe(false)
    const info = await probeMedia(tools, result.filePath, undefined, true)
    expect(Number(info.streams.find(s => s.codec_type === 'video')?.nb_read_frames)).toBe(Math.ceil(Math.round(result.timeline.outputSeconds * 48000) * 30 / 48000))
    const packets = JSON.parse((await runTool(tools.ffprobe, ['-v', 'error', '-i', result.filePath, '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json'])).stdout) as { packets: Array<{ pts_time: string; dts_time: string; flags: string }> }
    for (const [index, packet] of packets.packets.entries()) {
      expect(Math.abs(Number(packet.pts_time) - index / 30)).toBeLessThan(0.00001)
      expect(packet.dts_time).toBe(packet.pts_time)
      if (index % 30 === 0) expect(packet.flags).toContain('K')
    }
    console.info(`${transition}: sample count ${next.length / 8}, max error ${maximumError}, ${JSON.stringify(result.metrics)}`)
  })

  it('shares an atomically published cache between overlapping tasks and invalidates changed source bytes', async () => {
    const isolated = path.join(root, 'concurrent-cache'); await mkdir(isolated)
    const requests = await Promise.all([request(), request()])
    for (const req of requests) req.performance!.cacheDirectory = isolated
    const results = await Promise.all(requests.map(renderMedia))
    expect(results.every(result => result.metrics?.staticVideo)).toBe(true)
    const entries = await readdir(path.join(isolated, 'music-static-v4'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[0-9a-f]{64}$/)
    const warm = await request({ performance: requests[0].performance })
    expect((await renderMedia(warm)).metrics?.cacheHit).toBe(true)
    const changedImage = path.join(root, 'changed.png')
    await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'color=c=blue:s=320x240', '-frames:v', '1', changedImage])
    const changed = await request({ imagePath: changedImage, performance: requests[0].performance })
    expect((await renderMedia(changed)).metrics?.cacheHit).toBe(false)
    expect(await readdir(path.join(isolated, 'music-static-v4'))).toHaveLength(2)
  })

  it('rejects a corrupt cache entry without overwriting it; preserves originals and private task isolation', async () => {
    const isolated = path.join(root, 'corrupt-cache'); await mkdir(isolated)
    const req = await request(); req.performance!.cacheDirectory = isolated
    await renderMedia(req)
    const entry = (await readdir(path.join(isolated, 'music-static-v4')))[0]
    const segment = path.join(isolated, 'music-static-v4', entry, 'segment.mp4')
    await writeFile(segment, 'not a media file')
    const original = await hashMedia(image)
    const next = await renderMedia(await request({ performance: req.performance }))
    expect(next.metrics).toMatchObject({ staticVideo: true, cacheHit: false })
    expect(await readFile(segment, 'utf8')).toBe('not a media file')
    expect(await hashMedia(image)).toBe(original)
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

  it('falls back safely for nonlocal cache settings and never deletes a pre-existing output', async () => {
    const req = await request(); req.performance!.cacheDirectory = 'https://fake.invalid/cache'
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false })
    expect(result.metrics?.fallbacks).toHaveLength(1)
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
  if (result.metrics?.encoder === 'cpu') expect(result.metrics.fallbacks?.[0]).toMatchObject({ encoder: 'nvenc', stage: 'tools', exitCode: expect.any(Number), stderr: expect.any(String) })
})

it('re-encodes directly and repeats complete validation after a corrupted stream-copy result', async () => {
  const { writeFileSync } = await import('node:fs')
  const req = await request()
  let injected = false
  req.onStage = stage => {
    if (stage === 'validate' && !injected) { injected = true; writeFileSync(path.join(req.taskDirectory, 'video.partial.mp4'), 'fault injection only') }
  }
  const result = await renderMedia(req)
  expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [expect.objectContaining({ stage: 'validate' })] })
  expect((await probeMedia(tools, result.filePath, undefined, true)).streams.find(s => s.codec_type === 'video')?.nb_read_frames).toBe('151')
})
