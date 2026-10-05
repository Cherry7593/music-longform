import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { MediaKind } from '../../shared/workbench-types'
import { AppError } from '../providers/http'
import { isMissing } from '../storage/atomic'
import { localLibraryPath } from '../storage/library-validation'
import { requireTools, runTool, type VideoTools } from '../video/ffmpeg'
import { assertFingerprint, fingerprintFile, safeLibraryPath, validateMedia, type Fingerprint } from './imports'
import { LIMITS, type Evidence, type Metadata, type Stamp } from './assets-v4-schema'

export const VALIDATOR = 'assets-v4/1'
export function pathKey(file: string): string { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file) }
export function stamp(info: BigIntStats, sha256: string): Stamp {
  return { dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs), size: Number(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), links: Number(info.nlink), sha256 }
}
export function sameStamp(a: Stamp, b: Stamp, content = true): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birth === b.birth && (!content || (a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.sha256 === b.sha256))
}
/** Missing descendants are allowed for historical registrations, but every existing ancestor is checked. */
export async function safeAncestors(file: string, directory = false): Promise<boolean> {
  if (!localLibraryPath(file)) throw new AppError('素材路径不安全：必须使用本地绝对路径。')
  try { await safeLibraryPath(file, directory); return true } catch (error) {
    if (!isMissing(error)) throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    await safeAncestors(parent, true)
    return false
  }
}
/** Streaming, read-only and no-follow; also used for non-media receipts and large MP4s. */
export async function fingerprintRaw(file: string, maximum = LIMITS.videoBytes): Promise<Fingerprint> {
  const before = await safeLibraryPath(file)
  if (before.size < 0n || before.size > BigInt(maximum)) throw new AppError('资产文件大小超限。')
  const source = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = stamp(before, '')
    if (!sameStamp(initial, stamp(await source.stat({ bigint: true }), ''))) throw new AppError('文件身份发生变化。')
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0; let header = Buffer.alloc(0)
    for (;;) {
      const read = await source.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maximum) throw new AppError('资产文件大小超限。')
      const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk)
      if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)])
    }
    if (bytes !== Number(before.size) || !sameStamp(initial, stamp(await source.stat({ bigint: true }), '')) || !sameStamp(initial, stamp(await safeLibraryPath(file), ''))) throw new AppError('文件在读取时发生变化。')
    return { identity: before, bytes, sha256: hash.digest('hex'), header }
  } finally { await source.close() }
}
export async function readMetadata(file: string, maximum: number): Promise<{ data: unknown; bytes: number }> {
  const before = await safeLibraryPath(file)
  if (before.size > BigInt(maximum)) throw new AppError('资产元数据大小超限。')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameStamp(stamp(before, ''), stamp(await handle.stat({ bigint: true }), ''))) throw new AppError('资产元数据身份变化。')
    const chunks: Buffer[] = []; let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum - bytes + 1)); const result = await handle.read(chunk)
      if (!result.bytesRead) break
      bytes += result.bytesRead
      if (bytes > maximum) throw new AppError('资产元数据大小超限。')
      chunks.push(chunk.subarray(0, result.bytesRead))
    }
    if (!sameStamp(stamp(before, ''), stamp(await handle.stat({ bigint: true }), '')) || !sameStamp(stamp(before, ''), stamp(await safeLibraryPath(file), ''))) throw new AppError('资产元数据读取时发生变化。')
    return { data: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown, bytes }
  } finally { await handle.close() }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
async function validateVideo(file: string, fingerprint: Fingerprint, tools: VideoTools): Promise<Metadata> {
  if (fingerprint.bytes < 16 || fingerprint.header.toString('ascii', 4, 8) !== 'ftyp' || fingerprint.header.readUInt32BE(0) < 16 || fingerprint.header.readUInt32BE(0) > fingerprint.bytes) throw new AppError('视频不是有效的 MP4 容器。')
  const input = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-max_streams', '16']
  const probe = await runTool(tools.ffprobe, ['-v', 'error', ...input, '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 60000, maxOutputBytes: 512 * 1024 })
  let metadata: Metadata
  try {
    const raw: unknown = JSON.parse(probe.stdout)
    if (!object(raw) || !object(raw.format) || typeof raw.format.format_name !== 'string' || !raw.format.format_name.split(',').includes('mov') || !Array.isArray(raw.streams) || !raw.streams.length || raw.streams.length > 16 || !raw.streams.every(object)) throw new Error('container')
    const streams = raw.streams as Record<string, unknown>[]
    const videos = streams.filter(stream => stream.codec_type === 'video' && !(object(stream.disposition) && stream.disposition.attached_pic === 1))
    if (videos.length !== 1 || streams.some(stream => !['audio', 'video', 'subtitle', 'data'].includes(String(stream.codec_type)))) throw new Error('streams')
    if (streams.some(stream => stream.codec_type === 'audio' && (typeof stream.channels !== 'number' || !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 64
      || typeof stream.sample_rate !== 'string' || !/^\d+$/.test(stream.sample_rate) || Number(stream.sample_rate) < 1 || Number(stream.sample_rate) > 768000))) throw new Error('audio bounds')
    const video = videos[0]; const duration = Number(raw.format.duration)
    if (typeof video.codec_name !== 'string' || !video.codec_name.length || video.codec_name.length > 100 || video.codec_name === 'unknown'
      || typeof video.width !== 'number' || !Number.isInteger(video.width) || video.width < 1 || video.width > 32768
      || typeof video.height !== 'number' || !Number.isInteger(video.height) || video.height < 1 || video.height > 32768 || video.width * video.height > 268435456
      || !Number.isFinite(duration) || duration <= 0 || duration > LIMITS.durationSeconds) throw new Error('bounds')
    metadata = { format: 'mp4', durationSeconds: duration, width: video.width, height: video.height }
  } catch { throw new AppError('视频容器、轨道、尺寸或时长无效。') }
  let decoded = 0
  const result = await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '2', ...input,
    '-i', file, '-map', '0:V:0', '-map', '0:a?', '-sn', '-dn', '-t', String(LIMITS.durationSeconds + 1), '-threads', '2', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'],
  { timeoutMs: 2 * 60 * 60 * 1000, maxOutputBytes: 64 * 1024, onProgress: seconds => { decoded = Math.max(decoded, seconds) } })
  if (!(decoded > 0) || decoded > LIMITS.durationSeconds || Math.abs(decoded - metadata.durationSeconds!) > Math.max(1, metadata.durationSeconds! * 0.01)
    || ![...result.stdout.matchAll(/(?:^|\n)frame=\s*(\d+)/g)].some(match => Number(match[1]) > 0)) throw new AppError('视频完整解码失败或实际时长与探测不符。')
  return metadata
}

/** The boolean registration hint is intentionally not an input to this validator. */
export class AssetValidator {
  private resolved?: { selection: string; pending: Promise<VideoTools> }
  private toolVersions = new Map<string, Promise<string>>()
  private flights = new Map<string, Promise<Evidence>>()
  constructor(private readonly getPath: () => string | undefined) {}
  private async tools(): Promise<{ tools: VideoTools; key: string }> {
    const selected = this.getPath(); const selection = selected ?? `PATH:${process.env.PATH ?? ''}`
    if (this.resolved?.selection !== selection) this.resolved = { selection, pending: requireTools(selected) }
    let tools: VideoTools
    try { tools = await this.resolved.pending } catch (error) { this.resolved = undefined; throw error }
    const stats = await Promise.all([tools.ffmpeg, tools.ffprobe].map(async file => `${pathKey(file)}:${JSON.stringify(stamp(await safeLibraryPath(file), ''))}`))
    const signature = stats.join('|')
    let pending = this.toolVersions.get(signature)
    if (!pending) {
      pending = Promise.all([tools.ffmpeg, tools.ffprobe].map(file => runTool(file, ['-hide_banner', '-version'], { timeoutMs: 15000, maxOutputBytes: 128 * 1024 })))
        .then(results => {
          if (!/^ffmpeg version\s+\S+/m.test(results[0].stdout) || !/^ffprobe version\s+\S+/m.test(results[1].stdout)) throw new AppError('媒体工具版本无效。')
          return createHash('sha256').update(signature).update(results.map(result => result.stdout).join('|')).digest('hex')
        })
      this.toolVersions.clear(); this.toolVersions.set(signature, pending)
      void pending.catch(() => this.toolVersions.delete(signature))
    }
    return { tools, key: await pending }
  }
  inspect(file: string, kind: MediaKind, expected?: string, evidence?: Evidence, transfer = false): Promise<Evidence> {
    const key = `${pathKey(file)}:${kind}:${expected ?? ''}`
    const existing = this.flights.get(key)
    if (existing) return existing
    const pending = this.inspectOnce(file, kind, expected, evidence, transfer)
    this.flights.set(key, pending)
    void pending.finally(() => this.flights.delete(key)).catch(() => undefined)
    return pending
  }
  private async inspectOnce(file: string, kind: MediaKind, expected?: string, evidence?: Evidence, transfer = false): Promise<Evidence> {
    const before = await safeLibraryPath(file)
    const context = kind === 'image' ? undefined : await this.tools()
    const tool = context?.key ?? createHash('sha256').update(JSON.stringify(sharp.versions)).digest('hex')
    const usable = evidence?.validator === VALIDATOR && evidence.tool === tool && (!expected || evidence.fingerprint.sha256 === expected)
    if (usable && sameStamp(evidence.fingerprint, stamp(before, evidence.fingerprint.sha256))) {
      await safeLibraryPath(file).then(info => { if (!sameStamp(stamp(before, ''), stamp(info, ''))) throw new AppError('素材在校验时发生变化。') })
      return structuredClone(evidence)
    }
    const fingerprint = kind === 'video' ? await fingerprintRaw(file) : await fingerprintFile(file, kind)
    if (!fingerprint.bytes) throw new AppError('素材文件为空。')
    if (expected && fingerprint.sha256 !== expected) throw new AppError('素材文件指纹已变化，已拒绝使用；不会更新登记的原始哈希。')
    const metadata = transfer && usable && evidence.fingerprint.sha256 === fingerprint.sha256 ? evidence.metadata
      : kind === 'video' ? await validateVideo(file, fingerprint, context!.tools)
        : await validateMedia(file, kind, fingerprint, async () => context!.tools)
    await assertFingerprint(file, fingerprint)
    return { validator: VALIDATOR, tool, fingerprint: stamp(fingerprint.identity, fingerprint.sha256), metadata: structuredClone(metadata) }
  }
}
