import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { saveImageBytes } from '../../src/main/downloads'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { VideoDraft } from '../../src/shared/types'
import { AppError } from '../../src/main/providers/http'
import { CancelledError, discoverTools, probeMedia, requireTools, runTool, type VideoTools } from '../../src/main/video/ffmpeg'
import { renderMedia, type RenderProgress, type RenderRequest, type RenderTrack } from '../../src/main/video/pipeline'

// Opt-in: npx vitest run --config vitest.integration.config.ts
// FFMPEG_PATH may select a real local executable. No HTTP, paid API, downloads, or workspace fixtures.
let tools: VideoTools
let root: string
let imagePath: string
let tracks: RenderTrack[]
let originalHashes: string[]
const frequencies = [440, 660, 880]
const base = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2']
async function hash(file: string): Promise<string> { return createHash('sha256').update(await readFile(file)).digest('hex') }
async function tone(name: string, frequency: number, seconds: number, rate = 48000, channels = 2, volume = 1): Promise<RenderTrack> {
  const file = path.join(root, name)
  await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=${seconds}`, '-af', `volume=${volume}`, '-ac', String(channels), '-c:a', 'pcm_s16le', file])
  const info = await probeMedia(tools, file)
  return { id: randomUUID(), path: file, durationSeconds: info.durationSeconds }
}
async function request(draft: Partial<VideoDraft> = {}, extra: Partial<RenderRequest> = {}): Promise<RenderRequest> {
  return {
    tools, draft: { ...DEFAULT_VIDEO, initialized: true, audioIds: tracks.map(track => track.id), imageId: randomUUID(), durationMode: 'all', transitionSeconds: 0.75, fadeInSeconds: 0.5, fadeOutSeconds: 0.5, ...draft },
    tracks, imagePath, taskDirectory: await mkdtemp(path.join(root, '.work-')), kind: 'video', signal: new AbortController().signal, ...extra
  }
}
async function audioSamples(file: string, start = 0, seconds = 30): Promise<Float32Array> {
  const output = path.join(root, `${randomUUID()}.f32`)
  await runTool(tools.ffmpeg, [...base, '-ss', String(start), '-protocol_whitelist', 'file,pipe', '-i', file, '-t', String(seconds), '-map', '0:a:0', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', output])
  const bytes = await readFile(output)
  const values = new Float32Array(bytes.length / 4)
  for (let index = 0; index < values.length; index++) values[index] = bytes.readFloatLE(index * 4)
  return values
}
function rms(data: Float32Array, start: number, seconds = 0.1): number {
  const first = Math.round(start * 48000)
  const last = Math.min(data.length, first + Math.round(seconds * 48000))
  let sum = 0
  for (let i = first; i < last; i++) sum += data[i] ** 2
  return Math.sqrt(sum / (last - first))
}
function amplitude(data: Float32Array, frequency: number, start: number, seconds = 0.1): number {
  const first = Math.round(start * 48000)
  const count = Math.round(seconds * 48000)
  let real = 0
  let imaginary = 0
  for (let i = 0; i < count; i++) {
    const phase = 2 * Math.PI * frequency * i / 48000
    real += data[first + i] * Math.cos(phase)
    imaginary += data[first + i] * Math.sin(phase)
  }
  return 2 * Math.hypot(real, imaginary) / count
}
async function frame(file: string, seconds: number): Promise<Buffer> {
  const output = path.join(root, `${randomUUID()}.rgb`)
  await runTool(tools.ffmpeg, [...base, '-ss', String(seconds), '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=192:108', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output])
  return readFile(output)
}

beforeAll(async () => {
  tools = await requireTools(process.env.FFMPEG_PATH)
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'video-integration-中文 空格 & '))
  console.info(`Real FFmpeg fixtures: ${root}`)
  imagePath = path.join(root, '静态 图像.png')
  await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'color=c=0xCC3366:size=320x240,drawbox=x=64:y=40:w=128:h=100:color=0x22CC66:t=fill', '-frames:v', '1', imagePath])
  tracks = [
    await tone('第一首 440Hz.wav', 440, 3, 44100, 1),
    await tone('第二首 & 660Hz.wav', 660, 3, 32000, 2),
    await tone('第三首 880Hz.wav', 880, 3, 48000, 1)
  ]
  originalHashes = await Promise.all([imagePath, ...tracks.map(track => track.path)].map(hash))
})
afterAll(async () => { if (root && process.env.VIDEO_ENGINE_KEEP !== '1') await rm(root, { recursive: true, force: true }) })

describe('real independent video engine', () => {
  it('detects the real version, required encoders/filters, image dimensions and actual source durations', async () => {
    const status = await discoverTools(tools.ffmpeg)
    expect(status.available).toBe(true)
    expect(status.version).toMatch(/^ffmpeg version /)
    console.info(status.version)
    expect(await probeMedia(tools, imagePath)).toMatchObject({ durationSeconds: 0, streams: [expect.objectContaining({ width: 320, height: 240, codec_name: 'png' })] })
    for (let i = 0; i < tracks.length; i++) {
      const probe = await probeMedia(tools, tracks[i].path)
      expect(probe.durationSeconds).toBeCloseTo(3, 4)
      expect(probe.streams[0].sample_rate).toBe(String([44100, 32000, 48000][i]))
      expect(probe.streams[0].channels).toBe([1, 2, 1][i])
    }
  })

  it.each(['cut', 'fade', 'crossfade'] as const)('renders %s: duration, 1080p30 streams, order/envelopes, static picture and matching preview', async transition => {
    const events: RenderProgress[] = []
    const req = await request({ transition, fit: transition === 'fade' ? 'cover' : 'contain' }, { onProgress: event => events.push(event) })
    const started = Date.now()
    const result = await renderMedia(req)
    const expected = transition === 'crossfade' ? 7.5 : 9
    console.info(`${transition}: ${result.durationSeconds}s, render+decode ${Date.now() - started}ms`)
    expect(Math.abs(result.durationSeconds - expected)).toBeLessThanOrEqual(0.1)
    expect(path.dirname(result.filePath)).toBe(req.taskDirectory)
    expect(path.basename(result.filePath)).toBe('video.partial.mp4')
    const probe = await probeMedia(tools, result.filePath)
    expect(probe.streams).toHaveLength(2)
    expect(probe.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '30/1' })
    expect(probe.streams.find(stream => stream.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', channels: 2, sample_rate: '48000' })
    expect(events.some(event => event.status === 'validating')).toBe(true)
    expect(events.every((event, index) => event.progress! < 1 && (index === 0 || event.progress! >= events[index - 1].progress!))).toBe(true)
    expect(events.some(event => event.status === 'succeeded')).toBe(false)

    const audio = await audioSamples(result.filePath)
    for (let i = 0; i < tracks.length; i++) {
      const start = result.timeline.tracks[i].startSeconds + 1.25
      const own = amplitude(audio, frequencies[i], start)
      for (const other of frequencies.filter(f => f !== frequencies[i])) expect(own).toBeGreaterThan(amplitude(audio, other, start) * 10)
    }
    const level = rms(audio, 1)
    expect(rms(audio, 0.01, 0.05)).toBeLessThan(level * 0.3)
    expect(rms(audio, expected - 0.08, 0.05)).toBeLessThan(rms(audio, expected - 1) * 0.35)
    if (transition === 'cut') {
      expect(rms(audio, 2.9, 0.08)).toBeGreaterThan(level * 0.8)
      expect(amplitude(audio, 660, 3.05)).toBeGreaterThan(amplitude(audio, 440, 3.05) * 10)
    } else if (transition === 'fade') {
      expect(rms(audio, 2.9, 0.08)).toBeLessThan(level * 0.25)
      expect(rms(audio, 3.02, 0.05)).toBeLessThan(rms(audio, 4) * 0.25)
    } else {
      expect(amplitude(audio, 440, 2.575)).toBeGreaterThan(amplitude(audio, 440, 1) * 0.5)
      expect(amplitude(audio, 660, 2.575)).toBeGreaterThan(amplitude(audio, 660, 3.5) * 0.5)
    }

    const first = await frame(result.filePath, 0)
    for (const second of [await frame(result.filePath, expected / 2), await frame(result.filePath, expected - 0.1)]) {
      expect(first.length).toBe(192 * 108 * 3)
      expect(second.length).toBe(first.length)
      let difference = 0
      for (let index = 0; index < first.length; index++) difference += Math.abs(first[index] - second[index])
      expect(difference / first.length).toBeLessThan(1.5) // tolerate tiny I/P-frame encoder differences
    }
    const edge = (54 * 192 + 2) * 3
    if (req.draft.fit === 'contain') expect(first[edge] + first[edge + 1] + first[edge + 2]).toBeLessThan(15)
    else expect(first[edge] + first[edge + 1] + first[edge + 2]).toBeGreaterThan(150)

    const previewReq = await request(req.draft, { kind: 'preview', boundaryIndex: 1 })
    const preview = await renderMedia(previewReq)
    expect(preview.durationSeconds).toBeLessThan(30)
    const previewProbe = await probeMedia(tools, preview.filePath)
    expect(previewProbe.streams).toEqual([expect.objectContaining({ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 })])
    const start = Math.max(0, result.timeline.tracks[2].startSeconds - 5)
    const fromVideoMaster = await audioSamples(path.join(req.taskDirectory, 'master.wav'), start, preview.durationSeconds)
    const fromPreview = await audioSamples(preview.filePath)
    expect(fromPreview.length).toBe(fromVideoMaster.length)
    let error = 0
    for (let i = 0; i < fromPreview.length; i++) error = Math.max(error, Math.abs(fromPreview[i] - fromVideoMaster[i]))
    expect(error).toBeLessThan(0.00006)
  })

  it.each(['png', 'jpeg', 'webp'] as const)('decodes and preserves %s source bytes, then renders contain and cover', async format => {
    const source = sharp(imagePath)
    if (format === 'jpeg') source.resize(1280, 960) // larger JPEG reproduces image2's nominal single-frame duration
    const bytes = await source.toFormat(format).toBuffer()
    const saved = await saveImageBytes(bytes, root, randomUUID())
    const picture = path.join(root, saved.fileName)
    expect(await readFile(picture)).toEqual(bytes)
    expect((await probeMedia(tools, picture, undefined, true)).streams[0].nb_read_frames).toBe('1')
    for (const fit of ['contain', 'cover'] as const) {
      const req = await request({ fit, transition: 'cut', audioIds: [tracks[0].id] }, { tracks: [tracks[0]], imagePath: picture })
      const result = await renderMedia(req)
      expect(result.durationSeconds).toBeCloseTo(3, 1)
      const probe = await probeMedia(tools, result.filePath)
      expect(probe.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ width: 1920, height: 1080, codec_name: 'h264' })
      const first = await frame(result.filePath, 0.5)
      const last = await frame(result.filePath, 2.5)
      expect(first.reduce((sum, value, i) => sum + Math.abs(value - last[i]), 0) / first.length).toBeLessThan(1.5)
      const edge = (54 * 192 + 2) * 3
      const light = first[edge] + first[edge + 1] + first[edge + 2]
      expect(fit === 'contain' ? light < 15 : light > 150).toBe(true)
    }
    expect(await readFile(picture)).toEqual(bytes)
  })

  it('normalizes full tracks with two-pass EBU measurements and handles silent -inf without NaN or gain compensation', async () => {
    const quiet = await tone('quiet.wav', 440, 4, 44100, 1, 0.05)
    const silentPath = path.join(root, 'silence.wav')
    await runTool(tools.ffmpeg, [...base, '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '4', '-c:a', 'pcm_s16le', silentPath])
    const silent: RenderTrack = { id: randomUUID(), path: silentPath, durationSeconds: 4 }
    const req = await request({ audioIds: [quiet.id, silent.id], transition: 'cut', normalize: true, fadeInSeconds: 0, fadeOutSeconds: 0 }, { tracks: [quiet, silent], kind: 'preview', boundaryIndex: 0 })
    const result = await renderMedia(req)
    const normalScript = await readFile(path.join(req.taskDirectory, 'prepare-0.filter.txt'), 'utf8')
    expect(normalScript).toMatch(/loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=/)
    expect(normalScript).toContain('linear=true')
    const silenceScript = await readFile(path.join(req.taskDirectory, 'prepare-1.filter.txt'), 'utf8')
    expect(silenceScript).not.toMatch(/loudnorm|inf|NaN/)
    const normalized = await runTool(tools.ffmpeg, [...base, '-loglevel', 'info', '-i', path.join(req.taskDirectory, 'prepared-000.wav'), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'])
    const measured = /"input_i"\s*:\s*"([\d.-]+)"/.exec(normalized.stderr)
    expect(measured).not.toBeNull()
    expect(Math.abs(Number(measured![1]) + 16)).toBeLessThan(0.5)
    const audio = await audioSamples(result.filePath)
    expect(rms(audio, 1)).toBeGreaterThan(0.1)
    expect(rms(audio, 6)).toBe(0)
  })

  it('trims the master to a 60s target BEFORE its final fade; the short preview includes the identical trimmed end', async () => {
    const first = await tone('target first.wav', 440, 57)
    const last = await tone('target last.wav', 880, 8, 44100, 1)
    const req = await request({ audioIds: [first.id, last.id], transition: 'cut', durationMode: 'target', targetSeconds: 60, fadeOutSeconds: 2 }, { tracks: [first, last], kind: 'preview', boundaryIndex: 0 })
    const result = await renderMedia(req)
    expect(result.timeline.outputSeconds).toBe(60)
    expect(result.timeline.tracks[1].usedSeconds).toBe(3)
    expect(result.durationSeconds).toBeCloseTo(8, 3)
    expect((await probeMedia(tools, path.join(req.taskDirectory, 'master.wav'))).durationSeconds).toBeCloseTo(60, 3)
    const audio = await audioSamples(result.filePath)
    expect(rms(audio, 7.92, 0.05)).toBeLessThan(rms(audio, 5.5) * 0.08)
    const script = await readFile(path.join(req.taskDirectory, 'master.filter.txt'), 'utf8')
    expect(script.indexOf('atrim=')).toBeLessThan(script.indexOf('afade=t=out'))
    expect(script).toContain('afade=t=out:st=58.00000000:d=2.00000000')
    expect(script).toContain('level=false:latency=true')
  })

  it('rebuilds timeline from decoded WAV duration and refuses overstated source length instead of padding', async () => {
    const req = await request({ transition: 'cut', durationMode: 'target', targetSeconds: 60 }, { tracks: tracks.map(track => ({ ...track, durationSeconds: 25 })), kind: 'preview', boundaryIndex: 0 })
    await expect(renderMedia(req)).rejects.toThrow('不足')
    expect((await readdir(req.taskDirectory)).some(name => name.includes('.partial.'))).toBe(false)
  })

  it('missing/corrupt tools or sources fail honestly and originals stay unchanged', async () => {
    expect((await discoverTools(path.join(root, 'missing', 'ffmpeg.exe'))).available).toBe(false)
    await expect(probeMedia(tools, path.join(root, 'missing.wav'))).rejects.toBeInstanceOf(AppError)
    const bad = path.join(root, 'corrupt.wav')
    await writeFile(bad, 'this is not media')
    await expect(probeMedia(tools, bad)).rejects.toBeInstanceOf(AppError)
    expect(await Promise.all([imagePath, ...tracks.map(track => track.path)].map(hash))).toEqual(originalHashes)
  })

  it('real cancellation waits for child close, leaves an unrelated FFmpeg alive and permits private-directory cleanup', async () => {
    const controller = new AbortController()
    const unrelated = runTool(tools.ffmpeg, [...base, '-re', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-f', 'null', '-'])
    const cancelled = runTool(tools.ffmpeg, [...base, '-progress', 'pipe:1', '-re', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=30', '-f', 'null', '-'], {
      signal: controller.signal, onProgress: seconds => { if (seconds > 0.1) controller.abort() }
    })
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError)
    await expect(unrelated).resolves.toHaveProperty('stdout')
    const duringRender = new AbortController()
    const req = await request({ transition: 'cut' }, { signal: duringRender.signal, onProgress: event => { if (event.status === 'encoding') duringRender.abort() } })
    await expect(renderMedia(req)).rejects.toBeInstanceOf(CancelledError)
    await rm(req.taskDirectory, { recursive: true, force: true }) // caller owns cleanup, and no child retains the output handle
    await mkdir(req.taskDirectory)
    expect(await readdir(req.taskDirectory)).toEqual([])
  })
})
