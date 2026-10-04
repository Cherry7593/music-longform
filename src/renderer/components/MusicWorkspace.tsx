import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowRight, Bookmark, Check, Download, Music2, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { activeMusicStatuses, musicDraftSchema } from '../../shared/schemas'
import { assetURL } from '../../shared/types'
import type { AudioAsset, MusicDraft, MusicJob, Project } from '../../shared/types'
import { dateLabel, duration, modelLabel, validationMessage } from '../utils'
import { pauseOtherMedia } from '../media'
import { Banner, EmptyState, JobBadge } from './Common'
import { MusicParameters } from './Parameters'

interface MusicWorkspaceProps {
  project: Project
  disabled: boolean
  hasKey: boolean
  busy: string[]
  onChange: (draft: MusicDraft) => void
  onGenerate: () => void
  onSettings: () => void
  onStop: (batchId: string) => void
  onContinue: (batchId: string) => void
  onRecover: (jobId: string) => void
  onKeep: (asset: AudioAsset) => void
  onExport: (assetId: string) => void
}

function MusicJobRow({ job, recovering, disabled, onRecover }: {
  job: MusicJob; recovering: boolean; disabled: boolean; onRecover: (id: string) => void
}) {
  const canRecover = Boolean(job.taskId && job.recoverable && job.status !== 'succeeded' && !activeMusicStatuses.has(job.status))
  return <div className="job-row">
    <div className="section-row"><span className="job-title">音乐任务 {job.index}<span className="muted"> · {dateLabel(job.createdAt, true)}</span></span><JobBadge status={job.status} /></div>
    {job.error && <p className="job-error">{job.error}</p>}
    {job.status === 'unknown' && <p className="charge-warning">请求可能已被服务商受理并扣费。请先核对服务商后台，不要直接重复生成。{!job.taskId && '未取得任务 ID，无法安全恢复查询。'}</p>}
    {canRecover && <div className="recovery-action"><button type="button" className="text-button" disabled={disabled || recovering} onClick={() => onRecover(job.id)}>
      <RotateCcw size={14} />{recovering ? '恢复中…' : '恢复查询 / 下载'}</button><span>仅查询原任务，不新建付费任务</span></div>}
    <details className="job-details"><summary>任务详情</summary><dl>
      <div><dt>模型</dt><dd>{modelLabel(job.actualModel ?? job.snapshot.model)}</dd></div>
      <div><dt>模式</dt><dd>{job.snapshot.mode === 'instrumental' ? '纯音乐' : '人声歌曲'}</dd></div>
      {job.taskId && <div><dt>服务商任务 ID</dt><dd>{job.taskId}</dd></div>}
      <div><dt>提示词快照</dt><dd className="preserve-lines">{job.snapshot.prompt || '（空）'}</dd></div>
    </dl></details>
  </div>
}

function AudioRow({ projectId, asset, index, disabled, keeping, exporting, onKeep, onExport }: {
  projectId: string; asset: AudioAsset; index: number; disabled: boolean; keeping: boolean; exporting: boolean
  onKeep: () => void; onExport: () => void
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  useEffect(() => { const player = audio.current; return () => { player?.pause() } }, [])
  return <article className={`audio-row ${playing ? 'is-playing' : ''}`} style={{ '--item-delay': `${Math.min(index, 3) * 24}ms` } as CSSProperties}>
    <div className="audio-row-top"><span className="track-number">{String(index + 1).padStart(2, '0')}</span>
      <div className="track-heading"><h4>{asset.title || `音乐 ${index + 1}`}</h4><p>{asset.mode === 'instrumental' ? '纯音乐' : '人声歌曲'} · {asset.model} · {duration(asset.durationMs)}</p></div>
      <button type="button" className={`icon-button keep-button ${asset.kept ? 'selected' : ''}`} aria-pressed={asset.kept}
        aria-label={`${asset.kept ? '取消保留' : '保留'} ${asset.title}`} title={asset.kept ? '取消保留' : '保留这首音乐'} disabled={disabled || keeping} onClick={onKeep}>
        <Bookmark size={18} fill={asset.kept ? 'currentColor' : 'none'} /></button>
      <button type="button" className="icon-button" aria-label={`另存为 ${asset.title}`} title="另存为音频" disabled={disabled || exporting} onClick={onExport}><Download size={17} /></button>
    </div>
    <audio ref={audio} controls preload="metadata" src={assetURL(projectId, 'audio', asset.id)} aria-label={`播放与进度：${asset.title}`} onError={() => setFailed(true)}
      onLoadedMetadata={() => setFailed(false)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onPlay={event => {
        pauseOtherMedia(event.currentTarget)
        setPlaying(true)
      }} />
    {failed && <div className="media-error" role="alert"><span>无法读取本地音频，请检查素材目录中的文件。</span>
      <button type="button" className="text-button" onClick={() => { setFailed(false); audio.current?.load() }}>重新读取</button></div>}
    <details className="asset-details"><summary>素材信息{asset.kept ? ' · 已保留' : ''}</summary><p className="preserve-lines">{asset.prompt}</p><p>{dateLabel(asset.createdAt, true)} · {asset.fileName}</p><p>任务 ID：{asset.taskId}</p></details>
  </article>
}

export function MusicWorkspace({ project, disabled, hasKey, busy, onChange, onGenerate, onSettings, onStop, onContinue, onRecover, onKeep, onExport }: MusicWorkspaceProps) {
  const id = useId()
  const draft = project.music
  const validation = musicDraftSchema.safeParse(draft)
  const maxLength = draft.mode === 'instrumental' ? 1024 : 2000
  const unfinished = project.batches.filter(batch => batch.state !== 'completed').slice().reverse()
  const active = project.musicJobs.some(job => activeMusicStatuses.has(job.status))
  const hasPendingBatch = unfinished.some(batch => project.musicJobs.some(job => job.batchId === batch.id && job.status === 'pending'))
  const blocked = active || hasPendingBatch || unfinished.some(batch => batch.state === 'running' || batch.state === 'stopping')
  const jobs = [...project.musicJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.index - a.index)
  const prominent = new Set([...jobs.slice(0, 2), ...jobs.filter(job => job.status === 'failed').slice(0, 1), ...jobs.filter(job => activeMusicStatuses.has(job.status) || job.recoverable || job.status === 'unknown')].map(job => job.id))
  const history = jobs.filter(job => !prominent.has(job.id))
  const kept = project.audio.filter(asset => asset.kept)
  const audio = [...project.audio].reverse()
  return <section className="workspace music-workspace" aria-labelledby={`${id}-heading`}>
    <header className="workspace-heading"><span className="workspace-icon"><Music2 size={20} /></span><h2 id={`${id}-heading`}>音乐</h2><span className="provider-label">Mureka</span></header>
    <div className="creation-form">
      <div className="field prompt-field"><label htmlFor={`${id}-prompt`}>音乐描述</label>
        <textarea id={`${id}-prompt`} value={draft.prompt} disabled={disabled} spellCheck={false} rows={4}
          placeholder="例：温暖原声吉他，轻柔钢琴，适合阅读"
          aria-describedby={`${id}-prompt-note`} aria-invalid={draft.prompt.length > maxLength}
          onChange={event => onChange({ ...draft, prompt: event.target.value })} />
        <div className="prompt-caption" id={`${id}-prompt-note`}><span className={draft.prompt.length > maxLength ? 'error-text' : ''}>{draft.prompt.length} / {maxLength}</span></div>
      </div>
      <MusicParameters value={draft} onChange={onChange} disabled={disabled} />
      {!validation.success && <p className="field-error" role="alert">{validationMessage(validation.error)}。原始输入已保留，请调整后保存。</p>}
      <div className="generate-row"><button type="button" className="button primary generate-button" disabled={disabled || busy.includes('music-submit') || blocked || !validation.success || !draft.prompt.trim() || !hasKey} onClick={onGenerate}>
        <Music2 size={16} />{busy.includes('music-submit') ? '准备提交…' : '生成音乐'}<ArrowRight size={16} /></button><span className="field-note">{blocked ? '先处理当前批次' : '提交前确认费用 · 每次 1 首'}</span></div>
      {!hasKey && <p className="setup-hint">尚未配置 Mureka 密钥。<button type="button" className="text-button" onClick={onSettings}>前往设置</button></p>}
    </div>
    {unfinished.length > 0 && <div className="batch-list" aria-label="音乐生成批次">
      {unfinished.map(batch => {
        const items = project.musicJobs.filter(job => job.batchId === batch.id)
        const pending = items.filter(job => job.status === 'pending').length
        const succeeded = items.filter(job => job.status === 'succeeded').length
        return <div className="batch-panel" key={batch.id}>
          <div className="section-row"><strong>{batch.state === 'paused' ? <Pause size={15} /> : <Music2 size={15} />}{batch.state === 'paused' ? '批次已暂停' : batch.state === 'stopping' ? '后续任务已停止' : '批次进行中'}</strong>
            <span className="muted">已完成 {succeeded} / {batch.total} 首</span></div>
          <p>{pending} 首尚未提交。{batch.message || (batch.state === 'paused' ? '请确认后继续剩余队列。' : '已提交的任务由服务商处理。')}</p>
          <div className="button-row wrap">{batch.state === 'paused' && pending > 0 && <button type="button" className="button small" disabled={disabled || active || !hasKey || busy.includes('music-submit')} onClick={() => onContinue(batch.id)}><Play size={14} />继续剩余 {pending} 首</button>}
            <button type="button" className="button small subtle" disabled={disabled || (pending === 0 && batch.state !== 'paused') || batch.state === 'stopping' || busy.includes(`stop:${batch.id}`)} onClick={() => onStop(batch.id)}><Square size={13} />{busy.includes(`stop:${batch.id}`) ? '停止中…' : pending === 0 && batch.state === 'paused' ? '结束此批次' : '停止后续任务'}</button></div>
          <p className="batch-caution">{batch.state === 'paused' ? '继续只提交等待任务，跳过失败 / 未知任务，不会重试它们。' : '只停止未提交任务；当前任务仍可能完成并计费。'}</p>
        </div>
      })}
    </div>}
    {jobs.length > 0 && <div className="task-log" aria-label="音乐任务记录">
      {jobs.filter(job => prominent.has(job.id)).map(job => <MusicJobRow key={job.id} job={job} onRecover={onRecover} disabled={disabled || active} recovering={busy.includes(`recover:${job.id}`)} />)}
      {history.length > 0 && <details className="task-history"><summary>更多音乐任务记录 · {history.length} 条</summary>{history.map(job => <MusicJobRow key={job.id} job={job} onRecover={onRecover} disabled={disabled || active} recovering={busy.includes(`recover:${job.id}`)} />)}</details>}
    </div>}
    <div className="results-heading"><h3>音乐素材 <span>{project.audio.length}</span></h3><span className="kept-total"><Check size={14} />已保留 {kept.length} 首 · {duration(kept.reduce((sum, asset) => sum + asset.durationMs, 0))}</span></div>
    {audio.length === 0 ? <EmptyState icon={<Music2 size={30} strokeWidth={1.3} />} title="暂无音乐" />
      : <div className="audio-list">{audio.map((asset, index) => <AudioRow key={asset.id} projectId={project.id} asset={asset} index={index} disabled={disabled}
        keeping={busy.includes(`keep:${asset.id}`)} exporting={busy.includes(`export:${asset.id}`)} onKeep={() => onKeep(asset)} onExport={() => onExport(asset.id)} />)}</div>}
    {jobs.some(job => job.status === 'failed' && !job.taskId) && <Banner tone="info">没有任务 ID 的失败请求不能恢复查询。如需重新生成，请检查错误并在上方重新确认；这会创建新的付费请求。</Banner>}
  </section>
}
