import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { batchRequestSchema, DEFAULT_BATCH_OPTIONS } from '../../shared/batch-schemas'
import type { BatchGroupInput, BatchOptions, BatchPlan, BatchRequest, VideoBatch } from '../../shared/library-types'
import type { LibraryController } from './useLibrary'
import { errorMessage } from '../utils'

/** A preview is stamped with the exact input/material revision; late responses cannot restore it. */
export function useBatchComposer(library: LibraryController, onStarted: (batch: VideoBatch) => void) {
  const [name, setName] = useState('新批次')
  const [options, setOptions] = useState<BatchOptions>({ ...DEFAULT_BATCH_OPTIONS })
  const [preview, setPreview] = useState<{ key: string; plan: BatchPlan } | null>(null)
  const [busy, setBusy] = useState<'plan' | 'revise' | 'start' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mutex = useRef(false)
  const request: BatchRequest = { ...options, name, ...library.selection }
  const materials = [...request.audioIds, ...request.imageIds].map(id => {
    const item = library.assetsById.get(id)
    return [id, item?.available, item?.sha256, item?.bytes, item?.durationSeconds]
  })
  const key = JSON.stringify([request, materials])
  const stamp = useRef({ key, revision: 0 })
  useLayoutEffect(() => {
    if (stamp.current.key !== key) stamp.current = { key, revision: stamp.current.revision + 1 }
  }, [key])
  useEffect(() => { setPreview(null); setError(null); setNotice(null) }, [key])
  const plan = preview?.key === key ? preview.plan : null
  const valid = batchRequestSchema.safeParse(request).success && !library.unavailableIds.length
  const canStart = Boolean(plan && plan.groups.length && !plan.issues.length && plan.groups.every(group => !group.issues.length))

  async function run(kind: 'plan' | 'revise' | 'start', action: (revision: number) => Promise<void>): Promise<void> {
    if (mutex.current) return
    mutex.current = true; setBusy(kind); setError(null); setNotice(null)
    const revision = stamp.current.revision
    try { await action(revision) }
    catch (cause) { if (revision === stamp.current.revision) setError(errorMessage(cause)) }
    finally { mutex.current = false; setBusy(null) }
  }
  const createPlan = () => run('plan', async revision => {
    if (!valid) throw new Error('请检查批次名称、素材选择和参数范围。')
    setPreview(null)
    const result = await window.canvas.planBatch(structuredClone(request))
    if (revision === stamp.current.revision) { setPreview({ key, plan: result }); setNotice('分组已校验；可以调整歌曲，再一键合成。') }
  })
  const revise = (groups: BatchGroupInput[]) => run('revise', async revision => {
    if (!plan) return
    const result = await window.canvas.reviseBatchPlan(plan.id, structuredClone(groups))
    if (revision === stamp.current.revision) { setPreview({ key, plan: result }); setNotice('分组调整已重新校验。') }
  })
  const start = () => run('start', async revision => {
    if (!plan || !canStart) return
    const result = await window.canvas.startBatch(plan.id)
    onStarted(result)
    if (revision === stamp.current.revision) {
      setPreview(null)
      setNotice('批次已提交。以下队列显示实际进度；修改选择不会改变已提交的快照。')
    }
  })
  return { name, setName, options, setOptions, plan, busy, error, notice, valid, canStart, createPlan, revise, start }
}
export type BatchComposerController = ReturnType<typeof useBatchComposer>
