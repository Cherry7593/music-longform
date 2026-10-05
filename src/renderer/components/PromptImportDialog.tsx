import { useLayoutEffect, useRef, useState } from 'react'
import type { EntryDraft, GenerationEntry, GenerationKind, PromptImportInput, PromptImportResult, WorkbenchSnapshot } from '../../shared/workbench-types'
import { initialEntry, promptImportInputSchema } from '../../shared/workbench-schemas'
import { parsePromptImport, PROMPT_IMPORT_MAX_BYTES, utf8ByteLength } from '../../shared/prompt-import'
import type { PromptImportIssue, PromptTextEntry } from '../../shared/prompt-import'
import type { WorkspaceStore } from '../useWorkspace'
import { applyPromptSettings, changePromptProvider, PromptSaveFailure, savePromptBatch } from '../prompt-import-utils'
import { Dialog } from './Dialog'
import { Banner, Pager } from './Common'
import { EntryEditor, entryIssue } from './EntryEditor'

type Row = { source: PromptTextEntry; entry: GenerationEntry }
export function PromptImportDialog({ projectId, projectName, kind, data, store, onClose, onCreated }: {
  projectId: string; projectName: string; kind: GenerationKind; data: WorkbenchSnapshot; store: WorkspaceStore
  onClose: () => void; onCreated: (result: PromptImportResult) => Promise<void>
}) {
  const [step, setStep] = useState<'paste' | 'preview'>('paste')
  const [raw, setRaw] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [bulk, setBulk] = useState<GenerationEntry>()
  const [batchId, setBatchId] = useState(() => crypto.randomUUID())
  const [page, setPage] = useState(0)
  const [errors, setErrors] = useState<PromptImportIssue[]>([])
  const [message, setMessage] = useState<string>()
  const [confirm, setConfirm] = useState<'close' | 'back'>()
  const [busy, setBusy] = useState(false)
  const [checkOnly, setCheckOnly] = useState(false)
  const frozen = useRef<PromptImportInput | undefined>(undefined)
  const sending = useRef(false)
  const rawInput = useRef<HTMLTextAreaElement>(null), previewTitle = useRef<HTMLHeadingElement>(null), discardButton = useRef<HTMLButtonElement>(null)
  const input: PromptImportInput = { projectId, kind, batchId, drafts: rows.map(row => row.entry.draft) }
  const validation = step === 'preview' ? promptImportInputSchema.safeParse(input) : undefined
  const locked = busy || Boolean(frozen.current)
  const bytes = utf8ByteLength(raw), overLimit = bytes > PROMPT_IMPORT_MAX_BYTES
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1))
  const duplicates: string[] = [], seen = new Map<string, number>()
  for (const row of rows) {
    const earlier = seen.get(row.entry.draft.prompt)
    if (earlier !== undefined) duplicates.push(`条目 ${row.source.number} 与条目 ${earlier} 的提示词相同，仍分别保留。`)
    else seen.set(row.entry.draft.prompt, row.source.number)
  }
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => { if (confirm) discardButton.current?.focus(); else if (step === 'paste') rawInput.current?.focus(); else previewTitle.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [step, confirm])
  function close(): void {
    if (sending.current) return
    if (raw.trim() || rows.length) setConfirm('close')
    else onClose()
  }
  function discard(): void {
    if (confirm === 'close') { onClose(); return }
    frozen.current = undefined; setCheckOnly(false); setRows([]); setBulk(undefined); setErrors([]); setMessage(undefined); setStep('paste'); setConfirm(undefined)
  }
  function parse(): void {
    const result = parsePromptImport(raw, kind)
    if (!result.ok) { setErrors(result.errors); return }
    const stamp = new Date().toISOString(), provider = data.apis.find(api => api.kind === kind)?.provider
    const parsed = result.entries.map(source => ({ source, entry: { version: 1 as const, id: crypto.randomUUID(), projectId, kind, createdAt: stamp, updatedAt: stamp, revision: 0,
      draft: { ...initialEntry(kind, provider), prompt: source.prompt, ...(source.title !== undefined ? { title: source.title } : {}), ...(source.lyrics !== undefined ? { lyrics: source.lyrics } : {}) }, alternatives: {} } }))
    frozen.current = undefined; setCheckOnly(false); setBatchId(crypto.randomUUID()); setRows(parsed); setBulk(structuredClone(parsed[0].entry)); setErrors([]); setMessage(undefined); setPage(0); setStep('preview')
  }
  function edit(id: string, draft: EntryDraft): void { setRows(old => old.map(row => row.entry.id === id ? { ...row, entry: { ...row.entry, draft } } : row)) }
  const noSettings = (): void => setMessage('如需添加 API，请先保留原文并取消本次导入，再前往设置。没有 API 也可创建待完善草稿。')
  async function create(): Promise<void> {
    if (sending.current) return
    const currentState = store.getSnapshot(), project = currentState.data?.generationProjects.find(value => value.id === projectId)
    if (currentState.page !== 'generation' || currentState.generationId !== projectId || !project || project.page !== kind) { setMessage('原项目或素材类型已切换，本次操作终止，未向其他项目创建条目。'); return }
    if (!frozen.current) {
      if (!validation?.success) return
      frozen.current = structuredClone(validation.data)
    }
    sending.current = true; setBusy(true); setMessage(undefined); setConfirm(undefined)
    let saved: PromptImportResult | undefined
    try {
      const result = await savePromptBatch(window.canvas, frozen.current, !checkOnly)
      if (result.status === 'missing') { setCheckOnly(false); setMessage('已核对：本批尚未保存。可再次创建同一批，或返回修改原文。'); return }
      saved = result; setCheckOnly(true)
      await onCreated(result)
      onClose()
    } catch (error) {
      if (saved) { setCheckOnly(true); setMessage(`本批 ${saved.entryIds.length} 个草稿已保存，刷新未完成；请核对结果，不会重复创建。`) }
      else { setCheckOnly(error instanceof PromptSaveFailure && error.uncertain); setMessage(error instanceof Error ? error.message : '创建未完成，请先核对本批结果。') }
    } finally { sending.current = false; setBusy(false) }
  }
  return <Dialog title={`批量导入${kind === 'audio' ? '音乐' : '图片'}提示词`} description={`绑定项目「${projectName}」 · 仅创建草稿，不生成、不付费`} className="prompt-import-dialog" busy={busy} onClose={close}>
    <div className="dialog-body stack">
      <p className="meta" data-testid="prompt-import-step">{step === 'paste' ? '1. 粘贴文本并解析' : '2. 预览、配置并创建'} · 项目切换在弹窗关闭前不可操作</p>
      {confirm && <Banner tone="warning"><p>{confirm === 'close' ? checkOnly ? '本批保存状态需要核对。关闭不会重新创建，请在原项目核对已保存条目；未提交输入将丢弃。' : '关闭将丢弃本次未提交的输入与预览修改，未保存的条目不会创建。' : '返回会丢弃预览中的编辑、移除和参数设置，保留原始粘贴文本；必须重新解析。'}</p><div className="button-row"><button ref={discardButton} className="button danger" data-testid="prompt-import-discard" onClick={discard}>{confirm === 'close' ? '放弃并关闭' : '放弃预览修改并返回'}</button><button className="button" onClick={() => setConfirm(undefined)}>继续编辑</button></div></Banner>}
      {message && <Banner tone="warning">{message}</Banner>}
      {step === 'paste' ? <>
        <label className="field">粘贴外部 AI 返回的完整结果<textarea ref={rawInput} data-testid="prompt-import-text" rows={15} spellCheck={false} value={raw} onChange={event => { setRaw(event.target.value); setErrors([]) }} placeholder={kind === 'audio' ? '# 音乐提示词 v1\n\n## 条目 1\n### 提示词\n填写音乐描述' : '# 图片提示词 v1\n\n## 条目 1\n### 提示词\n填写画面描述'} /></label>
        <p className={overLimit ? 'error-text' : 'meta'}>{bytes.toLocaleString()} / 2,097,152 UTF-8 字节 · 1–500 条{overLimit ? ' · 已超过 2 MiB，请分批粘贴；原文未截断' : ''}</p>
        <p className="meta">只粘贴模板要求的结果，不粘贴模板说明；允许单层 md/markdown 代码围栏。不会读取文本中的网址或文件路径。</p>
        {errors.length > 0 && <Banner tone="error"><strong>请修改原文后重新解析，尚未创建任何条目。</strong><ul data-testid="prompt-import-errors">{errors.map((issue, index) => <li key={index}>原文第 {issue.line} 行{issue.entry !== undefined ? ` · 条目 ${issue.entry}` : ''}：{issue.message}</li>)}</ul></Banner>}
      </> : <>
        <h3 ref={previewTitle} tabIndex={-1} data-testid="prompt-import-count">识别 {rows.length} 个待创建条目</h3>
        <p className="meta">按剩余条目的原文顺序追加。名称可留空，不会把编号作为曲名；无 API 或未达到生成要求的内容可保存为待完善草稿。</p>
        {duplicates.length > 0 && <Banner tone="warning"><details><summary>重复提示词提醒 · {duplicates.length} 项（不会自动合并）</summary><ul>{duplicates.map(text => <li key={text}>{text}</li>)}</ul></details></Banner>}
        {validation && !validation.success && <Banner tone="error"><ul data-testid="prompt-import-storage-errors">{validation.error.issues.slice(0, 20).map((issue, index) => { const row = typeof issue.path[1] === 'number' ? rows[issue.path[1]] : undefined; return <li key={index}>{row ? `原文第 ${row.source.line} 行 · 条目 ${row.source.number}：` : ''}{issue.message}</li> })}</ul></Banner>}
        <fieldset className="prompt-import-fields stack" disabled={locked}>
          {bulk && <details className="prompt-import-bulk" data-testid="prompt-import-bulk"><summary>统一参数 · 仅用于本次导入</summary><div className="stack"><EntryEditor entry={bulk} apis={data.apis} draftOnly parametersOnly onChange={draft => setBulk(old => old ? { ...old, draft } : old)} onProvider={provider => setBulk(old => old ? changePromptProvider(old, provider) : old)} onSettings={noSettings} checkingModels={false} onRefreshModels={() => undefined} /><button className="button" data-testid="prompt-import-apply-all" onClick={() => { setRows(old => old.map(row => ({ ...row, entry: { ...row.entry, draft: applyPromptSettings(row.entry.draft, bulk.draft) } }))); setMessage(`已将参数应用到本次 ${rows.length} 个条目，名称、提示词和歌词保持不变。`) }}>应用到本次全部条目</button></div></details>}
          {rows.slice(current * 10, current * 10 + 10).map(row => { const issue = entryIssue(row.entry, data.apis); return <article className="prompt-import-row stack" key={row.entry.id} data-testid={`prompt-import-row-${row.source.number}`}><div className="section-row"><h3>条目 {row.source.number}</h3><span className="meta">原文第 {row.source.line} 行</span><button className="text-button danger" data-testid={`prompt-import-remove-${row.source.number}`} onClick={() => setRows(old => old.filter(item => item.entry.id !== row.entry.id))}>移除本条</button></div>
            <label className="field">名称 · 可选<input data-testid="prompt-import-title" value={row.entry.draft.title ?? ''} onChange={event => edit(row.entry.id, { ...row.entry.draft, title: event.target.value || undefined })} /><span className="meta">使用现有条目名称 / 曲名语义，草稿最多 500 字符</span></label>
            <EntryEditor entry={row.entry} apis={data.apis} draftOnly onChange={draft => edit(row.entry.id, draft)} onProvider={provider => setRows(old => old.map(item => item.entry.id === row.entry.id ? { ...item, entry: changePromptProvider(item.entry, provider) } : item))} onSettings={noSettings} checkingModels={false} onRefreshModels={() => undefined} />
            {issue && <p className="field-note">可保存草稿；生成前需完善：{issue}</p>}
          </article> })}
          <Pager page={current} total={rows.length} size={10} onChange={setPage} />
        </fieldset>
        {frozen.current && <p className="meta">本次确认快照已锁定 · 批次 {frozen.current.batchId}。核对与重试使用同一批标识，不创建新批次。</p>}
      </>}
    </div>
    <footer className="dialog-footer"><button className="button" disabled={busy} onClick={close}>取消</button>{step === 'preview' && <button className="button" data-testid="prompt-import-back" disabled={busy || checkOnly} onClick={() => setConfirm('back')}>返回修改原文</button>}{step === 'paste' ? <button className="button primary" data-testid="prompt-import-parse" disabled={!raw.trim() || overLimit || Boolean(confirm)} onClick={parse}>解析预览</button> : <button className="button primary" data-testid="prompt-import-create" disabled={busy || Boolean(confirm) || (!frozen.current && !validation?.success)} onClick={() => void create()}>{busy ? '保存并核对中…' : checkOnly ? '核对本批保存结果' : `创建 ${rows.length} 个条目`}</button>}</footer>
  </Dialog>
}
