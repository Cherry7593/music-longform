import { useRef, useState } from 'react'
import { Clapperboard, Image, ListChecks, Music2 } from 'lucide-react'
import type { BatchGroupInput, BatchPlan } from '../../shared/library-types'
import type { CompositionDraft, CompositionProject, ExecutionBatch, GenerationKind, WorkbenchAsset, WorkbenchSnapshot } from '../../shared/workbench-types'
import { RENDER_ACTIVE, RENDER_RESERVED } from '../../shared/workbench-types'
import { compositionDraftSchema } from '../../shared/workbench-schemas'
import type { WorkspaceStore } from '../useWorkspace'
import { AssetSelector } from './AssetSelector'
import { Banner, ConfirmDialog, EmptyState, Pager, StatusBadge, duration, useAction } from './Common'
import type { Confirmation } from './Common'
import { CompositionParameters } from './CompositionParameters'
import { BatchPlanPreview } from './BatchPlanPreview'
import { DiagnosticsDialog } from './DiagnosticsDialog'

type Preview = { revision: number; signature: string; plan: BatchPlan }
export function CompositionWorkspace({ project, data, store, onPreview }: { project: CompositionProject; data: WorkbenchSnapshot; store: WorkspaceStore; onPreview: (asset: WorkbenchAsset) => void }) {
  const [selector, setSelector] = useState<{ kind: GenerationKind; projectId: string }>()
  const [preview, setPreview] = useState<Preview>()
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [diagnostic, setDiagnostic] = useState<string>()
  const [batchPage, setBatchPage] = useState(0)
  const [openBatches, setOpenBatches] = useState<Record<string, boolean>>({})
  const action = useAction()
  const editVersion = useRef(0)
  const value = project.draft
  const saved = store.getSnapshot().saves[project.id]
  const signature = JSON.stringify(value)
  const plan = preview && preview.revision === project.revision && preview.signature === signature && !saved ? preview.plan : undefined
  const batches = data.batches.filter(b => b.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const currentBatchPage = Math.min(batchPage, Math.max(0, Math.ceil(batches.length / 10) - 1))
  const byId = new Map(data.assets.map(a => [a.id, a]))
  const valid = compositionDraftSchema.safeParse(value).success && value.audioIds.length > 0 && value.imageIds.length > 0
  const missing = [...value.audioIds, ...value.imageIds].filter(id => !byId.get(id)?.available)
  function edit(next: CompositionDraft): void { editVersion.current++; setPreview(undefined); store.editComposition(project.id, next) }
  async function createPlan(): Promise<void> {
    await action.run(async () => {
      setPreview(undefined); await store.flushComposition(project.id)
      const current = store.getSnapshot().data?.compositionProjects.find(p => p.id === project.id)
      if (!current) throw new Error('项目已不存在')
      const version = editVersion.current, before = JSON.stringify(current.draft)
      const next = await window.canvas.planComposition(project.id, current.revision)
      const live = store.getSnapshot()
      if (version !== editVersion.current || live.saves[project.id] || live.data?.compositionProjects.find(p => p.id === project.id)?.revision !== current.revision) throw new Error('草稿已变化，请重新规划')
      setPreview({ revision: current.revision, signature: before, plan: next })
    })
  }
  async function revise(groups: BatchGroupInput[]): Promise<void> {
    if (!plan) return
    const original = plan
    await action.run(async () => {
      const version = editVersion.current
      const next = await window.canvas.reviseCompositionPlan(project.id, original.id, groups)
      await store.refresh()
      const current = store.getSnapshot()
      const live = current.data?.compositionProjects.find(p => p.id === project.id)
      if (!live || version !== editVersion.current || current.saves[project.id]) throw new Error('草稿已变化，请重新规划')
      setPreview({ revision: live.revision, signature: JSON.stringify(live.draft), plan: next })
    })
  }
  function start(): void {
    if (!plan || !preview) return
    const checked = preview
    setConfirm({ title: '确认开始本批合成', label: '开始合成', body: <><p>项目「{project.name}」将提交 {plan.groups.length} 条视频。每首音乐完整播放一次，同批不重复；成功成片自动登记素材库。</p><p className="meta">本次使用不可变计划快照。全局目标并行 {data.settings.render.concurrency}，受线程、内存和磁盘预算约束；资源不足时会等待，不保证同时运行数量。</p></>, action: async () => {
      const current = store.getSnapshot(), live = current.data?.compositionProjects.find(p => p.id === project.id)
      if (!live || current.saves[project.id] || live.revision !== checked.revision || JSON.stringify(live.draft) !== checked.signature) throw new Error('计划已过期，请重新规划后提交')
      await window.canvas.startComposition(project.id, checked.plan.id); setPreview(undefined); await store.refresh(); store.notify('合成批次已提交，切换项目不影响后台任务')
    } })
  }
  function batchAction(batch: ExecutionBatch, mode: 'pause' | 'continue' | 'cancel'): void {
    const remaining = batch.jobs.filter(j => j.status !== 'succeeded').length
    setConfirm({ title: mode === 'pause' ? '完成当前任务后暂停？' : mode === 'continue' ? '确认继续未成功任务？' : '取消此批次？', label: mode === 'pause' ? '暂停后续任务' : mode === 'continue' ? '确认继续' : '取消批次', danger: mode === 'cancel',
      body: <p>{mode === 'pause' ? '正在执行的任务继续到完成；停止领取本批后续任务，不影响其他项目。' : mode === 'continue' ? `仅继续本批 ${remaining} 个未成功任务。成功项不重跑；请先查看失败诊断，解决工具或资源问题。` : '取消此批未完成任务，成功成片与使用记录保留；其他批次不受影响。'}</p>,
      acknowledge: mode === 'continue' ? '已核对未成功任务与诊断，确认继续使用本地资源' : undefined,
      action: async () => { if (mode === 'pause') await window.canvas.pauseBatch(batch.id); else if (mode === 'continue') await window.canvas.continueBatch(batch.id); else await window.canvas.cancelBatch(batch.id); await store.refresh() } })
  }
  function previewAsset(id: string): void { const asset = byId.get(id); if (asset) onPreview(asset); else store.notify('素材已删除或尚未登记', 'error') }
  return <div className="workspace-body stack" data-testid="composition-workspace">
    {project.migrationNote && <Banner tone="warning">{project.migrationNote}</Banner>}
    <section className="stack"><div className="section-row"><h2>选材与顺序</h2><span className="meta">{saved ? saved.phase === 'error' ? '保存失败' : '保存草稿中…' : '草稿已保存'} · 版本 {project.revision}</span></div>
      <div className="selection-lines">{(['audio', 'image'] as const).map(kind => { const ids = kind === 'audio' ? value.audioIds : value.imageIds; return <div className="selection-line" key={kind}>{kind === 'audio' ? <Music2 size={20} /> : <Image size={20} />}<div><strong>{kind === 'audio' ? `${ids.length} 首音乐` : `${ids.length} 张图片`}</strong><p className="meta">{kind === 'audio' ? `共 ${duration(ids.reduce((sum, id) => sum + (byId.get(id)?.durationSeconds ?? 0), 0))} · 未扣转场重叠` : '一张图片对应一条视频，保持原始比例'}</p></div><button className="button" data-testid={`composition-select-${kind}`} disabled={action.busy} onClick={() => setSelector({ kind, projectId: project.id })}>{ids.length ? '调整选材' : '选择素材'}</button></div> })}</div>
      <p className="meta">每条最多 100 首 / 6 小时，每批最多 100 条。直接在本项目选材，不需要先去素材库勾选。</p>
      {missing.length > 0 && <Banner tone="warning">{missing.length} 个已选素材不可用或已删除，请在选材器中移除或替换。</Banner>}
      {saved?.phase === 'error' && <Banner tone="error">保存失败，草稿已保留：{saved.message}<button className="text-button" onClick={() => void action.run(() => store.flushComposition(project.id))}>重试保存</button></Banner>}
    </section>
    <section className="stack composition-settings"><h2>合成参数</h2><CompositionParameters value={value} disabled={action.busy} onChange={edit} /><div className="button-row"><button className="button primary" data-testid="composition-plan-button" disabled={action.busy || !valid || Boolean(missing.length)} onClick={() => void createPlan()}><ListChecks size={17} />{action.busy ? '处理中…' : value.groups?.length ? '规划并核对已存分组' : '规划分组'}</button>{value.groups?.length ? <button className="button" disabled={action.busy} onClick={() => edit({ ...value, groups: undefined })}>清除手动分组</button> : null}<span className="meta">改动选材或参数后，计划立即失效。</span></div></section>
    {action.error && <Banner tone="error">{action.error}</Banner>}
    {preview && !plan && <Banner tone="warning">计划已过期，请重新规划。</Banner>}
    {plan && <><BatchPlanPreview plan={plan} disabled={action.busy} onRevise={groups => void revise(groups)} onPreview={previewAsset} /><div className="button-row"><button className="button primary" data-testid="composition-start" disabled={action.busy || !plan.groups.length || plan.issues.length > 0 || plan.groups.some(g => g.issues.length)} onClick={start}><Clapperboard size={18} />开始合成 · {plan.groups.length} 条视频</button></div></>}
    <section className="execution-section stack"><div className="section-row"><h2>本项目执行记录</h2>{batches.some(b => b.jobs.some(j => RENDER_RESERVED.has(j.status))) && <button className="button danger" data-testid="composition-cancel-project" onClick={() => setConfirm({ title: '取消本项目所有未完成任务？', label: '取消本项目任务', danger: true, body: <p>只取消「{project.name}」的未完成任务。成功成片保留，其他合成项目不受影响。</p>, action: async () => { await window.canvas.cancelComposition(project.id); await store.refresh() } })}>取消本项目任务</button>}</div>
      {!batches.length ? <EmptyState title="暂无执行批次">规划分组并确认后，逐条显示真实进度。</EmptyState> : batches.slice(currentBatchPage * 10, currentBatchPage * 10 + 10).map(batch => <details className="execution-batch" key={batch.id}
        open={openBatches[batch.id] ?? (batch.state === 'running' || batch.state === 'pausing')}
        onToggle={event => { const open = event.currentTarget.open; setOpenBatches(old => old[batch.id] === open ? old : { ...old, [batch.id]: open }) }} data-testid={`batch-${batch.id}`}>
        <summary><strong>{batch.name}</strong><StatusBadge status={batch.state} /><span className="meta">{batch.jobs.filter(j => j.status === 'succeeded').length} / {batch.jobs.length} 已完成 · {new Date(batch.createdAt).toLocaleString('zh-CN')}</span></summary>
        <div className="stack"><div className="button-row">
          {batch.state === 'running' && <button className="button" data-testid={`batch-pause-${batch.id}`} onClick={() => batchAction(batch, 'pause')}>完成当前后暂停</button>}
          {['paused', 'partial', 'cancelled'].includes(batch.state) && batch.jobs.some(j => j.status !== 'succeeded') && <button className="button" data-testid={`batch-continue-${batch.id}`} onClick={() => batchAction(batch, 'continue')}>继续未成功任务</button>}
          {batch.jobs.some(j => RENDER_RESERVED.has(j.status)) && <button className="button danger" data-testid={`batch-cancel-${batch.id}`} onClick={() => batchAction(batch, 'cancel')}>取消本批</button>}
        </div>{batch.message && <Banner>{batch.message}</Banner>}
        <div className="render-jobs">{batch.jobs.map(job => <article key={job.id} className="render-job" data-testid={`render-job-${job.id}`}><div className="section-row"><strong>视频 {job.index + 1} · {byId.get(job.group.imageId)?.name ?? '图片'}</strong><StatusBadge status={job.status} /></div>{RENDER_ACTIVE.has(job.status) && <div className="progress-line"><progress max={100} value={job.progress} aria-label={`视频 ${job.index + 1} 合成进度`} /><span className="meta">{job.progress === undefined ? '处理中' : `${Math.round(job.progress)}%`}</span></div>}{job.detail && <p className="meta">{job.detail}</p>}{job.error && <p className="error-text preserve-lines">{job.error}</p>}<div className="section-row"><span className="meta">{job.group.audioIds.length} 首 · 尝试 {job.attempts.length} 次{job.durationSeconds !== undefined ? ` · ${duration(job.durationSeconds)}` : ''}</span><div className="button-row">{job.videoAssetId && <button className="button" data-testid={`render-play-${job.id}`} onClick={() => previewAsset(job.videoAssetId!)}>播放成片</button>}<button className="text-button" data-testid={`render-diagnostics-${job.id}`} onClick={() => setDiagnostic(job.id)}>诊断详情</button>{RENDER_RESERVED.has(job.status) && <button className="text-button danger" data-testid={`render-cancel-${job.id}`} onClick={() => setConfirm({ title: '取消这一条任务？', label: '取消任务', danger: true, body: <p>仅取消视频 {job.index + 1}，同批其他任务继续执行。</p>, action: async () => { await window.canvas.cancelRenderJob(batch.id, job.id); await store.refresh() } })}>取消此任务</button>}</div></div></article>)}</div>
      </div></details>)}<Pager page={currentBatchPage} total={batches.length} size={10} onChange={setBatchPage} />
    </section>
    {selector?.projectId === project.id && <AssetSelector key={`${selector.projectId}:${selector.kind}`} kind={selector.kind} assets={data.assets} projects={data.generationProjects} initialIds={selector.kind === 'audio' ? value.audioIds : value.imageIds} onApply={ids => {
      const current = store.getSnapshot()
      const live = current.data?.compositionProjects.find(item => item.id === selector.projectId && !item.deletedAt)
      if (current.page !== 'composition' || current.compositionId !== selector.projectId || !live) throw new Error('项目已切换或已删除，选择未应用。')
      edit({ ...live.draft, [selector.kind === 'audio' ? 'audioIds' : 'imageIds']: ids, groups: undefined })
    }} onClose={() => setSelector(undefined)} />}
    {confirm && <ConfirmDialog value={confirm} onClose={() => setConfirm(null)} />}{diagnostic && <DiagnosticsDialog key={diagnostic} taskId={diagnostic} onClose={() => setDiagnostic(undefined)} />}
  </div>
}
