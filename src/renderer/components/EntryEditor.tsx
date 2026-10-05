import { useId } from 'react'
import type { ApiConfiguration, EntryDraft, GenerationEntry } from '../../shared/workbench-types'
import { PROVIDER_NAMES } from '../../shared/workbench-types'
import type { Provider } from '../../shared/types'
import type { AceStepStatus as LocalStatus, MusicDraft } from '../../shared/music-types'
import { MUSIC_STYLES, musicModels, musicOutputNote, musicPromptLimit, isMurekaProvider, MUREKA_ORIGINS } from '../../shared/music-capabilities'
import { IMAGE_SIZES } from '../../shared/schemas'
import { submissionIssue } from '../../shared/workbench-schemas'
import { AceStepStatus, aceStepCapabilityIssue, aceStepModelIssue } from './AceStepStatus'
import { Banner } from './Common'

export const editableMusic = (value: EntryDraft): MusicDraft => ({ ...value, provider: value.provider === 'siliconflow' || !value.provider ? 'mureka' : value.provider, mode: value.mode ?? 'song', styles: value.styles ?? [], count: 1 })
export function entryIssue(entry: GenerationEntry, apis: ApiConfiguration[], ace?: LocalStatus): string | undefined {
  const issue = submissionIssue(entry.kind, entry.draft)
  if (issue) return issue
  const api = apis.find(api => api.provider === entry.draft.provider && api.kind === entry.kind)
  if (!api) return '所选 API 未添加，请到设置添加后再提交'
  if (api.provider !== 'acestep' && !api.hasKey) return '所选 API 没有保存密钥，请在设置中补充'
  return entry.kind === 'audio' ? aceStepCapabilityIssue(editableMusic(entry.draft), ace) : undefined
}
export function EntryEditor({ entry, apis, onChange, onProvider, onSettings, aceStatus, aceError, checkingModels, onRefreshModels, draftOnly = false, parametersOnly = false }: {
  entry: GenerationEntry; apis: ApiConfiguration[]; onChange: (draft: EntryDraft) => void; onProvider: (provider: Provider) => void; onSettings: () => void
  aceStatus?: LocalStatus; aceError?: string; checkingModels: boolean; onRefreshModels: () => void; draftOnly?: boolean; parametersOnly?: boolean
}) {
  const uid = useId(), value = entry.draft, audio = entry.kind === 'audio', local = value.provider === 'acestep', mureka = isMurekaProvider(value.provider)
  const choices = apis.filter(api => api.kind === entry.kind)
  const music = editableMusic(value)
  const modelNames = audio ? local ? [...new Set(['default', ...(aceStatus?.defaultModel ? [aceStatus.defaultModel] : []), ...(aceStatus?.models.map(m => m.name) ?? [])])] : musicModels(music) : ['Qwen/Qwen-Image']
  const custom = value.provider === 'kie' || value.inputMode === 'lyrics'
  const lyricsNeeded = audio && !mureka && custom && value.mode !== 'instrumental'
  const durationInUse = audio && (local || value.provider === 'kie' || value.provider === 'reapi' && custom)
  const limit = draftOnly && !value.provider ? 32000 : audio ? musicPromptLimit(music) : 32000
  const update = (patch: Partial<EntryDraft>): void => onChange({ ...value, ...patch })
  return <div className="entry-editor stack">
    <div className="form-grid"><label className="field">已添加的{audio ? '音乐' : '图片'} API<select data-testid="entry-provider" value={value.provider ?? ''} onChange={e => onProvider(e.target.value as Provider)}><option value="" disabled>选择已添加 API</option>{value.provider && !choices.some(a => a.provider === value.provider) && <option value={value.provider} disabled>{PROVIDER_NAMES[value.provider]}（未添加）</option>}{choices.map(api => <option key={api.provider} value={api.provider}>{PROVIDER_NAMES[api.provider]}</option>)}</select></label>
      {audio && <label className="field">作品类型<select data-testid="entry-mode" value={value.mode ?? 'song'} onChange={e => update({ mode: e.target.value as EntryDraft['mode'] })}><option value="song">人声歌曲</option><option value="instrumental">纯音乐</option></select></label>}
    </div>
    {!choices.length && <Banner>还没有添加适用 API。<button className="text-button" onClick={onSettings}>去设置添加 API</button></Banner>}
    {isMurekaProvider(value.provider) && <p className="meta">{PROVIDER_NAMES[value.provider]} · {MUREKA_ORIGINS[value.provider]} · 独立密钥，任务始终绑定此站点，不自动切站。</p>}
    {!parametersOnly && <label className="field" htmlFor={`${uid}-prompt`}>{audio ? '音乐描述' : '画面描述'}<textarea data-testid="entry-prompt" id={`${uid}-prompt`} rows={3} value={value.prompt} spellCheck={false} aria-invalid={value.prompt.length > limit} onChange={e => update({ prompt: e.target.value })} placeholder={audio ? '描述曲风、乐器、情绪与人声，例如：温暖民谣，轻柔女声，原声吉他' : '描述主体、光线、构图与画面风格'} /><span className={`meta ${value.prompt.length > limit ? 'error-text' : ''}`}>{value.prompt.length} / {limit} · {draftOnly ? '生成限制另行校验；草稿上限 32000 字符，不截断' : '超长文本保留，提交前需修正'}</span></label>}
    {audio && !mureka && value.provider && value.provider !== 'kie' && <label className="field">输入方式<select data-testid="entry-input-mode" value={value.inputMode ?? 'description'} onChange={e => update({ inputMode: e.target.value as 'description' | 'lyrics' })}><option value="description" disabled={!draftOnly && local && !aceStatus?.llmInitialized}>{local ? '描述自动成歌 · 需要语言模型' : '描述生成'}</option><option value="lyrics">{local ? '基础模式 · 描述 + 自填歌词' : '自定义 · 自填歌词'}</option></select></label>}
    {value.provider === 'kie' && <p className="meta">Kie.ai 使用自定义模式，人声歌曲需单独填写歌词；不会自动付费写词。</p>}
    {!parametersOnly && audio && (lyricsNeeded || Boolean(value.lyrics) || draftOnly) && <label className="field">歌词{!lyricsNeeded && <span className="meta">已保留；当前模式不发送</span>}<textarea data-testid="entry-lyrics" rows={4} value={value.lyrics ?? ''} spellCheck={false} aria-invalid={lyricsNeeded && !value.lyrics?.trim() || (value.lyrics?.length ?? 0) > (draftOnly ? 32000 : 5000)} onChange={e => update({ lyrics: e.target.value })} placeholder="填写独立歌词，可包含段落标记" /><span className="meta">{value.lyrics?.length ?? 0} / {draftOnly ? '32000 · 草稿上限，生成前另行校验' : '5000'}{lyricsNeeded ? ' · 人声歌曲必填' : ''}</span></label>}
    <details className="advanced"><summary>高级参数 <span className="meta">{value.model || '选择模型'}{durationInUse ? ` · ${value.seconds ?? '默认'} 秒` : ''}</span></summary><div className="stack">
      <div className="form-grid"><label className="field">模型<select data-testid="entry-model" value={value.model} onChange={e => update({ model: e.target.value })}>{!modelNames.includes(value.model) && <option value={value.model}>{value.model || '未选择'}（需核对）</option>}{modelNames.map(name => <option key={name} value={name} disabled={local && Boolean(aceStepModelIssue(name, aceStatus))}>{name}{local && aceStepModelIssue(name, aceStatus) ? ' · 不可用' : ''}</option>)}</select></label>
        {durationInUse && <label className="field">请求时长 · 秒<input data-testid="entry-seconds" type="number" min={10} max={local ? 600 : 360} value={value.seconds ?? ''} onChange={e => update({ seconds: e.target.value === '' ? undefined : Number(e.target.value) })} /><span className="meta">10–{local ? 600 : 360} 秒，实际时长由服务决定</span></label>}
        {!audio && <label className="field">画面尺寸<select value={value.size ?? '1664x928'} onChange={e => update({ size: e.target.value })}>{IMAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
      </div>
      {audio && !draftOnly && !parametersOnly && <label className="field">曲名 · 可选<input value={value.title ?? ''} aria-invalid={(value.title?.length ?? 0) > 80} onChange={e => update({ title: e.target.value })} /></label>}
      {value.provider === 'sunor' && <label className="field">输出格式<select value={value.outputFormat ?? 'mp3'} onChange={e => update({ outputFormat: e.target.value as 'mp3' | 'original' })}><option value="mp3">MP3</option><option value="original">原始格式</option></select></label>}
      {mureka && value.mode === 'song' && <div className="stack"><span>风格 · 可选</span><div className="button-row">{MUSIC_STYLES.map(style => <button key={style} className="button small" aria-pressed={value.styles?.includes(style) ?? false} onClick={() => update({ styles: value.styles?.includes(style) ? value.styles.filter(s => s !== style) : [...value.styles ?? [], style] })}>{style}</button>)}</div></div>}
      {local && <><label className="checkbox-label"><input type="checkbox" checked={Boolean(value.thinking)} disabled={!draftOnly && !aceStatus?.llmInitialized && !value.thinking} onChange={e => update({ thinking: e.target.checked })} />LM 增强 · 需要语言模型就绪</label><label className="field">歌词语言<input value={value.language ?? ''} placeholder="zh / en / ja" onChange={e => update({ language: e.target.value || undefined })} /></label></>}
    </div></details>
    {local && (draftOnly ? <p className="meta">仅保存本地草稿；这里不读取模型、不测试连接。生成前需在原条目中核对模型与 LM 能力。</p> : <div className="stack ace-controls"><div className="section-row"><span className="meta">{apis.find(a => a.provider === 'acestep')?.local?.baseUrl ?? '未添加本地连接'}</span><button className="button" disabled={checkingModels || !choices.some(a => a.provider === 'acestep')} data-testid="ace-models-refresh" onClick={onRefreshModels}>{checkingModels ? '读取中…' : '刷新模型（只读）'}</button></div>{aceStatus ? <AceStepStatus status={aceStatus} /> : <p className="meta">尚未核对模型。基础模式可提交后由后台检查；描述自动成歌和 LM 增强须先手动核对。</p>}{aceError && <Banner tone="error">{aceError}</Banner>}</div>)}
    {audio && value.provider && value.provider !== 'siliconflow' && <p className="meta">{musicOutputNote(value.provider)}。切换厂商保留各自草稿，不截断描述或歌词。</p>}
  </div>
}
