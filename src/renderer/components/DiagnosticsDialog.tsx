import { useEffect, useState } from 'react'
import type { DiagnosticRecord } from '../../shared/workbench-types'
import { messageOf } from '../useWorkspace'
import { Dialog } from './Dialog'
import { Banner, useAction } from './Common'

export function DiagnosticsDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [records, setRecords] = useState<DiagnosticRecord[]>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [copied, setCopied] = useState<string>()
  const action = useAction()
  useEffect(() => { let active = true; window.canvas.getDiagnostics(taskId).then(result => { if (active) { setRecords(result); setError(undefined) } }, e => { if (active) setError(messageOf(e)) }); return () => { active = false } }, [taskId, retry])
  return <Dialog title="任务诊断" description={`任务 ${taskId} · 按每次尝试保留证据`} className="diagnostic-dialog" onClose={onClose}><div className="dialog-body stack">{error && <Banner tone="error">{error}<button className="text-button" onClick={() => setRetry(n => n + 1)}>重试读取</button></Banner>}{!records && !error && <p role="status">读取诊断中…</p>}{records?.length === 0 && <p className="meta">尚无诊断记录。原因未确定时，不会推断为素材损坏。</p>}{records?.map(record => <article key={record.id} className="diagnostic-record stack"><div className="section-row"><h3>{record.message}</h3><button className="button" data-testid={`diagnostic-copy-${record.id}`} disabled={action.busy} onClick={() => void action.run(async () => { await window.canvas.copyDiagnostic(record.id); setCopied(record.id) })}>{copied === record.id ? '已复制' : '复制安全诊断'}</button></div><dl className="key-values"><dt>阶段 / 分类</dt><dd>{record.stage} / {record.category}</dd><dt>尝试 / 时间</dt><dd>{record.attemptId} · {new Date(record.createdAt).toLocaleString('zh-CN')}</dd><dt>工具 / 编码器</dt><dd>{record.toolVersion ?? '未记录'} / {record.encoder ?? '未记录'}</dd><dt>相关素材</dt><dd>{record.assetName ?? '未记录'} {record.assetId}</dd><dt>退出码 / 系统错误</dt><dd>{record.exitCode === undefined ? '未记录' : String(record.exitCode)} / {record.osCode ?? '无'}</dd><dt>处理建议</dt><dd>{record.suggestion}</dd></dl><details><summary>脱敏 stderr</summary><pre>{record.stderr || '未记录 stderr'}</pre></details></article>)}{action.error && <Banner tone="error">{action.error}</Banner>}</div><footer className="dialog-footer"><button className="button" onClick={onClose}>关闭</button></footer></Dialog>
}
