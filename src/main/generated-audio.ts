import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { GeneratedAudioResult, MusicConnection } from '../shared/music-types'
import { openCloudAudio } from './downloads'
import { assertFingerprint, ensureLibraryDirectory, fingerprintFile, safeLibraryPath, type Fingerprint } from './library/imports'
import { AppError } from './providers/http'
import { atomicJson, isMissing, readJson } from './storage/atomic'
import { LIBRARY_LIMITS, localLibraryPath } from './storage/library-validation'
import { assertAssetId } from './storage/paths'
import { resolveToolPaths, runTool, type VideoTools } from './video/ffmpeg'

const MAX_BYTES = LIBRARY_LIMITS.audioBytes
const MAX_SECONDS = LIBRARY_LIMITS.durationSeconds
const DOWNLOAD_MS = 10 * 60 * 1000
const DECODE_MS = 20 * 60 * 1000
const MANIFEST_BYTES = 8192
const containerSchema = z.enum(['mp3', 'wav', 'flac', 'mov', 'ogg'])
const formatSchema = z.enum(['mp3', 'wav', 'flac', 'm4a'])
const digestSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(MAX_BYTES) }).strict()
const identitySchema = z.object({ dev: z.string().regex(/^\d{1,30}$/), ino: z.string().regex(/^\d{1,30}$/), birth: z.string().regex(/^\d{1,30}$/) }).strict()
const manifestSchema = z.object({
  version: z.literal(1), assetId: z.string().max(100),
  source: digestSchema.extend({ container: containerSchema }).strict().optional(),
  original: z.enum(['mp4', 'ogg']).optional(),
  ready: digestSchema.extend({ format: formatSchema, durationMs: z.number().int().positive().max(MAX_SECONDS * 1000) }).strict().optional(),
  partial: z.object({ name: z.enum(['download.part', 'compatible.flac']), identity: identitySchema }).strict().optional()
}).strict()
type Manifest = z.infer<typeof manifestSchema>
type Identity = z.infer<typeof identitySchema>
type Digest = z.infer<typeof digestSchema>
type Container = z.infer<typeof containerSchema>
type Format = z.infer<typeof formatSchema>
export interface SaveGeneratedAudioOptions {
  directory: string
  assetId: string
  url: string
  connection?: MusicConnection
  getFFmpegPath?: () => string | undefined
  signal?: AbortSignal
  /** Trusted cloud fixtures only; never used for the local authenticated transport. */
  fetcher?: typeof fetch
}

function identity(info: BigIntStats): Identity { return { dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs) } }
function sameIdentity(a: Identity, b: BigIntStats): boolean { return a.dev === String(b.dev) && a.ino === String(b.ino) && a.birth === String(b.birthtimeNs) }
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new AppError('音频保存已取消或超过处理时限；已接收的原始音频保留供恢复。') }
async function exists(file: string): Promise<boolean> {
  try { await safeLibraryPath(file); return true } catch (error) { if (isMissing(error)) return false; throw error }
}
async function verified(file: string, expected: Digest): Promise<Fingerprint> {
  const actual = await fingerprintFile(file, 'audio')
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new AppError('已保存音频的指纹发生变化，已停止恢复；不会覆盖现有文件。')
  return actual
}
async function removeOwned(file: string, owner: Identity): Promise<void> {
  try {
    if (!sameIdentity(owner, await safeLibraryPath(file))) throw new AppError('暂存文件已被替换，已停止清理。')
    await unlink(file)
  } catch (error) { if (!isMissing(error)) throw error }
}

/** Same-volume, exclusive publication, as in stageImport; never rename over a media file.
 * A deterministic source + durable receipt replaces stageImport's disposable random staging here.
 */
async function publish(source: string, target: string, expected: Digest): Promise<void> {
  if (await exists(target)) { await verified(target, expected); return }
  await safeLibraryPath(path.dirname(target), true)
  const fingerprint = await verified(source, expected)
  await assertFingerprint(source, fingerprint)
  try { await link(source, target) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    await verified(target, expected)
    return
  }
  const published = await safeLibraryPath(target)
  if (!sameIdentity(identity(fingerprint.identity), published) || published.size !== fingerprint.identity.size || published.mtimeNs !== fingerprint.identity.mtimeNs) {
    throw new AppError('音频发布期间文件发生变化，已停止保存；文件保留供检查。')
  }
}

class Recovery {
  readonly file: string
  private stamp?: BigIntStats
  private constructor(readonly root: string, readonly work: string, readonly owner: Identity, public data: Manifest) { this.file = path.join(work, 'manifest.json') }
  static async load(root: string, assetId: string): Promise<Recovery> {
    const work = path.join(root, '.generated-audio', assetId)
    await ensureLibraryDirectory(work)
    const state = new Recovery(root, work, identity(await safeLibraryPath(work, true)), { version: 1, assetId })
    if (await exists(state.file)) {
      const before = await safeLibraryPath(state.file)
      const parsed = manifestSchema.safeParse(await readJson(state.file, MANIFEST_BYTES))
      const after = await safeLibraryPath(state.file)
      if (!parsed.success || parsed.data.assetId !== assetId || !sameIdentity(identity(before), after) || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
        throw new AppError('音频恢复记录损坏或已被替换；现有文件未改动。')
      }
      const data = parsed.data
      if ((data.original && (!data.source || data.source.container !== (data.original === 'mp4' ? 'mov' : 'ogg')))
        || (data.ready && (!data.source || data.ready.format !== (data.original ? 'flac' : data.source.container === 'mov' ? 'm4a' : data.source.container)
          || (!data.original && (data.ready.sha256 !== data.source.sha256 || data.ready.bytes !== data.source.bytes))))) {
        throw new AppError('音频恢复记录中的格式关系无效；现有文件未改动。')
      }
      state.data = data
      state.stamp = after
    } else await state.save()
    return state
  }
  async save(): Promise<void> {
    if (!sameIdentity(this.owner, await safeLibraryPath(this.work, true))) throw new AppError('音频暂存目录已被替换。')
    manifestSchema.parse(this.data)
    if (this.stamp) {
      const current = await safeLibraryPath(this.file)
      if (!sameIdentity(identity(this.stamp), current) || current.mtimeNs !== this.stamp.mtimeNs || current.size !== this.stamp.size) throw new AppError('音频恢复记录已被其他操作修改。')
      await atomicJson(this.file, this.data, MANIFEST_BYTES)
    } else {
      // The first manifest is exclusive too; updates replace only our previously verified manifest.
      const temporary = path.join(this.work, `.manifest-${randomUUID()}.json`)
      await atomicJson(temporary, this.data, MANIFEST_BYTES)
      const owner = identity(await safeLibraryPath(temporary))
      try { await link(temporary, this.file) } finally { await removeOwned(temporary, owner) }
    }
    this.stamp = await safeLibraryPath(this.file)
  }
  async begin(name: NonNullable<Manifest['partial']>['name']): Promise<Awaited<ReturnType<typeof open>>> {
    if (!sameIdentity(this.owner, await safeLibraryPath(this.work, true))) throw new AppError('音频暂存目录已被替换。')
    const file = path.join(this.work, name)
    const handle = await open(file, 'wx', 0o600)
    const owner = identity(await handle.stat({ bigint: true }))
    try {
      this.data.partial = { name, identity: owner }
      await this.save()
      return handle
    } catch (error) { await handle.close(); await removeOwned(file, owner); throw error }
  }
  async discardPartial(): Promise<void> {
    if (!this.data.partial) return
    await removeOwned(path.join(this.work, this.data.partial.name), this.data.partial.identity)
    delete this.data.partial
    await this.save()
  }
}

function detect(header: Buffer, bytes: number): Container {
  const start = header.subarray(0, 4).toString('ascii')
  if (start === 'fLaC') return 'flac'
  if (['RIFF', 'RF64'].includes(start) && header.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (header.length >= 16 && header.toString('ascii', 4, 8) === 'ftyp' && header.readUInt32BE(0) >= 16 && header.readUInt32BE(0) <= bytes) return 'mov'
  if (start === 'OggS' && header[4] === 0) return 'ogg'
  if ((start.startsWith('ID3') && header.length >= 10 && [2, 3, 4].includes(header[3]) && !header.subarray(6, 10).some(byte => byte >= 128))
    || (header.length >= 4 && header[0] === 255 && (header[1] & 0xe0) === 0xe0 && ((header[1] >> 1) & 3) === 1)) return 'mp3'
  throw new AppError('下载内容不是已知音频；已拒绝伪造文件头、HTML、JSON 和播放列表。')
}

async function receive(options: SaveGeneratedAudioOptions, state: Recovery, signal: AbortSignal): Promise<void> {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), DOWNLOAD_MS)
  deadline.unref()
  const receiving = AbortSignal.any([signal, controller.signal])
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = (): void => { void reader?.cancel().catch(() => undefined) }
  try {
    checkAbort(receiving)
    handle = await state.begin('download.part')
    response = options.connection
      ? await (await import('./providers/local-http')).fetchLocalAudio({ ...options.connection, signal: receiving }, options.url)
      : await openCloudAudio(options.url, receiving, options.fetcher)
    checkAbort(receiving)
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
    const length = response.headers.get('content-length')
    if (!response.ok || !response.body || mime.startsWith('text/') || /html|json|xml/.test(mime) || (encoding && encoding !== 'identity')) throw new AppError('服务未返回有效的原始音频字节，已停止下载。')
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > MAX_BYTES)) throw new AppError('音频大小无效或超过 1 GiB，已停止接收。')
    reader = response.body.getReader()
    receiving.addEventListener('abort', cancel, { once: true })
    let bytes = 0
    let chunks = 0
    for (;;) {
      checkAbort(receiving)
      const { done, value } = await reader.read()
      checkAbort(receiving)
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new AppError('音频超过 1 GiB，已停止接收。')
      if (++chunks > 2_000_000) throw new AppError('音频响应分片过多，已停止接收。')
      // No arrayBuffer()/Buffer.concat(): only the current network chunk is held in memory.
      for (let offset = 0; offset < value.byteLength;) {
        checkAbort(receiving)
        const { bytesWritten } = await handle.write(value, offset, Math.min(64 * 1024, value.byteLength - offset))
        if (!bytesWritten) throw new AppError('音频写入未完成，请检查存储空间。')
        offset += bytesWritten
      }
    }
    if (!bytes || (length !== null && Number(length) !== bytes)) throw new AppError('音频响应长度不符或为空，未保存不完整音频。')
    await handle.sync()
    await handle.close(); handle = undefined
    const fingerprint = await fingerprintFile(path.join(state.work, 'download.part'), 'audio')
    state.data.source = { sha256: fingerprint.sha256, bytes: fingerprint.bytes, container: detect(fingerprint.header, fingerprint.bytes) }
    // Durable receipt BEFORE source.bin or any public path can appear.
    await state.save()
    await publish(path.join(state.work, 'download.part'), path.join(state.work, 'source.bin'), state.data.source)
    await state.discardPartial()
  } finally {
    clearTimeout(deadline)
    receiving.removeEventListener('abort', cancel)
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
    else void response?.body?.cancel().catch(() => undefined)
    controller.abort()
    await handle?.close()
  }
}

/** Caller performs generation preflight. Here resolution performs no uncancellable child processes. */
async function toolsFor(getPath?: () => string | undefined): Promise<VideoTools> {
  const selected = getPath?.()
  const candidates = selected !== undefined ? [selected] : (process.env.PATH ?? '').split(path.delimiter)
    .map(entry => entry.replace(/^"(.*)"$/, '$1')).filter(localLibraryPath)
    .map(directory => path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  for (const candidate of candidates) {
    try { return await resolveToolPaths(candidate) } catch { /* Try the next PATH entry, never shell lookup. */ }
  }
  throw new AppError('未找到本地 FFmpeg / FFprobe，请检查设置；已接收的原始音频保留供恢复。')
}
function inputArgs(container: Container): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', container, '-f', container,
    '-probesize', '1048576', '-analyzeduration', '10000000', '-max_streams', '8',
    ...(container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : [])]
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function duration(value: unknown): number | undefined {
  if (value === undefined || value === 'N/A') return undefined
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('duration')
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) throw new Error('duration')
  return seconds
}
interface Probed { seconds: number; opus: boolean; format: Format }
/** validateMedia's import policy deliberately remains unchanged. This guarded variant additionally
 * recognizes Opus and threads cancellation through EVERY probe/decode/conversion subprocess.
 */
async function probe(file: string, fingerprint: Fingerprint, container: Container, tools: VideoTools, signal: AbortSignal): Promise<Probed> {
  checkAbort(signal)
  await assertFingerprint(file, fingerprint)
  const result = await runTool(tools.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...inputArgs(container), '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 60000, maxOutputBytes: 512 * 1024 })
  await assertFingerprint(file, fingerprint)
  try {
    const raw: unknown = JSON.parse(result.stdout)
    if (!object(raw) || !object(raw.format) || typeof raw.format.format_name !== 'string' || !raw.format.format_name.split(',').includes(container)
      || !Array.isArray(raw.streams) || !raw.streams.length || raw.streams.length > 8 || !raw.streams.every(object)) throw new Error('container')
    const streams = raw.streams as Record<string, unknown>[]
    const audio = streams.filter(stream => stream.codec_type === 'audio')
    if (audio.length !== 1 || streams.some(stream => stream.codec_type !== 'audio' && !(stream.codec_type === 'video' && object(stream.disposition) && stream.disposition.attached_pic === 1))) throw new Error('streams')
    const codec = audio[0].codec_name
    const opus = (container === 'mov' || container === 'ogg') && codec === 'opus'
    if (typeof codec !== 'string' || !(opus || (container === 'wav' ? /^(?:pcm_|adpcm_)/.test(codec) : codec === (container === 'mov' ? 'aac' : container)))) throw new Error('codec')
    if (typeof audio[0].channels !== 'number' || !Number.isInteger(audio[0].channels) || audio[0].channels < 1 || audio[0].channels > 64
      || typeof audio[0].sample_rate !== 'string' || !/^\d+$/.test(audio[0].sample_rate) || Number(audio[0].sample_rate) < 1 || Number(audio[0].sample_rate) > 768000) throw new Error('bounds')
    const containerSeconds = duration(raw.format.duration)
    const seconds = duration(audio[0].duration) ?? containerSeconds
    if (!seconds) throw new Error('no duration')
    return { seconds, opus, format: opus ? 'flac' : container === 'mov' ? 'm4a' : container as Format }
  } catch { throw new AppError('音频容器、编码、音轨或真实时长无效（最长 6 小时），未入库。') }
}
async function decode(file: string, fingerprint: Fingerprint, container: Container, seconds: number, tools: VideoTools, signal: AbortSignal, output?: { file: string; owner: Identity }): Promise<number> {
  await assertFingerprint(file, fingerprint)
  if (output) {
    const empty = await safeLibraryPath(output.file)
    if (!sameIdentity(output.owner, empty) || empty.size !== 0n || empty.nlink !== 1n) throw new AppError('兼容副本暂存文件已被修改，已拒绝覆盖。')
  }
  let decoded = 0
  await runTool(tools.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-max_alloc', '67108864', '-threads', '2',
    ...inputArgs(container), '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '2',
    // A rejection guard, not trimming: hitting this ceiling can NEVER produce an accepted asset.
    '-t', String(MAX_SECONDS + 1), '-progress', 'pipe:1', '-nostats',
    // Reserve room for the final bounded FLAC packet/header: FFmpeg's -fs is a packet boundary,
    // not a byte-exact cap. The full-source decode comparison also rejects every size-limited crop.
    ...(output ? ['-map_metadata', '-1', '-c:a', 'flac', '-sample_fmt', 's32', '-frame_size', '4608', '-fs', String(MAX_BYTES - 2 * 1024 ** 2), '-f', 'flac', '-y', output.file] : ['-f', 'null', '-'])
  ], { signal, timeoutMs: DECODE_MS, maxOutputBytes: 64 * 1024, onProgress: value => { decoded = Math.max(decoded, value) } })
  await assertFingerprint(file, fingerprint)
  if (output && !sameIdentity(output.owner, await safeLibraryPath(output.file))) throw new AppError('兼容副本暂存文件已被替换，已停止保存。')
  if (!(decoded > 0) || decoded > MAX_SECONDS || Math.abs(decoded - seconds) > Math.max(1, seconds * 0.01)) throw new AppError('音频完整解码时长与探测不符或超过 6 小时，未入库。')
  return decoded
}

function result(state: Recovery): GeneratedAudioResult {
  const ready = state.data.ready!
  return { fileName: `audio/${state.data.assetId}.${ready.format}`, durationMs: ready.durationMs,
    ...(state.data.original ? { originalFileName: `audio-originals/${state.data.assetId}.${state.data.original}`, originalSha256: state.data.source!.sha256 } : {}) }
}
async function archive(state: Recovery, source: string): Promise<void> {
  if (!state.data.original) return
  await ensureLibraryDirectory(path.join(state.root, 'audio-originals'))
  await publish(source, path.join(state.root, `audio-originals/${state.data.assetId}.${state.data.original}`), state.data.source!)
}
async function save(options: SaveGeneratedAudioOptions, signal: AbortSignal): Promise<GeneratedAudioResult> {
  checkAbort(signal)
  assertAssetId(options.assetId)
  await safeLibraryPath(options.directory, true)
  const root = path.resolve(options.directory)
  await ensureLibraryDirectory(path.join(root, 'audio'))
  const state = await Recovery.load(root, options.assetId)
  const sourcePath = path.join(state.work, 'source.bin')
  const compatiblePath = path.join(state.work, 'compatible.flac')
  try {
    // Do not adopt unrelated pre-existing media, including the same ID under another extension.
    for (const format of ['mp3', 'wav', 'flac', 'm4a'] as const) {
      const target = path.join(root, `audio/${options.assetId}.${format}`)
      if (await exists(target) && state.data.ready?.format !== format) throw new AppError('该素材标识已有文件，已拒绝覆盖或重复保存。')
    }
    if (state.data.ready) {
      const target = path.join(root, result(state).fileName)
      const staged = state.data.original ? compatiblePath : sourcePath
      if (await exists(target) || await exists(staged)) {
        checkAbort(signal)
        if (state.data.original) {
          const original = path.join(root, result(state).originalFileName!)
          if (await exists(original)) await verified(original, state.data.source!)
          else await archive(state, sourcePath)
        }
        await publish(staged, target, state.data.ready)
        checkAbort(signal)
        return result(state)
      }
      delete state.data.ready
      await state.save()
    }
    if (state.data.partial?.name === 'download.part' && state.data.source) {
      await publish(path.join(state.work, 'download.part'), sourcePath, state.data.source)
      await state.discardPartial()
    } else if (state.data.partial) await state.discardPartial()
    if (!state.data.source) await receive(options, state, signal)
    checkAbort(signal)
    let source = sourcePath
    if (!(await exists(source)) && state.data.original) source = path.join(root, `audio-originals/${options.assetId}.${state.data.original}`)
    const fingerprint = await verified(source, state.data.source!)
    const container = detect(fingerprint.header, fingerprint.bytes)
    if (container !== state.data.source!.container) throw new AppError('音频恢复记录与实际文件头不符。')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DECODE_MS)
    timer.unref()
    const processing = AbortSignal.any([signal, controller.signal])
    try {
      const tools = await toolsFor(options.getFFmpegPath)
      const info = await probe(source, fingerprint, container, tools, processing)
      if (state.data.original && !info.opus) throw new AppError('原始音频恢复记录与实际编码不符。')
      let output = source
      let expectedOutput: Digest = fingerprint
      let durationSeconds: number
      if (info.opus) {
        state.data.original = container === 'mov' ? 'mp4' : 'ogg'
        // Archive receipt is durable before original publication, and before conversion can fail.
        await state.save()
        await archive(state, source)
        // Adding the archive hard link changes ctime; fingerprint the same stored bytes again.
        const archived = await verified(source, state.data.source!)
        const sourceSeconds = await decode(source, archived, container, info.seconds, tools, processing)
        const handle = await state.begin('compatible.flac')
        await handle.close()
        const convertedSeconds = await decode(source, archived, container, info.seconds, tools, processing, { file: compatiblePath, owner: state.data.partial!.identity })
        if (Math.abs(convertedSeconds - sourceSeconds) > 0.00005) throw new AppError('兼容转换未完整解码原曲；原始音频已保留，请检查空间和大小上限。')
        const flushed = await open(compatiblePath, 'r+')
        try { await flushed.sync() } finally { await flushed.close() }
        const converted = await fingerprintFile(compatiblePath, 'audio')
        const outputInfo = await probe(compatiblePath, converted, 'flac', tools, processing)
        durationSeconds = await decode(compatiblePath, converted, 'flac', outputInfo.seconds, tools, processing)
        if (Math.abs(durationSeconds - sourceSeconds) > 0.00005) throw new AppError('兼容副本时长不完整；原始音频已保留，请重试本地转换。')
        output = compatiblePath
        expectedOutput = converted
        await archive(state, source)
      } else durationSeconds = await decode(source, fingerprint, container, info.seconds, tools, processing)
      checkAbort(processing)
      const final = await verified(output, expectedOutput)
      // The complete verified receipt precedes publication; a crash after link() is idempotent.
      state.data.ready = { sha256: final.sha256, bytes: final.bytes, format: info.format, durationMs: Math.max(1, Math.round(durationSeconds * 1000)) }
      await state.save()
      checkAbort(processing)
      await publish(output, path.join(root, result(state).fileName), state.data.ready)
      return result(state)
    } catch (error) { checkAbort(processing); throw error } finally { clearTimeout(timer); controller.abort() }
  } catch (error) {
    // Never delete a known complete source or a ready output. Only our inode-identified partial.
    if (state.data.partial && !state.data.ready && !(state.data.source && state.data.partial.name === 'download.part')) {
      await state.discardPartial().catch(() => undefined)
    }
    throw error
  }
}

const saves = new Map<string, Promise<GeneratedAudioResult>>()
/** New-provider audio only. Original compatible bytes stay byte-for-byte intact; Opus is archived
 * with a complete FLAC compatibility copy. No URLs, credentials, or external paths enter receipts.
 */
export async function saveGeneratedAudio(options: SaveGeneratedAudioOptions): Promise<GeneratedAudioResult> {
  const signal = AbortSignal.any([options.signal, options.connection?.signal].filter((value): value is AbortSignal => !!value))
  if (!localLibraryPath(options.directory)) throw new AppError('音频保存目录必须是安全的本地绝对路径。')
  assertAssetId(options.assetId)
  const key = `${process.platform === 'win32' ? path.resolve(options.directory).toLowerCase() : path.resolve(options.directory)}|${options.assetId.toLowerCase()}`
  const previous = saves.get(key)
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => save(options, signal))
  saves.set(key, pending)
  try { return await pending } catch (error) {
    if (signal.aborted) checkAbort(signal)
    // Drop FFmpeg diagnostic causes, OS paths, remote response text and signed URLs at this boundary.
    throw new AppError(error instanceof AppError ? error.message : '音频下载、校验或保存失败；已接收的原始文件保留供恢复，请检查连接、工具和存储空间后重试。')
  } finally { if (saves.get(key) === pending) saves.delete(key) }
}
