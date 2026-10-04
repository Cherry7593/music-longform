import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LibraryStore } from '../../src/main/storage/library'
import { LIBRARY_LIMITS } from '../../src/main/storage/library-validation'
import { fingerprintFile, stageImport, validateMedia } from '../../src/main/library/imports'
import { AppError } from '../../src/main/providers/http'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../../src/main/video/ffmpeg', async original => ({ ...await original<typeof import('../../src/main/video/ffmpeg')>(), requireTools: vi.fn(), runTool: vi.fn() }))
let root: string
let managed: string
let library: LibraryStore
let probe: { format: { format_name: string; duration: string }; streams: Array<Record<string, unknown>> }
let decoded: number
const tools = { ffmpeg: 'fixture-ffmpeg', ffprobe: 'fixture-ffprobe' }
const picture = (colour = '#7812ab') => sharp({ create: { width: 20, height: 16, channels: 3, background: colour } }).withMetadata({ density: 120 })
async function file(name: string, bytes: Buffer | string): Promise<string> { const target = join(root, name); await writeFile(target, bytes); return target }
function header(format: string): Buffer {
  if (format === 'wav') return Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(64)])
  if (format === 'flac') return Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64)])
  if (format === 'm4a') return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(64)])
  return Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)])
}
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'library-import-中文 & ')); managed = join(root, 'managed')
  decoded = 12.5
  probe = { format: { format_name: 'wav', duration: '12.5' }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, duration: '12.5' }] }
  vi.mocked(requireTools).mockReset().mockResolvedValue(tools)
  vi.mocked(runTool).mockReset().mockImplementation(async (executable, _args, options) => {
    if (executable === tools.ffprobe) return { stdout: JSON.stringify(probe), stderr: '' }
    options?.onProgress?.(decoded); return { stdout: `out_time_us=${decoded * 1e6}\nprogress=end\n`, stderr: '' }
  })
  library = new LibraryStore({ dataDir: join(root, 'data'), defaultRoot: managed, getFFmpegPath: () => undefined,
    projects: { all: async () => [], get: async () => { throw new Error('not used') }, pathForAsset: async () => { throw new Error('not used') } } })
  await library.init()
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('bounded original-byte imports', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('fully decodes %s but preserves metadata/watermark bytes and uses actual suffix', async format => {
    const bytes = await picture().toFormat(format).toBuffer(); const source = await file(`很长的 中文 文件名字 ${'名'.repeat(50)}.wrong`, bytes)
    const result = await library.importFiles([source], 'image'); expect(result.entries[0].status).toBe('imported')
    const id = result.entries[0].assetId!; const actual = await library.pathForAsset(id)
    expect(actual).toBe(join(managed, 'images', `${id}.${format === 'jpeg' ? 'jpg' : format}`))
    expect(await readFile(actual)).toEqual(bytes); expect(await readFile(source)).toEqual(bytes)
    expect(await library.get(id)).toMatchObject({ format, width: 20, height: 16, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(requireTools).not.toHaveBeenCalled(); expect(await readdir(join(managed, '.staging'))).toEqual([])
    await rm(source); expect((await library.verify(id)).asset.available).toBe(true)
  })

  it('keeps same filename/different content, case variants and per-file partial failures independent', async () => {
    const first = join(root, 'a'); const second = join(root, 'b'); await mkdir(first); await mkdir(second)
    const bytesA = await picture().png().toBuffer(); const bytesB = await picture('#ffffff').png().toBuffer()
    const a = join(first, 'Same.png'); const b = join(second, 'Same.png'); const c = join(second, 'same.PNG')
    await writeFile(a, bytesA); await writeFile(b, bytesB)
    // On Windows c is the same file as b; a separate directory covers a case-only spelling safely.
    const result = await library.importFiles([a, await file('fake.png', '<html>not an image</html>'), b, c, join(root, 'missing.png'), root], 'image')
    expect(result.entries.map(entry => entry.status)).toEqual(['imported', 'failed', 'imported', process.platform === 'win32' ? 'duplicate' : 'failed', 'failed', 'failed'])
    expect(await library.all()).toHaveLength(2); expect(result.entries[0].assetId).not.toBe(result.entries[2].assetId)
    expect(await readFile(a)).toEqual(bytesA); expect(await readFile(b)).toEqual(bytesB)
    expect(await readdir(join(managed, 'images'))).toHaveLength(2)
    expect(await readdir(join(managed, '.staging'))).toEqual([])
  })

  it('rejects truncated, animated, unsupported or excessive-dimension images', async () => {
    const png = await picture().png().toBuffer()
    const inputs = [png.subarray(0, png.length / 2), await picture().gif().toBuffer(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#fff' } }).png().toBuffer(),
      await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#fff' } }).png().toBuffer()]
    // acTL is rejected even for one-frame APNG, before trusting a decoder's first-frame metadata.
    const acTL = Buffer.alloc(20); acTL.writeUInt32BE(8); acTL.write('acTL', 4); acTL.writeUInt32BE(1, 8)
    inputs.push(Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]))
    const paths = await Promise.all(inputs.map((bytes, index) => file(`bad${index}.png`, bytes)))
    const result = await library.importFiles(paths, 'image')
    expect(result.entries.every(entry => entry.status === 'failed' && entry.error?.includes('图片损坏'))).toBe(true)
    expect(await library.all()).toEqual([])
  })

  it('bounds batch count and file bytes before decode and keeps queue usable after errors', async () => {
    await expect(library.importFiles(Array(501).fill('irrelevant'), 'image')).rejects.toThrow('500')
    const oversized = await file('large.png', '')
    const handle = await open(oversized, 'r+'); await handle.truncate(LIBRARY_LIMITS.imageBytes + 1); await handle.close()
    const result = await library.importFiles([oversized, await file('empty.png', ''), await file('ok.png', await picture().png().toBuffer())], 'image')
    expect(result.entries.map(entry => entry.status)).toEqual(['failed', 'failed', 'imported'])
    expect(result.entries[0].error).toContain('40 MiB'); expect(await library.all()).toHaveLength(1)
  })

  it('rejects relative/network/device/ADS paths, directories and redirected parents', async () => {
    const bytes = await picture().png().toBuffer(); const original = await file('safe.png', bytes)
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'safe.png'), bytes)
    const redirect = join(root, 'redirect'); await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir')
    const unsafe = ['../safe.png', '\\\\server\\share\\a.png', 'https://example.com/a.png', '\\\\?\\C:\\a.png', `${original}:payload`, root, join(redirect, 'safe.png')]
    const result = await library.importFiles(unsafe, 'image')
    expect(result.entries.every(entry => entry.status === 'failed')).toBe(true); expect(await library.all()).toEqual([])
    expect(await readFile(original)).toEqual(bytes)
    await expect(library.configureRoot(redirect)).rejects.toThrow('不安全')
  })

  it('refuses redirected destination directories and exclusive publication never overwrites a file', async () => {
    const bytes = await picture().png().toBuffer(); const source = await file('original.png', bytes)
    const outside = join(root, 'outside'); await mkdir(outside); await mkdir(managed)
    await symlink(outside, join(managed, 'images'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await library.importFiles([source], 'image')).entries[0].status).toBe('failed')
    expect(await readdir(outside)).toEqual([]); expect(await readdir(join(managed, '.staging'))).toEqual([])
    await rm(join(managed, 'images')); await mkdir(join(managed, 'images'))
    const staged = await stageImport(source, 'image', managed); const id = randomUUID(); const target = join(managed, 'images', `${id}.png`)
    await writeFile(target, 'existing must survive')
    await expect(staged.publish(id, 'png')).rejects.toMatchObject({ code: 'EEXIST' }); await staged.dispose()
    expect(await readFile(target, 'utf8')).toBe('existing must survive'); expect(await readFile(source)).toEqual(bytes)
  })

  it('retains only its own cleanup scope on publication failure and preserves old managed fingerprints', async () => {
    const source = await file('source.png', await picture().png().toBuffer())
    const id = (await library.importFiles([source], 'image')).entries[0].assetId!; const target = await library.pathForAsset(id)
    const original = await library.get(id)
    await writeFile(target, await picture('#000000').png().toBuffer())
    const result = await library.importFiles([source], 'image')
    expect(result.entries[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('指纹变化') })
    await expect(library.verify(id)).rejects.toThrow('指纹已变化')
    expect((await library.get(id)).sha256).toBe(original.sha256)
    expect(await readdir(join(managed, 'images'))).toEqual([basename(target)])
  })

  it('detects source identity/bytes changing during streaming copy and removes only its owned stage', async () => {
    const source = await file('changing.png', await picture().png().toBuffer())
    const nativeOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await nativeOpen(target, flags, mode)
      if (target === source) {
        const nativeStat = handle.stat.bind(handle)
        let count = 0
        handle.stat = (async (options?: { bigint?: boolean }) => {
          if (++count === 2) await writeFile(source, await picture('#333333').png().toBuffer())
          return options?.bigint ? nativeStat({ bigint: true }) : nativeStat()
        }) as typeof handle.stat
      }
      return handle
    })
    const result = await library.importFiles([source], 'image')
    expect(result.entries[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('发生变化') })
    expect(await library.all()).toEqual([]); expect(await readdir(join(managed, '.staging'))).toEqual([])
  })
})

describe('audio validation uses constrained probe and full bounded decode', () => {
  it.each(['mp3', 'wav', 'flac', 'm4a'])('uses actual %s codec/container/duration, preserves bytes, and resolves without legacy extension rules', async format => {
    probe.format.format_name = format === 'm4a' ? 'mov,mp4,m4a,3gp,3g2,mj2' : format
    probe.streams[0].codec_name = format === 'm4a' ? 'aac' : format === 'wav' ? 'pcm_s16le' : format
    const bytes = header(format); const source = await file('fake extension.png', bytes)
    const result = await library.importFiles([source], 'audio'); expect(result.entries[0].status).toBe('imported')
    const id = result.entries[0].assetId!; const target = await library.pathForAsset(id)
    expect(target.endsWith(`.${format}`)).toBe(true); expect(await readFile(target)).toEqual(bytes); expect(await readFile(source)).toEqual(bytes)
    expect(await library.get(id)).toMatchObject({ durationSeconds: 12.5, format, available: true })
    const decode = vi.mocked(runTool).mock.calls.find(([tool]) => tool === tools.ffmpeg)!
    expect(decode[1]).toEqual(expect.arrayContaining(['-xerror', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,wav,flac,mov', '-map', '0:a:0', '-t', '21601', '-f', 'null']))
    expect(decode[2]).toMatchObject({ timeoutMs: 1200000, maxOutputBytes: 65536 })
    if (format === 'm4a') expect(decode[1]).toEqual(expect.arrayContaining(['-enable_drefs', '0', '-use_absolute_path', '0']))
    probe.format.duration = '13'; probe.streams[0].duration = '13'; decoded = 13
    expect((await library.verify(id)).asset.durationSeconds).toBe(13)
  })

  it('rejects playlists/spoofs before tools and rejects AAC outside M4A', async () => {
    const inputs = ['#EXTM3U\nhttps://private.example/audio.mp3', 'ffconcat version 1.0\nfile outside.wav', '<html>denied</html>']
    const result = await library.importFiles(await Promise.all(inputs.map((bytes, i) => file(`spoof-${i}.mp3`, bytes))), 'audio')
    expect(result.entries.every(entry => entry.status === 'failed')).toBe(true); expect(runTool).not.toHaveBeenCalled()
    expect((await library.importFiles([await file('adts.m4a', Buffer.from([255, 241, 80, 128, 0, 31, 252]))], 'audio')).entries[0].status).toBe('failed')
  })

  it('rejects codec/container mismatch, excessive durations, multiple streams and truncated decode', async () => {
    const source = await file('audio.wav', header('wav'))
    probe.format.format_name = 'hls'; expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    probe.format.format_name = 'wav'; probe.streams[0].codec_name = 'aac'; expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    probe.streams[0].codec_name = 'pcm_s16le'; probe.format.duration = '21600.01'; expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    probe.format.duration = '12.5'; probe.streams.push({ ...probe.streams[0] }); expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    probe.streams.pop(); decoded = 21601; expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    decoded = 1; expect((await library.importFiles([source], 'audio')).entries[0].status).toBe('failed')
    expect(await library.all()).toEqual([])
  })

  it('does not accept failed full decodes and keeps images usable without tools', async () => {
    const source = await file('audio.wav', header('wav'))
    vi.mocked(runTool).mockRejectedValue(new AppError('完整解码失败'))
    expect((await library.importFiles([source], 'audio')).entries[0]).toMatchObject({ status: 'failed', error: '完整解码失败' })
    vi.mocked(requireTools).mockRejectedValue(new AppError('请配置 FFmpeg / FFprobe'))
    expect((await library.importFiles([source], 'audio')).entries[0].error).toContain('FFmpeg')
    expect((await library.importFiles([await file('image.png', await picture().png().toBuffer())], 'image')).entries[0].status).toBe('imported')
  })

  it('rejects a registered source changed during tool validation', async () => {
    const source = await file('source.wav', header('wav')); const fingerprint = await fingerprintFile(source, 'audio')
    vi.mocked(runTool).mockImplementation(async (executable, _args, options) => {
      if (executable === tools.ffprobe) { await writeFile(source, Buffer.concat([header('wav'), Buffer.from('changed')])); return { stdout: JSON.stringify(probe), stderr: '' } }
      options?.onProgress?.(decoded); return { stdout: '', stderr: '' }
    })
    await expect(validateMedia(source, 'audio', fingerprint, async () => tools)).rejects.toThrow('发生变化')
  })
})
