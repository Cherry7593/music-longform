import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, Play, Square } from 'lucide-react'
import { activeVideoStatuses } from '../../shared/schemas'
import { assetURL } from '../../shared/types'
import type { Project, VideoJob, VideoJobStatus } from '../../shared/types'
import { pauseOtherMedia } from '../media'
import { dateLabel } from '../utils'
import { transitionLabels } from './VideoParameters'

export function videoDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const ms = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const sec = Math.floor(ms / 1000) % 60
  const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, '0').replace(/0+$/, '')}` : ''
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(sec).padStart(2, '0')}${fraction}`
}

export function LocalAudio({ projectId, kind, assetId, label, autoPlay = false }: {
  projectId: string; kind: 'audio' | 'preview'; assetId: string; label: string; autoPlay?: boolean
}) {
  const player = useRef<HTMLAudioElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => { const element = player.current; return () => { element?.pause() } }, [])
  return <div className="local-audio">
    <audio ref={player} controls preload="metadata" autoPlay={autoPlay} aria-label={label} src={assetURL(projectId, kind, assetId)}
      onPlay={event => pauseOtherMedia(event.currentTarget)} onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} />
    {state === 'loading' && <p className="field-note" role="status">正在读取本地音频…</p>}
    {state === 'error' && <div className="media-error" role="alert"><span>无法读取本地音频，请检查原文件。</span>
      <button type="button" className="text-button" onClick={() => { setState('loading'); player.current?.load() }}>重新读取</button></div>}
  </div>
}

const labels: Record<VideoJobStatus, string> = {
  analyzing: '正在分析素材', processing: '正在处理音频', mixing: '正在混合音轨', encoding: '正在编码视频', validating: '正在校验文件',
  succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
}

export function VideoJobs({ project, kind, disabled, busy, onCancel, onPlay, onExport, onReveal }: {
  project: Project; kind: 'video' | 'preview'; disabled: boolean; busy: string[]
  onCancel: (job: VideoJob) => void; onPlay: (job: VideoJob) => void
  onExport: (job: VideoJob) => void; onReveal: (job: VideoJob) => void
}) {
  const jobs = project.videoJobs.filter(job => job.kind === kind).slice().reverse()
  return <section className="video-history" aria-label={kind === 'video' ? '视频导出历史' : '连接处试听历史'} data-testid={`${kind}-history`}>
    <div className="results-heading"><h3>{kind === 'video' ? '视频导出历史' : '连接处试听历史'}<span>{jobs.length}</span></h3></div>
    {!jobs.length && <p className="video-history-empty">{kind === 'video' ? '暂无导出记录' : '暂无试听片段'}</p>}
    <div className="video-job-list">{jobs.map(job => {
      const active = activeVideoStatuses.has(job.status)
      const percent = job.status === 'succeeded' ? 100 : job.progress !== undefined && Number.isFinite(job.progress) ? Math.max(0, Math.min(99, Math.floor(job.progress))) : undefined
      const snapshot = job.snapshot
      return <article className="video-job" key={job.id} data-job-id={job.id} data-status={job.status}>
        <div className="section-row"><h4>{kind === 'video' ? '视频导出' : `连接处 ${(job.boundaryIndex ?? 0) + 1} → ${(job.boundaryIndex ?? 0) + 2}`}
          <span className="muted"> · {dateLabel(job.createdAt, true)}</span></h4>
          <span className={`job-badge status-${job.status}`} role="status">{labels[job.status]}{percent !== undefined ? ` · ${percent}%` : ''}</span></div>
        {active && percent !== undefined && <progress max={100} value={percent} aria-label={`${labels[job.status]}进度`} />}
        {job.detail && <p className="field-note preserve-lines">{job.detail}</p>}
        {job.error && <p className="job-error" role="alert">{job.error}</p>}
        {job.status === 'interrupted' && <p className="field-note">任务已中断，不会自动重跑。检查当前配置后可重新导出或试听。</p>}
        {active && <div className="button-row wrap"><button type="button" className="button small" disabled={disabled || busy.includes(`cancel-video:${job.id}`)} onClick={() => onCancel(job)}>
          <Square size={13} />{busy.includes(`cancel-video:${job.id}`) ? '正在取消…' : '取消任务'}</button><span className="field-note">使用创建时的快照；修改草稿不影响此任务。</span></div>}
        {job.status === 'succeeded' && job.fileName && <>
          <p className="video-file">{job.fileName}{job.durationSeconds !== undefined && ` · ${videoDuration(job.durationSeconds)}`}</p>
          {kind === 'preview' && <LocalAudio projectId={project.id} kind="preview" assetId={job.id} label={`试听连接处 ${dateLabel(job.createdAt, true)}`} />}
          <div className="button-row wrap">
            {kind === 'video' && <button type="button" className="button small" disabled={disabled} onClick={() => onPlay(job)}><Play size={14} />播放成片</button>}
            <button type="button" className="button small" disabled={disabled || busy.includes(`reveal:${job.id}`)} onClick={() => onReveal(job)}><FolderOpen size={14} />打开文件位置</button>
            <button type="button" className="button small" disabled={disabled || busy.includes(`export:${job.id}`)} onClick={() => onExport(job)}><Download size={14} />{busy.includes(`export:${job.id}`) ? '保存中…' : '另存为'}</button>
          </div>
        </>}
        {job.status === 'succeeded' && !job.fileName && <p className="job-error">记录中没有可播放文件，请检查项目目录。</p>}
        <details className="job-details"><summary>本次任务快照</summary><dl>
          <div><dt>音乐顺序</dt><dd><ol className="snapshot-tracks">{snapshot.audioIds.map(id => <li key={id}>{project.audio.find(asset => asset.id === id)?.title || id}</li>)}</ol></dd></div>
          <div><dt>图片</dt><dd>{project.images.find(image => image.id === snapshot.imageId)?.fileName || snapshot.imageId || '未选择'}</dd></div>
          <div><dt>时长规则</dt><dd>{snapshot.durationMode === 'all' ? '全部播放一次' : `目标 ${videoDuration(snapshot.targetSeconds)}`}</dd></div>
          <div><dt>音乐连接</dt><dd>{transitionLabels[snapshot.transition]}{snapshot.transition !== 'cut' ? ` · ${snapshot.transitionSeconds} 秒` : ''}</dd></div>
          <div><dt>首尾淡化</dt><dd>{snapshot.fadeInSeconds} 秒 / {snapshot.fadeOutSeconds} 秒</dd></div>
          <div><dt>音量 / 画面</dt><dd>{snapshot.normalize ? '均衡开启' : '均衡关闭'} · {snapshot.fit === 'contain' ? '完整显示，黑边' : '居中裁切铺满'}</dd></div>
          <div><dt>任务 ID</dt><dd>{job.id}</dd></div>
        </dl></details>
      </article>
    })}</div>
  </section>
}
