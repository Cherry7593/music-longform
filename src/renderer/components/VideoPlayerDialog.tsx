import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen } from 'lucide-react'
import { assetURL } from '../../shared/types'
import type { VideoJob } from '../../shared/types'
import { pauseOtherMedia } from '../media'
import { Banner } from './Common'
import { Dialog } from './Dialog'
import { videoDuration } from './VideoJobs'

export function VideoPlayerDialog({ projectId, job, onClose, onExport, onReveal, exporting, revealing, returnFocus, notice }: {
  projectId: string; job: VideoJob; onClose: () => void; onExport: () => void; onReveal: () => void
  exporting: boolean; revealing: boolean; returnFocus: HTMLElement | null
  notice: { tone: 'error' | 'success' | 'info'; text: string } | null
}) {
  const player = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    pauseOtherMedia()
    const element = player.current
    return () => { element?.pause() }
  }, [])
  function close(): void { player.current?.pause(); onClose() }
  return <Dialog title="播放成片" description={`1920 × 1080 · 30fps · MP4${job.durationSeconds !== undefined ? ` · ${videoDuration(job.durationSeconds)}` : ''}`}
    className="video-player-dialog" onClose={close} returnFocus={returnFocus}>
    <div className="dialog-body">
      <video ref={player} data-testid="video-player" controls playsInline preload="metadata" tabIndex={0} aria-label="本地导出视频"
        src={assetURL(projectId, 'video', job.id)} onPlay={event => pauseOtherMedia(event.currentTarget)}
        onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} />
      {state === 'loading' && <p className="field-note" role="status">正在读取本地成片…</p>}
      {state === 'error' && <div className="media-error" role="alert"><span>无法播放本地成片，请检查文件是否仍在原位置。</span>
        <button type="button" className="text-button" onClick={() => { setState('loading'); player.current?.load() }}>重新读取</button></div>}
      <p className="video-file">{job.fileName}</p>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
    </div>
    <footer className="dialog-footer"><button type="button" className="button" onClick={close}>关闭播放</button>
      <button type="button" className="button" disabled={revealing} onClick={onReveal}><FolderOpen size={16} />打开文件位置</button>
      <button type="button" className="button primary" disabled={exporting} onClick={onExport}><Download size={16} />{exporting ? '保存中…' : '另存为视频'}</button></footer>
  </Dialog>
}
