import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAudio, saveImage } from '../../src/main/downloads'
import sharp from 'sharp'

const { dns, nativeRequest } = vi.hoisted(() => ({ dns: vi.fn(), nativeRequest: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns }))
vi.mock('node:https', () => ({ request: nativeRequest }))

let root: string
let directory: string
let png: string
const url = 'https://cdn.example.com/music?signature=unit-only'
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(413)])
function wav(): Buffer {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8)
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40)
  return bytes
}
const response = (bytes: Buffer = mp3, headers?: HeadersInit) => new Response(new Uint8Array(bytes), { headers })

beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated disk tests')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'canvas-downloads-'))
  directory = join(root, '中文 项目')
  await mkdir(directory)
  png = (await sharp({ create: { width: 16, height: 9, channels: 3, background: '#357' } }).png().toBuffer()).toString('base64')
  dns.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  nativeRequest.mockReset().mockImplementation(() => { throw new Error('unexpected production transport in test') })
})
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) })

describe('downloadAudio', () => {
  it.each(['mp3', 'wav'] as const)('detects %s from bytes rather than a misleading URL extension', async (extension) => {
    const id = randomUUID()
    const bytes = extension === 'mp3' ? mp3 : wav()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes, { 'content-type': 'application/octet-stream' }))
    expect(await downloadAudio(`${url}&file=wrong.html`, directory, id, fetcher)).toEqual({ fileName: `audio/${id}.${extension}` })
    expect(await readFile(join(directory, 'audio', `${id}.${extension}`))).toEqual(bytes)
    expect(await readdir(join(directory, 'audio'))).toEqual([`${id}.${extension}`])
    const init = fetcher.mock.calls[0][1]
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })

  it('supports an ID3 header followed by a valid MP3 frame', async () => {
    const id = randomUUID()
    const bytes = Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), mp3])
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes))
    expect(await downloadAudio(url, directory, id, fetcher)).toEqual({ fileName: `audio/${id}.mp3` })
  })

  it.each([
    'http://example.com/a', 'file:///secret', 'data:audio/mpeg;base64,aA==', 'https://user:password@example.com/a',
    'https://localhost/a', 'https://localhost./a', 'https://a.localhost/a', 'https://intranet/a', 'https://a.local/a',
    'https://127.0.0.1/a', 'https://127.1/a', 'https://2130706433/a', 'https://0x7f000001/a',
    'https://10.1.2.3/a', 'https://172.16.0.1/a', 'https://192.168.1.1/a', 'https://169.254.169.254/a',
    'https://100.64.1.1/a', 'https://0.0.0.0/a', 'https://224.0.0.1/a', 'https://example.com:8443/a',
    'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://[fc00::1]/a', 'https://[fe80::1]/a', 'https://[2001:db8::1]/a'
  ])('rejects unsafe URL %s without any request', async (unsafe) => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadAudio(unsafe, directory, randomUUID(), fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(nativeRequest).not.toHaveBeenCalled()
    expect(dns).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects private and mixed DNS results before making a request', async () => {
    dns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '192.168.0.1', family: 4 }])
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('非公网')
    expect(fetcher).not.toHaveBeenCalled()
    expect(dns).toHaveBeenCalledTimes(1)
  })

  it('pins the validated IP for production HTTPS while retaining TLS identity', async () => {
    nativeRequest.mockImplementation((_options: unknown, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter()
      return Object.assign(request, { end: () => callback(Object.assign(Readable.from([mp3]), { statusCode: 200, headers: { 'content-type': 'audio/mpeg' } }) as IncomingMessage) })
    })
    await downloadAudio(url, directory, randomUUID())
    expect(dns).toHaveBeenCalledTimes(1)
    expect(nativeRequest.mock.calls[0][0]).toMatchObject({ hostname: '8.8.8.8', servername: 'cdn.example.com', agent: false, headers: { Host: 'cdn.example.com' } })
    expect(nativeRequest.mock.calls[0][0]).not.toHaveProperty('auth')
  })

  it('safely rejects malformed native HTTP responses without retry or an uncaught exception', async () => {
    nativeRequest.mockImplementation((_options: unknown, callback: (response: IncomingMessage) => void) => {
      return Object.assign(new EventEmitter(), { end: () => callback(Object.assign(Readable.from([]), { statusCode: 999, headers: {} }) as IncomingMessage) })
    })
    await expect(downloadAudio(url, directory, randomUUID())).rejects.toThrow('无效响应')
    expect(nativeRequest).toHaveBeenCalledTimes(1)
  })

  it('revalidates each redirect and never follows private targets', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/secret' } }))
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('公网')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('follows safe relative redirects but caps them at three', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockResolvedValueOnce(response())
    await downloadAudio(url, directory, randomUUID(), fetcher)
    expect(fetcher.mock.calls[1][0]).toBe('https://cdn.example.com/next')
    const loop = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }))
    await expect(downloadAudio(url, directory, randomUUID(), loop)).rejects.toThrow('跳转次数')
    expect(loop).toHaveBeenCalledTimes(4)
  })

  it('retries network failures at most three times without HTTP-status retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network error with private diagnostic'))
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('连接失败')
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const status of [401, 403, 429, 503]) {
      const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
      await expect(downloadAudio(url, directory, randomUUID(), denied)).rejects.toThrow('拒绝')
      expect(denied).toHaveBeenCalledTimes(1)
    }
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it('can recover a network read failure but never writes a partial download', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(mp3)); controller.error(new TypeError('disconnected')) } })
    const id = randomUUID()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(response())
    await downloadAudio(url, directory, id, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await readdir(join(directory, 'audio'))).toEqual([`${id}.mp3`])
  })

  it('enforces an overall 90-second deadline and cancels a stalled stream', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { started(); return new Response(new ReadableStream({ cancel })) })
    const assertion = expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('90 秒')
    await ready
    await vi.advanceTimersByTimeAsync(90_000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it('enforces the 80 MB header and streamed limits and cancels oversized bodies', async () => {
    const largeHeader = vi.fn<typeof fetch>().mockResolvedValue(response(mp3, { 'content-length': String(80 * 1024 * 1024 + 1) }))
    await expect(downloadAudio(url, directory, randomUUID(), largeHeader)).rejects.toThrow('过大')
    expect(largeHeader).toHaveBeenCalledTimes(1)
    const cancel = vi.fn()
    const chunk = new Uint8Array(1024 * 1024)
    const oversized = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk) }, cancel })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(oversized))
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('过大')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it.each([
    ['<html>error</html>', 'audio/mpeg'], ['ID3<html>error</html>', 'application/octet-stream'], ['{}', 'application/json']
  ])('rejects non-audio content %s even with a misleading MIME type', async (body, contentType) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': contentType } }))
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it('rejects a truncated MPEG frame even when its four-byte header is valid', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(mp3.subarray(0, 4)))
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('不是受支持')
    expect(await readdir(join(directory, 'audio'))).toEqual([])
  })

  it('rejects unsafe IDs, relative paths and escaping audio junctions before any request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadAudio(url, directory, '../escape', fetcher)).rejects.toThrow('标识')
    await expect(downloadAudio(url, 'relative', randomUUID(), fetcher)).rejects.toThrow('绝对路径')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(directory, 'audio'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(downloadAudio(url, directory, randomUUID(), fetcher)).rejects.toThrow('不安全')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readdir(outside)).toEqual([])
  })
})

describe('saveImage', () => {
  it('validates PNG and returns an atomic relative images path', async () => {
    const id = randomUUID()
    expect(await saveImage(png, directory, id)).toEqual({ fileName: `images/${id}.png`, format: 'png', width: 16, height: 9 })
    expect(await readFile(join(directory, 'images', `${id}.png`))).toEqual(Buffer.from(png, 'base64'))
    expect(await readdir(join(directory, 'images'))).toEqual([`${id}.png`])
  })

  it.each(['', 'not base64', 'aA=', 'aA===', 'aA==\n', 'data:image/png;base64,aA==', 'AB==', Buffer.from('not png').toString('base64')])('rejects malformed base64/PNG %s before creating folders', async (base64) => {
    await expect(saveImage(base64, directory, randomUUID())).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })

  it('bounds images at 40 MB before decoding', async () => {
    await expect(saveImage('A'.repeat(4 * Math.ceil(40 * 1024 * 1024 / 3) + 4), directory, randomUUID())).rejects.toThrow('40 MB')
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects UUID traversal and image junctions, and cleans temporary files after failed commits', async () => {
    await expect(saveImage(png, directory, '../escape')).rejects.toThrow('标识')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(directory, 'images'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(saveImage(png, directory, randomUUID())).rejects.toThrow('不安全')
    expect(await readdir(outside)).toEqual([])
    await rm(join(directory, 'images'))
    await mkdir(join(directory, 'images'))
    const id = randomUUID()
    await mkdir(join(directory, 'images', `${id}.png`))
    await expect(saveImage(png, directory, id)).rejects.toThrow('保存失败')
    expect(await readdir(join(directory, 'images'))).toEqual([`${id}.png`])
  })
})
