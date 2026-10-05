import { z } from 'zod'
import type { AceStepStatus, MusicAdapter, MusicConnection, MusicDraft, ProviderMusicTask } from '../../shared/music-types'
import { AppError, malformedResponse } from './http'
import { localBaseURL, normalizeLocalAudioURL, requestLocalJson } from './local-http'
import { envelopeData, milliseconds, parseResponse, parseResultJson, remoteTaskId, secondsSchema, validateDraft, validateTaskId } from './music-contract'

const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const healthSchema = z.object({
  status: z.literal('ok'), service: z.literal('ACE-Step API'),
  models_initialized: z.boolean().optional(), llm_initialized: z.boolean().optional()
})
const inventorySchema = z.object({
  models: z.array(z.object({ name: modelName, is_default: z.boolean(), is_loaded: z.boolean().optional(),
    supported_task_types: z.array(z.string().min(1).max(80)).max(30).optional() })).max(100),
  default_model: modelName.nullish(), llm_initialized: z.boolean(), loaded_lm_model: modelName.nullish()
})
const resultSchema = z.array(z.object({
  file: z.string().min(1).max(8192), status: z.literal(1).optional(),
  metas: z.object({ duration: secondsSchema }).nullish(), dit_model: modelName.optional()
})).min(1).max(20)

export class AceStepMusicAdapter implements MusicAdapter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async models(connection: MusicConnection): Promise<AceStepStatus> {
    const parsedHealth = healthSchema.safeParse(envelopeData(await requestLocalJson(this.fetcher, connection, '/health'), 200))
    if (!parsedHealth.success) throw new AppError('未识别为 ACE-Step 官方 REST API，请检查服务版本及 API 端口，不要填写网页端口。')
    const health = parsedHealth.data
    const inventory = parseResponse(inventorySchema, envelopeData(await requestLocalJson(this.fetcher, connection, '/v1/models'), 200))
    const names = new Set(inventory.models.map(model => model.name))
    if (names.size !== inventory.models.length || inventory.models.filter(model => model.is_default).length > 1) throw malformedResponse(false)
    return {
      message: health.models_initialized ? 'ACE-Step 服务可达，鉴权通过，模型已初始化；未验证实际生成。' : 'ACE-Step 服务可达，鉴权通过，默认模型待服务延迟初始化；未验证实际生成。',
      baseUrl: localBaseURL(connection), modelsInitialized: health.models_initialized,
      models: inventory.models.map(model => ({ name: model.name, isDefault: model.is_default,
        ...(model.is_loaded !== undefined ? { isLoaded: model.is_loaded } : {}),
        ...(model.supported_task_types ? { supportedTaskTypes: model.supported_task_types } : {}) })),
      defaultModel: inventory.default_model ?? inventory.models.find(model => model.is_default)?.name,
      llmInitialized: inventory.llm_initialized, ...(inventory.loaded_lm_model ? { loadedLmModel: inventory.loaded_lm_model } : {})
    }
  }
  async check(connection: MusicConnection): Promise<{ message: string }> {
    const status = await this.models(connection)
    return { message: `${status.message}${status.llmInitialized ? '语言模型已就绪。' : '语言模型未就绪，可使用基础纯音乐／自填歌词模式。'}` }
  }
  async preflight(draft: MusicDraft, connection: MusicConnection): Promise<void> {
    const input = validateDraft(draft, 'acestep')
    const status = await this.models(connection)
    const name = input.model === 'default' ? status.defaultModel : input.model
    const selected = status.models.find(model => model.name === name)
    const delayedDefault = !!name && name === status.defaultModel && status.modelsInitialized === false
    if ((!selected && !delayedDefault) || (selected?.isLoaded === false && !delayedDefault)) throw new AppError('所选 ACE-Step 模型尚不可用；请在服务端准备该模型，或选择可延迟初始化的默认模型。')
    if (selected?.supportedTaskTypes && !selected.supportedTaskTypes.includes('text2music')) throw new AppError('所选 ACE-Step 模型不支持 text2music，请选择支持文字生成音乐的模型。')
    if ((input.inputMode === 'description' || input.thinking) && !status.llmInitialized) throw new AppError('描述自动成歌／LM 增强需要已就绪的语言模型；请在服务端准备 LM，或改用基础自填歌词／纯音乐模式。')
  }
  async create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask> {
    const input = validateDraft(draft, 'acestep')
    await this.preflight(input, connection)
    const description = input.inputMode === 'description'
    const thinking = description || input.thinking === true
    const value = await requestLocalJson(this.fetcher, connection, '/release_task', {
      task_type: 'text2music', batch_size: 1, audio_format: 'flac', audio_duration: input.seconds ?? 180,
      prompt: input.prompt.trim(), lyrics: input.mode === 'instrumental' ? '[Instrumental]' : description ? '' : input.lyrics!.trim(),
      ...(input.model === 'default' ? {} : { model: input.model }), vocal_language: input.language ?? 'en',
      thinking, sample_mode: false, use_format: false,
      // Defaults are TRUE upstream and would otherwise trigger lazy LM initialization, even with thinking:false.
      use_cot_caption: thinking, use_cot_language: thinking,
      ...(description ? { sample_query: `${input.mode === 'instrumental' ? 'Instrumental, no vocals. ' : ''}${input.prompt.trim()}` } : {})
    })
    const data = parseResponse(z.object({ task_id: remoteTaskId, status: z.literal('queued').optional() }), envelopeData(value, 200, true), true)
    return { id: data.task_id, model: input.model, status: 'queued' }
  }
  async query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask> {
    validateDraft(draft, 'acestep'); validateTaskId(taskId)
    const value = await requestLocalJson(this.fetcher, connection, '/query_result', { task_id_list: [taskId] })
    const rows = parseResponse(z.array(z.object({ task_id: remoteTaskId, status: z.union([z.literal(0), z.literal(1), z.literal(2)]), result: z.string().max(1024 * 1024) })).length(1), envelopeData(value, 200))
    const data = rows[0]
    if (data.task_id !== taskId) throw malformedResponse(false)
    if (data.status === 0) return { id: taskId, model: draft.model, status: 'running' }
    if (data.status === 2) return { id: taskId, model: draft.model, status: 'failed', detail: 'ACE-Step 推理失败，请查看服务端状态、显存和模型配置；未自动重新生成。' }
    const decoded = parseResultJson(data.result)
    if (Array.isArray(decoded) && !decoded.length) throw new AppError('ACE-Step 报告完成但没有音频结果，请检查原任务及服务端输出；未重新生成。')
    const results = parseResponse(resultSchema, decoded)
    return { id: taskId, model: results[0].dit_model ?? draft.model, status: 'succeeded', choices: results.map(result => ({
      url: normalizeLocalAudioURL(connection, result.file), ...(result.metas?.duration != null ? { durationMs: milliseconds(result.metas.duration) } : {})
    })) }
  }
}
