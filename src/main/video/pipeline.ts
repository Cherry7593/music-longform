import { lstat, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { videoDraftSchema } from '../../shared/schemas'
import type { VideoDraft, VideoJobStatus, VideoTimeline } from '../../shared/types'
import { AppError } from '../providers/http'
import { assertLocalMediaFile, CancelledError, probeMedia, runTool, type VideoTools } from './ffmpeg'
import { calculateTimeline } from './timeline'
import type { RenderMetrics, RenderStage } from '../../shared/video-diagnostics'
import { hashMedia, selectEncoder, staticFilter, staticSegment, toolIdentity, videoEncoderArgs, type Encoder } from './encoders'
import { diagnosticFor, RenderClock, withDiagnostic } from './render-diagnostics'

export interface RenderTrack { id: string; path: string; durationSeconds: number }
export interface RenderProgress { status: VideoJobStatus; progress?: number; detail: string }
export interface RenderRequest {
  tools: VideoTools
  draft: VideoDraft
  tracks: RenderTrack[]
  imagePath?: string
  taskDirectory: string
  kind: 'video' | 'preview'
  boundaryIndex?: number
  minimumSeconds?: number
  signal: AbortSignal
  onProgress?: (event: RenderProgress) => void
  onStage?: (stage: RenderStage) => void
  performance?: { threads: number; encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv'; cacheDirectory: string; staticVideo: boolean }
}

const RATE = 48000
const PCM_BYTES_PER_SECOND = RATE * 2 * 4 // float WAV avoids intermediate clipping/quantization
const base = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2']
const toolBase = (req: RenderRequest): string[] => base.map((value, index) => value === '2' && base[index - 1].includes('threads') ? String(req.performance?.threads ?? 2) : value)
const input = (file: string): string[] => ['-protocol_whitelist', 'file,pipe', '-i', file]
const pcm = ['-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-rf64', 'auto', '-map_metadata', '-1']
const decimal = (seconds: number): string => seconds.toFixed(8)
const samples = (seconds: number): number => Math.round(seconds * RATE)
const standardize = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

function checkAbort(req: RenderRequest): void { if (req.signal.aborted) throw new CancelledError() }
function usable(timeline: VideoTimeline, minimum = 0): void {
  if (timeline.issues.length) throw new AppError(timeline.issues.join('；'))
  if (!Number.isFinite(timeline.outputSeconds) || timeline.outputSeconds <= 0 || timeline.outputSeconds > 21600
    || timeline.missingSeconds > 1 / RATE) throw new AppError('音乐时长无效或不足目标时长；请补充音乐，不会循环或补静音。')
  if (timeline.outputSeconds + 1 / RATE < minimum) throw new AppError('音乐实际时长不足最短时长；请补充音乐，不会裁歌、循环或补静音。')
}
function previewWindow(req: RenderRequest, timeline: VideoTimeline): { start: number; duration: number } {
  const index = req.boundaryIndex
  if (!Number.isInteger(index) || index === undefined || index < 0 || index >= timeline.tracks.length - 1) throw new AppError('请选择有效的相邻两首音乐连接处。')
  const left = timeline.tracks[index]
  const right = timeline.tracks[index + 1]
  const d = req.draft.transition === 'cut' ? 0 : req.draft.transitionSeconds
  const transitionEnd = req.draft.transition === 'crossfade' ? left.endSeconds : right.startSeconds + d
  if (right.usedSeconds <= 0 || transitionEnd > timeline.outputSeconds + 1 / RATE) throw new AppError('目标时长已裁掉或截断该连接处，无法试听完整转场。')
  const radius = req.draft.transition === 'fade' ? Math.max(5, d) : 5
  const start = Math.max(0, right.startSeconds - radius)
  const end = Math.min(timeline.outputSeconds, (req.draft.transition === 'crossfade' ? left.endSeconds : right.startSeconds) + radius)
  if (end <= start || end - start >= 30) throw new AppError('转场试听区间无效。')
  return { start, duration: end - start }
}

async function preflightSpace(req: RenderRequest, timeline: VideoTimeline, directAudio = false, segmentBytes?: number): Promise<void> {
  const preparedSeconds = timeline.tracks.filter(track => track.usedSeconds > 0).reduce((sum, track) => sum + track.durationSeconds, 0)
  // Prepared WAVs + disjoint transition/body WAVs + full master WAV. Bound video by its VBV rate;
  // allow faststart's second copy, headers, rounding, and 256 MiB headroom. No source is modified.
  const audio = (directAudio ? timeline.outputSeconds : preparedSeconds * 2 + timeline.outputSeconds) * PCM_BYTES_PER_SECOND
  const video = req.kind === 'video' ? (segmentBytes === undefined ? timeline.outputSeconds * 8000000 / 8 : Math.ceil(timeline.outputSeconds) * segmentBytes) * 2 + timeline.outputSeconds * 192000 / 8 * 2 : 30 * PCM_BYTES_PER_SECOND
  const required = Math.ceil((audio + video) * 1.2 + 256 * 1024 * 1024)
  let free: number
  try {
    const space = await statfs(req.taskDirectory, { bigint: true })
    free = Number(space.bavail * space.bsize)
  } catch { throw new AppError('无法检查任务磁盘的可用空间，请检查输出目录权限。') }
  if (!Number.isFinite(required) || !Number.isFinite(free) || free < required) {
    throw new AppError(`磁盘空间不足：本次合成保守估计需要 ${(required / 1073741824).toFixed(2)} GB，可用 ${(free / 1073741824).toFixed(2)} GB。请释放空间后重试。`)
  }
}

/** Full-source two-pass EBU R128, including stereo conversion in both passes. */
async function loudnessFilter(req: RenderRequest, track: RenderTrack, progress: (seconds: number) => void): Promise<string> {
  const analysis = await runTool(req.tools.ffmpeg, [
    ...toolBase(req), '-loglevel', 'info', ...input(track.path), '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `${standardize},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'
  ], { signal: req.signal, onProgress: progress })
  const blocks = analysis.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g)
  if (!blocks?.length) throw new AppError('无法取得完整曲目的响度分析结果。')
  let data: Record<string, unknown>
  try { data = JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown> } catch { throw new AppError('响度分析结果无效。') }
  // EBU gating on silence reports -inf (and sometimes inf for offset). Do not feed NaN/inf back to FFmpeg.
  if (data.input_i === '-inf' || data.input_tp === '-inf') return ''
  const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
  const values = fields.map(field => typeof data[field] === 'string' && /^-?\d+(?:\.\d+)?$/.test(data[field] as string) ? Number(data[field]) : NaN)
  if (!values.every(Number.isFinite)) throw new AppError('曲目响度分析包含无效数值，无法进行音量均衡。')
  const [i, tp, lra, threshold, offset] = values
  return `,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${threshold}:offset=${offset}:linear=true:print_format=none`
}

/**
 * Private working-directory engine only: no project mutation, final rename, locks, or cleanup.
 * A bounded-input, disjoint-segment graph keeps crossfades O(total audio), not O(n²) full-prefix joins.
 * Both preview and video consume the SAME full, trimmed/faded/limited master audio.
 */
export async function renderMedia(req: RenderRequest): Promise<{ filePath: string; durationSeconds: number; timeline: VideoTimeline; metrics?: RenderMetrics }> {
  const clock = new RenderClock(req.onStage)
  const context: { assetId?: string; toolVersion?: string } = {}
  try {
    const result = await renderAttempt(req, clock, context)
    return { ...result, metrics: clock.finish() }
  } catch (error) { throw withDiagnostic(error, { ...context, stage: clock.stage, encoder: clock.metrics.encoder }) }
}

async function renderAttempt(req: RenderRequest, clock: RenderClock, context: { assetId?: string; toolVersion?: string }): Promise<{ filePath: string; durationSeconds: number; timeline: VideoTimeline }> {
  checkAbort(req)
  const parsed = videoDraftSchema.safeParse(req.draft)
  if (!parsed.success || !['video', 'preview'].includes(req.kind)) throw new AppError('视频合成参数无效，请重新检查设置。')
  if (req.minimumSeconds !== undefined && (!Number.isFinite(req.minimumSeconds) || req.minimumSeconds < 60 || req.minimumSeconds > 21600
    || req.kind !== 'video' || parsed.data.durationMode !== 'all')) throw new AppError('批量最短时长约束不正确。')
  // Capture all caller-owned mutable arrays/objects; edits to the UI cannot change an active render.
  if (req.performance && (!Number.isInteger(req.performance.threads) || req.performance.threads < 1 || req.performance.threads > 16
    || !['auto', 'cpu', 'nvenc', 'qsv'].includes(req.performance.encoder) || typeof req.performance.staticVideo !== 'boolean'
    || typeof req.performance.cacheDirectory !== 'string')) throw new AppError('视频性能参数无效。')
  req = { ...req, tools: { ...req.tools }, draft: parsed.data, tracks: req.tracks.map(track => ({ ...track })), performance: req.performance ? { ...req.performance } : undefined }
  const base = toolBase(req)
  const threads = req.performance?.threads ?? 4
  const draft = req.draft
  if (!req.tracks.length || req.tracks.length > 100 || new Set(req.tracks.map(track => track.id)).size !== req.tracks.length
    || req.tracks.some(track => !Number.isFinite(track.durationSeconds) || track.durationSeconds <= 0)) throw new AppError('音乐列表或真实时长无效。')
  const byId = new Map(req.tracks.map(track => [track.id, track]))
  const ordered = draft.audioIds.map(id => byId.get(id))
  if (ordered.some(track => !track)) throw new AppError('所选音乐不在已登记的素材列表中。')
  const sources = ordered as RenderTrack[]
  let timeline = calculateTimeline(draft, sources)
  usable(timeline, req.minimumSeconds)
  if (req.kind === 'preview') previewWindow(req, timeline)
  if (!path.isAbsolute(req.taskDirectory) || /[\x00-\x1f]/.test(req.taskDirectory) || /^[\\/]{2}/.test(req.taskDirectory)
    || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(req.taskDirectory))) throw new AppError('任务目录必须是本地绝对路径。')
  try {
    const directory = await lstat(req.taskDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('invalid directory')
    const resolved = await realpath(req.taskDirectory)
    if (path.relative(resolved, req.taskDirectory)) throw new Error('redirected directory')
  } catch { throw new AppError('任务专用目录不存在、被重定向或无法写入。') }
  let lastProgress = 0
  const notify = (status: VideoJobStatus, progress: number, detail: string): void => {
    checkAbort(req)
    lastProgress = Math.max(lastProgress, Math.min(0.995, progress))
    req.onProgress?.({ status, progress: lastProgress, detail })
  }
  clock.enter('probe')
  notify('analyzing', 0.01, '检查素材、真实时长与磁盘空间')
  for (const track of sources) { context.assetId = track.id; checkAbort(req); await assertLocalMediaFile(track.path) }
  context.assetId = undefined
  if (req.kind === 'video') {
    context.assetId = draft.imageId
    if (!req.imagePath) throw new AppError('请先选择本项目的一张静态图片。')
    // image2 may report a nominal 0.04s for a single JPEG; duration alone is not a frame count.
    const image = await probeMedia(req.tools, req.imagePath, req.signal, true, threads)
    if (image.streams.length !== 1 || !image.streams.some(stream => stream.codec_type === 'video'
      && ['png', 'mjpeg', 'webp', 'bmp'].includes(stream.codec_name ?? '') && stream.nb_read_frames === '1')) {
      throw new AppError('所选素材不是支持的单帧静态图片。')
    }
  }
  context.assetId = undefined
  // Legacy preview/target and normalization retain the bounded prepared-segment engine.
  if (req.kind === 'preview') await preflightSpace(req, timeline)
  const sourceHashes = new Map<string, string>()
  for (const source of [...sources, ...(req.imagePath && req.kind === 'video' ? [{ id: draft.imageId, path: req.imagePath }] : [])]) {
    context.assetId = source.id
    sourceHashes.set(source.path, await hashMedia(source.path, req.signal))
  }
  let directAudio = req.kind === 'video' && draft.durationMode === 'all' && !draft.normalize && sources.length <= 4
  if (directAudio) {
    for (const source of sources) {
      context.assetId = source.id
      const info = await probeMedia(req.tools, source.path, req.signal, false, threads)
      const audio = info.streams.find(stream => stream.codec_type === 'audio')
      if (info.streams.length !== 1 || !audio || audio.sample_rate !== '48000' || !/^(?:pcm_s16le|pcm_s24le|pcm_s32le|pcm_f32le|flac)$/.test(audio.codec_name ?? '')) { directAudio = false; break }
      source.durationSeconds = Math.round(info.durationSeconds * RATE) / RATE
    }
    timeline = calculateTimeline(draft, sources); usable(timeline, req.minimumSeconds)
  }
  context.assetId = undefined
  let encoder: Encoder = 'cpu', identity = ''
  let segment: { filePath: string; cacheHit: boolean } | undefined
  if (req.kind === 'video') {
    clock.enter('tools')
    identity = await toolIdentity(req.tools, req.signal)
    context.toolVersion = identity.split('|')[0]
    const selection = await selectEncoder(req.tools, req.performance?.encoder ?? 'auto', req.taskDirectory, req.signal, threads, identity)
    encoder = selection.encoder; clock.metrics.encoder = encoder
    clock.metrics.fallbacks!.push(...selection.fallbacks)
    for (const fallback of selection.fallbacks) notify('analyzing', 0.02, `${fallback.encoder} 实际探测失败（${fallback.category}）；最终使用 ${encoder}`)
    if ((req.performance?.staticVideo ?? true) && draft.durationMode === 'all') {
      clock.enter('encode')
      try {
        segment = await staticSegment({ tools: req.tools, image: req.imagePath!, imageHash: sourceHashes.get(req.imagePath!)!, fit: draft.fit, encoder, threads, identity,
          cacheDirectory: req.performance?.cacheDirectory ?? req.taskDirectory, taskDirectory: req.taskDirectory, signal: req.signal })
        clock.metrics.cacheHit = segment.cacheHit
      } catch (error) {
        if (error instanceof CancelledError || req.signal.aborted) throw error
        clock.metrics.fallbacks!.push(diagnosticFor(error, { stage: 'encode', encoder, suggestion: '静图缓存/短片组合未通过验证，回退直接 CPU 编码。' }))
        encoder = 'cpu'; clock.metrics.encoder = encoder
        await selectEncoder(req.tools, 'cpu', req.taskDirectory, req.signal, threads, identity)
        notify('analyzing', 0.03, '静图缓存/短片不可用，回退直接 CPU 编码（保留完整输出校验）')
      }
    }
    await preflightSpace(req, timeline, directAudio, segment ? (await stat(segment.filePath)).size : undefined)
  }
  clock.metrics.audioPath = directAudio ? 'bounded-direct' : 'prepared-segments'
  clock.enter('audio')
  const file = (name: string): string => path.join(req.taskDirectory, name)
  const numbered = (prefix: string, index: number, extension = 'wav'): string => `${prefix}-${String(index).padStart(3, '0')}.${extension}`
  const graph = async (name: string, content: string): Promise<string[]> => {
    checkAbort(req)
    const script = file(`${name}.filter.txt`)
    await writeFile(script, content, { encoding: 'utf8', flag: 'wx' })
    return ['-/filter_complex', script, '-map', '[out]']
  }
  const master = file('master.wav')
  const finish = draft.durationMode === 'all' ? ['asetpts=N/SR/TB'] : [`atrim=end_sample=${samples(timeline.outputSeconds)}`, 'asetpts=N/SR/TB']
  // Direct path uses only sample-exact lossless 48 kHz inputs, at most four open streams.
  if (directAudio) {
    const filters: string[] = []
    for (let index = 0; index < sources.length; index++) {
      const fades: string[] = []
      if (draft.transition === 'fade' && index > 0) fades.push(`afade=t=in:st=0:d=${decimal(draft.transitionSeconds)}:curve=qsin`)
      if (draft.transition === 'fade' && index < sources.length - 1) fades.push(`afade=t=out:st=${decimal(sources[index].durationSeconds - draft.transitionSeconds)}:d=${decimal(draft.transitionSeconds)}:curve=qsin`)
      filters.push(`[${index}:a:0]${standardize},asetpts=N/SR/TB${fades.length ? ',' + fades.join(',') : ''}[a${index}]`)
    }
    let joined = 'a0'
    if (draft.transition === 'crossfade') {
      for (let index = 1; index < sources.length; index++) {
        filters.push(`[${joined}][a${index}]acrossfade=ns=${samples(draft.transitionSeconds)}:o=1:c1=qsin:c2=qsin[j${index}]`)
        joined = `j${index}`
      }
    } else if (sources.length > 1) { filters.push(`${sources.map((_, i) => `[a${i}]`).join('')}concat=n=${sources.length}:v=0:a=1[joined]`); joined = 'joined' }
    if (draft.fadeInSeconds > 0) finish.push(`afade=t=in:st=0:d=${decimal(draft.fadeInSeconds)}:curve=qsin`)
    if (draft.fadeOutSeconds > 0) finish.push(`afade=t=out:st=${decimal(timeline.outputSeconds - draft.fadeOutSeconds)}:d=${decimal(draft.fadeOutSeconds)}:curve=qsin`)
    finish.push('alimiter=limit=0.89125094:level=false:latency=true', 'asetpts=N/SR/TB')
    filters.push(`[${joined}]${finish.join(',')}[out]`)
    clock.enter('mix')
    await runTool(req.tools.ffmpeg, [...base, ...sources.flatMap(source => input(source.path)), ...await graph('master', filters.join(';')), ...pcm, master], {
      signal: req.signal, onProgress: seconds => notify('mixing', 0.05 + 0.55 * Math.min(1, seconds / timeline.outputSeconds), '有界整曲直接混音（不写重复预处理及分段 WAV）')
    })
  } else {
  const prepared: Array<RenderTrack & { name: string }> = []
  for (let index = 0; index < sources.length; index++) {
    if (timeline.tracks[index].usedSeconds <= 0) break
    const source = sources[index]
    context.assetId = sources[index].id
    const count = timeline.tracks.filter(track => track.usedSeconds > 0).length
    const progress = (pass: number, seconds: number): void => notify('processing', 0.05 + 0.35 * (index + (pass + Math.min(1, seconds / source.durationSeconds)) / (draft.normalize ? 2 : 1)) / count, `处理第 ${index + 1} / ${count} 首音乐${draft.normalize ? '（完整曲目两遍响度均衡）' : ''}`)
    progress(0, 0)
    const loudness = draft.normalize ? await loudnessFilter(req, source, seconds => progress(0, seconds)) : ''
    const name = numbered('prepared', index)
    const filters = await graph(`prepare-${index}`, `[0:a:0]${standardize}${loudness},aresample=48000,asetpts=N/SR/TB[out]`)
    await runTool(req.tools.ffmpeg, [...base, ...input(source.path), ...filters, ...pcm, file(name)], {
      signal: req.signal, onProgress: seconds => progress(draft.normalize ? 1 : 0, seconds)
    })
    const info = await probeMedia(req.tools, file(name), req.signal, false, threads)
    const audio = info.streams.find(stream => stream.codec_type === 'audio')
    if (!audio || audio.sample_rate !== '48000' || audio.channels !== 2 || info.durationSeconds <= 0) throw new AppError('预处理音乐的采样率、声道或时长校验失败。')
    prepared.push({ ...source, name, path: file(name), durationSeconds: info.durationSeconds })
    const previousUsed = timeline.tracks.filter(track => track.usedSeconds > 0).length
    timeline = calculateTimeline(draft, sources.map((track, i) => prepared[i] ?? track))
    usable(timeline, req.minimumSeconds) // Recheck full decoded durations, never trim to the minimum.
    if (timeline.tracks.filter(track => track.usedSeconds > 0).length > previousUsed) await preflightSpace(req, timeline)
  }
  if (req.kind === 'preview') previewWindow(req, timeline)
  context.assetId = undefined
  clock.enter('mix')
  const used = prepared.filter((_, index) => timeline.tracks[index].usedSeconds > 0)
  const parts: string[] = []
  const d = draft.transitionSeconds
  for (let index = 0; index < used.length; index++) {
    checkAbort(req)
    const track = used[index]
    const detail = `拼接第 ${index + 1} / ${used.length} 首音乐`
    const onProgress = (seconds: number): void => notify('mixing', 0.40 + 0.12 * (index + Math.min(1, seconds / track.durationSeconds)) / used.length, detail)
    onProgress(0)
    if (draft.transition === 'cut') { parts.push(track.name); continue }
    if (draft.transition === 'fade') {
      const fades: string[] = []
      if (index > 0) fades.push(`afade=t=in:st=0:d=${decimal(d)}:curve=qsin`)
      // Retain an outgoing fade even when the target ends before the next (unused) track starts.
      if (index < sources.length - 1) fades.push(`afade=t=out:st=${decimal(track.durationSeconds - d)}:d=${decimal(d)}:curve=qsin`)
      const name = numbered('fade', index)
      const filters = await graph(`fade-${index}`, `[0:a:0]${fades.length ? fades.join(',') : 'anull'},asetpts=N/SR/TB[out]`)
      await runTool(req.tools.ffmpeg, [...base, ...input(track.path), ...filters, ...pcm, file(name)], { signal: req.signal, onProgress })
      parts.push(name)
      continue
    }
    // Only the non-overlapping body and one bounded two-input boundary are written per track.
    // This is sample-equivalent to a chain of qsin acrossfades when transition windows do not collide.
    const start = index > 0 ? samples(d) : 0
    const end = samples(track.durationSeconds) - (index < used.length - 1 ? samples(d) : 0)
    if (end > start) {
      const name = numbered('body', index)
      const filters = await graph(`body-${index}`, `[0:a:0]atrim=end_sample=${end - start},asetpts=N/SR/TB[out]`)
      await runTool(req.tools.ffmpeg, [...base, '-ss', decimal(start / RATE), ...input(track.path), ...filters, ...pcm, file(name)], { signal: req.signal, onProgress })
      parts.push(name)
    }
    if (index < used.length - 1) {
      const next = used[index + 1]
      const name = numbered('join', index)
      const filters = await graph(`join-${index}`, `[0:a:0]atrim=end_sample=${samples(d)},asetpts=N/SR/TB[left];[1:a:0]atrim=end_sample=${samples(d)},asetpts=N/SR/TB[right];[left][right]acrossfade=ns=${samples(d)}:o=1:c1=qsin:c2=qsin[out]`)
      await runTool(req.tools.ffmpeg, [
        ...base, '-ss', decimal((samples(track.durationSeconds) - samples(d)) / RATE), '-t', decimal(d), ...input(track.path),
        '-t', decimal(d), ...input(next.path), ...filters, ...pcm, file(name)
      ], { signal: req.signal })
      parts.push(name)
    }
  }
  // Only engine-generated short ASCII basenames enter this demuxer. User paths never enter its grammar.
  const manifest = file('playlist.ffconcat')
  await writeFile(manifest, `ffconcat version 1.0\n${parts.map(name => `file '${name}'`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
  if (draft.fadeInSeconds > 0) finish.push(`afade=t=in:st=0:d=${decimal(draft.fadeInSeconds)}:curve=qsin`)
  if (draft.fadeOutSeconds > 0) finish.push(`afade=t=out:st=${decimal(timeline.outputSeconds - draft.fadeOutSeconds)}:d=${decimal(draft.fadeOutSeconds)}:curve=qsin`)
  finish.push('alimiter=limit=0.89125094:level=false:latency=true', 'asetpts=N/SR/TB')
  const finishGraph = await graph('master', `[0:a:0]${finish.join(',')}[out]`)
  await runTool(req.tools.ffmpeg, [...base, '-f', 'concat', '-safe', '1', ...input(manifest), ...finishGraph, ...pcm, master], {
    signal: req.signal, onProgress: seconds => notify('mixing', 0.52 + 0.08 * Math.min(1, seconds / timeline.outputSeconds), draft.durationMode === 'all' ? '完整播放列表、首尾淡化与防削波' : '裁切目标时长、首尾淡化与防削波')
  })
  }
  const masterInfo = await probeMedia(req.tools, master, req.signal, false, threads)
  if (Math.abs(masterInfo.durationSeconds - timeline.outputSeconds) > (directAudio ? 1 / RATE : 0.02)) throw new AppError('合成音轨时长不符，已阻止输出；不会使用静音补齐。')
  clock.enter('encode')
  let filePath: string
  let expectedSeconds: number
  let directFallback: (() => Promise<void>) | undefined
  if (req.kind === 'preview') {
    const window = previewWindow(req, timeline)
    filePath = file('preview.partial.wav')
    expectedSeconds = window.duration
    await runTool(req.tools.ffmpeg, [...base, '-ss', decimal(window.start), ...input(master), '-t', decimal(window.duration), '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', filePath], {
      signal: req.signal, onProgress: seconds => notify('encoding', 0.60 + 0.35 * Math.min(1, seconds / expectedSeconds), '生成与成片相同的连接处试听')
    })
  } else {
    filePath = file('video.partial.mp4')
    try { await lstat(filePath); throw new AppError('任务输出文件已存在；不会覆盖或删除已有媒体。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    expectedSeconds = timeline.outputSeconds
    const videoSeconds = Math.ceil(samples(expectedSeconds) * 30 / RATE) / 30
    const encode = async (copy: boolean): Promise<void> => {
      const videoInput = copy ? ['-stream_loop', '-1', '-t', decimal(videoSeconds), ...input(segment!.filePath)]
        : ['-loop', '1', '-framerate', '30', '-t', decimal(videoSeconds), ...input(req.imagePath!)]
      await runTool(req.tools.ffmpeg, [...base, ...videoInput, ...input(master), '-map', '0:v:0', '-map', '1:a:0',
        ...(copy ? ['-c:v', 'copy'] : ['-vf', staticFilter(draft.fit), ...videoEncoderArgs(encoder, threads)]),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-movflags', '+faststart', filePath
      ], { signal: req.signal, diagnostic: { stage: 'encode', encoder }, onProgress: seconds => notify('encoding', 0.60 + 0.35 * Math.min(1, seconds / expectedSeconds), copy ? '静图视频轨循环流拷贝；完整音乐仅播放一次' : `直接 ${encoder} 编码 1920×1080 静态画面与音乐`) })
    }
    directFallback = async (): Promise<void> => {
      clock.enter('encode')
      await rm(filePath, { force: true }) // checked absent before this attempt; only its private partial output
      encoder = 'cpu'; clock.metrics.encoder = encoder; clock.metrics.staticVideo = false
      await selectEncoder(req.tools, 'cpu', req.taskDirectory, req.signal, threads, identity)
      await preflightSpace(req, timeline, directAudio)
      await encode(false)
    }
    try { await encode(!!segment); clock.metrics.staticVideo = !!segment }
    catch (error) {
      if (error instanceof CancelledError || req.signal.aborted || !segment && encoder === 'cpu') throw error
      clock.metrics.fallbacks!.push(diagnosticFor(error, { stage: 'encode', encoder, suggestion: '流拷贝/硬件失败，回退直接 CPU 编码。' }))
      await directFallback()
    }
  }
  const validate = async (): Promise<Awaited<ReturnType<typeof probeMedia>>> => {
  clock.enter('validate')
  notify('validating', 0.96, '校验成片流、时长与完整解码')
  const result = await probeMedia(req.tools, filePath, req.signal, false, threads)
  const audio = result.streams.filter(stream => stream.codec_type === 'audio')
  const video = result.streams.filter(stream => stream.codec_type === 'video')
  if (audio.length !== 1 || audio[0].sample_rate !== '48000' || audio[0].channels !== 2 || Math.abs(result.durationSeconds - expectedSeconds) > 0.1) throw new AppError('输出音轨、声道或时长校验失败。')
  if (req.minimumSeconds !== undefined && (result.durationSeconds + 1 / RATE < req.minimumSeconds
    || (audio[0].duration !== undefined && Number(audio[0].duration) + 1 / RATE < req.minimumSeconds))) throw new AppError('输出实际时长未达到最短时长，已阻止发布。')
  if (req.kind === 'video') {
    if (result.streams.length !== 2 || video.length !== 1 || video[0].codec_name !== 'h264' || video[0].width !== 1920 || video[0].height !== 1080
      || video[0].pix_fmt !== 'yuv420p' || video[0].r_frame_rate !== '30/1' || audio[0].codec_name !== 'aac'
      || !video[0].duration || Math.abs(Number(video[0].duration) - expectedSeconds) > 0.1) throw new AppError('视频编码、画面尺寸、帧率或时长校验失败。')
  } else if (video.length || result.streams.length !== 1 || audio[0].codec_name !== 'pcm_s16le') throw new AppError('试听文件格式校验失败。')
  const decoded = await runTool(req.tools.ffmpeg, [...base, '-xerror', '-err_detect', 'explode', ...input(filePath), '-map', '0:a:0', ...(req.kind === 'video' ? ['-map', '0:v:0', '-fps_mode', 'passthrough'] : []), '-f', 'null', '-'], {
    signal: req.signal, onProgress: seconds => notify('validating', 0.96 + 0.03 * Math.min(1, seconds / expectedSeconds), '完整解码检查（尚未提交最终文件）')
  })
  if (req.kind === 'video') {
    const frames = [...decoded.stdout.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)
    if (!frames || Number(frames[1]) !== Math.ceil(samples(expectedSeconds) * 30 / RATE)) throw new AppError('完整解码帧数校验失败，已阻止发布。')
  }
    return result
  }
  let result: Awaited<ReturnType<typeof probeMedia>>
  try { result = await validate() }
  catch (error) {
    if (error instanceof CancelledError || req.signal.aborted || !clock.metrics.staticVideo || !directFallback) throw error
    clock.metrics.fallbacks!.push(diagnosticFor(error, { stage: 'validate', encoder, suggestion: '静图流拷贝成片未通过完整校验，回退 CPU 并重新完整校验。' }))
    await directFallback()
    result = await validate()
  }
  for (const source of sources) {
    context.assetId = source.id
    if (await hashMedia(source.path, req.signal) !== sourceHashes.get(source.path)) throw new AppError('合成过程中音乐素材发生变化，已阻止发布。')
  }
  context.assetId = draft.imageId
  if (req.kind === 'video' && await hashMedia(req.imagePath!, req.signal) !== sourceHashes.get(req.imagePath!)) throw new AppError('合成过程中图片素材发生变化，已阻止发布。')
  context.assetId = undefined
  checkAbort(req)
  return { filePath, durationSeconds: result.durationSeconds, timeline }
}
