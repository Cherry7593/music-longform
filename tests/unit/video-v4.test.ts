import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CancelledError, runTool } from '../../src/main/video/ffmpeg'
import { diagnosticFor, redactDiagnostic, RenderClock, withDiagnostic } from '../../src/main/video/render-diagnostics'
import { safeDirectory, videoEncoderArgs } from '../../src/main/video/encoders'
import { renderMedia } from '../../src/main/video/pipeline'
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

it('rejects relative, network, redirected directories and alternate data stream paths', async () => {
  await expect(safeDirectory(root)).resolves.toBeUndefined()
  for (const directory of ['.', 'https://fake.invalid', '\\\\server\\cache', `${root}:hidden`]) await expect(safeDirectory(directory)).rejects.toThrow()
  const target = path.join(root, 'target'), redirected = path.join(root, 'redirected')
  await mkdir(target); await symlink(target, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(safeDirectory(redirected)).rejects.toThrow('重定向')
})

it('uses explicit closed GOP and no B frames for every candidate without declaring them available', () => {
  for (const encoder of ['cpu', 'nvenc', 'qsv'] as const) {
    const args = videoEncoderArgs(encoder, 2)
    expect(args[args.indexOf('-g') + 1]).toBe('30')
    expect(args[args.indexOf('-bf') + 1]).toBe('0')
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
    expect(args[args.indexOf('-threads') + 1]).toBe('2')
  }
})

describe('performance request boundary', () => {
  it.each([0, 17, 1.5, NaN])('rejects invalid thread budget %s before tools run', async threads => {
    spawn.mockClear()
    await expect(renderMedia({ tools: { ffmpeg: executable, ffprobe: executable }, tracks: [], draft: DEFAULT_VIDEO, taskDirectory: root, kind: 'video', signal: new AbortController().signal,
      performance: { threads, encoder: 'cpu', staticVideo: true, cacheDirectory: root } })).rejects.toMatchObject({ diagnostic: { stage: 'tools', message: expect.stringContaining('性能参数') } })
    expect(spawn).not.toHaveBeenCalled()
  })
})
