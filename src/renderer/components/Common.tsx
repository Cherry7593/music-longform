import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DeletionImpact } from '../../shared/workbench-types'
import { messageOf } from '../useWorkspace'
import { Dialog } from './Dialog'

export function BrandMark({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M11 5H7a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-4M18 5h7a2 2 0 0 1 2 2v7M14 22V11l9-2v11M14 14l9-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><ellipse cx="11.5" cy="22" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.8" /><ellipse cx="20.5" cy="20" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.8" /></svg>
}
export function Banner({ children, tone = 'info', onClose }: { children: ReactNode; tone?: 'info' | 'error' | 'success' | 'warning'; onClose?: () => void }) {
  const Icon = tone === 'error' || tone === 'warning' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info
  return <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon size={18} /><div className="banner-content">{children}</div>{onClose && <button className="icon-button" onClick={onClose} aria-label="关闭提示"><X size={18} /></button>}</div>
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2><div className="muted">{children}</div></div>
}
export const duration = (seconds?: number): string => seconds === undefined ? '时长未知' : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
export const statusNames: Record<string, string> = {
  pending: '待提交 / 排队', paused: '已暂停', submitting: '正在提交', running: '处理中', saving: '保存素材', succeeded: '已完成', failed: '失败', unknown: '受理未知', cancelled: '已取消', abandoned: '已放弃追踪',
  blocked: '等待资源', analyzing: '探测素材', processing: '预处理', mixing: '混音', encoding: '编码', validating: '校验成片', publishing: '发布入库', interrupted: '已中断', pausing: '完成当前后暂停', completed: '已完成', partial: '部分完成',
}
export function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status}`}>{statusNames[status] ?? status}</span> }
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const lock = useRef(false)
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return undefined
    lock.current = true; setBusy(true); setError(undefined)
    try { return await action() } catch (e) { setError(messageOf(e)); return undefined }
    finally { lock.current = false; setBusy(false) }
  }
  return { busy, error, run }
}
export interface Confirmation { title: string; body: ReactNode; label?: string; danger?: boolean; acknowledge?: string; once?: boolean; returnFocus?: HTMLElement | null; action: () => Promise<void> }
export function ConfirmDialog({ value, onClose }: { value: Confirmation; onClose: () => void }) {
  const { busy, error, run } = useAction()
  const [acknowledged, setAcknowledged] = useState(false)
  const [attempted, setAttempted] = useState(false)
  return <Dialog title={value.title} onClose={onClose} busy={busy} returnFocus={value.returnFocus}><div className="dialog-body stack">{value.body}
    {value.acknowledge && <label className="checkbox-label"><input type="checkbox" data-testid="confirm-acknowledge" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />{value.acknowledge}</label>}
    {error && <Banner tone="error">{error}{value.once && <p>不会自动重发。请关闭此窗口，刷新并核对请求 / 批次记录后再操作；受理未知时先核对原平台。</p>}</Banner>}</div>
    <footer className="dialog-footer"><button className="button" disabled={busy} onClick={onClose}>{error && value.once ? '返回核对记录' : '取消'}</button>
      <button data-testid="confirm-action" className={`button ${value.danger ? 'danger' : 'primary'}`} disabled={busy || Boolean(value.once && attempted) || Boolean(value.acknowledge && !acknowledged)} onClick={() => { setAttempted(true); void run(async () => { await value.action(); onClose() }) }}>{busy ? '处理中…' : value.label ?? '确认'}</button>
    </footer></Dialog>
}
export function ImpactDialog({ impact, entity, onClose, onDelete }: { impact: DeletionImpact; entity: 'project' | 'asset' | 'api'; onClose: () => void; onDelete: () => Promise<void> }) {
  const { busy, error, run } = useAction()
  return <Dialog title={impact.blocked ? '暂不能删除' : `删除「${impact.name}」？`} busy={busy} onClose={onClose}><div className="dialog-body stack">
    <p>{entity === 'project' ? '只删除项目工作区元数据。音乐、图片、成片和历史使用台账全部保留。' : entity === 'asset' ? '删除软件管理的素材文件；不删除外部导入原件或另存副本。历史成功使用记录仍然保留，不会重置为未使用。' : '移除已添加 API 配置及凭据；已有素材保留。未完成请求不可静默更换来源。'}</p>
    {impact.reasons.length > 0 && <Banner tone={impact.blocked ? 'warning' : 'info'}><ul>{impact.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></Banner>}
    <h3>关联项目与记录 · {impact.references.length}</h3>{impact.references.length ? <ul className="impact-list">{impact.references.map((item, i) => <li key={`${item.id}-${i}`}><strong>{item.name}</strong><span className="meta">{item.kind}</span></li>)}</ul> : <p className="meta">没有关联记录。</p>}
    {entity === 'asset' && <p className="meta">管理文件：{impact.ownedFiles ?? '由存储层核对'} · 外部原件{impact.externalOriginalsKept ? '保留' : '不在本次删除范围'}</p>}
    {error && <Banner tone="error">{error}</Banner>}</div><footer className="dialog-footer"><button className="button" disabled={busy} onClick={onClose}>{impact.blocked ? '知道了' : '取消'}</button>{!impact.blocked && <button data-testid="delete-confirm" className="button danger" disabled={busy} onClick={() => void run(async () => { await onDelete(); onClose() })}>{busy ? '删除中…' : '确认删除'}</button>}</footer></Dialog>
}
export function RenameDialog({ name, title = '重命名', onClose, onSave }: { name: string; title?: string; onClose: () => void; onSave: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(name)
  const { busy, error, run } = useAction()
  return <Dialog title={title} busy={busy} onClose={onClose}><form onSubmit={e => { e.preventDefault(); if (value.trim()) void run(async () => { await onSave(value.trim()); onClose() }) }}><div className="dialog-body stack"><label className="field">名称<input data-testid="rename-input" value={value} maxLength={500} required disabled={busy} onChange={e => setValue(e.target.value)} /></label>{error && <Banner tone="error">{error}</Banner>}</div><footer className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button data-testid="rename-save" className="button primary" disabled={busy || !value.trim()}>{busy ? '保存中…' : '保存名称'}</button></footer></form></Dialog>
}
export function Pager({ page, total, size = 20, onChange }: { page: number; total: number; size?: number; onChange: (page: number) => void }) {
  const last = Math.max(0, Math.ceil(total / size) - 1)
  if (last === 0) return null
  return <div className="pager"><span className="meta">第 {page + 1} / {last + 1} 页 · 共 {total} 项</span><button className="button" disabled={page <= 0} onClick={() => onChange(page - 1)}>上一页</button><button className="button" disabled={page >= last} onClick={() => onChange(page + 1)}>下一页</button></div>
}
