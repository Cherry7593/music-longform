import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { requireTools, runTool } from '../../src/main/video/ffmpeg'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import type { BatchPlan } from '../../src/shared/library-types'
import type { ExecutionBatch, RenderStatus } from '../../src/shared/workbench-types'
import { assertScratch, writeTone } from './v4-helpers'
const DEFAULT_MUSIC = { prompt: '', mode: 'instrumental', model: 'auto', count: 1, styles: [] }
const DEFAULT_IMAGE = { prompt: '', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'medium', format: 'png' }

/** V1/V2 disk fixture with synthetic PCM/image bytes. V2 supplies an actual legacy single-video draft. */
export async function seedVideoProfile(root: string, durations = [20, 25, 20], version: 1 | 2 = 2) {
  assertScratch(root)
  const profile = path.join(root, 'appdata'); await mkdir(profile, { recursive: true })
  const projectRoot = path.join(root, '旧 素材')
  const id = randomUUID(), directory = path.join(projectRoot, id)
  await mkdir(path.join(directory, 'audio'), { recursive: true }); await mkdir(path.join(directory, 'images'))
  const tools = await requireTools()
  const audio = [], now = new Date().toISOString()
  for (const [index, seconds] of durations.entries()) {
    const assetId = randomUUID(), fileName = `audio/${assetId}.wav`
    await writeTone(path.join(directory, fileName), seconds, 220 + index * 110, index % 2 ? 48000 : 44100, index % 2 ? 2 : 1)
    audio.push({ id: assetId, jobId: randomUUID(), remoteId: `song${index}`, taskId: `task${index}`, title: `本地曲目 ${index + 1}`, fileName, createdAt: now, prompt: '合成音调：不是模型推理', durationMs: seconds * 1000, model: 'local-test', mode: 'instrumental' as const, kept: index < 2 })
  }
  const images = []
  for (const [index, [width, height]] of [[1280, 720], [864, 1536]].entries()) {
    const assetId = randomUUID(), fileName = `images/${assetId}.png`
    await sharp({ create: { width, height, channels: 3, background: index ? '#819ab6' : '#efd5a9' } }).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="200" fill="#446da6"/><rect x="50" y="50" width="120" height="120" fill="#f7f8fc"/></svg>`) }]).png().toFile(path.join(directory, fileName))
    images.push({ id: assetId, jobId: randomUUID(), fileName, createdAt: now, prompt: '本地测试画面', model: 'local-test', quality: 'medium', size: `${width}x${height}` })
  }
  const video = { initialized: true, audioIds: audio.filter(asset => asset.kept).map(asset => asset.id), imageId: images[0].id, durationMode: 'target', targetSeconds: 3600,
    transition: 'crossfade', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain' }
  const project = { version, id, name: '合成回归测试', directory, createdAt: now, updatedAt: now, music: { ...DEFAULT_MUSIC, prompt: '旧音乐提示词' }, image: { ...DEFAULT_IMAGE, prompt: '旧图片提示词' }, audio, images, musicJobs: [], imageJobs: [], batches: [], selectedImageId: images[0].id, ...(version === 2 ? { video, videoJobs: [] } : {}) }
  const settings = { version: 1, projectRoot, musicDefaults: DEFAULT_MUSIC, imageDefaults: DEFAULT_IMAGE, lastProjectId: id }
  const projectText = JSON.stringify(project), settingsText = JSON.stringify(settings)
  await writeFile(path.join(directory, 'project.json'), projectText)
  await writeFile(path.join(profile, 'settings.json'), settingsText)
  await writeFile(path.join(profile, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id, directory }] }))
  return { id, directory, profile, tools, audio, images, projectText, settingsText }
}

/** The native-import test keeps real codec validation and partial failures, not placeholder files. */
export async function seedImportFiles(root: string) {
  assertScratch(root)
  const source = path.join(root, '导入 原始'); await mkdir(source)
  const tools = await requireTools(), audio: string[] = [], images: string[] = []
  for (const [index, [extension, codec]] of [['mp3', 'libmp3lame'], ['wav', 'pcm_s16le'], ['flac', 'flac'], ['m4a', 'aac']].entries()) {
    const file = path.join(source, `手动音乐 ${index + 1} ${'长中文名称'.repeat(index === 0 ? 5 : 1)}.${extension}`)
    await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', `sine=frequency=${300 + index * 60}:duration=35:sample_rate=48000`, '-ac', '2', '-c:a', codec, file])
    audio.push(file)
  }
  const broken = path.join(source, '损坏音乐.wav'); await writeFile(broken, 'not audio')
  for (const [index, format] of (['png', 'jpeg', 'webp'] as const).entries()) {
    const file = path.join(source, `手动图片 ${index + 1}.${format === 'jpeg' ? 'jpg' : format}`)
    await sharp({ create: { width: 640, height: 360, channels: 3, background: ['#517999', '#9b7157', '#648967'][index] } }).toFormat(format).toFile(file)
    images.push(file)
  }
  return { source, tools, audio, images, broken }
}

/** Crash image: write a schema-valid V4 execution only while its synthetic Electron profile is closed. */
export async function seedExecutionBatch(root: string, projectId: string, plan: BatchPlan, status: Extract<RenderStatus, 'encoding' | 'pending'> = 'encoding'): Promise<ExecutionBatch> {
  assertScratch(root)
  const db = new WorkbenchDB(path.join(root, 'appdata')); await db.init()
  const project = db.get('composition', projectId), now = new Date().toISOString(), id = randomUUID()
  const batch: ExecutionBatch = { version: 2, id, projectId, planId: plan.id, name: project.name, createdAt: now, updatedAt: now, state: 'running', plan,
    jobs: plan.groups.map((group, index) => ({ id: randomUUID(), index, group: { audioIds: [...group.audioIds], imageId: group.imageId }, status, queuedAt: now,
      attempts: status === 'encoding' ? [{ id: randomUUID(), startedAt: now, encoder: 'cpu' }] : [], ...(status === 'encoding' ? { progress: 12 } : {}) })) }
  project.batchIds.push(id)
  await db.commit([{ table: 'composition', id: projectId, value: project }, { table: 'executions', id, value: batch }])
  return batch
}
