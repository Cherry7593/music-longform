import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { probeEncoder, clearEncoderProbeCache } from '../../src/main/video/encoders'
import { CancelledError } from '../../src/main/video/ffmpeg'

const mocks = vi.hoisted(() => ({ device: vi.fn(), tool: vi.fn(), probe: vi.fn() }))
vi.mock('../../src/main/video/encoder-device', () => ({ encoderDeviceIdentity: mocks.device }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), runTool: mocks.tool, probeMedia: mocks.probe }))
let root: string
const tools = { ffmpeg: 'fixture-ffmpeg.exe', ffprobe: 'fixture-ffprobe.exe' }
beforeEach(async () => {
  clearEncoderProbeCache(); vi.clearAllMocks()
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'encoder-cache-unit-'))
  mocks.device.mockResolvedValue('device-A-driver-1')
  mocks.tool.mockResolvedValue({ stdout: JSON.stringify({ frames: Array.from({ length: 30 }, (_, i) => ({ key_frame: i ? 0 : 1, pict_type: i ? 'P' : 'I', best_effort_timestamp_time: String(i / 30) })) }), stderr: '' })
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
})
