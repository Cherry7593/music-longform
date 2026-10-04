import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LibraryStore } from '../../src/main/storage/library'
import { DEFAULT_IMAGE, DEFAULT_MUSIC, DEFAULT_VIDEO } from '../../src/shared/schemas'
import type { Project } from '../../src/shared/types'
import { requireTools, runTool, type VideoTools } from '../../src/main/video/ffmpeg'

// Opt-in real local media checks. No network, paid provider, or persistent user files.
let root: string
let tools: VideoTools
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const codecs = { wav: 'pcm_s16le', mp3: 'libmp3lame', flac: 'flac', m4a: 'aac' }
async function tone(format: keyof typeof codecs, name = `${format}-中文 音乐.${format}`): Promise<string> {
  const file = join(root, name)
  await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.25:sample_rate=48000', '-ac', '2', '-c:a', codecs[format], file])
  return file
}
async function store(projects: Project[] = []): Promise<LibraryStore> {
  const library = new LibraryStore({ dataDir: join(root, randomUUID()), defaultRoot: join(root, randomUUID()), getFFmpegPath: () => tools.ffmpeg,
    projects: {
      all: async () => structuredClone(projects),
      get: async id => structuredClone(projects.find(project => project.id === id)!),
      pathForAsset: async (projectId, _kind, assetId) => { const project = projects.find(project => project.id === projectId)!; return join(project.directory, project.audio.find(asset => asset.id === assetId)!.fileName) }
    } })
  await library.init(); return library
}
beforeAll(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'library-real-中文 & '))
  tools = await requireTools(process.env.FFMPEG_PATH)
}, 120000)
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('real FFprobe/FFmpeg library imports', () => {
  it.each(['mp3', 'wav', 'flac', 'm4a'] as const)('validates and preserves real %s bytes; verification reprobes registered files', async format => {
    const source = await tone(format); const bytes = await readFile(source); const library = await store()
    const result = await library.importFiles([source], 'audio')
    expect(result.entries[0], JSON.stringify(result)).toMatchObject({ status: 'imported' })
    const id = result.entries[0].assetId!; const verified = await library.verify(id)
    expect(verified.asset).toMatchObject({ format, sha256: sha(bytes), bytes: bytes.length, available: true })
    expect(verified.asset.durationSeconds).toBeGreaterThan(1.2); expect(verified.asset.durationSeconds).toBeLessThan(1.4)
    expect(await readFile(verified.path)).toEqual(bytes); expect(await readFile(source)).toEqual(bytes)
    expect((await library.importFiles([source], 'audio')).entries[0]).toMatchObject({ status: 'duplicate', assetId: id })
  }, 120000)

  it('rejects a real ALAC M4A, ADTS AAC, corrupt FLAC and playlists without adding records', async () => {
    const alac = join(root, 'alac.m4a'); const adts = join(root, 'raw.aac')
    for (const [codec, output] of [['alac', alac], ['aac', adts]]) {
      await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'sine=duration=0.3', '-c:a', codec, output])
    }
    const corrupted = join(root, 'broken.flac'); await writeFile(corrupted, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(80)]))
    const playlist = join(root, 'spoof.mp3'); await writeFile(playlist, '#EXTM3U\nhttps://example.invalid/audio.mp3')
    const library = await store(); const result = await library.importFiles([alac, adts, corrupted, playlist], 'audio')
    expect(result.entries.every(entry => entry.status === 'failed')).toBe(true); expect(await library.all()).toEqual([])
  }, 120000)

  it('does not trust project duration hints and refuses mutated project originals after registration', async () => {
    const id = randomUUID(); const projectId = randomUUID(); const directory = join(root, projectId); const now = new Date().toISOString()
    await mkdir(join(directory, 'audio'), { recursive: true })
    const bytes = await readFile(await tone('wav', 'project-original.wav'))
    const file = join(directory, 'audio', `${id}.wav`); await writeFile(file, bytes)
    const project: Project = {
      version: 3, id: projectId, directory, name: '原始 项目', createdAt: now, updatedAt: now,
      music: DEFAULT_MUSIC, image: DEFAULT_IMAGE, video: DEFAULT_VIDEO, musicJobs: [], batches: [], imageJobs: [], images: [], videoJobs: [],
      audio: [{ id, jobId: randomUUID(), taskId: 'task', remoteId: 'remote', title: '歌曲', fileName: `audio/${id}.wav`, durationMs: 123456789, createdAt: now, model: 'historical-model', prompt: '留存提示词', mode: 'instrumental', kept: false }]
    }
    const library = await store([project]); const item = (await library.all())[0]
    expect(item.durationSeconds).toBeCloseTo(1.25, 2); expect(await library.pathForAsset(item.id)).toBe(file)
    await writeFile(file, Buffer.concat([bytes, Buffer.from('changed')]))
    await expect(library.verify(item.id)).rejects.toThrow('指纹已变化')
    expect((await library.get(item.id)).sha256).toBe(sha(bytes))
    await writeFile(file, bytes); await library.refresh(); expect((await library.get(item.id)).available).toBe(true)
  }, 120000)
})
