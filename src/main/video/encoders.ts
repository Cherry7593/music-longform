import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EncoderStatus, VideoDiagnostic } from '../../shared/video-diagnostics'
import { AppError } from '../providers/http'
import { CancelledError, probeMedia, runTool, type VideoTools } from './ffmpeg'
import { diagnosticFor } from './render-diagnostics'
import { encoderDeviceIdentity } from './encoder-device'

export type Encoder = EncoderStatus['encoder']
const base = ['-hide_banner', '-nostdin', '-n', '-v', 'error']
const input = (file: string): string[] => ['-protocol_whitelist', 'file,pipe', '-i', file]
export const STATIC_FRAMES = 30

export async function hashMedia(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) {
    if (signal?.aborted) throw new CancelledError()
    hash.update(bytes)
  }
  if (signal?.aborted) throw new CancelledError()
  return hash.digest('hex')
}

export async function safeDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory) || /^[\\/]{2}/.test(directory)
    || directory.slice(process.platform === 'win32' ? 2 : 0).includes(':')
    || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(directory)) throw new AppError('缓存/任务目录必须是本地绝对路径。')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(await realpath(directory), path.resolve(directory))) throw new AppError('缓存/任务目录被重定向，无法安全使用。')
}
async function safeFile(file: string): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || path.relative(await realpath(file), path.resolve(file))) throw new AppError('缓存文件被重定向。')
}

export function videoEncoderArgs(encoder: Encoder, threads: number): string[] {
  const codec = encoder === 'cpu'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '20', '-x264-params', 'open-gop=0:scenecut=0:keyint=30:min-keyint=30']
    : encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '4M', '-forced-idr', '1']
      : ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '20']
  return [...codec, '-threads', String(threads), '-g', String(STATIC_FRAMES), '-bf', '0', '-flags', '+cgop', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', '30']
}

export async function toolIdentity(tools: VideoTools, signal: AbortSignal): Promise<string> {
  const versions: string[] = []
  for (const [name, file] of Object.entries(tools)) {
    const result = await runTool(file, ['-hide_banner', '-version'], { signal, timeoutMs: 15000, diagnostic: { stage: 'tools' } })
    const version = result.stdout.split(/\r?\n/)[0]
    if (!version.startsWith(`${name} version `)) throw new AppError('FFmpeg / FFprobe 版本无效。')
    const identity = await stat(file)
    versions.push(`${version}|${file}|${identity.size}|${identity.mtimeMs}|${identity.ctimeMs}`)
  }
  return versions.join('\n')
}

async function validateSegment(tools: VideoTools, file: string, signal: AbortSignal, threads: number): Promise<void> {
  const info = await probeMedia(tools, file, signal, true, threads)
  const video = info.streams[0]
  if (info.streams.length !== 1 || video.codec_type !== 'video' || video.codec_name !== 'h264'
    || video.width !== 1920 || video.height !== 1080 || video.pix_fmt !== 'yuv420p'
    || video.r_frame_rate !== '30/1' || Number(video.nb_read_frames) !== STATIC_FRAMES || Math.abs(Number(video.duration) - 1) > 0.00001) throw new AppError('静图片段编码规格、帧数或时长校验失败。')
  const frames = await runTool(tools.ffprobe, ['-v', 'error', '-threads', String(threads), ...input(file), '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=key_frame,pict_type,best_effort_timestamp_time', '-of', 'json'], { signal })
  const data = JSON.parse(frames.stdout) as { frames: Array<{ key_frame: number; pict_type: string; best_effort_timestamp_time: string }> }
  if (data.frames.length !== STATIC_FRAMES || data.frames[0].key_frame !== 1 || data.frames.some((frame, index) => frame.pict_type === 'B' || Math.abs(Number(frame.best_effort_timestamp_time) - index / 30) > 0.00001)) throw new AppError('静图片段不是从关键帧开始的无 B 帧闭合序列。')
  await runTool(tools.ffmpeg, [...base, '-threads', String(threads), '-xerror', '-err_detect', 'explode', ...input(file), '-map', '0:v:0', '-f', 'null', '-'], { signal, diagnostic: { stage: 'tools' } })
}

type ProbeStatus = EncoderStatus & { diagnostic?: VideoDiagnostic }
/** Only evidence from a real short encode/probe/decode is cached; hardware keys include live driver/device identity. */
const tested = new Map<string, { at: number; status: ProbeStatus }>()
export function clearEncoderProbeCache(): void { tested.clear() }
function rememberProbe(key: string | undefined, status: ProbeStatus): void {
  if (!key) return
  if (tested.size >= 64) tested.clear()
  tested.set(key, { at: Date.now(), status: structuredClone(status) })
}
export async function probeEncoder(tools: VideoTools, encoder: Encoder, directory: string, signal: AbortSignal, threads: number, identity: string): Promise<EncoderStatus & { diagnostic?: VideoDiagnostic }> {
  if (signal.aborted) throw new CancelledError()
  const device = encoder === 'cpu' ? 'cpu' : await encoderDeviceIdentity(signal)
  const key = device ? `${identity}|${encoder}|${threads}|${process.platform}|${process.arch}|${device}` : undefined
  const cached = key ? tested.get(key) : undefined
  const ttl = encoder === 'cpu' || !cached?.status.available ? 30000 : 300000
  if (cached && Date.now() - cached.at < ttl) return structuredClone(cached.status)
  const work = await mkdtemp(path.join(directory, 'encoder-test-'))
  try {
    const file = path.join(work, 'probe.mp4')
    await runTool(tools.ffmpeg, [...base, '-filter_threads', String(threads), '-f', 'lavfi', '-i', 'color=c=0x334455:s=1920x1080:r=30', '-frames:v', String(STATIC_FRAMES), '-an', ...videoEncoderArgs(encoder, threads), file], { signal, timeoutMs: 30000, diagnostic: { stage: 'tools', encoder } })
    await validateSegment(tools, file, signal, threads)
    const status = { encoder, available: true, message: `${encoder} 已通过真实 1080p30 短编码、逐帧探测及完整解码。` }
    rememberProbe(key, status)
    return status
  } catch (error) {
    if (error instanceof CancelledError || signal.aborted) throw error
    const diagnostic = diagnosticFor(error, { stage: 'tools', encoder, toolVersion: identity.split('|')[0] })
    const status = { encoder, available: false, message: `${encoder} 实际初始化/验证失败 (${diagnostic.category})：${diagnostic.stderr ?? diagnostic.message}`, diagnostic }
    rememberProbe(key, status)
    return status
  } finally { await rm(work, { recursive: true, force: true }) }
}

export async function selectEncoder(tools: VideoTools, preference: Encoder | 'auto', directory: string, signal: AbortSignal, threads: number, identity: string): Promise<{ encoder: Encoder; statuses: EncoderStatus[]; fallbacks: VideoDiagnostic[] }> {
  const candidates: Encoder[] = preference === 'auto' ? ['nvenc', 'qsv', 'cpu'] : preference === 'cpu' ? ['cpu'] : [preference, 'cpu']
  const statuses: EncoderStatus[] = [], fallbacks: VideoDiagnostic[] = []
  for (const encoder of candidates) {
    const status = await probeEncoder(tools, encoder, directory, signal, threads, identity)
    statuses.push(status)
    if (status.available) return { encoder, statuses, fallbacks }
    fallbacks.push({ ...(status.diagnostic ?? diagnosticFor(new AppError(status.message), { stage: 'tools', encoder })), suggestion: '改试下一候选；硬件失败时明确回退 CPU。' })
  }
  throw Object.assign(new AppError('CPU 与候选硬件编码器均未通过实际编码测试。'), { diagnostic: fallbacks.at(-1) })
}

export function staticFilter(fit: 'contain' | 'cover'): string {
  const scale = fit === 'contain'
    ? 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black'
    : 'scale=1920:1080:force_original_aspect_ratio=increase:force_divisible_by=2:out_range=tv,crop=1920:1080:(iw-ow)/2:(ih-oh)/2'
  return `${scale},setsar=1,format=yuv420p`
}

/** Entry directory is published atomically; concurrent producers never overwrite an existing entry. */
export async function staticSegment(options: { tools: VideoTools; image: string; imageHash: string; fit: 'contain' | 'cover'; encoder: Encoder; threads: number; identity: string; cacheDirectory: string; taskDirectory: string; signal: AbortSignal }): Promise<{ filePath: string; cacheHit: boolean }> {
  const { tools, image, imageHash, fit, encoder, threads, identity, cacheDirectory, taskDirectory, signal } = options
  await safeDirectory(cacheDirectory)
  const root = path.join(cacheDirectory, 'music-static-v4')
  await mkdir(root, { recursive: true }); await safeDirectory(root)
  const key = createHash('sha256').update(JSON.stringify({ v: 1, imageHash, filter: staticFilter(fit), args: videoEncoderArgs(encoder, threads), identity })).digest('hex')
  const entry = path.join(root, key)
  const readEntry = async (): Promise<string> => {
    await safeDirectory(entry)
    const file = path.join(entry, 'segment.mp4'), meta = path.join(entry, 'entry.json')
    await safeFile(file); await safeFile(meta)
    const data = JSON.parse(await readFile(meta, 'utf8')) as { key: string; sha256: string }
    if (data.key !== key || data.sha256 !== await hashMedia(file, signal)) throw new AppError('静图片段缓存校验失败。')
    await validateSegment(tools, file, signal, threads)
    return file
  }
  try { return { filePath: await readEntry(), cacheHit: true } }
  catch (error) { if (error instanceof CancelledError || signal.aborted) throw error }
  const pending = await mkdtemp(path.join(root, '.pending-'))
  try {
    const file = path.join(pending, 'segment.mp4'), snapshot = path.join(pending, `source${path.extname(image)}`)
    await copyFile(image, snapshot, constants.COPYFILE_EXCL)
    if (await hashMedia(snapshot, signal) !== imageHash) throw new AppError('图片在建立缓存快照时发生变化。')
    await runTool(tools.ffmpeg, [...base, '-threads', String(threads), '-filter_threads', String(threads), '-loop', '1', '-framerate', '30', ...input(snapshot), '-vf', staticFilter(fit), '-frames:v', String(STATIC_FRAMES), '-an', ...videoEncoderArgs(encoder, threads), '-map_metadata', '-1', file], { signal, diagnostic: { stage: 'encode', encoder } })
    await rm(snapshot)
    await validateSegment(tools, file, signal, threads)
    await writeFile(path.join(pending, 'entry.json'), JSON.stringify({ key, sha256: await hashMedia(file, signal) }), { flag: 'wx' })
    if (signal.aborted) throw new CancelledError()
    await safeDirectory(root)
    try { await rename(pending, entry); return { filePath: path.join(entry, 'segment.mp4'), cacheHit: false } }
    catch {
      try { return { filePath: await readEntry(), cacheHit: true } }
      catch (error) { if (error instanceof CancelledError || signal.aborted) throw error }
      // A corrupt/foreign entry is never deleted or overwritten. Use this attempt's validated private copy.
      const privateFile = path.join(taskDirectory, `static-${randomUUID()}.mp4`)
      await rename(file, privateFile)
      return { filePath: privateFile, cacheHit: false }
    }
  } finally { await rm(pending, { recursive: true, force: true }) }
}
