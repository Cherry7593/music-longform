import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { JobStatus } from '../../shared/types'
import { statusLabels } from '../utils'

export function BrandMark({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M11 5H7a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-4M18 5h7a2 2 0 0 1 2 2v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M14 22V11l9-2v11M14 14l9-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <ellipse cx="11.5" cy="22" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.8" />
    <ellipse cx="20.5" cy="20" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.8" />
  </svg>
}
export function Banner({ children, tone = 'info', onClose }: {
  children: ReactNode; tone?: 'info' | 'error' | 'success' | 'warning'; onClose?: () => void
}) {
  const Icon = tone === 'error' || tone === 'warning' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info
  return <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={16} className="banner-icon" /><div className="banner-content">{children}</div>
    {onClose && <button type="button" className="icon-button small" onClick={onClose} aria-label="关闭提示"><X size={15} /></button>}
  </div>
}
export function JobBadge({ status }: { status: JobStatus }) {
  return <span className={`job-badge status-${status}`}><span className="status-dot" />{statusLabels[status]}</span>
}
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3>{children && <p>{children}</p>}</div>
}
