import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowDown, ArrowUp, Check, Film, Headphones, Image as ImageIcon, ListMusic, Play, Trash2 } from 'lucide-react'
import { activeVideoStatuses, videoDraftSchema } from '../../shared/schemas'
import type { AssetKind, Project, VideoAnalysis, VideoDraft, VideoJob } from '../../shared/types'
import { calculateTimeline } from '../../shared/video-timeline'
import type { WorkspaceStore } from '../useWorkspace'
import { errorMessage, validationMessage } from '../utils'
import { pauseOtherMedia } from '../media'
import { Banner, EmptyState } from './Common'
import { LocalImage } from './ImageWorkspace'
import { LocalAudio, VideoJobs, videoDuration } from './VideoJobs'
import { VideoParameters } from './VideoParameters'

type Notice = { tone: 'error' | 'info' | 'success'; text: string }
type Checked = { projectId: string; revision: number; snapshot: string; media: string; result: VideoAnalysis }

// Ordered primitive fields make snapshot comparison independent of JSON object key order.
function snapshotKey(draft: VideoDraft): string {
  return JSON.stringify([draft.initialized, draft.audioIds, draft.imageId, draft.durationMode, draft.targetSeconds,
    draft.transition, draft.transitionSeconds, draft.fadeInSeconds, draft.fadeOutSeconds, draft.normalize, draft.fit])
}
function mediaKey(project: Project): string {
  return JSON.stringify([project.video.audioIds.map(id => {
    const asset = project.audio.find(item => item.id === id)
    return [id, asset?.fileName, asset?.durationMs]
  }), project.images.find(item => item.id === project.video.imageId)])
}

export function VideoWorkspace({ project, store, disabled, busy, onSettings, onPlay, onExport, onReveal }: {
  project: Project; store: WorkspaceStore; disabled: boolean; busy: string[]; onSettings: () => void
  onPlay: (job: VideoJob) => void; onExport: (kind: AssetKind, id: string) => void; onReveal: (kind: AssetKind, id: string) => void
}) {
  const id = useId()
  const draft = project.video
  const [checked, setChecked] = useState<Checked | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<'analyze' | 'video' | 'preview' | null>(null)
  const lock = useRef(false)
  const alive = useRef(false)
  const [listening, setListening] = useState<string | null>(null)
  const [boundary, setBoundary] = useState({ order: draft.audioIds.join(','), index: 0 })
  const revision = store.getVideoRevision()
  const snapshot = snapshotKey(draft)
  const media = mediaKey(project)
  const analysis = checked?.projectId === project.id && checked.revision === revision && checked.snapshot === snapshot && checked.media === media ? checked.result : null
  const validation = videoDraftSchema.safeParse(draft)
  const estimated = useMemo(() => {
    if (!videoDraftSchema.safeParse(draft).success) return { timeline: null, error: '' }
    try {
      return { timeline: calculateTimeline(draft, project.audio.map(asset => ({ id: asset.id, durationSeconds: asset.durationMs / 1000 }))), error: '' }
    } catch (error) { return { timeline: null, error: errorMessage(error) } }
  }, [draft, project.audio])
  const timeline = analysis?.timeline ?? estimated.timeline
  const selectedImage = project.images.find(image => image.id === draft.imageId)
  const audioMap = new Map(project.audio.map(asset => [asset.id, asset]))
  const kept = project.audio.filter(asset => asset.kept)
  const missingAudio = draft.audioIds.some(assetId => !audioMap.has(assetId))
  const active = project.videoJobs.some(job => activeVideoStatuses.has(job.status))
  const processing = Boolean(pending) || busy.includes('video-submit')
  const boundaryIndex = boundary.order === draft.audioIds.join(',') && boundary.index < draft.audioIds.length - 1 ? boundary.index : 0
  const canCheck = validation.success && Boolean(selectedImage) && draft.audioIds.length > 0 && !missingAudio
  const exportBlocked = !canCheck || !timeline || timeline.missingSeconds > 0 || timeline.issues.length > 0 || analysis?.tools.available === false

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; pauseOtherMedia() }
  }, [])
  useEffect(() => {
    // Read the live store, so StrictMode/remounts and late project events cannot initialize twice.
    const current = store.getSnapshot().project
    if (disabled || current?.id !== project.id || current.video.initialized) return
    store.edit('video', { ...current.video, initialized: true, imageId: current.selectedImageId,
      audioIds: current.audio.filter(asset => asset.kept).map(asset => asset.id) })
    // More than 100 kept assets deliberately remains invalid and visible; the user chooses what to remove.
  }, [store, project.id, disabled])

  function edit(next: VideoDraft): void {
    setChecked(null)
    setNotice(null)
    store.edit('video', next)
  }
  function useKept(): void {
    edit({ ...draft, audioIds: kept.map(asset => asset.id) })
    setNotice({ tone: 'info', text: kept.length > 100
      ? `已列出全部 ${kept.length} 首保留音乐，超过 100 首上限。请手动移除或取消勾选；未截断，不能保存或导出。`
      : `已按项目素材顺序使用 ${kept.length} 首保留音乐。此后保留状态变化不会自动重排。` })
  }
  function move(index: number, direction: -1 | 1): void {
    const next = index + direction
    if (next < 0 || next >= draft.audioIds.length) return
    const audioIds = [...draft.audioIds]
    ;[audioIds[index], audioIds[next]] = [audioIds[next], audioIds[index]]
    edit({ ...draft, audioIds })
  }
  function remove(assetId: string): void {
    if (listening === assetId) setListening(null)
    edit({ ...draft, audioIds: draft.audioIds.filter(item => item !== assetId) })
  }
  async function perform(kind: 'analyze' | 'video' | 'preview'): Promise<void> {
    if (lock.current || disabled) return
    lock.current = true; setPending(kind); setNotice(null)
    if (kind === 'analyze') setChecked(null)
    const projectId = project.id
    const requestedBoundary = boundaryIndex
    const requestedOrder = draft.audioIds.join(',')
    try {
      await store.flush()
      const current = store.getSnapshot().project
      if (!current || current.id !== projectId || !alive.current) throw new Error('项目或工作区已切换，请重新操作')
      if (kind === 'analyze') {
        const requestRevision = store.getVideoRevision()
        const requestSnapshot = snapshotKey(current.video)
        const requestMedia = mediaKey(current)
        const result = await window.canvas.analyzeVideo(projectId)
        const latest = store.getSnapshot().project
        if (!alive.current || latest?.id !== projectId) return
        if (requestRevision !== store.getVideoRevision() || snapshotKey(latest.video) !== requestSnapshot || mediaKey(latest) !== requestMedia || snapshotKey(result.draft) !== requestSnapshot) {
          setNotice({ tone: 'info', text: '检查期间草稿或素材已改变，旧结果未用于当前配置。请重新检查素材。' })
          return
        }
        setChecked({ projectId, revision: requestRevision, snapshot: requestSnapshot, media: requestMedia, result })
      } else {
        // run() preserves dirty renderer revisions while the backend creates a fixed job snapshot.
        await store.run('video-submit', (api, currentId) => {
          if (currentId !== projectId || !alive.current) throw new Error('项目或工作区已切换')
          if (kind === 'preview' && store.getSnapshot().project?.video.audioIds.join(',') !== requestedOrder) throw new Error('音乐顺序已改变，请重新选择连接处')
          return kind === 'video' ? api.startVideo(currentId) : api.previewTransition(currentId, requestedBoundary)
        }, true)
        if (alive.current) setNotice({ tone: 'info', text: '已提交' })
      }
    } catch (error) {
      if (alive.current) setNotice({ tone: 'error', text: errorMessage(error) })
    } finally { lock.current = false; if (alive.current) setPending(null) }
  }
  function cancel(job: VideoJob): void {
    setNotice(null)
    // Cancellation must stay possible even while a numeric draft is invalid; it does not consume the draft.
    void store.run(`cancel-video:${job.id}`, (api, projectId) => api.cancelVideo(projectId, job.id)).catch(error => {
      if (alive.current) setNotice({ tone: 'error', text: errorMessage(error) })
    })
  }

  return <section className="video-workspace" aria-labelledby={`${id}-heading`} data-testid="video-workspace">
    <header className="workspace-heading"><span className="workspace-icon"><Film size={20} /></span><h2 id={`${id}-heading`}>视频合成</h2><span className="provider-label">1920 × 1080 · 30fps · MP4</span></header>
    <div className="video-grid">
      <div className="video-materials">
        <div className="section-row video-section-heading"><h3><ListMusic size={17} />音乐编排 <span className="muted">{draft.audioIds.length} / 100</span></h3>
          <button type="button" className="button small" data-testid="video-use-kept" disabled={disabled} onClick={useKept}><Check size={14} />使用已保留音乐</button></div>
        <p className="field-note">每首最多一次。“使用已保留音乐”会替换当前列表。</p>
        {draft.audioIds.length > 100 && <Banner tone="error">已选 {draft.audioIds.length} 首，超过 100 首上限。所有选择均保留，请手动减少后再保存或导出。</Banner>}
        <details className="video-audio-picker"><summary>从本项目勾选音乐 · {project.audio.length} 首（已保留 {kept.length} 首）</summary>
          {!project.audio.length ? <p className="field-note">暂无音乐，请前往「素材生成」。</p>
            : <div className="video-audio-choices">{project.audio.map((asset, index) => <label className="video-audio-choice" key={asset.id}>
              <input type="checkbox" checked={draft.audioIds.includes(asset.id)} disabled={disabled} data-audio-id={asset.id}
                onChange={event => event.target.checked ? edit({ ...draft, audioIds: [...draft.audioIds, asset.id] }) : remove(asset.id)} />
              <span><strong>{asset.title || `音乐 ${index + 1}`}</strong><small>{videoDuration(asset.durationMs / 1000)} · {asset.kept ? '已保留' : '未保留，可选入'}</small></span>
            </label>)}</div>}
        </details>
        {!draft.audioIds.length ? <div className="video-order-empty"><EmptyState icon={<ListMusic size={28} strokeWidth={1.3} />} title="未选择音乐">勾选音乐，或使用已保留音乐。</EmptyState></div>
          : <ol className="video-track-list" aria-label="视频音乐顺序" data-testid="video-track-list">{draft.audioIds.map((assetId, index) => {
            const asset = audioMap.get(assetId)
            const track = timeline?.tracks.find(item => item.id === assetId)
            const omitted = track?.usedSeconds === 0
            const trimmed = track && track.usedSeconds > 0 && track.usedSeconds < track.durationSeconds - 0.001
            const title = asset?.title || (asset ? `音乐 ${index + 1}` : '素材已缺失')
            return <li className={`video-track ${omitted ? 'is-omitted' : ''}`} key={assetId} data-audio-id={assetId} data-used={omitted ? 'omitted' : trimmed ? 'trimmed' : 'full'}
              style={{ '--item-delay': `${Math.min(index, 3) * 24}ms` } as CSSProperties}>
              <div className="video-track-top"><span className="track-number">{String(index + 1).padStart(2, '0')}</span><div className="track-heading"><h4>{title}</h4>
                <p>{asset ? `${videoDuration(asset.durationMs / 1000)} · ${asset.kept ? '已保留' : '未保留'}` : assetId}</p>
                {track && <p className={omitted || trimmed ? 'track-usage' : ''}>{analysis ? '实际' : '预计'}使用 {videoDuration(track.usedSeconds)}{omitted ? ' · 超出目标，不使用' : trimmed ? ' · 末曲裁切' : ''}</p>}
              </div></div>
              <div className="video-track-actions"><button type="button" className={`button small ${listening === assetId ? 'selected' : ''}`} aria-pressed={listening === assetId} disabled={disabled || !asset}
                aria-label={`${listening === assetId ? '关闭试听' : '试听'} ${title}`} onClick={() => { pauseOtherMedia(); setListening(listening === assetId ? null : assetId) }}><Play size={13} />{listening === assetId ? '关闭试听' : '试听'}</button>
                <button type="button" className="icon-button" aria-label={`上移 ${title}`} title="上移" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
                <button type="button" className="icon-button" aria-label={`下移 ${title}`} title="下移" disabled={disabled || index === draft.audioIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
                <button type="button" className="icon-button" aria-label={`移除 ${title}`} title="从视频列表移除，不删除文件" disabled={disabled} onClick={() => remove(assetId)}><Trash2 size={16} /></button>
              </div>
              {listening === assetId && asset && <LocalAudio key={assetId} projectId={project.id} kind="audio" assetId={assetId} label={`视频素材试听：${title}`} autoPlay />}
            </li>
          })}</ol>}
        <div className="transition-preview">
          <div className="field"><label htmlFor={`${id}-boundary`}>选择相邻连接处</label><select id={`${id}-boundary`} data-testid="video-boundary" value={draft.audioIds.length > 1 ? boundaryIndex : ''} disabled={disabled || draft.audioIds.length < 2}
            onChange={event => setBoundary({ order: draft.audioIds.join(','), index: Number(event.target.value) })}>
            {draft.audioIds.length < 2 && <option value="">至少选择两首音乐</option>}
            {draft.audioIds.slice(0, -1).map((assetId, index) => <option value={index} key={assetId}>{index + 1} → {index + 2} · {audioMap.get(assetId)?.title || '音乐'} → {audioMap.get(draft.audioIds[index + 1])?.title || '音乐'}</option>)}
          </select></div>
          <button type="button" className="button" data-testid="video-preview-transition" disabled={disabled || processing || active || !validation.success || missingAudio || draft.audioIds.length < 2} onClick={() => void perform('preview')}><Headphones size={16} />{pending === 'preview' ? '提交试听…' : '试听连接处'}</button>
          <p className="field-note">时长不足也可试听；完整导出仍需补齐。试听与导出一次只运行一个。</p>
        </div>
      </div>
      <div className="video-output">
        <div className="field"><label htmlFor={`${id}-image`}>视频图片 · 全程显示同一张</label><select id={`${id}-image`} data-testid="video-image" value={draft.imageId ?? ''} disabled={disabled}
          onChange={event => edit({ ...draft, imageId: event.target.value || undefined })}>
          <option value="">{project.images.length ? '请选择本项目图片' : '暂无图片'}</option>
          {draft.imageId && !selectedImage && <option value={draft.imageId}>所选图片已缺失</option>}
          {project.images.map((image, index) => <option key={image.id} value={image.id}>图片 {index + 1}{project.selectedImageId === image.id ? ' · 项目主图' : ''} · {image.size} · {image.fileName}</option>)}
        </select></div>
        <div className={`video-frame fit-${draft.fit}`} data-testid="video-frame" aria-label={`16:9 画面预览，${draft.fit === 'contain' ? '完整显示，黑边' : '居中裁切铺满'}`}>
          {selectedImage ? <LocalImage key={selectedImage.id} projectId={project.id} image={selectedImage} /> : <div className="video-frame-empty"><ImageIcon size={28} strokeWidth={1.3} /><p>选择本项目的一张图片</p><span>横屏 16:9 · 不拉伸</span></div>}
        </div>
        <fieldset className="mode-field video-fit"><legend>画面适配</legend><div className="segmented">
          <button type="button" data-testid="video-fit-contain" aria-pressed={draft.fit === 'contain'} disabled={disabled} onClick={() => edit({ ...draft, fit: 'contain' })}>完整显示 · 黑边</button>
          <button type="button" data-testid="video-fit-cover" aria-pressed={draft.fit === 'cover'} disabled={disabled} onClick={() => edit({ ...draft, fit: 'cover' })}>居中裁切 · 铺满</button>
        </div></fieldset>
        <h3 className="video-section-heading">时长与音乐连接</h3>
        <VideoParameters draft={draft} disabled={disabled} onChange={edit} />
      </div>
    </div>
    <section className="video-summary" aria-label="视频时长统计" data-testid="video-timeline">
      <div className="section-row"><h3>{analysis ? '已检查本地素材' : '时长估算'}</h3><span className="field-note" data-testid="video-analysis-state">{pending === 'analyze' ? '正在用 FFprobe 检查…' : analysis ? '基于本次检查的真实文件时长' : checked ? '配置已改变 · 请重新检查' : '尚未检查 · 基于素材记录估算'}</span></div>
      <dl className="video-time-stats">
        {([['原始总长', timeline?.rawSeconds, 'raw'], ['重叠扣除', timeline?.overlapSeconds, 'overlap'], ['可用时长', timeline?.availableSeconds, 'available'],
          ['输出时长', timeline?.outputSeconds, 'output'], ['不足时长', timeline?.missingSeconds, 'deficit']] as const).map(([label, value, key]) => <div key={key} className={key === 'deficit' && (value ?? 0) > 0 ? 'has-deficit' : ''}>
          <dt>{label}</dt><dd data-testid={`video-time-${key}`}>{value === undefined ? '—' : videoDuration(value)}</dd></div>)}
      </dl>
      {!validation.success && <Banner tone="error">{validationMessage(validation.error)}。原始输入仍保留，请修正后保存。</Banner>}
      {estimated.error && !analysis && <Banner tone="error">{estimated.error}</Banner>}
      {missingAudio && <Banner tone="error">有音乐已不在本项目登记列表中，请从编排列表移除后重新选择。</Banner>}
      {!selectedImage && <p className="field-note">导出前需要选择本项目的一张图片。</p>}
      {timeline && timeline.missingSeconds > 0 && <Banner tone="warning">还差 {videoDuration(timeline.missingSeconds)}，当前不能按目标时长导出。请自行补充音乐，或改为「全部播放一次」。不会循环、用静音补足或自动付费生成。</Banner>}
      {timeline && timeline.issues.length > 0 && <Banner tone="error">{timeline.issues.map((issue, index) => <p key={index}>{issue}</p>)}</Banner>}
      {analysis && <Banner tone={!analysis.tools.available ? 'error' : analysis.timeline.issues.length || analysis.timeline.missingSeconds > 0 ? 'warning' : 'success'}>
        {analysis.tools.available ? `本地素材已检查${analysis.imageWidth && analysis.imageHeight ? `，图片 ${analysis.imageWidth} × ${analysis.imageHeight}` : ''}。${analysis.timeline.issues.length || analysis.timeline.missingSeconds > 0 ? '请先解决时长或素材问题。' : '素材就绪，导出仍将重新核对文件。'}` : analysis.tools.message}
      </Banner>}
      {notice && <Banner tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Banner>}
      <div className="video-export-actions"><div className="button-row wrap">
        <button type="button" className="button" data-testid="video-analyze" disabled={disabled || processing || active || !canCheck} onClick={() => void perform('analyze')}><Check size={16} />{pending === 'analyze' ? '正在检查素材…' : '检查素材'}</button>
        <button type="button" className="button primary" data-testid="video-export" disabled={disabled || processing || active || exportBlocked} onClick={() => void perform('video')}><Film size={16} />{pending === 'video' ? '提交导出…' : active ? '本地任务进行中' : '导出视频'}</button>
      </div><button type="button" className="text-button" onClick={onSettings} disabled={disabled}>视频工具设置</button></div>
      <p className="field-note">需要 FFmpeg 与 FFprobe，不自动安装；原始素材不变。</p>
    </section>
    <div className="video-histories">
      <VideoJobs project={project} kind="video" disabled={disabled} busy={busy} onCancel={cancel} onPlay={onPlay} onExport={job => onExport(job.kind, job.id)} onReveal={job => onReveal(job.kind, job.id)} />
      <VideoJobs project={project} kind="preview" disabled={disabled} busy={busy} onCancel={cancel} onPlay={onPlay} onExport={job => onExport(job.kind, job.id)} onReveal={job => onReveal(job.kind, job.id)} />
    </div>
  </section>
}
