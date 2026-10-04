import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'
import { AppError } from '../../src/main/providers/http'
import { assertLocalMediaFile, CancelledError, discoverTools, probeMedia, requireTools, runTool } from '../../src/main/video/ffmpeg'
import { renderMedia, type RenderRequest } from '../../src/main/video/pipeline'
import { calculateTimeline } from '../../src/main/video/timeline'
import { calculateTimeline as sharedTimeline } from '../../src/shared/video-timeline'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: spawnMock }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})

class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 123
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  kill = vi.fn((_signal: string) => { this.killed = true; return true })
  close(code: number | null = 0): void { this.exitCode = code; this.emit('close', code) }
}
let root: string
let ffmpeg: string
let ffprobe: string
let media: string
let children: Child[]
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
const encoders = ' V....D libx264 H264\n A....D aac AAC\n'
const filters = ['acrossfade', 'afade', 'loudnorm', 'alimiter', 'scale', 'pad', 'crop'].map(name => ` ... ${name} A->A`).join('\n')
const validProbe = { streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, duration: '1.250000' }], format: { duration: '10.000000' } }
function autoOutput(output: (tool: string, args: string[]) => string): void {
  spawnMock.mockImplementation((tool: string, args: string[]) => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => { child.stdout.write(output(tool, args)); child.close() })
    return child
  })
}
function toolsOutput(tool: string, args: string[]): string {
  if (args.includes('-version')) return `${path.basename(tool).startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 9.0-test\n`
  if (args.includes('-encoders')) return encoders
  return filters
}
async function running(): Promise<Child> {
  await vi.waitFor(() => expect(children).toHaveLength(1))
  return children[0]
}
function request(patch: Partial<RenderRequest> = {}): RenderRequest {
  return {
    tools: { ffmpeg, ffprobe }, draft: { ...DEFAULT_VIDEO, audioIds: ids, durationMode: 'all', transition: 'cut', fadeInSeconds: 1, fadeOutSeconds: 1 },
    tracks: ids.map(id => ({ id, path: media, durationSeconds: 8 })), taskDirectory: root, kind: 'preview', boundaryIndex: 0,
    signal: new AbortController().signal, ...patch
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'video-unit-'))
  ffmpeg = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  ffprobe = path.join(root, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  media = path.join(root, '中文 音乐 & data.wav')
  await Promise.all([ffmpeg, ffprobe, media].map(file => writeFile(file, 'unit fixture')))
})
beforeEach(() => {
  children = []
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => { const child = new Child(); children.push(child); return child })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('tool discovery and process boundary', () => {
  it.each(['ffmpeg', 'https://host/ffmpeg.exe', 'cmd.exe', 'ffmpeg.cmd', 'ffmpeg.bat'])('rejects unsafe executable %s without spawning', async file => {
    await expect(runTool(file.includes('.') && !file.includes('/') ? path.join(root, file) : file, [])).rejects.toBeInstanceOf(AppError)
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('ignores empty, relative and current-directory PATH entries rather than using a shell search', async () => {
    vi.stubEnv('PATH', ['', '.', 'relative', ''].join(path.delimiter))
    expect((await discoverTools()).available).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('requires a real adjacent ffprobe and verifies versions, encoders and every required filter', async () => {
    autoOutput(toolsOutput)
    expect(await discoverTools(ffmpeg)).toMatchObject({ available: true, ffmpeg, ffprobe, version: 'ffmpeg version 9.0-test' })
    expect(spawnMock).toHaveBeenCalledTimes(4)
    await expect(requireTools(ffmpeg)).resolves.toEqual({ ffmpeg, ffprobe })
  })
  it.each(['aac', 'libx264', 'acrossfade', 'afade', 'loudnorm', 'alimiter', 'scale', 'pad', 'crop'])('reports missing capability %s', async name => {
    autoOutput((tool, args) => toolsOutput(tool, args).split('\n').filter(line => !line.includes(` ${name} `)).join('\n'))
    expect(await discoverTools(ffmpeg)).toMatchObject({ available: false, message: expect.stringContaining(name) })
  })
  it('fails missing companion and invalid version instead of inventing status', async () => {
    await rm(ffprobe)
    try { await expect(requireTools(ffmpeg)).rejects.toBeInstanceOf(AppError); expect(spawnMock).not.toHaveBeenCalled() }
    finally { await writeFile(ffprobe, 'unit fixture') }
    autoOutput(() => 'not a media tool')
    expect((await discoverTools(ffmpeg)).available).toBe(false)
  })
  it('uses spawn argv, no shell, hidden windows and ignored stdin, retaining bounded output tails', async () => {
    const onProgress = vi.fn()
    const args = ['-nostdin', '-i', media, '-progress', 'pipe:1']
    const pending = runTool(ffmpeg, args, { onProgress, maxOutputBytes: 64 })
    const child = await running()
    child.stdout.write('out_time_us=12')
    child.stdout.write('50000\nout_time_ms=1250000\nout_time=00:00:02.500000\n')
    child.stdout.write('x'.repeat(100000) + '\nprogress=end\n')
    child.stderr.write('z'.repeat(100000) + '诊断尾部')
    child.close()
    const result = await pending
    expect(spawnMock.mock.calls[0]).toEqual([ffmpeg, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }])
    expect(onProgress.mock.calls).toEqual([[1.25], [2.5]])
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64)
    expect(result.stdout.endsWith('progress=end\n')).toBe(true)
    expect(result.stderr.endsWith('诊断尾部')).toBe(true)
  })
  it('does not start an already cancelled request', async () => {
    await expect(runTool(ffmpeg, [], { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError)
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('kills only the live held child and settles cancellation after close, removing listeners', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const unrelated = new Child()
    let settled = false
    const pending = runTool(ffmpeg, [], { signal: controller.signal }).catch(error => { settled = true; return error as unknown })
    const child = await running()
    controller.abort()
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(unrelated.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    child.close(null)
    expect(await pending).toBeInstanceOf(CancelledError)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it('does not kill an exited child or a process after normal close', async () => {
    const controller = new AbortController()
    const pending = runTool(ffmpeg, [], { signal: controller.signal }).catch(error => error as unknown)
    const child = await running()
    child.exitCode = 0
    controller.abort()
    expect(child.kill).not.toHaveBeenCalled()
    child.close()
    expect(await pending).toBeInstanceOf(CancelledError)
    children = []
    const after = new AbortController()
    const done = runTool(ffmpeg, [], { signal: after.signal, timeoutMs: 1000 })
    const exited = await running()
    exited.close()
    await done
    after.abort()
    expect(exited.kill).not.toHaveBeenCalled()
  })
  it('timeouts terminate only their child, reject after close, and enforce the two-hour maximum', async () => {
    const pending = runTool(ffmpeg, [], { timeoutMs: 5 }).catch(error => error as unknown)
    const child = await running()
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce())
    child.close(null)
    expect(await pending).toMatchObject({ message: expect.stringContaining('超时') })
    await expect(runTool(ffmpeg, [], { timeoutMs: 7200001 })).rejects.toBeInstanceOf(AppError)
  })
  it('handles spawn errors on close and does not leak arbitrary diagnostics into AppError.message', async () => {
    const pending = runTool(ffmpeg, []).catch(error => error as Error)
    const child = await running()
    child.emit('error', new Error('private path'))
    child.stderr.write('secret text')
    child.close(1)
    const error = await pending as Error
    expect(error).toBeInstanceOf(AppError)
    expect(error.message).not.toMatch(/secret|private/)
  })
})

describe('strict local FFprobe contract', () => {
  it('prefers valid audio stream duration and uses only local input protocols', async () => {
    autoOutput(() => JSON.stringify(validProbe))
    expect(await probeMedia({ ffmpeg, ffprobe }, media)).toMatchObject({ durationSeconds: 1.25 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-show_streams')
    expect(args).toContain('-show_format')
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe')
  })
  it('permits durationless static images and container fallback for audio', async () => {
    autoOutput(() => JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width: 32, height: 64, r_frame_rate: '25/1' }], format: {} }))
    expect((await probeMedia({ ffmpeg, ffprobe }, media)).durationSeconds).toBe(0)
    autoOutput(() => JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '2.3' } }))
    expect((await probeMedia({ ffmpeg, ffprobe }, media)).durationSeconds).toBe(2.3)
  })
  it('counts actual image frames even when a still JPEG has nominal container duration', async () => {
    autoOutput(() => JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 1280, height: 720, duration: '0.04', nb_read_frames: '1' }], format: { duration: '0.04' } }))
    const info = await probeMedia({ ffmpeg, ffprobe }, media, undefined, true)
    expect(info).toMatchObject({ durationSeconds: 0.04, streams: [expect.objectContaining({ nb_read_frames: '1' })] })
    expect(spawnMock.mock.calls[0][1]).toContain('-count_frames')
  })

  it.each([
    { streams: [{ codec_type: 'audio', duration: 'Infinity' }] },
    { streams: [{ codec_type: 'audio', duration: '3oops' }] },
    { streams: [{ codec_type: 'audio', duration: '-1' }] },
    { streams: [{ codec_type: 'audio' }], format: { duration: 'NaN' } },
    { streams: [{ codec_type: 'video', width: 3.5, height: 10 }] },
    { streams: [{ codec_type: 'video', width: 2147483647, height: 10 }] },
    { streams: [{ codec_type: 'video', width: 32, height: 32, nb_read_frames: '-1' }] },
    { streams: [{ codec_type: 'video', width: 32, height: 32, nb_read_frames: 'N/A' }] },
    { streams: [] }
  ])('rejects invalid probe information %#', async result => {
    autoOutput(() => JSON.stringify(result))
    await expect(probeMedia({ ffmpeg, ffprobe }, media)).rejects.toBeInstanceOf(AppError)
  })
  it('rejects missing files, URLs, network shares and non-JSON output', async () => {
    for (const file of ['https://host/a.wav', '\\\\host\\a.wav', path.join(root, 'missing.wav')]) await expect(assertLocalMediaFile(file)).rejects.toBeInstanceOf(AppError)
    expect(spawnMock).not.toHaveBeenCalled()
    autoOutput(() => '{truncated')
    await expect(probeMedia({ ffmpeg, ffprobe }, media)).rejects.toBeInstanceOf(AppError)
  })
})

describe('render preflight and shared timeline', () => {
  it('reexports exactly the pure shared timeline, not a divergent implementation', () => {
    expect(calculateTimeline).toBe(sharedTimeline)
    const req = request()
    expect(calculateTimeline(req.draft, req.tracks).outputSeconds).toBe(16)
  })
  it('rejects invalid settings, insufficient music, unregistered IDs and conflicting fade windows before spawning', async () => {
    const original = request()
    await expect(renderMedia(request({ draft: { ...original.draft, transitionSeconds: NaN } }))).rejects.toBeInstanceOf(AppError)
    await expect(renderMedia(request({ draft: { ...original.draft, durationMode: 'target', targetSeconds: 60 } }))).rejects.toThrow('不足')
    await expect(renderMedia(request({ tracks: original.tracks.slice(0, 1) }))).rejects.toThrow('登记')
    await expect(renderMedia(request({ draft: { ...original.draft, transition: 'fade', transitionSeconds: 8 } }))).rejects.toThrow('太短')
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('rejects a boundary clipped by the target instead of manufacturing a preview', async () => {
    const req = request()
    await expect(renderMedia(request({ draft: { ...req.draft, durationMode: 'target', targetSeconds: 60, transition: 'crossfade', transitionSeconds: 3 }, tracks: req.tracks.map((track, i) => ({ ...track, durationSeconds: i ? 10 : 61 })) }))).rejects.toThrow('截断')
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('preflights conservative disk capacity before preparing or altering source files', async () => {
    const source = await readFile(media)
    vi.mocked(statfs).mockResolvedValueOnce({ bavail: 0n, bsize: 4096n } as Awaited<ReturnType<typeof statfs>>)
    await expect(renderMedia(request())).rejects.toThrow('磁盘空间不足')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await readFile(media)).toEqual(source)
  })
  it('cancels preflight before any child is started', async () => {
    await expect(renderMedia(request({ signal: AbortSignal.abort() }))).rejects.toBeInstanceOf(CancelledError)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
