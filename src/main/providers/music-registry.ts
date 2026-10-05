import type { MusicProvider, RemoteMusicTask } from '../../shared/types'
import type { AceStepStatus, MusicAdapter, MusicConnection, MusicDraft, MusicProviderId, ProviderMusicTask } from '../../shared/music-types'
import { MurekaProvider } from './mureka'
import { KieMusicAdapter } from './kie-music'
import { ReapiMusicAdapter } from './reapi-music'
import { SunorMusicAdapter } from './sunor-music'
import { AceStepMusicAdapter } from './acestep-music'
import { AppError } from './http'
import { validateDraft } from './music-contract'

function bridgeTask(task: RemoteMusicTask): ProviderMusicTask {
  return { id: task.id, model: task.model, status: task.status,
    ...(task.detail ? { detail: task.detail } : task.failed_reason ? { detail: 'Mureka 生成失败，请检查账户额度和生成参数。' } : {}),
    // Mureka's duration is already milliseconds: NEVER multiply by 1000 here.
    ...(task.choices ? { choices: task.choices.map(choice => ({ remoteId: choice.id, url: choice.url, durationMs: choice.duration })) } : {}) }
}
class MurekaAdapter implements MusicAdapter {
  constructor(private readonly provider: MusicProvider, private readonly providerId: 'mureka' | 'mureka-cn' = 'mureka') {
    if (provider instanceof MurekaProvider && provider.providerId !== providerId) throw new AppError('Mureka 适配器站点绑定不一致。')
  }
  async create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask> {
    validateDraft(draft, this.providerId)
    if (connection.signal?.aborted) throw new AppError('请求已停止。')
    const task = this.provider instanceof MurekaProvider
      ? await this.provider.create(draft, connection.key ?? '', connection.signal)
      : await this.provider.create(draft, connection.key ?? '')
    return bridgeTask(task)
  }
  async query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask> {
    if (draft.provider !== this.providerId) throw new AppError('音乐任务不属于此站点，不能跨站查询。')
    if (connection.signal?.aborted) throw new AppError('请求已停止。')
    const task = this.provider instanceof MurekaProvider
      ? await this.provider.query(draft.mode, taskId, connection.key ?? '', connection.signal)
      : await this.provider.query(draft.mode, taskId, connection.key ?? '')
    return bridgeTask(task)
  }
  async check(connection: MusicConnection): Promise<{ message: string; balanceCents?: number }> {
    if (connection.signal?.aborted) throw new AppError('请求已停止。')
    return this.provider instanceof MurekaProvider ? this.provider.check(connection.key ?? '', connection.signal) : this.provider.check(connection.key ?? '')
  }
}

export class MusicRegistry {
  private readonly adapters: Record<MusicProviderId, MusicAdapter>
  private readonly aceStep: AceStepMusicAdapter
  constructor(mureka?: MusicProvider, fetcher: typeof fetch = fetch) {
    this.aceStep = new AceStepMusicAdapter(fetcher)
    this.adapters = { mureka: new MurekaAdapter(mureka ?? new MurekaProvider(fetcher)), 'mureka-cn': new MurekaAdapter(new MurekaProvider(fetcher, 'mureka-cn'), 'mureka-cn'), kie: new KieMusicAdapter(fetcher), reapi: new ReapiMusicAdapter(fetcher), sunor: new SunorMusicAdapter(fetcher), acestep: this.aceStep }
  }
  get(providerId: MusicProviderId): MusicAdapter {
    if (!Object.hasOwn(this.adapters, providerId)) throw new AppError('不支持此音乐提供方，请检查原任务绑定。')
    return this.adapters[providerId]
  }
  getAceStepModels(connection: MusicConnection): Promise<AceStepStatus> { return this.aceStep.models(connection) }
}
