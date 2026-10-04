import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface DialogProps {
  title: string
  description?: string
  className?: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  returnFocus?: HTMLElement | null
}

export function Dialog({ title, description, className = '', children, onClose, busy = false, returnFocus }: DialogProps) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const callback = useRef(onClose)
  const blocked = useRef(busy)
  const previousFocus = useRef<HTMLElement | null>(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useLayoutEffect(() => { callback.current = onClose; blocked.current = busy }, [onClose, busy])
  useLayoutEffect(() => {
    const previous = previousFocus.current
    const element = panel.current
    element?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!blocked.current) callback.current()
      }
      if (event.key !== 'Tab' || !element) return
      const focusable = [...element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )].filter(node => node.getClientRects().length > 0 && !node.closest('[hidden], [inert]') && node.tabIndex >= 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) { event.preventDefault(); element.focus(); return }
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === element || !element.contains(active))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (active === last || active === element || !element.contains(active))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      requestAnimationFrame(() => {
        if (document.querySelector('[data-canvas-dialog]')) return
        if (previous?.isConnected && !previous.matches(':disabled, [inert]')) previous.focus({ preventScroll: true })
        if (document.activeElement === document.body) (document.getElementById('project-name') ?? document.querySelector<HTMLElement>('.main-nav [aria-current="page"]'))?.focus({ preventScroll: true })
      })
    }
  }, [])
  return createPortal(
    <div className="dialog-backdrop" onClick={event => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div ref={panel} tabIndex={-1} data-canvas-dialog role="dialog" aria-modal="true"
        aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
        className={`dialog ${className}`}>
        <header className="dialog-header">
          <div><h2 id={`${id}-title`}>{title}</h2>{description && <p id={`${id}-description`}>{description}</p>}</div>
          <button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>, document.body,
  )
}
