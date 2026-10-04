import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { LibraryKind } from '../../shared/library-types'
import { AppError } from '../providers/http'
import { isMissing } from '../storage/atomic'
import { LIBRARY_LIMITS, libraryFileName, localLibraryPath } from '../storage/library-validation'
import { requireTools, runTool, type VideoTools } from '../video/ffmpeg'

export interface MediaMetadata { format: 'mp3' | 'wav' | 'flac' | 'm4a' | 'png' | 'jpeg' | 'webp'; durationSeconds?: number; width?: number; height?: number }
export interface Fingerprint { sha256: string; bytes: number; identity: BigIntStats; header: Buffer; imageBytes?: Buffer }
export type ToolResolver = () => Promise<VideoTools>
export function libraryTools(getPath: () => string | undefined): ToolResolver {
  let pending: Promise<VideoTools> | undefined
  return () => pending ??= requireTools(getPath())
}
export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(a) === normalize(b)
}
function sameIdentity(a: BigIntStats, b: BigIntStats, content = true): boolean {
  return a.dev === b.dev && a.ino === b.ino && (!content || (a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs))
}

/** Check every parent, not just the leaf: a junction under a local drive is not a local authorization. */
async function walk(file: string, directory: boolean, create: boolean): Promise<BigIntStats> {
  if (!localLibraryPath(file)) throw new AppError('素材路径不安全：必须是本地绝对路径，不能使用网络共享、设备路径或越界路径。')
  const normalized = path.resolve(file)
  const root = path.parse(normalized).root
  const pieces = normalized.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  let info = await lstat(root, { bigint: true })
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('素材所在根目录不安全。')
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index])
    try { info = await lstat(current, { bigint: true }) } catch (error) {
      if (!create || !isMissing(error)) throw error
      try { await mkdir(current) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      info = await lstat(current, { bigint: true })
    }
    if (info.isSymbolicLink() || (index < pieces.length - 1 || directory ? !info.isDirectory() : !info.isFile())) {
      throw new AppError('素材路径不安全，不能使用符号链接、重定向目录或非普通文件。')
    }
  }
  if (!samePath(await realpath(normalized), normalized)) throw new AppError('素材路径被重定向，已拒绝访问。')
  if (directory ? !info.isDirectory() : !info.isFile()) throw new AppError('素材路径不是预期的文件或目录。')
  return info
}
export async function safeLibraryPath(file: string, directory = false): Promise<BigIntStats> { return walk(file, directory, false) }
export async function ensureLibraryDirectory(directory: string): Promise<void> { await walk(directory, true, true) }

function byteLimit(kind: LibraryKind): number { return kind === 'audio' ? LIBRARY_LIMITS.audioBytes : LIBRARY_LIMITS.imageBytes }
function sizeError(kind: LibraryKind): AppError { return new AppError(kind === 'audio' ? '音频为空或超过 1 GiB，未导入。' : '图片为空或超过 40 MiB，未导入。') }

/** Bounded read/copy through a read-only source handle. Hash and identity describe those exact copied bytes. */
async function scan(file: string, kind: LibraryKind, destination?: string): Promise<Fingerprint> {
  const before = await safeLibraryPath(file)
  const maximum = byteLimit(kind)
  if (before.size <= 0n || before.size > BigInt(maximum)) throw sizeError(kind)
  const source = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (!sameIdentity(before, await source.stat({ bigint: true }))) throw new AppError('源文件在读取前发生变化，请重新选择。')
    if (destination) {
      await safeLibraryPath(path.dirname(destination), true)
      output = await open(destination, 'wx', 0o600)
    }
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let bytes = 0
    let header = Buffer.alloc(0)
    const buffer = Buffer.alloc(64 * 1024)
    while (true) {
      const read = await source.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maximum) throw sizeError(kind)
      const chunk = buffer.subarray(0, read.bytesRead)
      hash.update(chunk)
      if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)])
      if (!destination && kind === 'image') chunks.push(Buffer.from(chunk))
      if (output) {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) throw new AppError('素材复制未完成，请检查存储空间。')
          offset += bytesWritten
        }
      }
    }
    if (bytes !== Number(before.size) || !sameIdentity(before, await source.stat({ bigint: true })) || !sameIdentity(before, await safeLibraryPath(file))) {
      throw new AppError('源文件在读取/复制时发生变化，未登记；请等待文件写入完成后重试。')
    }
    await output?.sync()
    return { bytes, sha256: hash.digest('hex'), identity: before, header, ...(kind === 'image' && !destination ? { imageBytes: Buffer.concat(chunks, bytes) } : {}) }
  } finally { await source.close(); await output?.close() }
}
export async function fingerprintFile(file: string, kind: LibraryKind): Promise<Fingerprint> {
  try { return await scan(file, kind) } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('素材文件缺失或不可读取，请检查原文件和存储权限。')
  }
}
export async function assertFingerprint(file: string, fingerprint: Fingerprint): Promise<void> {
  if (!sameIdentity(fingerprint.identity, await safeLibraryPath(file))) throw new AppError('素材在校验期间发生变化，已拒绝使用。')
}

function audioFormat(header: Buffer): 'mp3' | 'wav' | 'flac' | 'm4a' {
  if (header.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
  if (['RIFF', 'RF64'].includes(header.subarray(0, 4).toString('ascii')) && header.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (header.subarray(4, 8).toString('ascii') === 'ftyp' && header.readUInt32BE(0) >= 16) return 'm4a'
  if (header.subarray(0, 3).toString('ascii') === 'ID3' || (header.length >= 4 && header[0] === 255 && (header[1] & 0xe0) === 0xe0 && ((header[1] >> 1) & 3) === 1)) return 'mp3'
  throw new AppError('不支持或伪造的音频；仅支持 MP3、WAV、FLAC、AAC 编码的 M4A，不接受播放列表。')
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function seconds(value: unknown): number | undefined {
  if (value === undefined || value === 'N/A') return undefined
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('invalid duration')
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0 || result > LIBRARY_LIMITS.durationSeconds) throw new Error('duration limit')
  return result
}
async function validateAudio(file: string, fingerprint: Fingerprint, resolveTools: ToolResolver): Promise<MediaMetadata> {
  const format = audioFormat(fingerprint.header)
  const tools = await resolveTools()
  const input = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,wav,flac,mov', '-f', format === 'm4a' ? 'mov' : format,
    ...(format === 'm4a' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : [])]
  const result = await runTool(tools.ffprobe, ['-v', 'error', ...input, '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 60000, maxOutputBytes: 512 * 1024 })
  let durationSeconds: number
  try {
    const raw: unknown = JSON.parse(result.stdout)
    if (!object(raw) || !object(raw.format) || typeof raw.format.format_name !== 'string' || !raw.format.format_name.split(',').includes(format === 'm4a' ? 'mov' : format)
      || !Array.isArray(raw.streams) || !raw.streams.length || raw.streams.length > 8 || !raw.streams.every(object)) throw new Error('container')
    const streams = raw.streams as Record<string, unknown>[]
    const audio = streams.filter(stream => stream.codec_type === 'audio')
    if (audio.length !== 1 || streams.some(stream => stream.codec_type !== 'audio' && !(stream.codec_type === 'video' && object(stream.disposition) && stream.disposition.attached_pic === 1))) throw new Error('streams')
    const codec = audio[0].codec_name
    if (typeof codec !== 'string' || codec.length > 100 || !(format === 'wav' ? /^(?:pcm_|adpcm_)/.test(codec) : codec === (format === 'm4a' ? 'aac' : format))) throw new Error('codec')
    if (typeof audio[0].channels !== 'number' || !Number.isInteger(audio[0].channels) || audio[0].channels < 1 || audio[0].channels > 64
      || typeof audio[0].sample_rate !== 'string' || !/^\d+$/.test(audio[0].sample_rate) || Number(audio[0].sample_rate) < 1 || Number(audio[0].sample_rate) > 768000) throw new Error('audio bounds')
    const containerSeconds = seconds(raw.format.duration)
    durationSeconds = seconds(audio[0].duration) ?? containerSeconds ?? 0
    if (!durationSeconds) throw new Error('no duration')
  } catch { throw new AppError('音频容器、编码或真实时长无效（最长 6 小时），未导入。') }
  let decodedSeconds = 0
  await runTool(tools.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '2', ...input, '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(LIBRARY_LIMITS.durationSeconds + 1), '-threads', '2',
    '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'
  ], { timeoutMs: 20 * 60 * 1000, maxOutputBytes: 64 * 1024, onProgress: value => { decodedSeconds = Math.max(decodedSeconds, value) } })
  if (!(decodedSeconds > 0) || decodedSeconds > LIBRARY_LIMITS.durationSeconds || Math.abs(decodedSeconds - durationSeconds) > Math.max(1, durationSeconds * 0.01)) {
    throw new AppError('音频完整解码时长与探测不符或超过 6 小时，未导入。')
  }
  return { format, durationSeconds }
}

function animatedPNG(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === 'acTL') return true
    if (length > bytes.length - offset - 12) break
    offset += length + 12
  }
  return false
}
async function validateImage(fingerprint: Fingerprint): Promise<MediaMetadata> {
  try {
    const bytes = fingerprint.imageBytes
    if (!bytes || animatedPNG(bytes)) throw new Error('animated image')
    const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : undefined
    if (!detected) throw new Error('unsupported image signature')
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: LIBRARY_LIMITS.imagePixels, sequentialRead: true }).timeout({ seconds: 10 })
    const info = await decoder.metadata()
    if (info.format !== detected || !info.width || !info.height || info.width > LIBRARY_LIMITS.imageDimension || info.height > LIBRARY_LIMITS.imageDimension
      || info.width * info.height > LIBRARY_LIMITS.imagePixels || (info.pages ?? 1) !== 1 || info.loop !== undefined || info.delay !== undefined) throw new Error('unsupported image')
    await decoder.raw().toBuffer()
    return { format: info.format as 'png' | 'jpeg' | 'webp', width: info.width, height: info.height }
  } catch { throw new AppError('图片损坏、尺寸超限或不是静态 PNG/JPEG/WebP，未导入。') }
}
export async function validateMedia(file: string, kind: LibraryKind, fingerprint: Fingerprint, resolveTools: ToolResolver): Promise<MediaMetadata> {
  await assertFingerprint(file, fingerprint)
  const metadata = kind === 'audio' ? await validateAudio(file, fingerprint, resolveTools) : await validateImage(fingerprint)
  await assertFingerprint(file, fingerprint)
  return metadata
}

export interface StagedImport {
  path: string
  sha256: string
  bytes: number
  publish(id: string, format: MediaMetadata['format']): Promise<{ path: string; fileName: string }>
  dispose(): Promise<void>
}
/** Only a caller-owned unique staging directory is ever cleaned up. Publication never overwrites. */
export async function stageImport(source: string, kind: LibraryKind, root: string): Promise<StagedImport> {
  try { await safeLibraryPath(source) } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('导入源文件缺失或不可读取，请检查文件和本地存储权限。')
  }
  await ensureLibraryDirectory(path.join(root, '.staging'))
  const stage = await mkdtemp(path.join(root, '.staging', `${randomUUID()}-`))
  const identity = await safeLibraryPath(stage, true)
  const staged = path.join(stage, 'source.bin')
  const dispose = async (): Promise<void> => {
    try { if (sameIdentity(identity, await safeLibraryPath(stage, true), false)) await rm(stage, { recursive: true, force: true }) } catch { /* Never follow a replaced parent during cleanup. */ }
  }
  try {
    const fingerprint = await scan(source, kind, staged)
    const stagedIdentity = await safeLibraryPath(staged)
    return {
      path: staged, sha256: fingerprint.sha256, bytes: fingerprint.bytes, dispose,
      async publish(id, format) {
        const extension = format === 'jpeg' ? 'jpg' : format
        const folder = kind === 'audio' ? 'audio' : 'images'
        const fileName = `${folder}/${id}.${extension}`
        // IDs/formats originate in the store, but keep this lower-level boundary closed too.
        if (!libraryFileName(fileName, kind, id)) throw new AppError('素材发布标识或格式无效。')
        await ensureLibraryDirectory(path.join(root, folder))
        if (!sameIdentity(stagedIdentity, await safeLibraryPath(staged))) throw new AppError('暂存文件在发布前发生变化，未登记。')
        const target = path.join(root, fileName)
        // Hard-link publication is atomic and exclusive on the same volume; no rename-overwrite race.
        await link(staged, target)
        const published = await safeLibraryPath(target)
        if (!sameIdentity(stagedIdentity, published, false) || stagedIdentity.size !== published.size || stagedIdentity.mtimeNs !== published.mtimeNs) throw new AppError('素材发布时发生变化，未登记；文件保留供检查。')
        return { path: target, fileName }
      }
    }
  } catch (error) {
    await dispose()
    if (error instanceof AppError) throw error
    throw new AppError('素材复制失败，请检查文件、存储空间和权限；原文件未被修改。')
  }
}
