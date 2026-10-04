import { ArrowDown, ArrowUp } from 'lucide-react'
import type { BatchGroupInput, BatchPlan } from '../../shared/library-types'
import { Banner } from './Common'
import { LibraryThumbnail } from './LibraryMedia'
import { videoDuration } from './VideoJobs'

export function BatchPlanPreview({ plan, disabled, revising, onRevise, onPreview }: {
  plan: BatchPlan; disabled: boolean; revising: boolean; onRevise: (groups: BatchGroupInput[]) => void; onPreview: (id: string) => void
}) {
  const assets = new Map(plan.assets.map(asset => [asset.id, asset]))
  const editable = (): BatchGroupInput[] => plan.groups.map(group => ({ imageId: group.imageId, audioIds: [...group.audioIds] }))
  function move(songId: string, target: number): void {
    if (disabled || !plan.groups[target]) return
    const groups = editable().map(group => ({ ...group, audioIds: group.audioIds.filter(id => id !== songId) }))
    groups[target].audioIds.push(songId)
    onRevise(groups)
  }
  function reorder(groupIndex: number, from: number, direction: number): void {
    if (disabled) return
    const groups = editable()
    const songs = groups[groupIndex].audioIds
    const to = from + direction
    if (to < 0 || to >= songs.length) return
    ;[songs[from], songs[to]] = [songs[to], songs[from]]
    onRevise(groups)
  }
  return <section className="batch-plan" aria-label="分组预览" data-testid="batch-plan" aria-busy={revising}>
    <div className="section-row"><h2>分组预览</h2><span className="field-note">将生成 {plan.groups.length} 个视频 · {plan.request.audioIds.length} 首音乐全部分配一次</span></div>
    <p className="field-note">每张图片对应一个视频；整首播放，不循环、不裁歌。组内默认保留选曲顺序。移动歌曲会从原组移除，再由主进程重新校验。</p>
    {plan.reason === 'search-exhausted' && <Banner tone="warning">在本次搜索预算内未找到可行的整首分组，不代表素材总量必然不足。可手动调组，或减少图片、降低最短时长。</Banner>}
    {plan.issues.length > 0 && <Banner tone="warning"><strong>当前方案不能提交</strong><ul className="batch-issues">{plan.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></Banner>}
    {revising && <p role="status" className="field-note">正在重新校验分组；完成前不能继续调整或合成。</p>}
    <div className="batch-plan-groups">{plan.groups.map((group, groupIndex) => {
      const image = assets.get(group.imageId)
      const extra = group.durationSeconds - plan.request.minimumSeconds
      return <article className="batch-plan-group" key={group.imageId} data-testid={`batch-group-${groupIndex}`}>
        <div className="batch-group-header"><button type="button" className="batch-group-image" onClick={() => onPreview(group.imageId)} disabled={disabled} aria-label={`查看视频 ${groupIndex + 1} 图片`}><LibraryThumbnail id={group.imageId} name={image?.name ?? group.imageId} /></button>
          <div><h3>视频 {groupIndex + 1} · {image?.name ?? group.imageId}</h3><p>{group.audioIds.length} 首 · 预计 {videoDuration(group.durationSeconds)}</p>
            <p className={`field-note ${extra < 0 ? 'error-text' : ''}`}>{extra >= 0 ? `超出下限 ${videoDuration(extra)}` : `距最短时长还差 ${videoDuration(-extra)}`} · 已计入转场影响</p></div>
        </div>
        {group.issues.length > 0 && <ul className="batch-issues error-text">{group.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
        <details className="batch-group-songs" open={groupIndex === 0}><summary>曲目与播放顺序 · {group.audioIds.length} 首</summary>
          {!group.audioIds.length && <p className="field-note">本组尚无音乐，请从其他组移入。</p>}
          <ol className="batch-song-list">{group.audioIds.map((songId, songIndex) => {
            const song = assets.get(songId)
            const label = song?.name ?? songId
            return <li key={songId} className="batch-song" data-song-id={songId}>
              <div className="batch-song-title"><span className="track-number">{songIndex + 1}</span><div><strong>{label}</strong><p className="field-note">{song?.durationSeconds !== undefined ? videoDuration(song.durationSeconds) : '时长待校验'}</p></div></div>
              <div className="batch-song-controls"><button type="button" className="icon-button" aria-label={`上移${label}`} title="上移" disabled={disabled || songIndex === 0} onClick={() => reorder(groupIndex, songIndex, -1)}><ArrowUp size={17} /></button>
                <button type="button" className="icon-button" aria-label={`下移${label}`} title="下移" disabled={disabled || songIndex === group.audioIds.length - 1} onClick={() => reorder(groupIndex, songIndex, 1)}><ArrowDown size={17} /></button>
                <label className="batch-move field"><span className="sr-only">移动{label}到其他视频</span><select aria-label={`移动${label}到其他视频`} disabled={disabled || plan.groups.length < 2} value={groupIndex} onChange={event => move(songId, Number(event.target.value))}>
                  {plan.groups.map((target, index) => <option key={target.imageId} value={index}>{index === groupIndex ? `当前：视频 ${index + 1}` : `移到视频 ${index + 1}`} · {assets.get(target.imageId)?.name ?? '图片'}</option>)}</select></label>
              </div>
            </li>
          })}</ol>
        </details>
      </article>
    })}</div>
  </section>
}
