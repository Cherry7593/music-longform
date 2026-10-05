import type { AceStepStatus as Status, MusicDraft } from '../../shared/music-types'

export function aceStepModelIssue(name: string, status?: Status): string | undefined {
  if (!status) return undefined
  const defaultName = status.defaultModel ?? status.models.find(item => item.isDefault)?.name
  const resolved = name === 'default' ? defaultName : name
  const model = status.models.find(item => item.name === resolved)
  const delayedDefault = Boolean(resolved && resolved === defaultName && status.modelsInitialized === false)
  if (!model && !delayedDefault) return '服务未返回所选模型。原选择已保留，请刷新或选择其他模型。'
  if (model?.supportedTaskTypes && !model.supportedTaskTypes.includes('text2music')) return '所选模型未报告支持 text2music，请选择其他模型。'
  if (model?.isLoaded === false && !delayedDefault) return '所选模型未加载。请在服务端准备模型，或选择可延迟初始化的默认模型。'
  return undefined
}

export function aceStepCapabilityIssue(draft: MusicDraft, status?: Status): string | undefined {
  if (draft.provider !== 'acestep') return undefined
  if ((draft.inputMode === 'description' || draft.thinking) && !status?.llmInitialized) {
    return status ? '服务未报告语言模型已就绪。请改用基础模式并关闭 LM 增强，或准备语言模型后手动刷新。' : '描述自动成歌 / LM 增强需要语言模型。请先刷新模型，或改用基础模式并关闭 LM 增强。'
  }
  return aceStepModelIssue(draft.model, status)
}

export function AceStepStatus({ status }: { status: Status }) {
  return <div className="ace-status" role="status">
    <p>{status.message}</p>
    <p>模型状态：{status.modelsInitialized === true ? '已初始化' : status.modelsInitialized === false ? '待初始化' : '服务未报告'} · 语言模型：{status.llmInitialized ? `已就绪${status.loadedLmModel ? `（${status.loadedLmModel}）` : ''}` : '未就绪'}</p>
    <p>只读检查不验证实际出曲。默认模型待初始化不代表连接失败；确认生成后由服务初始化。</p>
  </div>
}
