import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { VideoToolsStatus } from '../../shared/types'
import { AppError } from '../providers/http'

export interface VideoTools { ffmpeg: string; ffprobe: string }
export class CancelledError extends AppError {
  constructor() { super('视频任务已取消。'); this.name = 'CancelledError' }
}

const MAX_TIMEOUT = 2 * 60 * 60 * 1000
const MAX_CAPTURE = 16 * 1024 * 1024

function localAbsolute(file: string): boolean {
  return typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file)
    && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(file))
    && !/[\x00-\x1f]/.test(file) && !/^[\\/]{2}/.test(file)
    && !file.slice(process.platform === 'win32' ? 2 : 0).includes(':')
}

/** The caller still owns project registration/containment checks. Never accepts URLs or UNC shares. */
export async function assertLocalMediaFile(file: string): Promise<void> {
  if (!localAbsolute(file)) throw new AppError('媒体文件必须是已登记的本地绝对路径，不能使用网址或网络共享。')
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    if (!localAbsolute(await realpath(file))) throw new Error('not local')
  } catch { throw new AppError('媒体文件不存在、不是普通文件或无法读取。') }
}

async function executablePath(file: string, expected?: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const name = expected ? new RegExp(`^${expected}(?:\\.exe)?$`, 'i') : /^(?:ffmpeg|ffprobe)(?:\.exe)?$/i
  if (!localAbsolute(file) || !name.test(path.basename(file))) {
    throw new AppError('请选择本地 FFmpeg 可执行文件（ffmpeg.exe），不能使用脚本、命令或网址。')
  }
  try {
    const resolved = await realpath(file)
    if (!localAbsolute(resolved) || !name.test(path.basename(resolved)) || !(await stat(resolved)).isFile()) throw new Error('invalid executable')
    return resolved
  } catch { throw new AppError('FFmpeg / FFprobe 可执行文件不存在或不是有效的普通文件。') }
}

/** Trusted main-process callers only. This is deliberately NOT an IPC command/argument API. */
export async function runTool(executable: string, args: string[], options: {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (seconds: number) => void
  maxOutputBytes?: number
} = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new CancelledError()
  const tool = await executablePath(executable)
  const timeout = options.timeoutMs ?? MAX_TIMEOUT
  const maximum = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT
    || !Number.isInteger(maximum) || maximum < 1 || maximum > MAX_CAPTURE
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new AppError('本地媒体工具参数无效。')
  // The engine uses file-backed graphs and a bounded number of input paths per invocation.
  if (process.platform === 'win32' && [tool, ...args].reduce((n, arg) => n + arg.length * 2 + 3, 0) > 30000) {
    throw new AppError('本地媒体工具参数过长，请缩短项目所在路径。')
  }
  if (options.signal?.aborted) throw new CancelledError()
  return new Promise((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let pending = ''
    let lastProgress = -1
    let stopped: AppError | undefined
    let spawnFailed = false
    let closed = false
    const decoder = new StringDecoder('utf8')
    const tail = (previous: Buffer, chunk: Buffer): Buffer => {
      if (chunk.length >= maximum) return Buffer.from(chunk.subarray(chunk.length - maximum))
      return Buffer.concat([previous.subarray(Math.max(0, previous.length + chunk.length - maximum)), chunk])
    }
    const progressLine = (line: string): void => {
      let seconds = NaN
      const micros = /^out_time_(?:us|ms)=(\d+)\s*$/.exec(line)
      const clock = /^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*$/.exec(line)
      if (micros) seconds = Number(micros[1]) / 1000000 // FFmpeg's out_time_ms is also microseconds.
      else if (clock && Number(clock[2]) < 60 && Number(clock[3]) < 60) seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
      if (Number.isFinite(seconds) && seconds >= 0 && seconds > lastProgress) {
        lastProgress = seconds
        try { options.onProgress?.(seconds) } catch { /* UI listeners must not orphan the child. */ }
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(tool, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { reject(new AppError('无法启动本地 FFmpeg / FFprobe，请检查可执行文件和权限。')); return }
    const stop = (error: AppError): void => {
      if (closed || stopped) return
      stopped = error
      // Never kill by name, process group, or a recycled PID; retain this exact child until close.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed) {
        try { child.kill('SIGKILL') } catch { /* close/error still owns settlement and cleanup */ }
      }
    }
    const abort = (): void => stop(new CancelledError())
    const timer = setTimeout(() => stop(new AppError('本地媒体处理超时（最长两小时），任务已停止。')), timeout)
    timer.unref()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = tail(stdout, chunk)
      const lines = (pending + decoder.write(chunk)).split(/\r?\n/)
      pending = (lines.pop() ?? '').slice(-4096)
      for (const line of lines) progressLine(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr, chunk) })
    child.on('error', () => { spawnFailed = true })
    child.once('close', code => {
      closed = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      progressLine(pending + decoder.end())
      if (stopped) { reject(stopped); return }
      if (spawnFailed || code !== 0) {
        const error = new AppError(spawnFailed ? '无法启动本地 FFmpeg / FFprobe，请检查安装和权限。' : 'FFmpeg / FFprobe 处理失败，请检查素材是否损坏以及工具是否支持所需格式。')
        // Diagnostics remain local; safeError/IPC expose only the authored message.
        error.cause = { code, stderr: stderr.toString('utf8') }
        reject(error)
      } else resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    })
    if (options.signal?.aborted) abort()
  })
}

export async function discoverTools(customPath?: string): Promise<VideoToolsStatus> {
  const candidates: string[] = []
  if (customPath !== undefined) candidates.push(customPath)
  else {
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
      const directory = entry.replace(/^"(.*)"$/, '$1')
      // No empty/relative entries and no shell/PATHEXT lookup (which implicitly searches cwd on Windows).
      if (!localAbsolute(directory)) continue
      candidates.push(path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
    }
  }
  let message = '未找到 FFmpeg。请安装本地 FFmpeg，或在设置中选择 ffmpeg.exe（同目录须有 ffprobe.exe）。'
  for (const candidate of [...new Set(candidates)]) {
    try {
      const ffmpeg = await executablePath(candidate, 'ffmpeg')
      const ffprobe = await executablePath(path.join(path.dirname(ffmpeg), /\.exe$/i.test(ffmpeg) ? 'ffprobe.exe' : 'ffprobe'), 'ffprobe')
      const options = { timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024 }
      const version = await runTool(ffmpeg, ['-hide_banner', '-version'], options)
      const probeVersion = await runTool(ffprobe, ['-hide_banner', '-version'], options)
      if (!/^ffmpeg version\s+\S+/m.test(version.stdout) || !/^ffprobe version\s+\S+/m.test(probeVersion.stdout)) throw new AppError('所选工具没有返回有效的 FFmpeg / FFprobe 版本。')
      const encoders = await runTool(ffmpeg, ['-hide_banner', '-encoders'], options)
      const filters = await runTool(ffmpeg, ['-hide_banner', '-filters'], options)
      const missing = ['libx264', 'aac'].filter(name => !new RegExp(`^\\s*[A-Z.]+\\s+${name}\\s`, 'm').test(encoders.stdout))
      missing.push(...['acrossfade', 'afade', 'loudnorm', 'alimiter', 'scale', 'pad', 'crop'].filter(name => !new RegExp(`^\\s*[A-Z.]+\\s+${name}\\s`, 'm').test(filters.stdout)))
      if (missing.length) throw new AppError(`FFmpeg 缺少必要编码器或滤镜：${missing.join('、')}。请安装完整版本。`)
      return { available: true, ffmpeg, ffprobe, version: version.stdout.split(/\r?\n/)[0].slice(0, 500), message: 'FFmpeg / FFprobe 和所需编码器、滤镜已就绪。' }
    } catch (error) {
      if (error instanceof AppError) message = error.message
    }
  }
  return { available: false, message }
}

export async function requireTools(customPath?: string): Promise<VideoTools> {
  const status = await discoverTools(customPath)
  if (!status.available || !status.ffmpeg || !status.ffprobe) throw new AppError(status.message)
  return { ffmpeg: status.ffmpeg, ffprobe: status.ffprobe }
}

export interface ProbeInfo {
  durationSeconds: number
  streams: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    sample_rate?: string
    channels?: number
    pix_fmt?: string
    r_frame_rate?: string
    duration?: string
    nb_read_frames?: string
  }>
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function duration(value: unknown): number | undefined {
  if (value === undefined || value === 'N/A') return undefined
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('invalid time')
  const number = Number(value)
  if (!Number.isFinite(number) || number > Number.MAX_SAFE_INTEGER / 48000) throw new Error('invalid time')
  return number
}

export async function probeMedia(tools: VideoTools, file: string, signal?: AbortSignal, countFrames = false): Promise<ProbeInfo> {
  if (signal?.aborted) throw new CancelledError()
  await assertLocalMediaFile(file)
  const result = await runTool(tools.ffprobe, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', file
  ], { signal, timeoutMs: 60000, maxOutputBytes: 4 * 1024 * 1024 })
  try {
    const data: unknown = JSON.parse(result.stdout)
    if (!record(data) || !Array.isArray(data.streams) || !data.streams.length || data.streams.length > 256) throw new Error('missing streams')
    const streams: ProbeInfo['streams'] = data.streams.map((raw: unknown) => {
      if (!record(raw)) throw new Error('invalid stream')
      const stream: ProbeInfo['streams'][number] = {}
      for (const key of ['codec_type', 'codec_name', 'pix_fmt', 'r_frame_rate', 'sample_rate', 'duration', 'nb_read_frames'] as const) {
        if (raw[key] !== undefined) {
          if (typeof raw[key] !== 'string' || raw[key].length > 128) throw new Error('invalid field')
          stream[key] = raw[key]
        }
      }
      for (const key of ['width', 'height', 'channels'] as const) {
        if (raw[key] !== undefined) {
          if (typeof raw[key] !== 'number' || !Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > (key === 'channels' ? 64 : 32768)) throw new Error('invalid dimension')
          stream[key] = raw[key]
        }
      }
      if (stream.codec_type === 'video' && (!stream.width || !stream.height || stream.width * stream.height > 268435456)) throw new Error('invalid dimensions')
      if (stream.sample_rate !== undefined && (!/^\d+$/.test(stream.sample_rate) || Number(stream.sample_rate) < 1 || Number(stream.sample_rate) > 768000)) throw new Error('invalid sample rate')
      if (stream.r_frame_rate !== undefined && !/^\d+\/\d+$/.test(stream.r_frame_rate)) throw new Error('invalid frame rate')
      if (stream.nb_read_frames !== undefined && (!/^\d+$/.test(stream.nb_read_frames) || !Number.isSafeInteger(Number(stream.nb_read_frames)))) throw new Error('invalid frame count')
      duration(stream.duration)
      return stream
    })
    const formatDuration = record(data.format) ? duration(data.format.duration) : undefined
    // Audio stream length is authoritative for a source with cover art or an imprecise container duration.
    const audio = streams.find(stream => stream.codec_type === 'audio')
    const audioDuration = audio ? duration(audio.duration) : undefined
    const durationSeconds = audioDuration && audioDuration > 0 ? audioDuration : formatDuration ?? 0
    if (audio && durationSeconds <= 0) throw new Error('no audio duration')
    return { durationSeconds, streams }
  } catch { throw new AppError('FFprobe 返回了无效的媒体信息、尺寸或时长，无法安全处理该素材。') }
}
