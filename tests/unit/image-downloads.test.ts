import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadImage, saveImageBytes } from '../../src/main/downloads'

const { dns, nativeRequest } = vi.hoisted(() => ({ dns: vi.fn(), nativeRequest: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns }))
vi.mock('node:https', () => ({ request: nativeRequest }))
let root: string
const url = 'https://cdn.example.com/signed.png?signature=fixture-secret'
const picture = () => sharp({ create: { width: 32, height: 24, channels: 3, background: '#bc7833' } })
const response = (bytes: Buffer, headers?: HeadersInit) => new Response(new Uint8Array(bytes), { headers })
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('isolated scratch required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'sf-图片 下载-'))
  dns.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  nativeRequest.mockReset().mockImplementation(() => { throw new Error('unexpected network') })
})
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('safe image download', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('fully decodes %s, keeps original bytes and metadata, detects format instead of trusting URL/MIME', async format => {
    const bytes = await picture().withMetadata({ density: 96 }).toFormat(format).toBuffer()
    const id = randomUUID()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes, { 'content-type': 'application/octet-stream' }))
    const saved = await downloadImage(url, root, id, fetcher)
    expect(saved).toEqual({ fileName: `images/${id}.${format === 'jpeg' ? 'jpg' : format}`, width: 32, height: 24, format })
    expect(await readFile(join(root, saved.fileName))).toEqual(bytes)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' })
  })

  it.each(['http://example.com/a', 'file:///a', 'data:image/png;base64,aA==', 'https://user:pw@example.com/a', 'https://127.1/a', 'https://[::1]/a', 'https://169.254.169.254/a', 'https://host.local/a'])('rejects unsafe image URL %s before network/files', async unsafe => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadImage(unsafe, root, randomUUID(), fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled(); expect(dns).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('rejects mixed/private DNS results and rechecks all redirects without credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example.com/private' } }))
    dns.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])
    await expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('非公网')
    expect(fetcher).toHaveBeenCalledTimes(1); expect(dns).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
  })

  it('pins native TLS transport to vetted IP without API headers', async () => {
    const bytes = await picture().png().toBuffer()
    nativeRequest.mockImplementation((_options: unknown, callback: (response: IncomingMessage) => void) => {
      return Object.assign(new EventEmitter(), { end: () => callback(Object.assign(Readable.from([bytes]), { statusCode: 200, headers: { 'content-type': 'image/png' } }) as IncomingMessage) })
    })
    await downloadImage(url, root, randomUUID())
    const options = nativeRequest.mock.calls[0][0]
    expect(options).toMatchObject({ hostname: '8.8.8.8', servername: 'cdn.example.com', agent: false, headers: { Host: 'cdn.example.com', Accept: 'image/*, application/octet-stream' } })
    expect(options.headers).not.toHaveProperty('Authorization')
    expect(dns).toHaveBeenCalledTimes(1)
  })

  it('allows safe redirects without leaking keys, limits loops, and refuses expired links without retries', async () => {
    const bytes = await picture().png().toBuffer()
    const safe = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } })).mockResolvedValueOnce(response(bytes))
    await downloadImage(url, root, randomUUID(), safe)
    expect(safe.mock.calls[1][0]).toBe('https://cdn.example.com/next')
    expect(safe.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true)
    const loop = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } }))
    await expect(downloadImage(url, root, randomUUID(), loop)).rejects.toThrow('跳转次数')
    expect(loop).toHaveBeenCalledTimes(4)
    for (const status of [403, 404, 503]) {
      const expired = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
      await expect(downloadImage(url, root, randomUUID(), expired)).rejects.toThrow('过期')
      expect(expired).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['png', 'jpeg', 'webp'] as const)('refuses a truncated %s even if its header is recognized', async format => {
    const bytes = await picture().toFormat(format).toBuffer()
    const broken = bytes.subarray(0, Math.floor(bytes.length / 2))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(broken))
    await expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('图片损坏')
    expect(await readdir(join(root, 'images'))).toEqual([])
  })

  it('refuses HTML, JSON, SVG and GIF even under a PNG filename/MIME', async () => {
    for (const bytes of [Buffer.from('<html>denied</html>'), Buffer.from('{}'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>'), await picture().gif().toBuffer()]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes, { 'content-type': 'image/png' }))
      await expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('图片损坏')
    }
    expect(await readdir(join(root, 'images'))).toEqual([])
  })

  it('limits file bytes before full download and rejects dimensions/pixel bombs', async () => {
    const cancel = vi.fn()
    const chunk = new Uint8Array(1024 * 1024)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ pull(c) { c.enqueue(chunk) }, cancel })))
    await expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('过大')
    expect(cancel).toHaveBeenCalledTimes(1)
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(), { headers: { 'content-length': String(40 * 1024 * 1024 + 1) } }))
    await expect(downloadImage(url, root, randomUUID(), oversized)).rejects.toThrow('过大')
    for (const [width, height] of [[8193, 1], [4097, 4097]]) {
      const bytes = await sharp({ create: { width, height, channels: 3, background: '#fff' } }).png().toBuffer()
      await expect(saveImageBytes(bytes, root, randomUUID())).rejects.toThrow('尺寸超限')
    }
    expect(await readdir(join(root, 'images'))).toEqual([])
  })

  it('aborts a hung body at 90s and never saves a partial image', async () => {
    vi.useFakeTimers()
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { start(); return new Response(new ReadableStream({ cancel })) })
    const assertion = expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('90 秒')
    await started; await vi.advanceTimersByTimeAsync(90_000); await assertion
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1)
    expect(await readdir(join(root, 'images'))).toEqual([])
  })

  it('refuses unsafe image directories/IDs before contact and cleans failed writes', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadImage(url, root, '../bad', fetcher)).rejects.toThrow('标识')
    const outside = join(root, 'outside'); await mkdir(outside)
    await symlink(outside, join(root, 'images'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(downloadImage(url, root, randomUUID(), fetcher)).rejects.toThrow('不安全')
    expect(fetcher).not.toHaveBeenCalled()
    await rm(join(root, 'images')); await mkdir(join(root, 'images'))
    const id = randomUUID(); await mkdir(join(root, 'images', `${id}.jpg`))
    await expect(saveImageBytes(await picture().jpeg().toBuffer(), root, id)).rejects.toThrow('保存失败')
    expect(await readdir(join(root, 'images'))).toEqual([`${id}.jpg`])
  })
})
