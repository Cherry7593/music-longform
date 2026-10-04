import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'
import { DEFAULT_MUSIC } from '../../src/shared/schemas'
const DEFAULT_IMAGE = { prompt: '', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'medium', format: 'png' }

/** V1 disk fixture with real local media. No network requests and no API credentials. */
export async function seedVideoProfile(root: string, durations = [8, 12, 10]) {
  const profile = path.join(root, 'appdata'); await mkdir(profile, { recursive: true })
  const projectRoot = path.join(root, '旧 素材')
  const id = randomUUID(), directory = path.join(projectRoot, id)
  await mkdir(path.join(directory, 'audio'), { recursive: true }); await mkdir(path.join(directory, 'images'))
  const tools = await requireTools()
  const audio = []
  const now = new Date().toISOString()
  for (const [index, seconds] of durations.entries()) {
    const assetId = randomUUID(), fileName = `audio/${assetId}.wav`
    await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', `sine=frequency=${220 + index * 110}:duration=${seconds}:sample_rate=${index % 2 ? 48000 : 44100}`, '-ac', index % 2 ? '2' : '1', '-c:a', 'pcm_s16le', path.join(directory, fileName)], { timeoutMs: 60000 })
    audio.push({ id: assetId, jobId: randomUUID(), remoteId: `song${index}`, taskId: `task${index}`, title: `本地曲目 ${index + 1}`, fileName, createdAt: now, prompt: '本地回归测试', durationMs: seconds * 1000, model: 'local-test', mode: 'instrumental' as const, kept: index < 2 })
  }
  const images = []
  for (const [index, [width, height]] of [[1280, 720], [864, 1536]].entries()) {
    const assetId = randomUUID(), fileName = `images/${assetId}.png`
    await sharp({ create: { width, height, channels: 3, background: index ? '#819ab6' : '#efd5a9' } }).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="200" fill="#446da6"/><rect x="50" y="50" width="120" height="120" fill="#f7f8fc"/></svg>`) }]).png().toFile(path.join(directory, fileName))
    images.push({ id: assetId, jobId: randomUUID(), fileName, createdAt: now, prompt: '本地测试画面', model: 'local-test', quality: 'medium', size: `${width}x${height}` })
  }
  const project = { version: 1, id, name: '合成回归测试', directory, createdAt: now, updatedAt: now, music: { ...DEFAULT_MUSIC, prompt: '旧音乐提示词' }, image: { ...DEFAULT_IMAGE, prompt: '旧图片提示词' }, audio, images, musicJobs: [], imageJobs: [], batches: [], selectedImageId: images[0].id }
  const settings = { version: 1, projectRoot, musicDefaults: DEFAULT_MUSIC, imageDefaults: DEFAULT_IMAGE, lastProjectId: id }
  const projectText = JSON.stringify(project), settingsText = JSON.stringify(settings)
  await writeFile(path.join(directory, 'project.json'), projectText)
  await writeFile(path.join(profile, 'settings.json'), settingsText)
  await writeFile(path.join(profile, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id, directory }] }))
  return { id, directory, profile, tools, audio, images, projectText, settingsText }
}
