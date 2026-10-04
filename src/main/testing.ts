/** Development-only fixtures. index.ts gates this module with !app.isPackaged. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialCheck, ImageDraft, ImageProvider, ImageResult, MusicDraft, MusicMode, MusicProvider, RemoteMusicTask, SavedImage } from '../shared/types'
import { AppError } from './providers/http'
import { saveImage } from './downloads'

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
