import { useState } from 'react'
import { Download, FolderOpen, Pause, Play, RefreshCw, Square } from 'lucide-react'
import { activeVideoStatuses } from '../../shared/schemas'
import type { BatchJobStatus, BatchVideoJob, VideoBatch } from '../../shared/library-types'
import type { VideoBatchesController } from '../hooks/useVideoBatches'
import { dateLabel } from '../utils'
import { Banner } from './Common'
import { videoDuration } from './VideoJobs'
import { transitionLabels } from './VideoParameters'

const stateLabels: Record<VideoBatch['state'], string> = { running: '运行中', pausing: '完成当前后暂停', paused: '已暂停 · 待继续', completed: '已完成', cancelled: '已取消' }
const jobLabels: Record<BatchJobStatus, string> = { pending: '等待开始', analyzing: '正在分析素材', processing: '正在处理音频', mixing: '正在混合音轨', encoding: '正在编码视频', validating: '正在校验文件', succeeded: '已完成', failed: '失败', interrupted: '已中断 · 待重试', cancelled: '已取消' }

export function BatchVideoJobs({ controller, disabled, busy, onPlay, onExport, onReveal }: {
  controller: VideoBatchesController; disabled: boolean; busy: string[]
  onPlay: (batch: VideoBatch, job: BatchVideoJob) => void; onExport: (batch: VideoBatch, job: BatchVideoJob) => void
  onReveal: (batch: VideoBatch, job?: BatchVideoJob) => void
}) {
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const [shown, setShown] = useState(10)
  return <section className="batch-queue" aria-label="批量队列与历史" data-testid="batch-history">
    <div className="section-row"><h2>队列与历史</h2><button type="button" className="button small" disabled={disabled || controller.loading} onClick={() => void controller.refresh()}><RefreshCw size={16} />{controller.loading ? '读取中…' : '刷新队列'}</button></div>
    <p className="field-note">串行合成；只重试未成功任务，成功成片不会重跑。已提交批次使用固定快照。</p>
    {controller.error && <Banner tone="error">{controller.error}</Banner>}
    {!controller.batches.length && <p className="library-empty" role="status">{controller.loading ? '正在读取批次…' : '暂无批次。先规划分组，校验通过后即可提交。'}</p>}
    <div className="batch-history-list">{controller.batches.slice(0, shown).map(batch => {
      const complete = batch.jobs.filter(job => job.status === 'succeeded').length
      const active = batch.jobs.find(job => activeVideoStatuses.has(job.status))
      const assets = new Map(batch.plan.assets.map(asset => [asset.id, asset]))
      const waiting = batch.state === 'paused' || batch.state === 'cancelled'
      const locked = disabled || controller.busy.includes(batch.id)
      const percent = active?.progress !== undefined && Number.isFinite(active.progress) ? Math.max(0, Math.min(100, active.progress)) : undefined
      return <article className="batch-record" key={batch.id} data-batch-id={batch.id} data-state={batch.state}>
        <div className="section-row"><h3>{batch.name}</h3><span className={`job-badge status-${batch.state === 'completed' ? 'succeeded' : batch.state}`} role="status">{stateLabels[batch.state]}</span></div>
        <p className="field-note"><time dateTime={batch.createdAt}>{dateLabel(batch.createdAt, true)}</time> · 最短 {videoDuration(batch.plan.request.minimumSeconds)} · {transitionLabels[batch.plan.request.transition]}</p>
        <p className="batch-completed" role="status">已完成 {complete} / {batch.jobs.length} 个视频{active && ` · 当前视频 ${active.index + 1}：${jobLabels[active.status]}`}</p>
        {active && <div className="batch-active-progress">{percent !== undefined ? <><progress max={100} value={percent} aria-label={`视频 ${active.index + 1} 实际进度`} /><span className="field-note">{percent.toFixed(1)}%</span></> : <p className="field-note">等待引擎报告进度</p>}
          {active.detail && <p className="field-note preserve-lines">{active.detail}</p>}</div>}
        {batch.message && <p className="batch-message preserve-lines">{batch.message}</p>}
        <div className="button-row batch-control-row">
          {batch.state === 'running' && <button type="button" className="button small" disabled={locked} onClick={() => void controller.control(batch, 'pause')}><Pause size={15} />完成当前后暂停</button>}
          {batch.state === 'pausing' && <button type="button" className="button small" disabled><Pause size={15} />等待当前视频完成</button>}
          {waiting && complete < batch.jobs.length && <button type="button" className="button small primary" disabled={locked} onClick={() => void controller.control(batch, 'continue')}><Play size={15} />{controller.busy.includes(batch.id) ? '处理请求中…' : batch.jobs.some(job => ['failed', 'interrupted', 'cancelled'].includes(job.status)) ? '继续 / 重试未成功项' : '继续合成'}</button>}
          {batch.state !== 'completed' && batch.state !== 'cancelled' && <button type="button" className="button small danger" disabled={locked} onClick={() => setConfirmCancel(batch.id)}><Square size={14} />取消整批</button>}
          <button type="button" className="button small" disabled={disabled || busy.includes(`batch-reveal:${batch.id}`)} onClick={() => onReveal(batch)}><FolderOpen size={16} />打开批次目录</button>
        </div>
        {confirmCancel === batch.id && batch.state !== 'cancelled' && batch.state !== 'completed' && <div className="batch-cancel-confirm" role="group" aria-label="确认取消整批"><p>停止当前及剩余任务？已成功成片会保留，之后可重试未成功项。</p><div className="button-row"><button type="button" className="button small" disabled={locked} onClick={() => setConfirmCancel(null)}>保留队列</button><button type="button" className="button small danger" disabled={locked} onClick={() => { setConfirmCancel(null); void controller.control(batch, 'cancel') }}>确认取消整批</button></div></div>}
        <details className="batch-output-details" open={batch.state !== 'completed'}><summary>视频列表与结果 · {batch.jobs.length} 个</summary>
          <div className="batch-output-list">{batch.jobs.map(job => <article key={job.id} className="batch-output" data-job-id={job.id} data-status={job.status}>
            <div className="section-row"><h4>视频 {job.index + 1} · {assets.get(job.group.imageId)?.name ?? job.group.imageId}</h4><span className={`job-badge status-${job.status}`}>{jobLabels[job.status]}</span></div>
            <p className="field-note">{job.group.audioIds.length} 首音乐 · {job.status === 'succeeded' && job.durationSeconds !== undefined ? `成片 ${videoDuration(job.durationSeconds)}` : `规划 ${videoDuration(job.group.durationSeconds)}`}{job.finishedAt && ` · ${dateLabel(job.finishedAt, true)}`}</p>
            {job.error && <p className="job-error" role="alert">{job.error}</p>}
            {job.status === 'succeeded' && job.fileName && <div className="button-row">
              <button type="button" className="button small" disabled={disabled} onClick={() => onPlay(batch, job)}><Play size={15} />播放成片</button>
              <button type="button" className="button small" disabled={disabled || busy.includes(`batch-export:${job.id}`)} onClick={() => onExport(batch, job)}><Download size={15} />{busy.includes(`batch-export:${job.id}`) ? '保存中…' : '另存为'}</button>
              <button type="button" className="button small" disabled={disabled || busy.includes(`batch-reveal:${job.id}`)} onClick={() => onReveal(batch, job)}><FolderOpen size={15} />打开文件位置</button>
            </div>}
            <details className="batch-snapshot"><summary>查看实际选曲快照</summary><ol>{job.group.audioIds.map(id => <li key={id}>{assets.get(id)?.name ?? id}</li>)}</ol></details>
          </article>)}</div>
        </details>
        <details className="batch-snapshot"><summary>批次参数与保存位置</summary><p>画面：{batch.plan.request.fit === 'contain' ? '完整显示' : '居中裁切'} · 1920 × 1080 · 30fps · H.264 / AAC MP4</p><p>转场 {batch.plan.request.transitionSeconds} 秒 · 首尾淡化 {batch.plan.request.fadeInSeconds} / {batch.plan.request.fadeOutSeconds} 秒 · 音量均衡{batch.plan.request.normalize ? '开启' : '关闭'}</p><p>{batch.directory}</p></details>
      </article>
    })}</div>
    {controller.batches.length > shown && <button type="button" className="button" onClick={() => setShown(value => value + 10)}>再显示 10 个批次（剩余 {controller.batches.length - shown} 个）</button>}
  </section>
}
