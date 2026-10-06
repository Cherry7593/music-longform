import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { probeEncoder, clearEncoderProbeCache, selectEncoder } from '../../src/main/video/encoders'
import { CancelledError } from '../../src/main/video/ffmpeg'

const mocks = vi.hoisted(() => ({ device: vi.fn(), tool: vi.fn(), probe: vi.fn() }))
vi.mock('../../src/main/video/encoder-device', () => ({ encoderDeviceIdentity: mocks.device }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), runTool: mocks.tool, probeMedia: mocks.probe }))
let root: string
const tools = { ffmpeg: 'fixture-ffmpeg.exe', ffprobe: 'fixture-ffprobe.exe' }
const frames = () => Array.from({ length: 30 }, (_, i) => ({ key_frame: i ? 0 : 1, pict_type: i ? 'P' : 'I', best_effort_timestamp_time: String(i / 30) }))
beforeEach(async () => {
  clearEncoderProbeCache(); vi.resetAllMocks()
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'encoder-cache-unit-'))
  mocks.device.mockResolvedValue('device-A-driver-1')
  mocks.tool.mockResolvedValue({ stdout: JSON.stringify({ frames: frames() }), stderr: '' })
  mocks.probe.mockResolvedValue({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '30/1', nb_read_frames: '30', duration: '1' }] })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const run = (identity = 'ffmpeg-fixture-version-1', threads = 2) => probeEncoder(tools, 'qsv', root, new AbortController().signal, threads, identity)

describe('hardware initialization evidence cache', () => {
  it('caches only actual validated evidence and invalidates device/driver, tool and thread changes', async () => {
    const first = await run(); expect(first.available).toBe(true); expect(mocks.tool).toHaveBeenCalledTimes(3); expect(mocks.probe).toHaveBeenCalledOnce()
    first.available = false
    expect((await run()).available).toBe(true); expect(mocks.tool).toHaveBeenCalledTimes(3)
    expect(mocks.device).toHaveBeenCalledTimes(2)
    mocks.device.mockResolvedValue('device-A-driver-2'); await run(); expect(mocks.tool).toHaveBeenCalledTimes(6)
    await run('ffmpeg-fixture-version-2'); expect(mocks.tool).toHaveBeenCalledTimes(9)
    await run('ffmpeg-fixture-version-2', 4); expect(mocks.tool).toHaveBeenCalledTimes(12)
  })
  it('expires successful hardware evidence after five minutes', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await run(); clock.mockReturnValue(300999); await run(); expect(mocks.tool).toHaveBeenCalledTimes(3)
    clock.mockReturnValue(301001); await run(); expect(mocks.tool).toHaveBeenCalledTimes(6)
  })
  it('keeps a short failure cache with diagnostics, then permits a real retest', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    mocks.tool.mockRejectedValueOnce(Object.assign(new Error('driver unavailable'), { diagnostic: { stage: 'tools', category: 'encoder-initialization', message: 'fixture driver mismatch', stderr: 'unsupported isolated driver' } }))
    const failed = await run(); expect(failed.available).toBe(false); expect(failed.diagnostic).toBeTruthy()
    expect((await run()).available).toBe(false); expect(mocks.tool).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(31001); expect((await run()).available).toBe(true); expect(mocks.tool).toHaveBeenCalledTimes(4)
  })
  it('does not reuse hardware success when device identity cannot be established', async () => {
    mocks.device.mockResolvedValue(undefined)
    await run(); await run(); expect(mocks.tool).toHaveBeenCalledTimes(6)
  })
  it('cancels before looking up or returning an encoder result', async () => {
    await expect(probeEncoder(tools, 'qsv', root, AbortSignal.abort(), 2, 'fixture')).rejects.toBeInstanceOf(CancelledError)
    expect(mocks.device).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled()
  })
  it('accepts B frames while keeping a 30-frame, one-second, keyframe-started fully decoded probe', async () => {
    const displayed = frames().map((frame, i) => ({ ...frame, pict_type: i && i % 3 ? 'B' : frame.pict_type }))
    mocks.tool.mockResolvedValue({ stdout: JSON.stringify({ frames: displayed }), stderr: '' })
    expect((await run()).available).toBe(true)
    expect(mocks.tool).toHaveBeenCalledTimes(3)
    const encode = mocks.tool.mock.calls[0][1] as string[]
    expect(encode[encode.indexOf('-frames:v') + 1]).toBe('30')
    expect(encode[encode.indexOf('-g') + 1]).toBe('300')
    expect(encode).not.toContain('-bf')
    expect(mocks.probe).toHaveBeenCalledWith(tools, expect.any(String), expect.any(AbortSignal), true, 2)
    const displayedProbe = mocks.tool.mock.calls[1][1] as string[]
    expect(displayedProbe).toContain('-show_frames')
    expect(displayedProbe[displayedProbe.indexOf('-show_entries') + 1]).toContain('key_frame')
    expect(displayedProbe[displayedProbe.indexOf('-show_entries') + 1]).toContain('best_effort_timestamp_time')
    const decode = mocks.tool.mock.calls[2][1] as string[]
    expect(decode).toEqual(expect.arrayContaining(['-xerror', '-err_detect', 'explode', '-map', '0:v:0', '-f', 'null', '-']))
    expect(decode).not.toContain('-t')
    expect(decode).not.toContain('-frames:v')
  })
  it.each(['count', 'keyframe', 'timestamp', 'nonfinite-timestamp'] as const)('does not relax %s frame validation when B frames are allowed', async fault => {
    const displayed = frames()
    displayed[1].pict_type = 'B'
    if (fault === 'count') displayed.pop()
    if (fault === 'keyframe') displayed[0].key_frame = 0
    if (fault === 'timestamp') displayed[12].best_effort_timestamp_time = '0.9'
    if (fault === 'nonfinite-timestamp') displayed[12].best_effort_timestamp_time = 'N/A'
    mocks.tool.mockResolvedValue({ stdout: JSON.stringify({ frames: displayed }), stderr: '' })
    expect(await run()).toMatchObject({ available: false, diagnostic: expect.any(Object) })
  })
  it.each([
    { nb_read_frames: '29' }, { duration: '1.2' }, { codec_name: 'hevc' }, { width: 1280 },
    { height: 720 }, { pix_fmt: 'yuv444p' }, { r_frame_rate: '25/1' }
  ])('still rejects invalid short-probe specifications %j', async patch => {
    mocks.probe.mockResolvedValue({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '30/1', nb_read_frames: '30', duration: '1', ...patch }] })
    expect((await run()).available).toBe(false)
    expect(mocks.tool).toHaveBeenCalledTimes(1)
  })
  it('rejects full-decoder errors rather than caching a spec-only success', async () => {
    mocks.tool.mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ frames: frames() }), stderr: '' })
      .mockRejectedValueOnce(new Error('fixture full decode failure'))
    expect(await run()).toMatchObject({ available: false, diagnostic: expect.any(Object) })
    expect(mocks.tool).toHaveBeenCalledTimes(3)
  })
  it('selects CPU after actual hardware initialization failure with evidence', async () => {
    mocks.tool.mockRejectedValueOnce(Object.assign(new Error('NVENC fixture unavailable'), { diagnostic: { stage: 'tools', category: 'encoder-initialization', exitCode: 1, stderr: 'Cannot load fixture driver' } }))
    const selected = await selectEncoder(tools, 'nvenc', root, new AbortController().signal, 2, 'fixture')
    expect(selected).toMatchObject({ encoder: 'cpu', statuses: [{ encoder: 'nvenc', available: false }, { encoder: 'cpu', available: true }],
      fallbacks: [expect.objectContaining({ encoder: 'nvenc', stage: 'tools', exitCode: 1 })] })
    expect(mocks.tool).toHaveBeenCalledTimes(4)
  })
  it('does not cache cancellation as hardware failure or retry it on CPU', async () => {
    mocks.tool.mockRejectedValueOnce(new CancelledError())
    await expect(selectEncoder(tools, 'qsv', root, new AbortController().signal, 2, 'fixture')).rejects.toBeInstanceOf(CancelledError)
    expect(mocks.tool).toHaveBeenCalledTimes(1)
    expect((await run('fixture')).available).toBe(true)
    expect(mocks.tool).toHaveBeenCalledTimes(4)
  })
})
