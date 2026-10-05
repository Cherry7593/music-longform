import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, ImageOff } from 'lucide-react'
import { mediaURL } from '../../shared/workbench-types'
import type { WorkbenchAsset } from '../../shared/workbench-types'
import { pauseOtherMedia } from '../media'
import { Dialog } from './Dialog'
import { Banner, duration, useAction } from './Common'

export function LibraryThumbnail({ id, name, available = true }: { id: string; name: string; available?: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  return <span className="library-thumbnail">{available && state !== 'error' && <img src={mediaURL(id)} alt={name} loading="lazy" onLoad={() => setState('ready')} onError={() => setState('error')} />}{!available || state === 'error' ? <span className="thumbnail-message"><ImageOff size={20} /><span>图片不可用</span></span> : state === 'loading' && <span className="thumbnail-message">读取中…</span>}</span>
}
export function LibraryMediaDialog({ asset, onClose }: { asset: WorkbenchAsset; onClose: () => void }) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(asset.available ? 'loading' : 'error')
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string>()
  const action = useAction()
  const image = asset.kind === 'image', audio = asset.kind === 'audio'
  useEffect(() => { pauseOtherMedia(); const element = player.current; return () => { element?.pause() } }, [])
  function close(): void { player.current?.pause(); onClose() }
  return <Dialog title={image ? '查看图片' : audio ? '试听音乐' : '播放成片'} description={asset.name} className={audio ? 'audio-dialog' : 'media-dialog'} onClose={close}>
    <div className="dialog-body stack">
      {asset.available && (image ? <img key={attempt} className="library-full-image" alt={asset.name} src={mediaURL(asset.id)} onLoad={() => setState('ready')} onError={() => setState('error')} /> : audio ? <audio ref={element => { player.current = element }} controls preload="metadata" aria-label={asset.name} src={mediaURL(asset.id)} onPlay={e => pauseOtherMedia(e.currentTarget)} onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} /> : <video ref={element => { player.current = element }} controls playsInline preload="metadata" data-testid="asset-video-player" aria-label={asset.name} src={mediaURL(asset.id)} onPlay={e => pauseOtherMedia(e.currentTarget)} onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} />)}
      {state === 'loading' && <p role="status" className="meta">正在读取本地文件…</p>}
      {state === 'error' && <Banner tone="error">{asset.problem ?? '无法读取本地文件，请检查文件位置并刷新素材库。'}{asset.available && <button className="text-button" onClick={() => { setState('loading'); setAttempt(n => n + 1); player.current?.load() }}>重新读取</button>}</Banner>}
      <p className="meta">{image ? `${asset.width ?? '—'} × ${asset.height ?? '—'}` : duration(asset.durationSeconds)} · {asset.format?.toUpperCase() ?? '本地媒体'}</p>
      {notice && <Banner tone="success">{notice}</Banner>}{action.error && <Banner tone="error">{action.error}</Banner>}
    </div><footer className="dialog-footer"><button className="button" onClick={close}>关闭预览</button><button className="button" disabled={action.busy || !asset.available} onClick={() => void action.run(async () => { await window.canvas.revealAsset(asset.id); setNotice('已打开文件位置') })}><FolderOpen size={17} />文件位置</button><button className="button primary" disabled={action.busy || !asset.available} onClick={() => void action.run(async () => { const path = await window.canvas.exportAsset(asset.id); setNotice(path ? `已另存：${path}` : '已取消另存') })}><Download size={17} />另存为</button></footer>
  </Dialog>
}
