import { z } from 'zod'
import { IMAGE_MODELS, imageDraftSchema } from '../../shared/schemas'
import type { CredentialCheck, ImageDraft, ImageProvider, ImageResult } from '../../shared/types'
import { AppError, malformedResponse, requestJson } from './http'

const imageResponseSchema = z.object({ images: z.array(z.object({ url: z.url().max(8192) })).length(1) })

export class SiliconFlowImagesProvider implements ImageProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async generate(draft: ImageDraft, key: string, signal?: AbortSignal): Promise<ImageResult> {
    const parsed = imageDraftSchema.safeParse(draft)
    if (!parsed.success || !parsed.data.prompt.trim()) throw new AppError('请填写画面描述，并检查模型和尺寸。')
    const input = parsed.data
    const value = await requestJson(this.fetcher, 'https://api.siliconflow.cn/v1/images/generations', {
      method: 'POST', key, timeoutMs: 300_000, signal,
      // One image; preserve the provider's default watermark. Never add OpenAI or batch fields.
      body: { model: input.model, prompt: input.prompt.trim(), image_size: input.size, num_inference_steps: 50, cfg: 4 }
    })
    const result = imageResponseSchema.safeParse(value)
    if (!result.success) throw malformedResponse(true)
    return { url: result.data.images[0].url, model: input.model }
  }

  async check(key: string): Promise<CredentialCheck> {
    const value = await requestJson(this.fetcher, 'https://api.siliconflow.cn/v1/models?type=image&sub_type=text-to-image', { method: 'GET', key, timeoutMs: 20_000 })
    const result = z.object({ data: z.array(z.object({ id: z.string().min(1).max(300) })).max(10000) }).safeParse(value)
    if (!result.success) throw malformedResponse(false)
    const available = result.data.data.some(model => model.id === IMAGE_MODELS[0])
    return { message: available
      ? '连接成功，模型列表包含 Qwen-Image。未生成图片，尚未验证额度及实际生图权限。'
      : '连接成功，但模型列表未包含 Qwen-Image。请检查模型权限；未生成图片。' }
  }
}
