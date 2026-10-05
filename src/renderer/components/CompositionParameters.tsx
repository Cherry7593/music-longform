import { useId, useState } from 'react'
import type { CompositionDraft } from '../../shared/workbench-types'

export const transitionLabels = { cut: '直接拼接', fade: '淡出后淡入', crossfade: '平滑交叉淡化' } as const
export function NumberField({ label, value, onChange, min, max, scale = 1, disabled = false, testId, note }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number; scale?: number; disabled?: boolean; testId?: string; note?: string }) {
  const id = useId()
  const [input, setInput] = useState({ value, text: Number.isFinite(value) ? String(value / scale) : '' })
  const text = Object.is(input.value, value) ? input.text : Number.isFinite(value) ? String(value / scale) : ''
  const invalid = !Number.isFinite(value) || value / scale < min || value / scale > max
  return <label className="field" htmlFor={id}>{label}<input id={id} data-testid={testId} type="text" inputMode="decimal" value={text} disabled={disabled} aria-invalid={invalid} onChange={e => { const raw = e.target.value; const next = /^\d+(?:\.\d*)?$/.test(raw.trim()) ? Number(raw) * scale : Number.NaN; setInput({ value: next, text: raw }); onChange(next) }} /><span className={`meta ${invalid ? 'error-text' : ''}`}>{note ?? `${min}–${max}`}{invalid ? ' · 请修正，输入已保留' : ''}</span></label>
}
export function CompositionParameters({ value, disabled, onChange }: { value: CompositionDraft; disabled: boolean; onChange: (value: CompositionDraft) => void }) {
  const set = <K extends keyof CompositionDraft>(key: K, next: CompositionDraft[K]): void => onChange({ ...value, [key]: next })
  return <fieldset className="stack plain-fieldset" disabled={disabled}><NumberField label="每条视频最短时长 · 分钟" value={value.minimumSeconds} min={1} max={360} scale={60} testId="composition-minimum-minutes" note="1–360 分钟，整首播放，允许超出；不循环、不裁歌、不补静音" onChange={next => set('minimumSeconds', next)} />
    <details className="advanced"><summary>转场与画面 <span className="meta">{transitionLabels[value.transition]} · {value.fit === 'contain' ? '完整显示' : '居中裁切'}</span></summary><div className="stack"><div className="form-grid">
      <label className="field">音乐连接<select value={value.transition} data-testid="composition-transition" onChange={e => set('transition', e.target.value as CompositionDraft['transition'])}>{Object.entries(transitionLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <NumberField label="转场时长 · 秒" value={value.transitionSeconds} min={0.5} max={10} disabled={disabled || value.transition === 'cut'} onChange={next => set('transitionSeconds', next)} />
      <NumberField label="整段开头淡入 · 秒" value={value.fadeInSeconds} min={0} max={10} onChange={next => set('fadeInSeconds', next)} />
      <NumberField label="整段结尾淡出 · 秒" value={value.fadeOutSeconds} min={0} max={10} onChange={next => set('fadeOutSeconds', next)} />
      <label className="field">画面适配<select value={value.fit} onChange={e => set('fit', e.target.value as CompositionDraft['fit'])}><option value="contain">完整显示 · 必要时留黑边</option><option value="cover">居中裁切铺满 · 保持比例</option></select></label>
    </div><label className="checkbox-label"><input type="checkbox" checked={value.normalize} onChange={e => set('normalize', e.target.checked)} />音量均衡 · 默认关闭，启用会分析完整曲目</label><p className="meta">交叉淡化会重叠相邻曲目；规划时已扣除重叠。输出固定 1920 × 1080 / 30fps / H.264 + AAC。</p></div></details>
  </fieldset>
}
