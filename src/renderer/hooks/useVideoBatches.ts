import { useCallback, useEffect, useRef, useState } from 'react'
import type { VideoBatch } from '../../shared/library-types'
import { errorMessage } from '../utils'

const newestFirst = (a: VideoBatch, b: VideoBatch) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)

export function useVideoBatches(enabled: boolean) {
  const [batches, setBatches] = useState<VideoBatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string[]>([])
  const sequence = useRef(0)
  const revisions = useRef(new Map<string, number>())
  const latest = useRef(new Map<string, VideoBatch>())
  const locks = useRef(new Set<string>())
  const loadLock = useRef(false)
  const lifetime = useRef(0)
  const accept = useCallback((batch: VideoBatch, startedAt?: number) => {
    const old = latest.current.get(batch.id)
    if (old && old.updatedAt > batch.updatedAt) return
    if (old && startedAt !== undefined && (revisions.current.get(batch.id) ?? 0) > startedAt && old.updatedAt >= batch.updatedAt) return
    latest.current.set(batch.id, batch)
    revisions.current.set(batch.id, ++sequence.current)
    setBatches([...latest.current.values()].sort(newestFirst))
  }, [])
  // startBatch may return after its own progress events, including events in the same millisecond.
  const recordStarted = useCallback((batch: VideoBatch) => accept(batch, 0), [accept])
  const refresh = useCallback(async () => {
    if (!enabled || loadLock.current) return
    loadLock.current = true; setLoading(true); setError(null)
    const epoch = lifetime.current
    const start = sequence.current
    try {
      const result = await window.canvas.listVideoBatches()
      if (epoch !== lifetime.current) return
      for (const batch of result) accept(batch, start)
    } catch (cause) { if (epoch === lifetime.current) setError(errorMessage(cause)) }
    finally { if (epoch === lifetime.current) { loadLock.current = false; setLoading(false) } }
  }, [enabled, accept])
  useEffect(() => {
    if (!enabled) return
    lifetime.current += 1
    let unsubscribe: (() => void) | undefined
    try { unsubscribe = window.canvas.onVideoBatchChanged(batch => accept(batch)) }
    catch (cause) { setError(errorMessage(cause)) }
    void refresh()
    return () => { lifetime.current += 1; loadLock.current = false; unsubscribe?.() }
  }, [enabled, accept, refresh])
  const control = useCallback(async (batch: VideoBatch, command: 'pause' | 'continue' | 'cancel') => {
    if (locks.current.has(batch.id)) return
    locks.current.add(batch.id); setBusy([...locks.current]); setError(null)
    const start = sequence.current
    try {
      const result = command === 'pause' ? await window.canvas.pauseVideoBatch(batch.id)
        : command === 'continue' ? await window.canvas.continueVideoBatch(batch.id) : await window.canvas.cancelVideoBatch(batch.id)
      accept(result, start)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { locks.current.delete(batch.id); setBusy([...locks.current]) }
  }, [accept])
  return { batches, loading, error, busy, refresh, recordStarted, control }
}
export type VideoBatchesController = ReturnType<typeof useVideoBatches>
