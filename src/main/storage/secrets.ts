import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { keySchema, providerSchema } from '../../shared/schemas'
import type { Provider } from '../../shared/types'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { commitUpgrade } from './migrations'

interface Encryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
const encrypted = z.string().min(4).max(32768).refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value)
const legacySecretSchema = z.object({ version: z.literal(1), keys: z.object({ mureka: encrypted.optional(), openai: encrypted.optional() }).strict() }).strict()
const secretSchema = z.object({ version: z.literal(2), keys: z.object({ mureka: encrypted.optional(), siliconflow: encrypted.optional() }).strict() }).strict()
type SecretData = z.infer<typeof secretSchema>

/** Encryption is injected; this pure store neither imports Electron nor logs credentials. */
export class SecretStore {
  private value?: SecretData
  private readonly queue = new SerialQueue()
  private readonly path: string

  constructor(private readonly dataDir: string, private readonly encryption: Encryption) {
    this.path = join(dataDir, 'secrets.json')
  }

  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.value) return
      try { await mkdir(this.dataDir, { recursive: true }) } catch { throw new AppError('无法创建密钥存储目录。') }
      let data: unknown
      try { data = await readJson(this.path, 128 * 1024) } catch (error) {
        if (!isMissing(error)) throw new AppError('加密密钥文件损坏或不可读取；原文件未被覆盖，请先备份并修复。')
        data = { version: 2, keys: {} }
        try { await atomicJson(this.path, data) } catch { throw new AppError('无法保存加密密钥文件，请检查存储权限。') }
      }
      const parsed = secretSchema.safeParse(data)
      if (parsed.success) { this.value = parsed.data; return }
      const legacy = legacySecretSchema.safeParse(data)
      if (!legacy.success) throw new AppError('加密密钥文件格式不兼容；原文件未被覆盖，请先备份并修复。')
      const next: SecretData = { version: 2, keys: legacy.data.keys.mureka ? { mureka: legacy.data.keys.mureka } : {} }
      await commitUpgrade(this.path, next, 1)
      this.value = next
    })
  }

  isAvailable(): boolean {
    try { return this.encryption.isEncryptionAvailable() } catch { return false }
  }

  private checked(provider: Provider): SecretData {
    if (!providerSchema.safeParse(provider).success) throw new AppError('密钥服务商不正确。')
    if (!this.value) throw new AppError('密钥存储尚未初始化。')
    return this.value
  }

  has(provider: Provider): boolean {
    return this.checked(provider).keys[provider] !== undefined
  }

  get(provider: Provider): string {
    const value = this.checked(provider).keys[provider]
    if (!value) throw new AppError('尚未配置此服务商的 API 密钥，请前往设置。')
    if (!this.isAvailable()) throw new AppError('系统加密不可用，无法读取已保存的密钥；不会改用明文存储。')
    try {
      const decrypted = keySchema.safeParse(this.encryption.decryptString(Buffer.from(value, 'base64')))
      if (!decrypted.success) throw new Error('invalid decrypted key')
      return decrypted.data
    } catch { throw new AppError('已保存的加密密钥与当前用户或系统不兼容，请重新配置。') }
  }

  async set(provider: Provider, key: string): Promise<void> {
    const parsed = keySchema.safeParse(key)
    if (!parsed.success) throw new AppError('密钥格式不正确，必须是 8–4096 个不含空白的 ASCII 字符。')
    await this.queue.run(async () => {
      const previous = this.checked(provider)
      if (!this.isAvailable()) throw new AppError('系统加密不可用，不能保存密钥；不会改用明文存储。')
      let ciphertext: string
      try { ciphertext = this.encryption.encryptString(parsed.data).toString('base64') } catch { throw new AppError('密钥加密失败，请检查系统安全存储。') }
      if (!encrypted.safeParse(ciphertext).success) throw new AppError('密钥加密失败，系统未返回有效的加密数据。')
      const next: SecretData = { version: 2, keys: { ...previous.keys, [provider]: ciphertext } }
      try { await atomicJson(this.path, next) } catch { throw new AppError('加密密钥保存失败，请检查存储权限。') }
      this.value = next
    })
  }

  async clear(provider: Provider): Promise<void> {
    await this.queue.run(async () => {
      const previous = this.checked(provider)
      const next = structuredClone(previous)
      delete next.keys[provider]
      try { await atomicJson(this.path, next) } catch { throw new AppError('密钥清除失败，请检查存储权限。') }
      this.value = next
    })
  }
}
