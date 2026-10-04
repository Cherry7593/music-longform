import { useId } from 'react'
import { Clapperboard, ListChecks, X } from 'lucide-react'
import type { BatchOptions, BatchVideoJob, LibraryAsset, VideoBatch } from '../../shared/library-types'
import type { LibraryController } from '../hooks/useLibrary'
import type { BatchComposerController } from '../hooks/useBatchComposer'
import type { VideoBatchesController } from '../hooks/useVideoBatches'
import { Banner } from './Common'
import { NumberField, transitionLabels } from './VideoParameters'
import { LibrarySelectionSummary } from './LibraryWorkspace'
import { BatchPlanPreview } from './BatchPlanPreview'
import { BatchVideoJobs } from './BatchVideoJobs'
import { videoDuration } from './VideoJobs'

export function BatchVideoWorkspace({ library, composer, queue, disabled, busy, onLibrary, onSettings, onPreview, onPlay, onExport, onReveal }: {
  library: LibraryController; composer: BatchComposerController; queue: VideoBatchesController; disabled: boolean; busy: string[]
  onLibrary: () => void; onSettings: () => void; onPreview: (asset: LibraryAsset) => void
  onPlay: (batch: VideoBatch, job: BatchVideoJob) => void; onExport: (batch: VideoBatch, job: BatchVideoJob) => void
  onReveal: (batch: VideoBatch, job?: BatchVideoJob) => void
}) {
  const id = useId()
  const { options, plan } = composer
  const locked = disabled || Boolean(composer.busy)
  const setOption = <K extends keyof BatchOptions>(key: K, value: BatchOptions[K]) => composer.setOptions({ ...options, [key]: value })
  const invalidName = !composer.name.trim() || composer.name.trim().length > 80
  return <div className="batch-workspace" data-testid="batch-workspace">
    <LibrarySelectionSummary library={library} disabled={locked} onNext={onLibrary} nextLabel="回素材库调整" />
    <details className="batch-selected-details"><summary>查看已选素材与选择顺序</summary><div className="batch-selected-columns">
      {(['audio', 'image'] as const).map(kind => <div key={kind}><h3>{kind === 'audio' ? '音乐' : '图片'}</h3><ol className="batch-selected-list">{(kind === 'audio' ? library.selection.audioIds : library.selection.imageIds).map(assetId => {
        const asset = library.assetsById.get(assetId)
        return <li key={assetId}><span className={!asset?.available ? 'error-text' : ''}>{asset?.name ?? assetId}{!asset?.available && ' · 不可用'}{asset?.durationSeconds !== undefined && <small> · {videoDuration(asset.durationSeconds)}</small>}</span>
          <button type="button" className="icon-button" disabled={locked} onClick={() => library.select(kind, [assetId], false)} aria-label={`取消选择${asset?.name ?? assetId}`} title="取消选择"><X size={15} /></button></li>
      })}</ol></div>)}
    </div></details>
    {library.error && <Banner tone="error">素材库读取失败：{library.error}<button type="button" className="text-button" disabled={locked || library.loading} onClick={() => void library.refresh()}>刷新素材库</button></Banner>}
    <form className="batch-settings" onSubmit={event => { event.preventDefault(); if (!locked) void composer.createPlan() }} aria-busy={Boolean(composer.busy)}>
      <div className="section-row"><h2>合成设置</h2><button type="button" className="text-button" disabled={locked} onClick={onSettings}>FFmpeg / 输出设置</button></div>
      <div className="batch-primary-fields"><div className="field"><label htmlFor={`${id}-name`}>批次名称</label><input id={`${id}-name`} data-testid="batch-name" value={composer.name} disabled={locked} aria-invalid={invalidName} onChange={event => composer.setName(event.target.value)} />
        <p className={`field-note ${invalidName ? 'error-text' : ''}`}>1–80 个字符，用于识别本次输出</p></div>
        <NumberField label="最短时长（分钟）" testId="batch-minimum-minutes" value={options.minimumSeconds} scale={60} min={1} max={360} disabled={locked} note="1–360 分钟；整首播放，允许超出" onChange={value => setOption('minimumSeconds', value)} />
      </div>
      <details className="batch-advanced"><summary>转场与画面参数 · {transitionLabels[options.transition]}{options.transition !== 'cut' && ` ${options.transitionSeconds} 秒`} · {options.fit === 'contain' ? '完整显示' : '居中裁切'}</summary>
        <div className="batch-parameter-grid">
          <div className="field"><label htmlFor={`${id}-transition`}>音乐连接</label><select id={`${id}-transition`} data-testid="batch-transition" value={options.transition} disabled={locked} onChange={event => setOption('transition', event.target.value as BatchOptions['transition'])}>
            {Object.entries(transitionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <NumberField label="转场时长（秒）" testId="batch-transition-seconds" value={options.transitionSeconds} min={0.5} max={10} disabled={locked || options.transition === 'cut'} note="0.5–10 秒，默认 3" onChange={value => setOption('transitionSeconds', value)} />
          <div className="field"><label htmlFor={`${id}-fit`}>画面适配</label><select id={`${id}-fit`} data-testid="batch-fit" disabled={locked} value={options.fit} onChange={event => setOption('fit', event.target.value as BatchOptions['fit'])}><option value="contain">完整显示（必要时留黑边）</option><option value="cover">居中裁切铺满</option></select><p className="field-note">保持比例，不拉伸</p></div>
          <NumberField label="整段开头淡入（秒）" testId="batch-fade-in" value={options.fadeInSeconds} min={0} max={10} disabled={locked} note="0–10 秒，0 为关闭" onChange={value => setOption('fadeInSeconds', value)} />
          <NumberField label="整段结尾淡出（秒）" testId="batch-fade-out" value={options.fadeOutSeconds} min={0} max={10} disabled={locked} note="0–10 秒，不为凑时长裁歌" onChange={value => setOption('fadeOutSeconds', value)} />
        </div>
        <p className="field-note">{options.transition === 'crossfade' ? '相邻曲目交叉淡化会产生重叠，规划按扣除重叠后的时长校验下限。' : options.transition === 'fade' ? '前曲淡出后再播放下一曲淡入；曲目不重叠、不补静音。' : '整首顺序连接，不做曲目间的音量渐变。'}</p>
        <label className="checkbox-label"><input type="checkbox" data-testid="batch-normalize" checked={options.normalize} disabled={locked} onChange={event => setOption('normalize', event.target.checked)} /><span>音量均衡 <span className="field-note">· 默认关闭；启用后分析完整曲目响度</span></span></label>
      </details>
      <p className="field-note">一图一视频，同批音乐不重复。每个视频最多 100 首、最长 6 小时；每批最多 100 个视频。输出为 1080p / 30fps MP4。</p>
      {!library.selection.audioIds.length || !library.selection.imageIds.length ? <p className="field-note">请先在素材库至少选择一首音乐和一张图片。</p> : library.selection.imageIds.length > 100 || library.selection.audioIds.length > 10000 ? <p className="field-note error-text">选择超出单批容量，请减少素材。</p> : null}
      <div className="batch-plan-actions"><button type="submit" className="button primary" data-testid="batch-plan-button" disabled={locked || !composer.valid || !library.snapshot}><ListChecks size={17} />{composer.busy === 'plan' ? '正在探测素材与分组…' : plan ? '重新自动分组' : '规划分组'}</button><p className="field-note">修改选择或任意参数后，需重新规划；不足时不会循环或付费补素材。</p></div>
    </form>
    {composer.error && <Banner tone="error">{composer.error}</Banner>}
    {composer.notice && <Banner tone="info">{composer.notice}</Banner>}
    {plan && <><BatchPlanPreview plan={plan} disabled={locked} revising={composer.busy === 'revise'} onRevise={groups => void composer.revise(groups)} onPreview={assetId => { const asset = library.assetsById.get(assetId); if (asset) onPreview(asset) }} />
      <div className="batch-start-row"><div><p>{composer.canStart ? '所有分组已通过校验' : '请先解决上方分组问题'}</p><p className="field-note">提交后保存固定快照，选曲与顺序不再随素材选择改变。</p></div><button type="button" className="button primary" data-testid="batch-start" disabled={locked || !composer.canStart} onClick={() => void composer.start()}><Clapperboard size={17} />{composer.busy === 'start' ? '正在提交…' : `一键合成 ${plan.groups.length} 个视频`}</button></div>
    </>}
    <BatchVideoJobs controller={queue} disabled={disabled} busy={busy} onPlay={onPlay} onExport={onExport} onReveal={onReveal} />
  </div>
}
