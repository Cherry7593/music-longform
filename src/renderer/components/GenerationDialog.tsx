import { useRef, useState } from 'react'
import { ArrowRight, ShieldAlert } from 'lucide-react'
import type { ImageDraft, MusicDraft, MusicJob } from '../../shared/types'
import { errorMessage, modelLabel, sizeLabels, styleLabels } from '../utils'
import { Banner } from './Common'
import { Dialog } from './Dialog'

export type GenerationRequest =
  | { kind: 'music'; projectId: string; draft: MusicDraft }
  | { kind: 'image'; projectId: string; draft: ImageDraft }
  | { kind: 'continue'; projectId: string; batchId: string; pending: MusicJob[] }

export function GenerationDialog({ request, onClose, onConfirm, testMode, returnFocus }: {
  request: GenerationRequest; onClose: () => void; onConfirm: () => Promise<void>; testMode: boolean; returnFocus: HTMLElement | null
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const locked = useRef(false)
  const music = request.kind === 'music' ? request.draft : request.kind === 'continue' ? request.pending[0]?.snapshot : null
  const count = request.kind === 'image' ? 1 : request.kind === 'music' ? request.draft.count : request.pending.length
  const models = request.kind === 'continue' ? [...new Set(request.pending.map(job => job.snapshot.model))].map(modelLabel).join('、') : modelLabel(request.draft.model)
  const prompt = request.kind === 'continue' ? request.pending[0]?.snapshot.prompt : request.draft.prompt
  return <Dialog title={request.kind === 'continue' ? '继续未提交的音乐任务' : request.kind === 'music' ? '确认生成音乐' : '确认生成图片'}
    onClose={onClose} busy={busy} className="generation-dialog" returnFocus={returnFocus}>
    <div className="dialog-body">
      {testMode && <Banner>测试模式 · 模拟接口，不消耗真实额度。</Banner>}
      <dl className="confirmation-details">
        <div><dt>服务商</dt><dd>{request.kind === 'image' ? '硅基流动' : 'Mureka'}</dd></div>
        <div><dt>生成数量</dt><dd><strong>{count} {request.kind === 'image' ? '张' : '首'}</strong>{request.kind !== 'image' && <span className="muted"> · 串行，每次 1 首</span>}</dd></div>
        <div><dt>模型</dt><dd>{models}</dd></div>
        {music && <div><dt>模式</dt><dd>{music.mode === 'instrumental' ? '纯音乐' : '人声歌曲'}</dd></div>}
        {music?.mode === 'song' && music.styles.length > 0 && <div><dt>歌曲风格</dt><dd>{music.styles.map(style => styleLabels[style] ?? style).join('、')}</dd></div>}
        {request.kind === 'image' && <div><dt>尺寸</dt><dd>{sizeLabels[request.draft.size] ?? request.draft.size}</dd></div>}
      </dl>
      <details className="prompt-snapshot"><summary>查看本次提示词{request.kind === 'continue' ? '（原批次快照）' : ''}</summary><p>{prompt}</p></details>
      {request.kind === 'continue' && <Banner tone="warning">按原批次参数提交剩余 {count} 首；跳过失败和未知任务，不重试。请先核对未知任务是否已扣费。</Banner>}
      <div className="payment-note"><ShieldAlert size={19} /><div><strong>此操作可能产生服务商费用</strong>
        <p>以服务商实际计费为准。{request.kind !== 'image' ? '停止后续任务不取消已提交任务，仍可能计费。' : '提交后不保证可取消；中断或超时仍可能扣费，不会自动重发。'}</p></div></div>
      <label className="checkbox-label"><input type="checkbox" checked={acknowledged} disabled={busy || Boolean(failure)} onChange={event => setAcknowledged(event.target.checked)} />
        <span>已核对数量与模型，确认提交{testMode ? '测试' : '付费'}请求。</span></label>
      {failure && <Banner tone="error"><p>{failure}</p><p>未自动重发。请返回任务记录；状态不明时先核对服务商后台，避免重复扣费。</p></Banner>}
    </div>
    <footer className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{failure ? '返回检查' : '再想想'}</button>
      <button type="button" className="button primary" disabled={!acknowledged || busy || Boolean(failure) || count < 1} onClick={() => {
        if (locked.current || !acknowledged) return
        locked.current = true; setBusy(true)
        void onConfirm().catch(error => setFailure(errorMessage(error))).finally(() => setBusy(false))
      }}>{busy ? '正在提交…' : request.kind === 'continue' ? '确认付费并继续' : '确认付费并生成'}<ArrowRight size={16} /></button></footer>
  </Dialog>
}
