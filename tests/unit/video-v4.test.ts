import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest'
import { CancelledError, runTool } from '../../src/main/video/ffmpeg'
import { diagnosticFor, redactDiagnostic, RenderClock, withDiagnostic } from '../../src/main/video/render-diagnostics'
import * as encoders from '../../src/main/video/encoders'
import * as ffmpeg from '../../src/main/video/ffmpeg'
import { videoEncoderArgs, type Encoder } from '../../src/main/video/encoders'
import { renderMedia, type RenderRequest } from '../../src/main/video/pipeline'
import { DEFAULT_VIDEO } from '../../src/shared/schemas'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }))
let root: string, executable: string
beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'video-v4-unit-'))
  executable = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  await writeFile(executable, 'synthetic tool fixture')
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

it.each([
  ['ENOSPC', '', 'space'], ['EACCES', '', 'permission'], ['EPERM', '', 'permission'],
  ['ENOENT', '', 'tool-missing'], [undefined, 'Unknown encoder libx264', 'incompatible'],
  [undefined, 'Cannot load nvcuda.dll', 'encoder-initialization'], [undefined, 'Invalid data found when processing input', 'unreadable'],
  [undefined, 'some undecidable error', 'unknown']
])('classifies evidence code=%s, stderr=%s without claiming every failure is corrupt media', (code, stderr, category) => {
  const error = Object.assign(new Error('opaque child error'), { code })
  expect(diagnosticFor(error, { stage: 'tools', stderr })).toMatchObject({ stage: 'tools', category, suggestion: expect.any(String) })
})

it('retains safe structured context and OS/exit codes, not arbitrary causes or URLs', () => {
  const original = Object.assign(new Error('https://user:password@fake.invalid/?token=synthetic'), { code: 'ENOSPC', cause: { raw: 'private arbitrary log' } })
  const result = withDiagnostic(original, { stage: 'mix', assetId: 'synthetic-asset', exitCode: 28, toolVersion: 'test', encoder: 'cpu', stderr: 'No space left on device\nAuthorization: Bearer synthetic-secret\nhttps://fake.invalid?api_key=synthetic' })
  expect(result.diagnostic).toMatchObject({ stage: 'mix', assetId: 'synthetic-asset', category: 'space', osCode: 'ENOSPC', exitCode: 28, encoder: 'cpu' })
  expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|password@|https:\/\/|private arbitrary/)
  expect(result.cause).toBeUndefined()
})

it('redacts before tail truncation, including JSON credentials and fragmented child writes', async () => {
  expect(redactDiagnostic('x'.repeat(9000) + 'https://fake.invalid/' + 'credentialtail'.repeat(900), 8192)).not.toContain('credentialtail')
  expect(redactDiagnostic('{"api_key":"json-secret","token":"token-secret"}')).not.toMatch(/json-secret|token-secret/)
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 42, exitCode: null, signalCode: null, killed: false, kill: vi.fn() })
    queueMicrotask(() => {
      child.stderr.write('https://fake.invalid/?api_')
      child.stderr.write('key=fragment-secret\nAuthorization: Bearer bearer-secret\n')
      child.stderr.write('z'.repeat(1024 * 1024 + 1) + 'secret-oversized-line\nNo space left on device')
      child.emit('close', 28)
    })
    return child
  })
  const error = await runTool(executable, [], { maxOutputBytes: 2048, diagnostic: { stage: 'encode' } }).catch(value => value)
  expect(error.diagnostic).toMatchObject({ stage: 'encode', category: 'space', exitCode: 28 })
  expect(error.diagnostic.stderr.length).toBeLessThanOrEqual(2048)
  expect(JSON.stringify(error)).not.toMatch(/fragment-secret|bearer-secret|secret-oversized-line/)
  expect(error.diagnostic.stderr).toContain('oversized diagnostic line redacted')
})

it('classifies a missing executable and cancellation before spawn', async () => {
  spawn.mockClear()
  await expect(runTool(path.join(root, 'missing', path.basename(executable)), [])).rejects.toMatchObject({ diagnostic: { stage: 'tools', category: 'tool-missing', osCode: 'ENOENT' } })
  await expect(runTool(executable, [], { signal: AbortSignal.abort(), diagnostic: { stage: 'mix' } })).rejects.toMatchObject({ name: 'CancelledError', diagnostic: { stage: 'mix', category: 'cancelled' } })
  expect(spawn).not.toHaveBeenCalled()
  expect(withDiagnostic(new CancelledError(), { stage: 'validate' })).toBeInstanceOf(CancelledError)
})

it('aggregates revisited stages without inventing publishing time and isolates observer errors', () => {
  const clock = new RenderClock(() => { throw new Error('observer failed') })
  clock.enter('probe'); clock.enter('tools'); clock.enter('audio'); clock.enter('mix'); clock.enter('encode'); clock.enter('validate')
  const metrics = clock.finish()
  expect(metrics.stages.map(s => s.stage)).toEqual(['tools', 'probe', 'audio', 'mix', 'encode', 'validate'])
  expect(metrics.stages.every(s => Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0)).toBe(true)
  expect(Math.abs(metrics.stages.reduce((sum, s) => sum + s.elapsedMs, 0) - metrics.elapsedMs)).toBeLessThan(1)
})

it('retains each encoder quality/preset/VBV/output contract with GOP300 and no segment-splicing restrictions', () => {
  const codecs = {
    cpu: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '20'],
    nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '4M'],
    qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '20']
  }
  for (const encoder of ['cpu', 'nvenc', 'qsv'] as const) {
    const args = videoEncoderArgs(encoder, 2)
    expect(args).toEqual([...codecs[encoder], '-threads', '2', '-g', '300', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', '30'])
    expect(args.join(' ')).not.toMatch(/open-gop|scenecut|keyint|forced-idr|\+cgop/)
    expect(args).not.toContain('-bf')
    expect(args).not.toContain('-flags')
    expect(args).not.toContain('-x264-params')
  }
})

describe('performance request boundary', () => {
  it('exposes only threads and encoder in the performance request type', () => {
    expectTypeOf<NonNullable<RenderRequest['performance']>>().toEqualTypeOf<{ threads: number; encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv' }>()
  })
  it.each([0, 17, 1.5, NaN])('rejects invalid thread budget %s before tools run', async threads => {
    spawn.mockClear()
    await expect(renderMedia({ tools: { ffmpeg: executable, ffprobe: executable }, tracks: [], draft: DEFAULT_VIDEO, taskDirectory: root, kind: 'video', signal: new AbortController().signal,
      performance: { threads, encoder: 'cpu' } })).rejects.toMatchObject({ diagnostic: { stage: 'tools', message: expect.stringContaining('性能参数') } })
    expect(spawn).not.toHaveBeenCalled()
  })
})

// Mock only tool boundaries; exercise the real render state machine, filesystem ownership,
// stream/spec checks, full-decode frame counts and source hashing without hardware or codecs.
describe('continuous rendering and one-shot CPU fallback', () => {
  type Fault = 'encode' | 'streams' | 'audio' | 'duration' | 'decode' | 'frames'
  let req: RenderRequest, controller: AbortController, activeEncoder: Encoder
  let faults: Partial<Record<Encoder, Fault>>, cancel: 'encode-error' | 'encode-signal' | 'decode-error' | undefined
  let events: string[], commands: Array<{ encoder: Encoder; args: string[] }>, decodes: string[][]
  let selection: MockInstance<typeof encoders.selectEncoder>

  beforeEach(async () => {
    const directory = await mkdtemp(path.join(root, 'bounded-render-'))
    const source = path.join(directory, 'source.flac'), image = path.join(directory, 'image.png')
    await writeFile(source, 'immutable synthetic audio'); await writeFile(image, 'immutable synthetic image')
    controller = new AbortController(); activeEncoder = 'nvenc'; faults = {}; cancel = undefined
    events = []; commands = []; decodes = []
    const id = randomUUID()
    req = { tools: { ffmpeg: executable, ffprobe: executable }, kind: 'video', taskDirectory: directory, imagePath: image,
      tracks: [{ id, path: source, durationSeconds: 2 }], signal: controller.signal, performance: { threads: 2, encoder: 'nvenc' },
      draft: { ...DEFAULT_VIDEO, initialized: true, audioIds: [id], imageId: randomUUID(), durationMode: 'all', transition: 'cut', fadeInSeconds: 0, fadeOutSeconds: 0 } }
    vi.spyOn(encoders, 'toolIdentity').mockResolvedValue('ffmpeg version synthetic|fixture')
    selection = vi.spyOn(encoders, 'selectEncoder').mockImplementation(async (_tools, preference, _directory, signal) => {
      if (signal.aborted) throw new CancelledError()
      const encoder = preference === 'auto' ? 'nvenc' : preference
      return { encoder, statuses: [{ encoder, available: true, message: 'isolated probe evidence' }], fallbacks: [] }
    })
    vi.spyOn(ffmpeg, 'probeMedia').mockImplementation(async (_tools, file, signal) => {
      if (signal?.aborted) throw new CancelledError()
      if (file === image) return { durationSeconds: 0, streams: [{ codec_type: 'video', codec_name: 'png', nb_read_frames: '1' }] }
      const audio = { codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', channels: 2, duration: '2' }
      if (file === source || file === path.join(directory, 'master.wav')) return { durationSeconds: 2, streams: [audio] }
      if (file !== path.join(directory, 'video.partial.mp4')) throw new Error(`Unexpected probe fixture: ${file}`)
      events.push(`probe:${activeEncoder}`)
      const fault = faults[activeEncoder]
      return { durationSeconds: fault === 'duration' ? 3 : 2, streams: [
        { codec_type: 'video', codec_name: 'h264', width: fault === 'streams' ? 1280 : 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '30/1', duration: '2' },
        { ...audio, codec_name: 'aac', channels: fault === 'audio' ? 1 : 2 }
      ] }
    })
    vi.spyOn(ffmpeg, 'runTool').mockImplementation(async (_tool, args, options) => {
      if (options?.signal?.aborted) throw new CancelledError()
      const output = args.at(-1)!
      if (output === path.join(directory, 'master.wav')) {
        await writeFile(output, 'synthetic mixed master', { flag: 'wx' }); return { stdout: '', stderr: '' }
      }
      if (output === path.join(directory, 'video.partial.mp4')) {
        const codec = args[args.indexOf('-c:v') + 1]
        activeEncoder = codec === 'libx264' ? 'cpu' : codec === 'h264_nvenc' ? 'nvenc' : 'qsv'
        commands.push({ encoder: activeEncoder, args: [...args] }); events.push(`encode:${activeEncoder}`)
        // Abort a regressed retry loop rather than consuming unbounded work in this fixture.
        if (commands.length > 3) { controller.abort(); throw new CancelledError() }
        await writeFile(output, `private ${activeEncoder} partial`, { flag: 'wx' })
        if (cancel === 'encode-error') throw new CancelledError()
        if (cancel === 'encode-signal') { controller.abort(); throw new Error('child stopped after abort') }
        if (faults[activeEncoder] === 'encode') throw withDiagnostic(new Error('synthetic encode failure'), { stage: 'encode', encoder: activeEncoder, exitCode: 73, stderr: 'fixture encode failure' })
        return { stdout: '', stderr: '' }
      }
      if (output === '-' && args.includes(path.join(directory, 'video.partial.mp4')) && args.includes('null')) {
        decodes.push([...args]); events.push(`decode:${activeEncoder}`)
        if (cancel === 'decode-error') throw new CancelledError()
        if (faults[activeEncoder] === 'decode') throw withDiagnostic(new Error('synthetic complete-decode failure'), { stage: 'validate', exitCode: 74 })
        return { stdout: `frame=${faults[activeEncoder] === 'frames' ? 59 : 60}\nprogress=end\n`, stderr: '' }
      }
      throw new Error(`Unexpected tool invocation: ${args.join(' ')}`)
    })
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(req.taskDirectory, { recursive: true, force: true }) })

  function expectContinuous(expected: Encoder[]): void {
    expect(commands.map(command => command.encoder)).toEqual(expected)
    for (const { encoder, args } of commands) {
      const codecArgs = videoEncoderArgs(encoder, 2), start = args.indexOf('-c:v')
      expect(args.slice(start, start + codecArgs.length)).toEqual(codecArgs)
      expect(args[args.indexOf('-loop') + 1]).toBe('1')
      expect(args[args.indexOf('-i') + 1]).toBe(req.imagePath)
      expect(args).toEqual(expect.arrayContaining(['-n', '-vf', encoders.staticFilter(req.draft.fit), '-c:a', 'aac', '-b:a', '192k']))
      expect(args).not.toContain('-stream_loop'); expect(args).not.toContain('copy'); expect(args).not.toContain('-shortest')
    }
    for (const args of decodes) {
      expect(args).toEqual(expect.arrayContaining(['-xerror', '-err_detect', 'explode', '-fps_mode', 'passthrough', '-f', 'null']))
      expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:a:0', '0:v:0'])
      for (const limit of ['-t', '-to', '-frames:v', '-shortest']) expect(args).not.toContain(limit)
    }
  }
  function expectSelections(expected: string[]): void { expect(selection.mock.calls.map(call => call[1])).toEqual(expected) }

  it.each([true, false])('ignores legacy staticVideo=%s and even a nonlocal cacheDirectory without a cache fallback', async staticVideo => {
    const performance = { threads: 2, encoder: 'cpu' as const, staticVideo, cacheDirectory: 'https://fake.invalid/cache' }
    req.performance = performance
    const before = await readFile(req.imagePath!)
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    expect(events).toEqual(['encode:cpu', 'probe:cpu', 'decode:cpu'])
    expectContinuous(['cpu']); expectSelections(['cpu'])
    expect(await readFile(req.imagePath!)).toEqual(before)
    expect((await readdir(req.taskDirectory)).some(name => /cache|static-|encoder-test/.test(name))).toBe(false)
  })
  it.each(['nvenc', 'qsv'] as const)('falls back exactly once after an actual %s encode failure and fully validates CPU output', async encoder => {
    req.performance!.encoder = encoder; faults[encoder] = 'encode'
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [expect.objectContaining({ encoder, stage: 'encode', exitCode: 73 })] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    expect(events).toEqual([`encode:${encoder}`, 'encode:cpu', 'probe:cpu', 'decode:cpu'])
    expectContinuous([encoder, 'cpu']); expectSelections([encoder, 'cpu'])
  })
  it.each(['streams', 'audio', 'duration', 'decode', 'frames'] as const)('re-encodes hardware output once after %s validation failure and repeats complete validation', async fault => {
    faults.nvenc = fault
    const result = await renderMedia(req)
    expect(result.metrics).toMatchObject({ encoder: 'cpu', staticVideo: false, fallbacks: [expect.objectContaining({ encoder: 'nvenc', stage: 'validate' })] })
    expect(result.metrics).not.toHaveProperty('cacheHit')
    expect(events).toEqual(['encode:nvenc', 'probe:nvenc', ...(['decode', 'frames'].includes(fault) ? ['decode:nvenc'] : []), 'encode:cpu', 'probe:cpu', 'decode:cpu'])
    expectContinuous(['nvenc', 'cpu']); expectSelections(['nvenc', 'cpu'])
  })
  it.each(['encode', 'streams', 'audio', 'duration', 'decode', 'frames'] as const)('rejects CPU %s failure directly without retrying or bypassing validation', async fault => {
    req.performance!.encoder = 'cpu'; faults.cpu = fault
    await expect(renderMedia(req)).rejects.toMatchObject({ diagnostic: { stage: fault === 'encode' ? 'encode' : 'validate', encoder: 'cpu' } })
    expectContinuous(['cpu']); expectSelections(['cpu'])
    expect(events).toEqual(['encode:cpu', ...(fault === 'encode' ? [] : ['probe:cpu']), ...(['decode', 'frames'].includes(fault) ? ['decode:cpu'] : [])])
  })
  it.each(['encode', 'decode', 'frames'] as const)('rejects a failed %s CPU fallback instead of attempting a third encode', async fault => {
    faults.nvenc = 'decode'; faults.cpu = fault
    await expect(renderMedia(req)).rejects.toMatchObject({ diagnostic: { stage: fault === 'encode' ? 'encode' : 'validate', encoder: 'cpu' } })
    expectContinuous(['nvenc', 'cpu']); expectSelections(['nvenc', 'cpu'])
    expect(events).toEqual(['encode:nvenc', 'probe:nvenc', 'decode:nvenc', 'encode:cpu', ...(fault === 'encode' ? [] : ['probe:cpu', 'decode:cpu'])])
  })
  it.each(['encode-error', 'encode-signal', 'decode-error', 'validate-signal'] as const)('does not CPU-fallback on cancellation at %s', async stage => {
    if (stage === 'validate-signal') req.onStage = value => { if (value === 'validate') controller.abort() }
    else cancel = stage
    if (stage === 'encode-signal') await expect(renderMedia(req)).rejects.toThrow()
    else await expect(renderMedia(req)).rejects.toBeInstanceOf(CancelledError)
    expectContinuous(['nvenc']); expectSelections(['nvenc'])
    if (stage.endsWith('signal')) expect(controller.signal.aborted).toBe(true)
  })
  it('never deletes or overwrites an occupied output even when hardware was selected', async () => {
    const output = path.join(req.taskDirectory, 'video.partial.mp4')
    await writeFile(output, 'pre-existing user media')
    faults.nvenc = 'encode'
    await expect(renderMedia(req)).rejects.toThrow('不会覆盖')
    expect(await readFile(output, 'utf8')).toBe('pre-existing user media')
    expectContinuous([]); expectSelections(['nvenc'])
  })
})
