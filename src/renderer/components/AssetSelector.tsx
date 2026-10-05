import { useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { GenerationKind, GenerationProject, WorkbenchAsset } from '../../shared/workbench-types'
import { mediaURL } from '../../shared/workbench-types'
import { compositionDraftSchema } from '../../shared/workbench-schemas'
import { COMPOSITION_SELECTION_LIMITS, deselectSelection, replaceSelection, selectAvailable, sourceAssets, sourceOptions } from '../selection'
import type { SourceFilter } from '../selection'
import { pauseOtherMedia } from '../media'
import { Dialog } from './Dialog'
import { Banner, EmptyState, Pager, duration } from './Common'
import { LibraryThumbnail } from './LibraryMedia'

export type UsageFilter = 'all' | 'unused' | 'used' | 'queued' | 'uncertain' | 'unavailable'
export const matchesUsage = (asset: WorkbenchAsset, filter: UsageFilter): boolean => filter === 'all' || (filter === 'used' ? asset.usedCount > 0 : filter === 'unused' ? !asset.usedCount && !asset.historyUncertain : filter === 'queued' ? asset.queuedCount > 0 : filter === 'uncertain' ? asset.historyUncertain : !asset.available)
export const usageLabel = (asset: WorkbenchAsset): string => `${asset.usedCount ? `已用 ${asset.usedCount} 次` : asset.historyUncertain ? '历史待核对' : '未使用'}${asset.queuedCount ? ` · 排队引用 ${asset.queuedCount}` : ''}${asset.historyUncertain && asset.usedCount ? ' · 另有历史待核对' : ''}`
export function UsageSelect({ value, onChange }: { value: UsageFilter; onChange: (value: UsageFilter) => void }) {
  return <select aria-label="按使用状态筛选" value={value} onChange={e => onChange(e.target.value as UsageFilter)}><option value="all">全部使用状态</option><option value="unused">未使用（不含待核对）</option><option value="used">已使用</option><option value="queued">排队 / 执行引用</option><option value="uncertain">历史待核对</option><option value="unavailable">文件不可用</option></select>
}
export function AssetSelector({ kind, assets, projects, initialIds, onApply, onClose }: {
  kind: GenerationKind; assets: WorkbenchAsset[]; projects: GenerationProject[]; initialIds: string[]; onApply: (ids: string[]) => void; onClose: () => void
}) {
  const [selection, setSelection] = useState<{ ids: string[]; error?: string }>(() => ({ ids: [...initialIds] }))
  const { ids, error } = selection
  const [source, setSource] = useState<SourceFilter>('all')
  const [filter, setFilter] = useState<UsageFilter>('all')
  const [page, setPage] = useState(0)
  const [replacement, setReplacement] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [mediaError, setMediaError] = useState(false)
  const options = sourceOptions(assets.filter(asset => asset.kind === kind), projects)
  const filtered = sourceAssets(assets, kind, source).filter(asset => matchesUsage(asset, filter))
  const limit = COMPOSITION_SELECTION_LIMITS[kind]
  const selectedIds = new Set(ids)
  const current = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1))
  const byId = new Map(assets.map(a => [a.id, a]))
  const previewAsset = preview ? byId.get(preview) : undefined
  function updateIds(change: (old: string[]) => string[]): void {
    setSelection(old => {
      try { return { ids: change(old.ids) } }
      catch (error) { return { ...old, error: error instanceof Error ? error.message : '选择失败，原选择未更改。' } }
    })
  }
  const move = (index: number, step: number): void => updateIds(old => { const next = [...old]; [next[index], next[index + step]] = [next[index + step], next[index]]; return next })
  function choose(asset: WorkbenchAsset): void {
    if (replacement) {
      if (!asset.available || selectedIds.has(asset.id)) return
      updateIds(old => replaceSelection(old, replacement, asset.id)); setReplacement(undefined)
    } else updateIds(old => old.includes(asset.id) ? deselectSelection(old, [asset.id]) : selectAvailable(old, [asset], limit))
  }
  function apply(): void {
    try {
      const checked = compositionDraftSchema.shape[kind === 'audio' ? 'audioIds' : 'imageIds'].safeParse(ids)
      if (!checked.success) throw new Error(`选择无效（最多 ${limit} 项，且不能重复）：${checked.error.issues[0].message}`)
      onApply(ids); pauseOtherMedia(); onClose()
    } catch (error) { setSelection(old => ({ ...old, error: error instanceof Error ? error.message : '应用失败，选择未保存。' })) }
  }
  return <Dialog title={`选择${kind === 'audio' ? '音乐' : '图片'}`} description="只修改当前合成项目的当前素材类型，应用后才保存；筛选不改变已选顺序。" className="selector-dialog" onClose={() => { pauseOtherMedia(); onClose() }}>
    <div className="dialog-body stack"><div className="toolbar"><label className="field">来源项目<select data-testid="selector-source" aria-label="来源项目" value={source} onChange={e => { setSource(e.target.value as SourceFilter); setPage(0) }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><UsageSelect value={filter} onChange={value => { setFilter(value); setPage(0) }} /></div>
      <div className="button-row"><button className="button" data-testid="selector-select-all" disabled={Boolean(replacement) || !filtered.some(asset => asset.available)} onClick={() => updateIds(old => selectAvailable(old, filtered, limit))}>全选筛选结果</button><button className="button" data-testid="selector-deselect-all" disabled={Boolean(replacement) || !filtered.some(asset => selectedIds.has(asset.id))} onClick={() => updateIds(old => deselectSelection(old, filtered.map(asset => asset.id)))}>全取消筛选结果</button><span className="meta">跨全部分页 · 全选仅添加可用素材 · 最多 {limit} 项</span></div>
      {error && <Banner tone="error">{error}</Banner>}
      {replacement && <Banner>单项替换模式：正在替换「{byId.get(replacement)?.name ?? replacement}」，请选择未选素材；批量按钮已禁用。<button className="text-button" onClick={() => setReplacement(undefined)}>取消替换</button></Banner>}
      <div className="selector-columns"><section><h3>可选素材 · {filtered.length}</h3>{!filtered.length && <EmptyState title="没有匹配素材">可在素材库导入，或调整筛选条件。</EmptyState>}<div className="candidate-list">{filtered.slice(current * 20, current * 20 + 20).map(asset => <div className="candidate-row" key={asset.id}>{kind === 'image' && <LibraryThumbnail id={asset.id} name={asset.name} available={asset.available} />}<div className="candidate-name"><strong>{asset.name}</strong><p className="meta">{kind === 'audio' ? `${duration(asset.durationSeconds)} · ` : ''}{usageLabel(asset)}{!asset.available ? ' · 不可用' : ''}</p></div><div className="button-row"><button className="text-button" disabled={!asset.available} onClick={() => { pauseOtherMedia(); setPreview(asset.id); setMediaError(false) }}>{kind === 'audio' ? '试听' : '预览'}</button><button data-testid={`selector-toggle-${asset.id}`} className="button" aria-pressed={selectedIds.has(asset.id)} disabled={!asset.available && !selectedIds.has(asset.id) || Boolean(replacement && selectedIds.has(asset.id))} onClick={() => choose(asset)}>{replacement ? '替换' : selectedIds.has(asset.id) ? '移除' : '添加'}</button></div></div>)}</div><Pager page={current} total={filtered.length} onChange={setPage} /></section>
      <section className="selector-selected"><div className="section-row"><h3>已选顺序 · {ids.length}</h3><button className="text-button" data-testid="selector-clear-all" disabled={!ids.length || Boolean(replacement)} onClick={() => updateIds(() => [])}>清空全部已选</button></div>{!ids.length && <p className="meta">从左侧添加素材，可上下调整顺序。</p>}<ol className="ordered-list">{ids.map((id, index) => <li key={id}><span className={!byId.get(id)?.available ? 'error-text' : ''}>{index + 1}. {byId.get(id)?.name ?? '素材已删除'}</span><div className="button-row"><button className="icon-button" aria-label={`上移 ${byId.get(id)?.name}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label={`下移 ${byId.get(id)?.name}`} disabled={index === ids.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button className="text-button" onClick={() => setReplacement(id)}>替换</button><button className="icon-button" aria-label={`移除 ${byId.get(id)?.name}`} onClick={() => { updateIds(old => deselectSelection(old, [id])); if (replacement === id) setReplacement(undefined) }}><X size={16} /></button></div></li>)}</ol></section></div>
      {previewAsset && <div className="selector-preview"><div className="section-row"><strong>{previewAsset.name}</strong><button className="text-button" onClick={() => { pauseOtherMedia(); setPreview(undefined) }}>关闭预览</button></div>{previewAsset.kind === 'audio' ? <audio key={previewAsset.id} controls preload="metadata" aria-label={previewAsset.name} src={mediaURL(previewAsset.id)} onPlay={e => pauseOtherMedia(e.currentTarget)} onError={() => setMediaError(true)} /> : <img key={previewAsset.id} src={mediaURL(previewAsset.id)} alt={previewAsset.name} onError={() => setMediaError(true)} />}{mediaError && <Banner tone="error">文件读取失败，请刷新素材库后检查。</Banner>}</div>}
    </div><footer className="dialog-footer"><button className="button" onClick={() => { pauseOtherMedia(); onClose() }}>取消</button><button className="button primary" data-testid="selector-apply" onClick={apply}>应用选择 · {ids.length}</button></footer>
  </Dialog>
}
