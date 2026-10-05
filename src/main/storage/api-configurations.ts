import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { apiInputSchema, apiRecordSchema } from '../../shared/workbench-schemas'
import { aceStepConfigurationSchema } from '../../shared/music-schemas'
import { providerKeySchema } from '../../shared/schemas'
import type { ApiConfiguration, ApiConfigurationInput, DeletionImpact, RequestBinding } from '../../shared/workbench-types'
import { PROVIDER_NAMES } from '../../shared/workbench-types'
import type { Provider, ImageProvider } from '../../shared/types'
import type { MusicConnection } from '../../shared/music-types'
import type { MusicRegistry } from '../providers/music-registry'
import { AppError, safeError } from '../providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { aceStepConnectionId, defaultAceStepSettings } from './migrations'
import type { WorkbenchDB, ApiRecord } from './workbench-db'
import type { SecretStore, SecretData } from './secrets'

const pendingSchema = z.object({ version: z.literal(1), record: apiRecordSchema, encrypted: z.unknown() }).strict()
const now = () => new Date().toISOString()
export class ApiConfigurations {
  private readonly queue = new SerialQueue()
  private readonly journal: string
  constructor(private readonly db: WorkbenchDB, private readonly secrets: SecretStore, private readonly registry: MusicRegistry, private readonly images: ImageProvider) {
    this.journal = path.join(db.directory, 'api-transaction.json')
  }
  async init(): Promise<void> { await this.queue.run(() => this.recover()) }
  private async recover(): Promise<void> {
    let pending: z.infer<typeof pendingSchema>
    try { pending = pendingSchema.parse(await readJson(this.journal, 256 * 1024)) }
    catch (error) { if (isMissing(error)) return; throw new AppError('API 配置提交日志不可读取，原密钥保留。') }
    await this.secrets.commitPrepared(pending.encrypted as SecretData)
    await this.db.put('apis', pending.record.provider, pending.record)
    await unlink(this.journal)
  }
  list(): ApiConfiguration[] {
    return this.db.list('apis').filter(item => !item.deletedAt).map(record => {
      const { deletedAt: _deleted, ...value } = record; void _deleted
      return { ...value, hasKey: this.secrets.has(record.provider, record.local?.connectionId) }
    })
  }
  get(provider: Provider): ApiRecord {
    const record = this.db.get('apis', provider)
    if (record.deletedAt) throw new AppError('此 API 配置已删除，请重新添加。')
    return record
  }
  protectedRequests(provider: Provider) {
    return this.db.list('requests').filter(request => request.binding.provider === provider && (
      ['pending', 'paused', 'submitting', 'running', 'saving', 'unknown'].includes(request.status) || (request.status === 'failed' && request.recoverable)))
  }
  impact(provider: Provider): DeletionImpact {
    this.get(provider)
    const refs = this.protectedRequests(provider)
    return { id: provider, name: PROVIDER_NAMES[provider], blocked: refs.length > 0, reasons: refs.length ? ['仍有排队、运行或可恢复请求，请先停止后续任务并处理已提交请求。'] : [],
      references: refs.map(item => ({ id: item.id, kind: '生成请求', name: item.snapshot.title || item.snapshot.prompt.slice(0, 50) || item.id })), externalOriginalsKept: true }
  }
  binding(provider: Provider): RequestBinding {
    const config = this.get(provider)
    return { provider, adapterVersion: 1, ...(config.local ? { local: { baseUrl: config.local.baseUrl, connectionId: config.local.connectionId } } : {}) }
  }
  connection(binding: RequestBinding, signal?: AbortSignal): MusicConnection {
    if (binding.provider === 'openai') throw new AppError('旧 OpenAI 任务只保留历史，不能转换到其他服务重新提交。')
    const config = this.get(binding.provider)
    if (binding.provider === 'acestep') {
      if (!config.local || binding.local?.baseUrl !== config.local.baseUrl || binding.local.connectionId !== config.local.connectionId) throw new AppError('原任务绑定的 ACE-Step 连接已改变，请恢复原地址和凭据，不会向新服务发送原任务。')
      return { baseUrl: config.local.baseUrl, signal, ...(this.secrets.has('acestep', config.local.connectionId) ? { key: this.secrets.get('acestep', config.local.connectionId) } : {}) }
    }
    return { key: this.secrets.get(binding.provider), signal }
  }
  async save(input: ApiConfigurationInput): Promise<ApiConfiguration[]> {
    await this.queue.run(async () => {
      await this.recover()
      const value = apiInputSchema.parse(input), provider = value.provider
      if (value.key !== undefined) providerKeySchema(provider).parse(value.key)
      if (provider !== 'acestep' && value.local) throw new AppError('云端 API 不接受自定义地址。')
      const previous = this.db.has('apis', provider) ? this.db.get('apis', provider) : undefined
      const previousLocal = previous?.local ?? defaultAceStepSettings()
      const local = provider === 'acestep' ? aceStepConfigurationSchema.parse(value.local ?? { baseUrl: previousLocal.baseUrl, waitMinutes: previousLocal.waitMinutes, allowLan: previousLocal.allowLan }) : undefined
      const changedAddress = local && previous?.local && previous.local.baseUrl !== local.baseUrl
      if (changedAddress && this.protectedRequests(provider).length) throw new AppError('原连接仍有未完成请求，不能更换地址。请先恢复或明确结束原任务追踪。')
      const localSettings = local ? { ...local, connectionId: aceStepConnectionId(local.baseUrl) } : undefined
      const encrypted = this.secrets.prepare(provider, value.key, localSettings?.connectionId, value.clearKey || Boolean(changedAddress) || Boolean(previous?.deletedAt))
      if (provider !== 'acestep' && !encrypted.keys[provider] && (!previous || previous.deletedAt)) throw new AppError('新增云端 API 必须保存有效格式的密钥；编辑时可明确清除，清除后不能生成。')
      const record: ApiRecord = { version: 1, provider, kind: provider === 'siliconflow' ? 'image' : 'audio', createdAt: previous?.createdAt ?? now(), updatedAt: now(), ...(localSettings ? { local: localSettings } : {}) }
      await atomicJson(this.journal, { version: 1, record, encrypted }, 256 * 1024)
      await this.recover()
    })
    return this.list()
  }
  async delete(provider: Provider): Promise<void> {
    await this.queue.run(async () => {
      await this.recover()
      const impact = this.impact(provider)
      if (impact.blocked) throw new AppError(impact.reasons[0])
      const record = { ...this.get(provider), deletedAt: now(), updatedAt: now() }
      const encrypted = this.secrets.prepare(provider, undefined, undefined, true)
      await atomicJson(this.journal, { version: 1, record, encrypted }, 256 * 1024)
      await this.recover()
    })
  }
  async test(input: ApiConfigurationInput): Promise<{ message: string }> {
    const value = apiInputSchema.parse(input), provider = value.provider
    const stored = this.list().find(item => item.provider === provider)
    const previousLocal = stored?.local ?? defaultAceStepSettings()
    const local = provider === 'acestep' ? aceStepConfigurationSchema.parse(value.local ?? { baseUrl: previousLocal.baseUrl, waitMinutes: previousLocal.waitMinutes, allowLan: previousLocal.allowLan }) : undefined
    const sameConnection = local?.baseUrl === stored?.local?.baseUrl
    const key = value.clearKey ? undefined : value.key ?? (this.secrets.has(provider, stored?.local?.connectionId) && (provider !== 'acestep' || sameConnection) ? this.secrets.get(provider, stored?.local?.connectionId) : undefined)
    if (provider !== 'acestep') providerKeySchema(provider).parse(key)
    const connection = { ...(key ? { key } : {}), ...(local ? { baseUrl: local.baseUrl } : {}) }
    try {
      const result = provider === 'siliconflow' ? await this.images.check(key!) : await this.registry.get(provider).check(connection)
      if (stored && value.key === undefined && (provider !== 'acestep' || sameConnection)) await this.db.update('apis', provider, row => { if (row.updatedAt === stored.updatedAt) row.lastCheck = { at: now(), ok: true, message: result.message } })
      return result
    } catch (error) {
      if (stored && value.key === undefined && (provider !== 'acestep' || sameConnection)) await this.db.update('apis', provider, row => { if (row.updatedAt === stored.updatedAt) row.lastCheck = { at: now(), ok: false, message: safeError(error) } })
      throw error
    }
  }
}
