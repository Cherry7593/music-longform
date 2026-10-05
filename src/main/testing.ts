/** Development-only fixtures. index.ts gates this module with !app.isPackaged. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialCheck, ImageDraft, ImageProvider, ImageResult, MusicDraft, MusicMode, MusicProvider, RemoteMusicTask, SavedImage } from '../shared/types'
import { AppError } from './providers/http'
import { saveImage } from './downloads'
import { saveGeneratedAudio, type SaveGeneratedAudioOptions } from './generated-audio'
import type { GeneratedAudioResult } from '../shared/music-types'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
export const TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVQokWN4+/nPf0oww6gB/0fD4M9/AG4PK0+mPghEAAAAAElFTkSuQmCC'
export class TestMusicProvider implements MusicProvider {
  private polls = new Map<string, number>()
  async create(draft: MusicDraft): Promise<RemoteMusicTask> {
    await delay(150)
    if (draft.prompt.includes('[unknown]')) throw new AppError('模拟连接中断', true)
    if (draft.prompt.includes('[fail]')) throw new AppError('模拟余额不足')
    return { id: `fixture-${randomUUID()}`, status: 'preparing', model: 'test-fixture' }
  }
  async query(_mode: MusicMode, taskId: string): Promise<RemoteMusicTask> {
    await delay(100)
    const count = (this.polls.get(taskId) ?? 0) + 1
    this.polls.set(taskId, count)
    if (count < 3) return { id: taskId, status: 'running', model: 'test-fixture' }
    return { id: taskId, status: 'succeeded', model: 'test-fixture', choices: [{ id: taskId, url: 'https://fixture.invalid/tone.wav', duration: 8000 }] }
  }
  async check(): Promise<CredentialCheck> { return { message: '测试凭证可用（模拟接口，未连接服务商）', balanceCents: 1000 } }
}
export class TestImageProvider implements ImageProvider {
  async generate(draft: ImageDraft): Promise<ImageResult> {
    await delay(600)
    if (draft.prompt.includes('[unknown]')) throw new AppError('模拟图片响应超时', true)
    if (draft.prompt.includes('[fail]')) throw new AppError('模拟模型无权限')
    return { url: 'https://fixture.invalid/picture.png', model: 'Qwen/Qwen-Image' }
  }
  async check(): Promise<CredentialCheck> { return { message: '测试凭证可用；未验证真实图片模型权限' } }
}
export async function testDownload(_url: string, directory: string, assetId: string): Promise<{ fileName: string }> {
  const rate = 16000
  const samples = rate * 8
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 220) * 1000), 44 + i * 2)
  const fileName = `audio/${assetId}.wav`
  await mkdir(path.join(directory, 'audio'), { recursive: true })
  await writeFile(path.join(directory, fileName), buffer)
  return { fileName }
}
export async function testDownloadImage(_url: string, directory: string, assetId: string): Promise<SavedImage> {
  return saveImage(TEST_PNG, directory, assetId)
}

/** Fixed official response shapes, only loaded behind the isolated, unpackaged test gate. */
export const testMusicFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  if (['127.0.0.1', '[::1]'].includes(url.hostname)) return fetch(input, init)
  if (!['api.kie.ai', 'reapi.ai', 'sunor.cc'].includes(url.hostname)) throw new Error('Fixture refuses external network')
  const provider = url.hostname === 'api.kie.ai' ? 'kie' : url.hostname === 'reapi.ai' ? 'reapi' : 'sunor'
  await delay(100)
  if (init?.method === 'POST') {
    const id = `fixture-${provider}-${randomUUID()}`
    return provider === 'kie' ? Response.json({ code: 200, data: { taskId: id } })
      : provider === 'reapi' ? Response.json({ id, status: 'processing' })
        : Response.json({ code: 202, data: { task_id: id, status: 'pending' } }, { status: 202 })
  }
  if (url.pathname.endsWith('/credit')) return Response.json({ code: 200, data: 999 })
  if (url.pathname.endsWith('/balance')) return Response.json(provider === 'reapi' ? { balance: 999 } : { code: 200, data: { available: 999, frozen: 0 } })
  const id = provider === 'kie' ? url.searchParams.get('taskId')! : url.pathname.split('/').pop()!
  const urls = [0, 1].map(index => `https://fixture.invalid/${provider}/${id}/${index}.wav`)
  if (provider === 'kie') return Response.json({ code: 200, data: { taskId: id, state: 'success', resultJson: JSON.stringify({ resultUrls: urls }) } })
  if (provider === 'reapi') return Response.json({ id, status: 'completed', output: { audio_urls: urls } })
  return Response.json({ code: 200, data: { task_id: id, status: 'success', output: { result: urls.map(audio_url => ({ audio_url })) } } })
}
export async function testSaveGeneratedAudio(options: SaveGeneratedAudioOptions): Promise<GeneratedAudioResult> {
  if (options.connection) return saveGeneratedAudio(options)
  if (!options.url.startsWith('https://fixture.invalid/')) throw new Error('Only synthetic cloud audio is permitted in this fixture')
  return { ...await testDownload(options.url, options.directory, options.assetId), durationMs: 8000 }
}
