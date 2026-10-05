import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveGeneratedAudio } from '../../src/main/generated-audio'
import { openCloudAudio } from '../../src/main/downloads'
import type { runTool } from '../../src/main/video/ffmpeg'

const { dns, tool } = vi.hoisted(() => ({ dns: vi.fn(), tool: vi.fn<typeof runTool>() }))
vi.mock('node:dns/promises', () => ({ lookup: dns }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), runTool: tool }))
// Exercise the exact production streaming counter without writing a GiB in a unit test.
vi.mock('../../src/main/storage/library-validation', async original => {
  const real = await original<typeof import('../../src/main/storage/library-validation')>()
  return { ...real, LIBRARY_LIMITS: { ...real.LIBRARY_LIMITS, audioBytes: 1024 } }
})
let root: string
let directory: string
let executable: string
const url = 'https://cdn.example.com/audio?signature=synthetic'
const wav = Buffer.alloc(100)
wav.write('RIFF'); wav.write('WAVE', 8)
const probe = (seconds = '1.25') => ({ streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, duration: seconds }], format: { format_name: 'wav', duration: seconds } })
const success = async (_file: string, args: string[], limits: Parameters<typeof runTool>[2]) => {
  if (args.includes('-show_streams')) return { stdout: JSON.stringify(probe()), stderr: '' }
  limits?.onProgress?.(1.25)
  return { stdout: '', stderr: '' }
}
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'generated-audio-unit-'))
  directory = join(root, 'project'); await mkdir(directory)
  const bin = join(root, 'bin'); await mkdir(bin)
  executable = join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  await writeFile(executable, 'fixture - never executed')
  await writeFile(join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), 'fixture - never executed')
  dns.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  tool.mockReset().mockImplementation(success)
})
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })
const input = (assetId = randomUUID(), fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(wav)))) => ({ directory, assetId, url, fetcher, getFFmpegPath: () => executable })

describe('generated audio budgets and local storage boundaries', () => {
  it('enforces the streamed byte limit independently of Content-Length and cancels oversized bodies', async () => {
    const cancel = vi.fn(); const chunk = new Uint8Array(600)
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk) }, cancel })
    const options = input(randomUUID(), vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
    await expect(saveGeneratedAudio(options)).rejects.toThrow('1 GiB')
    expect(cancel).toHaveBeenCalledTimes(1); expect(tool).not.toHaveBeenCalled()
    expect(await readdir(join(directory, 'audio'))).toEqual([])
    expect(await readdir(join(directory, '.generated-audio', options.assetId))).toEqual(['manifest.json'])
  })

  it('uses explicit demux/protocol guards and caps probing, decoding, and diagnostic capture', async () => {
    const options = input(); expect((await saveGeneratedAudio(options)).durationMs).toBe(1250)
    expect(tool).toHaveBeenCalledTimes(2)
    const [, probeArgs, probeLimits] = tool.mock.calls[0]
    const [, decodeArgs, decodeLimits] = tool.mock.calls[1]
    for (const args of [probeArgs, decodeArgs]) {
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe')
      expect(args[args.indexOf('-format_whitelist') + 1]).toBe('wav')
      expect(args[args.indexOf('-f') + 1]).toBe('wav')
      expect(args.join(' ')).not.toContain('https://')
    }
    expect(probeLimits).toMatchObject({ timeoutMs: 60000, maxOutputBytes: 512 * 1024 })
    expect(decodeLimits).toMatchObject({ timeoutMs: 20 * 60 * 1000, maxOutputBytes: 64 * 1024 })
    expect(decodeLimits?.signal).toBeInstanceOf(AbortSignal)
    expect(decodeArgs).toContain('-xerror'); expect(decodeArgs[decodeArgs.indexOf('-t') + 1]).toBe('21601')
    expect(decodeArgs).not.toContain('-af'); expect(decodeArgs).not.toContain('-ss')
  })

  it.each(['0', '21601', 'Infinity', 'NaN'])('rejects an invalid/out-of-budget probed duration %s before decoding', async seconds => {
    tool.mockResolvedValue({ stdout: JSON.stringify(probe(seconds)), stderr: '' })
    await expect(saveGeneratedAudio(input())).rejects.toThrow('6 小时')
    expect(tool).toHaveBeenCalledTimes(1)
  })

  it('rejects a forged duration instead of accepting a short decode', async () => {
    tool.mockImplementation(async (file, args, limits) => args.includes('-show_streams') ? { stdout: JSON.stringify(probe('10')), stderr: '' } : success(file, args, limits))
    await expect(saveGeneratedAudio(input())).rejects.toThrow('解码时长与探测不符')
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it('enforces a 10-minute whole-response deadline even when an injected fetcher ignores cancellation', async () => {
    vi.useFakeTimers()
    let requested!: () => void; const ready = new Promise<void>(resolve => { requested = resolve })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { requested(); return new Promise(() => undefined) })
    const options = input(randomUUID(), fetcher)
    const failed = expect(saveGeneratedAudio(options)).rejects.toThrow()
    await ready; await vi.advanceTimersByTimeAsync(10 * 60 * 1000); await failed
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readdir(join(directory, '.generated-audio', options.assetId))).toEqual(['manifest.json'])
  })

  it('forwards cancellation to its processing subprocess and retains a completed receive for recovery', async () => {
    const controller = new AbortController()
    let decoding!: () => void; const ready = new Promise<void>(resolve => { decoding = resolve })
    tool.mockImplementation(async (file, args, limits) => {
      if (args.includes('-show_streams')) return success(file, args, limits)
      decoding()
      return new Promise((_resolve, reject) => limits!.signal!.addEventListener('abort', () => reject(new Error('private subprocess details')), { once: true }))
    })
    const options = input(); const failure = expect(saveGeneratedAudio({ ...options, signal: controller.signal })).rejects.toThrow('取消')
    await ready; controller.abort(); await failure
    expect(await readFile(join(directory, '.generated-audio', options.assetId, 'source.bin'))).toEqual(wav)
    tool.mockImplementation(success)
    expect((await saveGeneratedAudio(options)).fileName).toBe(`audio/${options.assetId}.wav`)
    expect(options.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['.generated-audio', 'audio'])('rejects a redirected %s parent before any download and leaves unrelated files alone', async folder => {
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'unrelated')
    await symlink(outside, join(directory, folder), process.platform === 'win32' ? 'junction' : 'dir')
    const options = input()
    await expect(saveGeneratedAudio(options)).rejects.toThrow()
    expect(options.fetcher).not.toHaveBeenCalled(); expect(await readdir(outside)).toEqual(['keep.txt'])
  })

  it('bounds and validates recovery metadata and never removes an unowned staging file', async () => {
    for (const manifest of ['x'.repeat(8193), JSON.stringify({ version: 1, assetId: 'wrong', source: { path: '../outside' } })]) {
      const options = input(); const work = join(directory, '.generated-audio', options.assetId)
      await mkdir(work, { recursive: true }); await writeFile(join(work, 'manifest.json'), manifest)
      await expect(saveGeneratedAudio(options)).rejects.toThrow()
      expect(options.fetcher).not.toHaveBeenCalled(); expect(await readFile(join(work, 'manifest.json'), 'utf8')).toBe(manifest)
    }
    const options = input(); const work = join(directory, '.generated-audio', options.assetId)
    await mkdir(work, { recursive: true }); await writeFile(join(work, 'download.part'), 'not ours')
    await expect(saveGeneratedAudio(options)).rejects.toThrow()
    expect(options.fetcher).not.toHaveBeenCalled(); expect(await readFile(join(work, 'download.part'), 'utf8')).toBe('not ours')
  })
})

describe('new cloud streaming entry point retains old transport protections', () => {
  it('returns an unread stream, validates all DNS results, and never sends credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(wav)))
    const opened = await openCloudAudio(url, new AbortController().signal, fetcher)
    expect(opened.bodyUsed).toBe(false); expect(opened.body?.locked).toBe(false)
    const init = fetcher.mock.calls[0][1]
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', method: 'GET' })
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    await opened.body?.cancel()
    dns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.2', family: 4 }])
    await expect(openCloudAudio(url, new AbortController().signal, fetcher)).rejects.toThrow('非公网')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['http://127.0.0.1/audio', 'https://169.254.169.254/audio', 'https://user:secret@example.com/a', 'file:///private', 'https://[::1]/a'])('refuses cloud target %s before transport', async unsafe => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(openCloudAudio(unsafe, new AbortController().signal, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled(); expect(dns).not.toHaveBeenCalled()
  })

  it('rechecks redirect addresses and cancels the rejected response body', async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: 'https://10.0.0.1/private' } }))
    await expect(openCloudAudio(url, new AbortController().signal, fetcher)).rejects.toThrow('公网')
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1)
  })
})
