import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportResult, LibraryKind, LibrarySnapshot } from '../../shared/library-types'
import { errorMessage } from '../utils'

export interface LibrarySelection { audioIds: string[]; imageIds: string[] }
const selectionKey = (kind: LibraryKind) => kind === 'audio' ? 'audioIds' : 'imageIds'

/** Coalesced, serialized reads: an event invalidates any older in-flight snapshot. */
export function useLibrary(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<string | null>(null)
  const [imports, setImports] = useState<ImportResult | null>(null)
  const [selection, setSelection] = useState<LibrarySelection>({ audioIds: [], imageIds: [] })
  const lock = useRef(false)
  const reader = useRef<((force?: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let revision = 0
    let pending = false
    let strong = false
    let lastRead = 0
    let running: Promise<void> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (force = false): Promise<void> => {
      pending = true; strong ||= force
      if (running) return running
      clearTimeout(timer); timer = undefined
      running = Promise.resolve().then(async () => {
        if (alive) setLoading(true)
        try {
          while (alive && pending) {
            const wait = Math.max(0, 250 - (Date.now() - lastRead))
            if (wait) await new Promise(resolve => setTimeout(resolve, wait))
            if (!alive) break
            lastRead = Date.now(); pending = false
            const version = revision
            const refresh = strong; strong = false
            try {
              const next = await (refresh ? window.canvas.refreshLibrary() : window.canvas.getLibrary())
              if (alive && version === revision) { setSnapshot(next); setError(null) }
            } catch (cause) {
              if (alive && version === revision) setError(errorMessage(cause))
            }
          }
        } finally { running = null; if (alive) setLoading(false) }
      })
      return running
    }
    reader.current = read
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.canvas.onLibraryChanged(() => {
        revision += 1; pending = true
        if (!running && !timer) timer = setTimeout(() => { timer = undefined; if (alive) void read() }, 250)
      })
    } catch (cause) { setError(errorMessage(cause)) }
    void read()
    return () => { alive = false; reader.current = null; clearTimeout(timer); unsubscribe?.() }
  }, [enabled])

  const run = useCallback(async (name: string, operation: () => Promise<void>) => {
    if (lock.current || !enabled) return
    lock.current = true; setAction(name); setError(null)
    try { await operation() } catch (cause) { setError(errorMessage(cause)) }
    finally { lock.current = false; setAction(null) }
  }, [enabled])
  const refresh = useCallback(() => run('refresh', async () => { await reader.current?.(true) }), [run])
  const importFiles = useCallback((kind: LibraryKind) => run('import', async () => {
    const result = await window.canvas.importLibrary(kind)
    setImports(result)
    await reader.current?.()
  }), [run])
  const chooseRoot = useCallback(() => run('root', async () => {
    await window.canvas.chooseLibraryRoot()
    await reader.current?.()
  }), [run])
  const select = useCallback((kind: LibraryKind, ids: string[], checked: boolean) => {
    const key = selectionKey(kind)
    setSelection(current => ({ ...current, [key]: checked ? [...new Set([...current[key], ...ids])] : current[key].filter(id => !ids.includes(id)) }))
  }, [])
  const clearSelection = useCallback(() => setSelection({ audioIds: [], imageIds: [] }), [])
  const assetsById = useMemo(() => new Map(snapshot?.assets.map(asset => [asset.id, asset]) ?? []), [snapshot])
  const selectedSeconds = selection.audioIds.reduce((sum, id) => sum + (assetsById.get(id)?.durationSeconds ?? 0), 0)
  const unavailableIds = [...selection.audioIds, ...selection.imageIds].filter(id => !assetsById.get(id)?.available)
  return { snapshot, loading, error, action, imports, dismissImports: () => setImports(null), selection, select, clearSelection,
    assetsById, selectedSeconds, unavailableIds, refresh, importFiles, chooseRoot }
}
export type LibraryController = ReturnType<typeof useLibrary>
