import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import type { SavedImage } from '../shared/types'
import { AppError, readLimited, TransportError, withTimeout } from './providers/http'
import { atomicBuffer } from './storage/atomic'
import { assertAssetId, assetFolder } from './storage/paths'

const AUDIO_LIMIT = 80 * 1024 * 1024
const IMAGE_LIMIT = 40 * 1024 * 1024
const IMAGE_PIXELS = 16_777_216
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

function publicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

function checkedURL(value: string): URL {
  let url: URL
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('invalid URL')
    url = new URL(value)
  } catch { throw new AppError('素材下载地址格式不正确。') }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hostname ||
      hostname === 'localhost' || /\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname) ||
      (isIP(hostname) ? !publicAddress(hostname) : !hostname.includes('.'))) {
    throw new AppError('只允许从公网 HTTPS 地址下载素材，已拒绝本地、内网或不安全地址。')
  }
  url.hash = ''
  return url
}

async function resolvePublic(url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return { address: host, family: isIP(host) }
  let addresses: Awaited<ReturnType<typeof lookup>>[]
  try { addresses = await lookup(host, { all: true, verbatim: true }) } catch { throw new TransportError('DNS') }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new AppError('下载地址解析到了非公网地址，已停止下载。')
  }
  return addresses[0]
}

/** Connect to the vetted IP, retaining the original TLS server name and Host.
 * This prevents a second DNS lookup (and DNS-rebinding) in the production transport.
 * An injected fetcher is for trusted tests; it is still given only validated URLs.
 */
async function pinnedFetch(url: URL, address: { address: string; family: number }, signal: AbortSignal, kind: 'audio' | 'image'): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const req = request({
      protocol: 'https:', hostname: address.address, family: address.family, port: 443,
      servername: isIP(host) ? undefined : host, path: `${url.pathname}${url.search}`, method: 'GET',
      headers: { Host: url.host, Accept: `${kind}/*, application/octet-stream`, 'Accept-Encoding': 'identity' },
      agent: false, signal
    }, (response) => {
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const status = response.statusCode ?? 502
        if ([204, 205, 304].includes(status)) {
          response.resume()
          resolve(new Response(null, { status, headers }))
        } else {
          resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
        }
      } catch {
        response.destroy()
        reject(new AppError('素材服务返回了无效响应，已停止下载。'))
      }
    })
    req.once('error', reject)
    req.end()
  })
}

function audioExtension(bytes: Buffer): 'mp3' | 'wav' {
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    let format = false
    let data = false
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString('ascii', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      if (offset + 8 + size > bytes.length) break
      if (name === 'fmt ' && size >= 16) {
        format = [1, 3, 65534].includes(bytes.readUInt16LE(offset + 8)) && bytes.readUInt16LE(offset + 10) > 0 && bytes.readUInt32LE(offset + 12) > 0
      }
      if (name === 'data' && size > 0) data = true
      offset += 8 + size + (size % 2)
    }
    if (format && data) return 'wav'
  }
  let offset = 0
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((byte) => byte >= 128)) throw new AppError('音频文件头无效，未保存文件。')
    offset = 10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9]
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10
  }
  if (offset + 4 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0 &&
      ((bytes[offset + 1] >> 3) & 3) !== 1 && ((bytes[offset + 1] >> 1) & 3) === 1 &&
      (bytes[offset + 2] >> 4) !== 0 && (bytes[offset + 2] >> 4) !== 15 && ((bytes[offset + 2] >> 2) & 3) !== 3) {
    const version = (bytes[offset + 1] >> 3) & 3
    const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    const sampleRate = [44100, 48000, 32000][(bytes[offset + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrates[bytes[offset + 2] >> 4] * 1000 / sampleRate) + ((bytes[offset + 2] >> 1) & 1)
    if (offset + frameLength <= bytes.length) return 'mp3'
  }
  throw new AppError('下载内容不是受支持的 MP3 或 WAV 音频，未保存文件。')
}

async function receiveMedia(initial: URL, signal: AbortSignal, fetcher?: typeof fetch, kind: 'audio' | 'image' = 'audio'): Promise<Buffer> {
  let url = initial
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = await resolvePublic(url)
    if (signal.aborted) throw new TransportError('timeout')
    let response: Response
    try {
      response = fetcher
        ? await fetcher(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: `${kind}/*, application/octet-stream`, 'Accept-Encoding': 'identity' }, signal })
        : await pinnedFetch(url, address, signal, kind)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new TransportError('network')
    }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined)
      throw new TransportError('timeout')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined)
      const location = response.headers.get('location')
      if (!location || redirects === 3) throw new AppError('素材下载跳转次数过多或地址无效。')
      let next: string
      try { next = new URL(location, url).href } catch { throw new AppError('素材下载跳转地址无效。') }
      url = checkedURL(next)
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new AppError(kind === 'audio' ? '音频下载被服务拒绝或链接已过期，请重新查询任务后重试下载。' : '图片下载被拒绝或链接已过期。图片可能已计费，请核对服务商后台。')
    }
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    if (mime.startsWith('text/') || mime.includes('html') || mime.includes('json') || mime.includes('xml')) {
      void response.body?.cancel().catch(() => undefined)
      throw new AppError('下载内容不是有效媒体，未保存文件。')
    }
    return readLimited(response, kind === 'image' ? IMAGE_LIMIT : AUDIO_LIMIT, signal)
  }
  throw new AppError('素材下载跳转次数过多。')
}

export async function downloadAudio(url: string, directory: string, assetId: string, fetcher?: typeof fetch): Promise<{ fileName: string }> {
  assertAssetId(assetId)
  const initial = checkedURL(url)
  // Fail invalid project directories before contacting a remote server.
  await assetFolder(directory, 'audio', true)
  let bytes: Buffer
  try {
    bytes = await withTimeout(90_000, async (signal) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await receiveMedia(initial, signal, fetcher) } catch (error) {
          if (!(error instanceof TransportError) || attempt === 2 || signal.aborted) throw error
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
          if (signal.aborted) throw new TransportError('timeout')
        }
      }
      throw new TransportError('network')
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('音频下载连接失败或超过 90 秒，请检查网络后重试下载。')
  }
  const extension = audioExtension(bytes)
  const folder = await assetFolder(directory, 'audio')
  try { await atomicBuffer(join(folder, `${assetId}.${extension}`), bytes) } catch { throw new AppError('音频保存失败，请检查存储空间和权限。') }
  return { fileName: `audio/${assetId}.${extension}` }
}

/** Validate a bounded full decode, but store the original bytes (including watermark/metadata). */
export async function saveImageBytes(bytes: Buffer, directory: string, assetId: string): Promise<SavedImage> {
  assertAssetId(assetId)
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new AppError('图片为空或超过 40 MB，未保存文件。')
  let width: number
  let height: number
  let format: SavedImage['format']
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: IMAGE_PIXELS, sequentialRead: true }).timeout({ seconds: 10 })
    const info = await decoder.metadata()
    if (!['png', 'jpeg', 'webp'].includes(info.format ?? '') || !info.width || !info.height ||
        info.width > 8192 || info.height > 8192 || info.width * info.height > IMAGE_PIXELS || (info.pages ?? 1) !== 1) throw new Error('unsupported image')
    width = info.width; height = info.height; format = info.format as SavedImage['format']
    await decoder.raw().toBuffer()
  } catch { throw new AppError('图片损坏、尺寸超限或不是静态 PNG/JPEG/WebP，未保存文件。') }
  const folder = await assetFolder(directory, 'image', true)
  const extension = format === 'jpeg' ? 'jpg' : format
  try { await atomicBuffer(join(folder, `${assetId}.${extension}`), bytes) } catch { throw new AppError('图片保存失败，请检查存储空间和权限。') }
  return { fileName: `images/${assetId}.${extension}`, width, height, format }
}

/** Used by isolated local fixtures; production providers return signed URLs, never base64. */
export async function saveImage(base64: string, directory: string, assetId: string): Promise<SavedImage> {
  assertAssetId(assetId)
  if (typeof base64 !== 'string' || !base64.length || base64.length > 4 * Math.ceil(IMAGE_LIMIT / 3) ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AppError('图片编码无效或超过 40 MB，未保存文件。')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) throw new AppError('图片编码无效，未保存文件。')
  return saveImageBytes(bytes, directory, assetId)
}

export async function downloadImage(url: string, directory: string, assetId: string, fetcher?: typeof fetch): Promise<SavedImage> {
  assertAssetId(assetId)
  const initial = checkedURL(url)
  await assetFolder(directory, 'image', true)
  let bytes: Buffer
  try {
    bytes = await withTimeout(90_000, async signal => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await receiveMedia(initial, signal, fetcher, 'image') } catch (error) {
          if (!(error instanceof TransportError) || attempt === 2 || signal.aborted) throw error
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
          if (signal.aborted) throw new TransportError('timeout')
        }
      }
      throw new TransportError('network')
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('图片下载连接失败或超过 90 秒；未重新生成，请检查网络及服务商后台。')
  }
  return saveImageBytes(bytes, directory, assetId)
}
