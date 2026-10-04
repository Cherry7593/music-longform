import { useId, useState } from 'react'
import { ArrowRight, Check, Download, Image as ImageIcon, ImageOff, Maximize2 } from 'lucide-react'
import { imageDraftSchema } from '../../shared/schemas'
import { assetURL } from '../../shared/types'
import type { ImageAsset, ImageDraft, ImageJob, Project } from '../../shared/types'
import { dateLabel, imageMetadata, imageProviderLabel, imageQualityLabel, validationMessage } from '../utils'
import { Banner, EmptyState, JobBadge } from './Common'
import { Dialog } from './Dialog'
import { ImageParameters } from './Parameters'

export function LocalImage({ projectId, image, thumbnail = false, onZoom }: { projectId: string; image: ImageAsset; thumbnail?: boolean; onZoom?: () => void }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const picture = <img key={attempt} src={assetURL(projectId, 'image', image.id)} alt={thumbnail ? '' : `生成图片 · ${image.fileName}`}
    onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} />
  return <div className={`local-image ${thumbnail ? 'is-thumbnail' : ''}`}>
    {status !== 'error' && (onZoom ? <button type="button" className="image-preview-button" aria-label="放大当前图片" onClick={onZoom}>
      {picture}<span className="zoom-affordance"><Maximize2 size={15} />放大</span></button> : picture)}
    {status === 'loading' && <span className="image-loading" role="status">{thumbnail ? '读取中' : '正在读取本地图片…'}</span>}
    {status === 'error' && <span className="image-load-error"><ImageOff size={thumbnail ? 20 : 28} /><span>{thumbnail ? '读取失败' : '无法读取本地图片，请检查素材文件。'}</span>
      {!thumbnail && <button type="button" className="image-retry" onClick={() => { setStatus('loading'); setAttempt(value => value + 1) }}>重新读取</button>}
    </span>}
  </div>
}

function ImageJobRow({ job }: { job: ImageJob }) {
  return <div className="job-row"><div className="section-row"><span className="job-title">{job.provider === 'openai' ? 'OpenAI 历史任务' : '图片任务'}<span className="muted"> · {dateLabel(job.createdAt, true)}</span></span><JobBadge status={job.status} /></div>
    {job.error && <p className="job-error">{job.error}</p>}
    {job.status === 'unknown' && <p className="charge-warning">可能已受理并扣费，请先核对{job.provider === 'openai' ? ' OpenAI ' : '硅基流动'}后台。不会自动重发{job.provider === 'openai' ? '；历史请求不能恢复或转交硅基流动。' : '，请勿直接重复生成。'}</p>}
    {job.status === 'failed' && <p className="field-note">{job.provider === 'openai' ? 'OpenAI 历史请求不能恢复；上方生成会创建新的硅基流动付费请求。' : '请先检查错误；重新生成须再次确认费用，不会自动重发。'}</p>}
    <details className="job-details"><summary>任务详情</summary><dl><div><dt>来源</dt><dd>{imageProviderLabel(job.provider)}</dd></div>
      <div><dt>模型</dt><dd>{job.snapshot.model}</dd></div><div><dt>尺寸</dt><dd>{job.snapshot.size.replace('x', ' × ')}</dd></div>
      {job.provider === 'openai' && <div><dt>质量 / 格式</dt><dd>{imageQualityLabel(job.snapshot.quality)} · {job.snapshot.format.toUpperCase()}</dd></div>}
      <div><dt>提示词快照</dt><dd className="preserve-lines">{job.snapshot.prompt}</dd></div></dl></details>
  </div>
}

export function ImageWorkspace({ project, disabled, hasKey, busy, onChange, onGenerate, onSettings, onSelect, onZoom, onExport }: {
  project: Project; disabled: boolean; hasKey: boolean; busy: string[]
  onChange: (draft: ImageDraft) => void; onGenerate: () => void; onSettings: () => void
  onSelect: (id: string) => void; onZoom: (asset: ImageAsset) => void; onExport: (id: string) => void
}) {
  const id = useId()
  const draft = project.image
  const validation = imageDraftSchema.safeParse(draft)
  const images = [...project.images].reverse()
  const latestId = images[0]?.id
  const [selection, setSelection] = useState({ latest: latestId, id: project.selectedImageId ?? latestId })
  const previewId = selection.latest === latestId ? selection.id : latestId
  const preview = images.find(image => image.id === previewId) ?? images[0]
  const jobs = [...project.imageJobs].reverse()
  const shown = new Set([...jobs.slice(0, 1), ...jobs.filter(job => job.status === 'unknown' || job.status === 'submitting' || job.status === 'downloading')].map(job => job.id))
  const history = jobs.filter(job => !shown.has(job.id))
  const active = jobs.some(job => job.status === 'submitting' || job.status === 'downloading')
  return <section className="workspace image-workspace" aria-labelledby={`${id}-heading`}>
    <header className="workspace-heading"><span className="workspace-icon"><ImageIcon size={20} /></span><h2 id={`${id}-heading`}>图片</h2><span className="provider-label">硅基流动</span></header>
    <div className="creation-form">
      <div className="field prompt-field"><label htmlFor={`${id}-prompt`}>画面描述</label>
        <textarea id={`${id}-prompt`} value={draft.prompt} disabled={disabled} spellCheck={false} rows={4}
          placeholder="例：午后窗边木桌，暖阳，柔和胶片质感"
          aria-describedby={`${id}-prompt-note`} aria-invalid={draft.prompt.length > 32000} onChange={event => onChange({ ...draft, prompt: event.target.value })} />
        <div className="prompt-caption" id={`${id}-prompt-note`}><span className={draft.prompt.length > 32000 ? 'error-text' : ''}>{draft.prompt.length} / 32000</span></div>
      </div>
      <ImageParameters value={draft} onChange={onChange} disabled={disabled} />
      {!validation.success && <p className="field-error" role="alert">{validationMessage(validation.error)}。原始输入已保留。</p>}
      <div className="generate-row"><button type="button" className="button primary generate-button" disabled={disabled || active || busy.includes('image-submit') || !validation.success || !draft.prompt.trim() || !hasKey} onClick={onGenerate}>
        <ImageIcon size={16} />{busy.includes('image-submit') ? '准备提交…' : active ? '图片生成中' : '生成图片'}<ArrowRight size={16} /></button><span className="field-note">提交前确认费用 · 每次 1 张</span></div>
      {!hasKey && <p className="setup-hint">请配置硅基流动密钥。<button type="button" className="text-button" onClick={onSettings}>前往设置</button></p>}
    </div>
    {jobs.length > 0 && <div className="task-log" aria-label="图片任务记录">
      {jobs.filter(job => shown.has(job.id)).map(job => <ImageJobRow key={job.id} job={job} />)}
      {history.length > 0 && <details className="task-history"><summary>更多图片任务记录 · {history.length} 条</summary>{history.map(job => <ImageJobRow key={job.id} job={job} />)}</details>}
    </div>}
    <div className="results-heading"><h3>图片素材 <span>{images.length}</span></h3></div>
    {!preview ? <div className="image-empty"><EmptyState icon={<ImageIcon size={30} strokeWidth={1.3} />} title="暂无图片" /></div> : <>
      <div className="image-preview"><LocalImage key={preview.id} projectId={project.id} image={preview} onZoom={() => onZoom(preview)} /></div>
      <div className="image-toolbar"><div className="image-metadata">{imageMetadata(preview)}</div>
        <div className="button-row wrap"><button type="button" className={`button small ${project.selectedImageId === preview.id ? 'selected' : ''}`} disabled={disabled || project.selectedImageId === preview.id || busy.includes('select-image')} onClick={() => onSelect(preview.id)}>
          <Check size={14} />{project.selectedImageId === preview.id ? '项目主图' : '设为项目主图'}</button><button type="button" className="button small" disabled={disabled || busy.includes(`export:${preview.id}`)} onClick={() => onExport(preview.id)}><Download size={14} />另存为</button></div></div>
      <details className="asset-details image-asset-details"><summary>当前图片信息</summary><p>{imageProviderLabel(preview.provider)} · {preview.model}</p><p className="preserve-lines">{preview.prompt}</p><p>{dateLabel(preview.createdAt, true)} · {preview.fileName}</p></details>
      {images.length > 1 && <div className="thumbnail-list" aria-label="历史图片">{images.map((image, index) => <button type="button" className={`thumbnail ${image.id === preview.id ? 'selected' : ''}`} key={image.id}
        aria-label={`预览图片 ${index + 1}${image.id === project.selectedImageId ? '，项目主图' : ''}`} aria-pressed={image.id === preview.id}
        onClick={() => setSelection({ latest: latestId, id: image.id })}><LocalImage projectId={project.id} image={image} thumbnail />
        {image.id === project.selectedImageId && <span className="thumbnail-main"><Check size={11} />主图</span>}</button>)}</div>}
    </>}
  </section>
}

export function ImageZoomDialog({ projectId, image, onClose, onExport, exporting, returnFocus, notice }: {
  projectId: string; image: ImageAsset; onClose: () => void; onExport: () => void; exporting: boolean; returnFocus: HTMLElement | null
  notice: { tone: 'error' | 'success' | 'info'; text: string } | null
}) {
  const [zoom, setZoom] = useState(100)
  const id = useId()
  return <Dialog title="图片预览" description={`${imageMetadata(image)} · ${imageProviderLabel(image.provider)} · ${image.model}`} className="zoom-dialog" onClose={onClose} returnFocus={returnFocus}>
    <div className="zoom-viewport"><div className="zoom-stage" style={{ width: `${zoom}%`, height: `${zoom}%` }}><LocalImage projectId={projectId} image={image} /></div></div>
    <div className="zoom-controls"><label htmlFor={`${id}-zoom`}>缩放</label><input id={`${id}-zoom`} aria-label="图片缩放比例" type="range" min={50} max={200} step={10} value={zoom} onChange={event => setZoom(Number(event.target.value))} /><output htmlFor={`${id}-zoom`}>{zoom}%</output><button type="button" className="text-button" onClick={() => setZoom(100)}>适合窗口</button></div>
    {notice && <div className="zoom-notice"><Banner tone={notice.tone}>{notice.text}</Banner></div>}
    <footer className="dialog-footer"><button type="button" className="button" onClick={onClose}>关闭预览</button><button type="button" className="button primary" disabled={exporting} onClick={onExport}><Download size={16} />{exporting ? '保存中…' : '另存为图片'}</button></footer>
  </Dialog>
}
