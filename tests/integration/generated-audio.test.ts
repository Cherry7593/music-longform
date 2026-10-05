import { createHash, randomUUID } from 'node:crypto'
import * as disk from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { saveGeneratedAudio, type SaveGeneratedAudioOptions } from '../../src/main/generated-audio'
import { fingerprintFile, validateMedia } from '../../src/main/library/imports'
import * as ffmpeg from '../../src/main/video/ffmpeg'

// Keep actual filesystem operations, but allow fault injection at the atomic publication boundary.
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

// Synthetic tones only: real FFmpeg/FFprobe and local TCP, never AI inference or paid APIs.
let root: string
let tools: ffmpeg.VideoTools
const fixtures = new Map<string, { file: string; bytes: Buffer }>()
const cloudURL = 'https://8.8.8.8/misleading.html?signature=fixture-only'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function context(): Promise<{ directory: string; assetId: string }> {
  const directory = await disk.mkdtemp(join(root, 'project-中文 & '))
  return { directory, assetId: randomUUID() }
}
function response(bytes: Buffer, headers?: HeadersInit): Response {
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return }
    const end = Math.min(offset + 4096, bytes.length)
    controller.enqueue(new Uint8Array(bytes.subarray(offset, end))); offset = end
  } }), { headers: { 'content-type': 'application/octet-stream', ...headers } })
}
function options(ctx: { directory: string; assetId: string }, format: string): SaveGeneratedAudioOptions & { fetcher: ReturnType<typeof vi.fn<typeof fetch>> } {
  return { ...ctx, url: cloudURL, getFFmpegPath: () => tools.ffmpeg, fetcher: vi.fn<typeof fetch>().mockImplementation(async () => response(fixtures.get(format)!.bytes)) }
}
const receiptPath = (ctx: { directory: string; assetId: string }) => join(ctx.directory, '.generated-audio', ctx.assetId, 'manifest.json')
async function fixture(name: string, codec: string, extra: string[] = []): Promise<void> {
  const file = join(root, `合成测试-${name}`)
  await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.25:sample_rate=48000', '-ac', '2', '-c:a', codec, ...extra, file])
  fixtures.set(name, { file, bytes: await disk.readFile(file) })
}
beforeAll(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await disk.mkdtemp(join(process.env.PI_SCRATCH_DIR, 'generated-audio-real-'))
  tools = await ffmpeg.requireTools(process.env.FFMPEG_PATH)
  for (const [name, codec] of [['tone.mp3', 'libmp3lame'], ['tone.wav', 'pcm_s16le'], ['tone.flac', 'flac'], ['tone.m4a', 'aac'], ['opus.mp4', 'libopus'], ['opus.ogg', 'libopus'], ['alac.m4a', 'alac'], ['vorbis.ogg', 'libvorbis']]) await fixture(name, codec)
  const multi = join(root, 'multiple-audio.mp4')
  await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.4', '-map', '0:a', '-map', '0:a', '-c:a', 'aac', multi])
  fixtures.set('multi.mp4', { file: multi, bytes: await disk.readFile(multi) })
  const video = join(root, 'video.mp4')
  await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.4', '-f', 'lavfi', '-i', 'color=size=16x16:duration=0.4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video])
  fixtures.set('video.mp4', { file: video, bytes: await disk.readFile(video) })
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { if (root) await disk.rm(root, { recursive: true, force: true }) })

describe('bounded new-provider generated audio with actual FFmpeg', () => {
  it.each(['mp3', 'wav', 'flac', 'm4a'])('preserves original %s bytes and real extension, verifies duration, and resumes without a request', async format => {
    const ctx = await context(); const input = options(ctx, `tone.${format}`)
    const saved = await saveGeneratedAudio(input)
    expect(saved).toEqual({ fileName: `audio/${ctx.assetId}.${format}`, durationMs: expect.any(Number) })
    expect(saved.durationMs).toBeGreaterThanOrEqual(1200); expect(saved.durationMs).toBeLessThan(1400)
    expect(await disk.readFile(join(ctx.directory, saved.fileName))).toEqual(fixtures.get(`tone.${format}`)!.bytes)
    const persisted = await disk.readFile(receiptPath(ctx), 'utf8')
    expect(persisted).not.toContain('signature'); expect(persisted).not.toContain(cloudURL)
    expect(Buffer.byteLength(persisted)).toBeLessThan(8192)
    input.fetcher.mockRejectedValue(new Error('must not redownload'))
    expect(await saveGeneratedAudio({ ...input, url: 'https://8.8.8.8/new-signature', getFFmpegPath: () => undefined })).toEqual(saved)
    expect(input.fetcher).toHaveBeenCalledTimes(1)
    const headers = new Headers(input.fetcher.mock.calls[0][1]?.headers)
    expect(headers.has('authorization')).toBe(false); expect(headers.has('x-api-key')).toBe(false)
    const target = join(ctx.directory, saved.fileName)
    const checked = await validateMedia(target, 'audio', await fingerprintFile(target, 'audio'), async () => tools)
    expect(checked.format).toBe(format)
  })

  it('uses the same real tool paths as preflight when PATH contains a junction directory', async () => {
    const linked = join(root, '工具目录链接'), originalPath = process.env.PATH
    await disk.symlink(dirname(tools.ffmpeg), linked, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      process.env.PATH = linked
      expect(await ffmpeg.requireTools()).toEqual(tools)
      const ctx = await context(), input = { ...options(ctx, 'tone.flac'), getFFmpegPath: () => undefined }
      const saved = await saveGeneratedAudio(input)
      expect(saved.fileName).toBe(`audio/${ctx.assetId}.flac`)
      expect(await disk.readFile(join(ctx.directory, saved.fileName))).toEqual(fixtures.get('tone.flac')!.bytes)
      expect(input.fetcher).toHaveBeenCalledTimes(1)
    } finally { process.env.PATH = originalPath; await disk.unlink(linked) }
  })

  it.each(['mp4', 'ogg'])('archives Opus-in-%s and produces a full-length verified FLAC without changing samples', async extension => {
    const ctx = await context(); const input = options(ctx, `opus.${extension}`)
    const saved = await saveGeneratedAudio(input)
    expect(saved).toEqual({ fileName: `audio/${ctx.assetId}.flac`, durationMs: expect.any(Number),
      originalFileName: `audio-originals/${ctx.assetId}.${extension}`, originalSha256: sha(fixtures.get(`opus.${extension}`)!.bytes) })
    expect(saved.durationMs).toBeGreaterThanOrEqual(1240); expect(saved.durationMs).toBeLessThan(1270)
    expect(await disk.readFile(join(ctx.directory, saved.originalFileName!))).toEqual(fixtures.get(`opus.${extension}`)!.bytes)
    const hashes: string[] = []
    for (const file of [fixtures.get(`opus.${extension}`)!.file, join(ctx.directory, saved.fileName)]) {
      const result = await ffmpeg.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s24le', '-f', 'hash', '-hash', 'sha256', '-'])
      hashes.push(result.stdout.trim())
    }
    expect(hashes[0]).toBe(hashes[1])
    expect(await saveGeneratedAudio(input)).toEqual(saved); expect(input.fetcher).toHaveBeenCalledTimes(1)
    const target = join(ctx.directory, saved.fileName)
    expect((await validateMedia(target, 'audio', await fingerprintFile(target, 'audio'), async () => tools)).durationSeconds).toBeCloseTo(saved.durationMs / 1000, 2)
    // The expanded generation policy must NOT expand manual import's accepted formats/codecs.
    await expect(validateMedia(fixtures.get(`opus.${extension}`)!.file, 'audio', await fingerprintFile(fixtures.get(`opus.${extension}`)!.file, 'audio'), async () => tools)).rejects.toThrow()
  })

  it.each(['alac.m4a', 'vorbis.ogg', 'multi.mp4', 'video.mp4'])('rejects unknown codecs and disguised multimedia: %s', async name => {
    const ctx = await context()
    await expect(saveGeneratedAudio(options(ctx, name))).rejects.toThrow()
    expect(await disk.readdir(join(ctx.directory, 'audio'))).toEqual([])
  })

  it.each([
    Buffer.from('<html>not audio</html>'), Buffer.from('{"url":"file:///private"}'),
    Buffer.from('#EXTM3U\nhttp://127.0.0.1/private'), Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(80)]),
    Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), Buffer.from('#EXTM3U\nfile:///private')]),
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('<html>fake mp4</html>')])
  ])('rejects forged/bad headers rather than treating a signed URL or MIME as proof (%#)', async bytes => {
    const ctx = await context()
    await expect(saveGeneratedAudio({ ...options(ctx, 'tone.wav'), fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes)) })).rejects.toThrow()
    expect(await disk.readdir(join(ctx.directory, 'audio'))).toEqual([])
  })

  it('rejects oversized and mismatched response lengths without publishing', async () => {
    for (const length of [String(1024 ** 3 + 1), '9', '999999', '-1', 'NaN']) {
      const ctx = await context(); const bytes = fixtures.get('tone.wav')!.bytes
      await expect(saveGeneratedAudio({ ...options(ctx, 'tone.wav'), fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes, { 'content-length': length })) })).rejects.toThrow()
      expect(await disk.readdir(join(ctx.directory, 'audio'))).toEqual([])
      expect(await disk.readdir(join(ctx.directory, '.generated-audio', ctx.assetId))).toEqual(['manifest.json'])
    }
  })

  it('retains original Opus after conversion failure, sanitizes errors, and retries only conversion', async () => {
    const ctx = await context(); const input = options(ctx, 'opus.mp4'); const originalRun = ffmpeg.runTool
    const spy = vi.spyOn(ffmpeg, 'runTool').mockImplementation(async (file, args, limits) => {
      if (args.includes('-c:a')) throw new Error('private-path-and-secret-token')
      return originalRun(file, args, limits)
    })
    const failure = await saveGeneratedAudio(input).catch(error => error as Error)
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain('private-path'); expect(failure).not.toHaveProperty('cause')
    expect(await disk.readFile(join(ctx.directory, `audio-originals/${ctx.assetId}.mp4`))).toEqual(fixtures.get('opus.mp4')!.bytes)
    expect(await disk.readdir(join(ctx.directory, 'audio'))).toEqual([])
    expect(await disk.readdir(join(ctx.directory, '.generated-audio', ctx.assetId))).toEqual(['manifest.json', 'source.bin'])
    spy.mockRestore(); input.fetcher.mockRejectedValue(new Error('offline'))
    expect((await saveGeneratedAudio(input)).fileName).toBe(`audio/${ctx.assetId}.flac`)
    expect(input.fetcher).toHaveBeenCalledTimes(1)
  })

  it('recovers a completed receive interrupted before source.bin publication', async () => {
    const ctx = await context(); const input = options(ctx, 'tone.wav'); const originalLink = disk.link
    const spy = vi.spyOn(disk, 'link').mockImplementation(async (from, to) => {
      if (String(to) === join(ctx.directory, '.generated-audio', ctx.assetId, 'source.bin')) throw new Error('simulated interruption')
      return originalLink(from, to)
    })
    await expect(saveGeneratedAudio(input)).rejects.toThrow()
    expect(await disk.readFile(join(ctx.directory, '.generated-audio', ctx.assetId, 'download.part'))).toEqual(fixtures.get('tone.wav')!.bytes)
    spy.mockRestore(); input.fetcher.mockRejectedValue(new Error('offline'))
    expect((await saveGeneratedAudio(input)).fileName).toBe(`audio/${ctx.assetId}.wav`)
    expect(input.fetcher).toHaveBeenCalledTimes(1)
  })

  it('persists the verified receipt before publication and recovers an orphan published asset', async () => {
    const ctx = await context(); const input = options(ctx, 'tone.flac'); const originalLink = disk.link
    const target = join(ctx.directory, 'audio', `${ctx.assetId}.flac`)
    const spy = vi.spyOn(disk, 'link').mockImplementation(async (from, to) => {
      if (String(to) !== target) return originalLink(from, to)
      const receipt = JSON.parse(await disk.readFile(receiptPath(ctx), 'utf8'))
      expect(receipt.ready).toMatchObject({ format: 'flac', sha256: sha(fixtures.get('tone.flac')!.bytes) })
      await originalLink(from, to)
      throw new Error('crash after exclusive link, before returning result')
    })
    await expect(saveGeneratedAudio(input)).rejects.toThrow()
    spy.mockRestore(); input.fetcher.mockRejectedValue(new Error('offline'))
    // Published bytes + receipt alone suffice, even if the private source was removed after a crash.
    await disk.unlink(join(ctx.directory, '.generated-audio', ctx.assetId, 'source.bin'))
    expect((await saveGeneratedAudio(input)).fileName).toBe(`audio/${ctx.assetId}.flac`)
    expect(input.fetcher).toHaveBeenCalledTimes(1)
  })

  it('serializes duplicate same-asset saves and never overwrites pre-existing or mutated content', async () => {
    const ctx = await context(); const input = options(ctx, 'tone.mp3')
    const [first, second] = await Promise.all([saveGeneratedAudio(input), saveGeneratedAudio(input)])
    expect(second).toEqual(first); expect(input.fetcher).toHaveBeenCalledTimes(1)
    const target = join(ctx.directory, first.fileName)
    await disk.writeFile(target, 'unrelated replacement')
    await expect(saveGeneratedAudio(input)).rejects.toThrow('指纹')
    expect(await disk.readFile(target, 'utf8')).toBe('unrelated replacement')
    const fresh = await context(); await disk.mkdir(join(fresh.directory, 'audio'))
    const occupied = join(fresh.directory, 'audio', `${fresh.assetId}.wav`)
    await disk.writeFile(occupied, 'unrelated')
    const next = options(fresh, 'tone.wav')
    await expect(saveGeneratedAudio(next)).rejects.toThrow('拒绝覆盖')
    expect(next.fetcher).not.toHaveBeenCalled(); expect(await disk.readFile(occupied, 'utf8')).toBe('unrelated')
  })

  it('cancels a stalled body, deletes only its own incomplete transfer, and can retry', async () => {
    const ctx = await context(); const controller = new AbortController(); const cancel = vi.fn()
    let opened!: () => void; const ready = new Promise<void>(resolve => { opened = resolve })
    const stalled = vi.fn<typeof fetch>().mockImplementation(async () => {
      opened()
      return new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(fixtures.get('tone.wav')!.bytes.subarray(0, 100))) }, cancel }))
    })
    const rejected = expect(saveGeneratedAudio({ ...options(ctx, 'tone.wav'), fetcher: stalled, signal: controller.signal })).rejects.toThrow('取消')
    await ready; controller.abort(); await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await disk.readdir(join(ctx.directory, '.generated-audio', ctx.assetId))).toEqual(['manifest.json'])
    expect((await saveGeneratedAudio(options(ctx, 'tone.wav'))).durationMs).toBe(1250)
  })

  it('aborts the actual decode child, leaves a concurrent unrelated FFmpeg alone, and resumes stored bytes', async () => {
    const ctx = await context(); const input = options(ctx, 'tone.wav'); const controller = new AbortController()
    const originalRun = ffmpeg.runTool
    const unrelated = originalRun(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-re', '-i', fixtures.get('tone.wav')!.file, '-f', 'null', '-'], { timeoutMs: 10000 })
    let decoding!: () => void; const started = new Promise<void>(resolve => { decoding = resolve })
    const spy = vi.spyOn(ffmpeg, 'runTool').mockImplementation(async (file, args, limits) => {
      if (!args.includes('-progress')) return originalRun(file, args, limits)
      const index = args.indexOf('-i')
      return originalRun(file, [...args.slice(0, index), '-readrate', '0.1', ...args.slice(index)], {
        ...limits, onProgress: seconds => { limits?.onProgress?.(seconds); decoding() }
      })
    })
    const stopped = expect(saveGeneratedAudio({ ...input, signal: controller.signal })).rejects.toThrow('取消')
    await started; controller.abort(); await stopped
    await expect(unrelated).resolves.toHaveProperty('stdout')
    expect(await disk.readFile(join(ctx.directory, '.generated-audio', ctx.assetId, 'source.bin'))).toEqual(fixtures.get('tone.wav')!.bytes)
    spy.mockRestore(); input.fetcher.mockRejectedValue(new Error('offline'))
    expect((await saveGeneratedAudio(input)).durationMs).toBe(1250); expect(input.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['abort', 'redirect'] as const)('local body lifetime and no-redirect security hold over real TCP: %s', async mode => {
    const ctx = await context(); const controller = new AbortController(); const bytes = fixtures.get('tone.flac')!.bytes
    let receiving!: () => void; const started = new Promise<void>(resolve => { receiving = resolve })
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/private' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': bytes.length }); res.write(bytes.subarray(0, 100)) }
      receiving()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing')
    try {
      const stopped = expect(saveGeneratedAudio({ ...ctx, url: '/v1/audio?path=synthetic',
        connection: { baseUrl: `http://127.0.0.1:${address.port}`, key: 'synthetic-local-key', signal: controller.signal }, getFFmpegPath: () => tools.ffmpeg })).rejects.toThrow()
      await started
      if (mode === 'abort') controller.abort()
      await stopped
      expect(requests).toBe(1); expect(await disk.readdir(join(ctx.directory, 'audio'))).toEqual([])
      expect(await disk.readdir(join(ctx.directory, '.generated-audio', ctx.assetId))).toEqual(['manifest.json'])
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })

  it('receives authenticated local /v1/audio over real TCP; a cloud fetcher cannot intercept local keys', async () => {
    const ctx = await context(); const bytes = fixtures.get('tone.flac')!.bytes
    const requests: Array<{ url?: string; authorization?: string }> = []
    const server: Server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization })
      if (req.headers.authorization !== 'Bearer synthetic-local-key') { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': bytes.length })
      res.write(bytes.subarray(0, 100)); setTimeout(() => res.end(bytes.subarray(100)), 20)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing')
    try {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('cloud transport must not be used'))
      const saved = await saveGeneratedAudio({ ...ctx, url: '/v1/audio?path=%2Fsynthetic%2F%E4%B8%AD%E6%96%87.flac',
        connection: { baseUrl: `http://127.0.0.1:${address.port}`, key: 'synthetic-local-key' }, getFFmpegPath: () => tools.ffmpeg, fetcher })
      expect(saved).toEqual({ fileName: `audio/${ctx.assetId}.flac`, durationMs: 1250 })
      expect(requests).toEqual([{ url: '/v1/audio?path=%2Fsynthetic%2F%E4%B8%AD%E6%96%87.flac', authorization: 'Bearer synthetic-local-key' }])
      expect(fetcher).not.toHaveBeenCalled(); expect(await disk.readFile(join(ctx.directory, saved.fileName))).toEqual(bytes)
      expect(await disk.readFile(receiptPath(ctx), 'utf8')).not.toContain('synthetic-local-key')
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
