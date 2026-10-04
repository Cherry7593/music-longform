import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, ImageOff } from 'lucide-react'
import { batchVideoURL, libraryAssetURL } from '../../shared/library-types'
import type { BatchVideoJob, LibraryAsset, VideoBatch } from '../../shared/library-types'
import { pauseOtherMedia } from '../media'
import { Dialog } from './Dialog'
import { Banner } from './Common'
import { videoDuration } from './VideoJobs'

export function LibraryThumbnail({ id, name, available = true }: { id: string; name: string; available?: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  return <span className="library-thumbnail">
    {available && state !== 'error' && <img src={libraryAssetURL(id)} alt={name} loading="lazy" onLoad={() => setState('ready')} onError={() => setState('error')} />}
    {!available || state === 'error' ? <span className="thumbnail-message"><ImageOff size={22} /><span>{available ? '预览读取失败' : '图片不可用'}</span></span>
      : state === 'loading' && <span className="thumbnail-message">读取图片…</span>}
  </span>
}

export type ManagedPreview = { kind: 'asset'; asset: LibraryAsset } | { kind: 'batch'; batch: VideoBatch; job: BatchVideoJob }
export function LibraryMediaDialog({ preview, onClose, returnFocus, onExport, onReveal, exporting, revealing, notice }: {
  preview: ManagedPreview; onClose: () => void; returnFocus: HTMLElement | null
  onExport: () => void; onReveal: () => void; exporting: boolean; revealing: boolean
  notice: { tone: 'error' | 'success' | 'info'; text: string } | null
}) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const image = preview.kind === 'asset' && preview.asset.kind === 'image'
  const audio = preview.kind === 'asset' && preview.asset.kind === 'audio'
  const name = preview.kind === 'asset' ? preview.asset.name : `${preview.batch.name} · 视频 ${preview.job.index + 1}`
  const src = preview.kind === 'asset' ? libraryAssetURL(preview.asset.id) : batchVideoURL(preview.batch.id, preview.job.id)
  const seconds = preview.kind === 'asset' ? preview.asset.durationSeconds : preview.job.durationSeconds
  useEffect(() => { pauseOtherMedia(); const element = player.current; return () => { element?.pause() } }, [])
  function close(): void { player.current?.pause(); onClose() }
  return <Dialog title={image ? '查看图片' : audio ? '试听音乐' : '播放批量成片'} description={name} className={audio ? 'library-audio-dialog' : 'video-player-dialog'} onClose={close} returnFocus={returnFocus}>
    <div className="dialog-body">
      {image ? <img key={attempt} className="library-full-image" alt={name} src={src} onLoad={() => setState('ready')} onError={() => setState('error')} />
        : audio ? <audio ref={element => { player.current = element }} controls preload="metadata" tabIndex={0} aria-label={name} src={src}
          onPlay={event => pauseOtherMedia(event.currentTarget)} onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} />
        : <video ref={element => { player.current = element }} controls playsInline preload="metadata" tabIndex={0} data-testid="batch-video-player" aria-label={name} src={src}
          onPlay={event => pauseOtherMedia(event.currentTarget)} onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} />}
      {state === 'loading' && <p role="status" className="field-note">正在读取本地文件…</p>}
      {state === 'error' && <div className="media-error" role="alert"><span>无法读取本地文件，请检查文件位置并刷新素材库。</span>
        <button type="button" className="text-button" onClick={() => { setState('loading'); setAttempt(value => value + 1); player.current?.load() }}>重新读取</button></div>}
      <p className="video-file">{seconds !== undefined && videoDuration(seconds)}{image && preview.kind === 'asset' && `${preview.asset.width ?? '—'} × ${preview.asset.height ?? '—'} · ${preview.asset.format?.toUpperCase() ?? '图片'}`}
        {preview.kind === 'batch' && ` · ${preview.job.fileName ?? ''}`}</p>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
    </div>
    <footer className="dialog-footer"><button type="button" className="button" onClick={close}>关闭预览</button>
      <button type="button" className="button" disabled={revealing} onClick={onReveal}><FolderOpen size={16} />打开文件位置</button>
      <button type="button" className="button primary" disabled={exporting} onClick={onExport}><Download size={16} />{exporting ? '保存中…' : '另存为'}</button></footer>
  </Dialog>
}
