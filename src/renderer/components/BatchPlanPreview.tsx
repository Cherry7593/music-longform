import { ArrowDown, ArrowUp } from 'lucide-react'
import type { BatchGroupInput, BatchPlan } from '../../shared/library-types'
import { Banner, duration } from './Common'

export function BatchPlanPreview({ plan, disabled, onRevise, onPreview }: { plan: BatchPlan; disabled: boolean; onRevise: (groups: BatchGroupInput[]) => void; onPreview: (id: string) => void }) {
  const assets = new Map(plan.assets.map(a => [a.id, a]))
  const editable = (): BatchGroupInput[] => plan.groups.map(g => ({ imageId: g.imageId, audioIds: [...g.audioIds] }))
  function reorder(groupIndex: number, from: number, direction: number): void { const groups = editable(); const songs = groups[groupIndex].audioIds; const to = from + direction; if (to < 0 || to >= songs.length) return; [songs[from], songs[to]] = [songs[to], songs[from]]; onRevise(groups) }
  function move(id: string, target: number): void { const groups = editable().map(g => ({ ...g, audioIds: g.audioIds.filter(song => song !== id) })); groups[target].audioIds.push(id); onRevise(groups) }
  return <section className="stack" data-testid="composition-plan"><div className="section-row"><h2>分组预览</h2><p className="meta">{plan.groups.length} 条视频 · {plan.request.audioIds.length} 首音乐</p></div>
    <p className="meta">一图一视频，整首播放一次；同批不重复。移动曲目会从原组移除，调整后重新校验。</p>
    {plan.issues.length > 0 && <Banner tone="warning"><strong>当前计划不能提交</strong><ul>{plan.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></Banner>}
    {plan.reason === 'search-exhausted' && <Banner tone="warning">在搜索预算内未找到可行分组，不代表总素材必然不足。可手动调整或减少图片。</Banner>}
    <div className="plan-groups">{plan.groups.map((group, index) => <details key={group.imageId} className="plan-group" open={plan.groups.length === 1 ? true : undefined}><summary><strong>视频 {index + 1} · {assets.get(group.imageId)?.name ?? group.imageId}</strong><span className="meta">{group.audioIds.length} 首 · 预计 {duration(group.durationSeconds)}{group.durationSeconds < plan.request.minimumSeconds ? ' · 时长不足' : ''}</span></summary><div className="stack"><button className="text-button" onClick={() => onPreview(group.imageId)}>查看配图</button>{group.issues.length > 0 && <ul className="error-text">{group.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}{!group.audioIds.length && <p className="meta">本组为空，请移入音乐。</p>}
      <ol className="ordered-list">{group.audioIds.map((id, songIndex) => <li key={id}><span>{songIndex + 1}. {assets.get(id)?.name ?? id}<small className="meta"> · {duration(assets.get(id)?.durationSeconds)}</small></span><div className="button-row"><button className="text-button" onClick={() => onPreview(id)}>试听</button><button className="icon-button" aria-label="曲目上移" disabled={disabled || songIndex === 0} onClick={() => reorder(index, songIndex, -1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label="曲目下移" disabled={disabled || songIndex === group.audioIds.length - 1} onClick={() => reorder(index, songIndex, 1)}><ArrowDown size={16} /></button>{plan.groups.length > 1 && <select aria-label={`移动 ${assets.get(id)?.name ?? id} 到分组`} value={index} disabled={disabled} onChange={e => move(id, Number(e.target.value))}>{plan.groups.map((g, n) => <option key={g.imageId} value={n}>视频 {n + 1}</option>)}</select>}</div></li>)}</ol></div></details>)}</div>
  </section>
}
