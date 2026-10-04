import { useId, useState } from 'react'
import type { VideoDraft } from '../../shared/types'

/** Keep the raw text (including incomplete/invalid input); schemas, not clamps, decide validity. */
export function NumberField({ label, value, onChange, min, max, scale = 1, disabled, testId, note }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number
  scale?: number; disabled: boolean; testId: string; note: string
}) {
  const id = useId()
  const [input, setInput] = useState({ value, text: Number.isFinite(value) ? String(value / scale) : '' })
  const text = Object.is(input.value, value) ? input.text : Number.isFinite(value) ? String(value / scale) : ''
  const invalid = !Number.isFinite(value) || value / scale < min || value / scale > max
  return <div className="field"><label htmlFor={id}>{label}</label>
    <input id={id} data-testid={testId} type="text" inputMode="decimal" value={text} disabled={disabled} autoComplete="off"
      aria-invalid={invalid} aria-describedby={`${id}-note`} onChange={event => {
        const raw = event.target.value
        const next = /^\d+(?:\.\d*)?$/.test(raw.trim()) ? Number(raw) * scale : Number.NaN
        setInput({ value: next, text: raw }); onChange(next)
      }} />
    <p className={`field-note ${invalid ? 'error-text' : ''}`} id={`${id}-note`}>{note}{invalid ? ' · 请修正，输入未丢弃' : ''}</p>
  </div>
}

export const transitionLabels = { cut: '直接拼接', fade: '淡出后淡入', crossfade: '平滑交叉淡化' } as const

export function VideoParameters({ draft, disabled, onChange }: {
  draft: VideoDraft; disabled: boolean; onChange: (draft: VideoDraft) => void
}) {
  const id = useId()
  return <div className="video-parameters">
    <div className="video-parameter-grid">
      <div className="field"><label htmlFor={`${id}-duration`}>视频时长</label>
        <select id={`${id}-duration`} data-testid="video-duration-mode" value={draft.durationMode} disabled={disabled}
          onChange={event => onChange({ ...draft, durationMode: event.target.value as VideoDraft['durationMode'] })}>
          <option value="target">目标时长</option><option value="all">全部播放一次</option>
        </select>
      </div>
      <NumberField label="目标时长（分钟）" testId="video-target-minutes" value={draft.targetSeconds} scale={60} min={1} max={360}
        note="1–360 分钟，默认 60" disabled={disabled || draft.durationMode === 'all'} onChange={targetSeconds => onChange({ ...draft, targetSeconds })} />
      <div className="field"><label htmlFor={`${id}-transition`}>音乐连接</label>
        <select id={`${id}-transition`} data-testid="video-transition" value={draft.transition} disabled={disabled}
          onChange={event => onChange({ ...draft, transition: event.target.value as VideoDraft['transition'] })}>
          {Object.entries(transitionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <NumberField label="转场时长（秒）" testId="video-transition-seconds" value={draft.transitionSeconds} min={0.5} max={10}
        note="0.5–10 秒，默认 3" disabled={disabled || draft.transition === 'cut'} onChange={transitionSeconds => onChange({ ...draft, transitionSeconds })} />
      <NumberField label="整段开头淡入（秒）" testId="video-fade-in" value={draft.fadeInSeconds} min={0} max={10}
        note="0–10 秒；0 为关闭" disabled={disabled} onChange={fadeInSeconds => onChange({ ...draft, fadeInSeconds })} />
      <NumberField label="整段结尾淡出（秒）" testId="video-fade-out" value={draft.fadeOutSeconds} min={0} max={10}
        note="0–10 秒；裁切后再淡出" disabled={disabled} onChange={fadeOutSeconds => onChange({ ...draft, fadeOutSeconds })} />
    </div>
    <p className="field-note">{draft.transition === 'crossfade' ? '相邻曲目重叠，视频总长会缩短；不自动对齐节拍或调性。' : draft.transition === 'fade' ? '前曲淡出后，后曲淡入；曲目不重叠，不主动添加间隔。' : '按顺序直接连接，不改变曲目原有首尾音量。'}</p>
    <label className="checkbox-label"><input data-testid="video-normalize" type="checkbox" checked={draft.normalize} disabled={disabled}
      onChange={event => onChange({ ...draft, normalize: event.target.checked })} /><span>音量均衡<span className="field-note"> · 可选，默认关闭；启用后分析完整曲目的响度。</span></span></label>
  </div>
}
