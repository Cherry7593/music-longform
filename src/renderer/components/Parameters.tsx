import { useId } from 'react'
import type { ImageDraft, MusicDraft } from '../../shared/types'
import { IMAGE_SIZES, INSTRUMENTAL_MODELS, SONG_MODELS, MUSIC_STYLES } from '../../shared/schemas'
import { modelLabel, sizeLabels, styleLabels } from '../utils'

export function MusicParameters({ value, onChange, disabled = false }: {
  value: MusicDraft; onChange: (value: MusicDraft) => void; disabled?: boolean
}) {
  const id = useId()
  const models: readonly string[] = value.mode === 'instrumental' ? INSTRUMENTAL_MODELS : SONG_MODELS
  const compatible = models.includes(value.model)
  const validCount = Number.isInteger(value.count) && value.count >= 1 && value.count <= 20
  return <div className="parameters">
    <fieldset className="mode-field" disabled={disabled}>
      <legend>生成模式</legend>
      <div className="segmented" role="group" aria-label="音乐生成模式">
        <button type="button" aria-pressed={value.mode === 'instrumental'} onClick={() => onChange({ ...value, mode: 'instrumental' })}>纯音乐</button>
        <button type="button" aria-pressed={value.mode === 'song'} onClick={() => onChange({ ...value, mode: 'song' })}>人声歌曲</button>
      </div>
    </fieldset>
    <div className="parameter-grid music-parameter-grid">
      <div className="field"><label htmlFor={`${id}-model`}>音乐模型</label>
        <select id={`${id}-model`} value={value.model} disabled={disabled} aria-invalid={!compatible} onChange={event => onChange({ ...value, model: event.target.value })}>
          {!compatible && <option value={value.model} disabled>{value.model}（此模式不可用）</option>}
          {models.map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor={`${id}-count`}>每批首数 <span className="muted">1–20</span></label>
        <input id={`${id}-count`} aria-label="每批首数" type="number" inputMode="numeric" min={1} max={20} step={1}
          value={Number.isNaN(value.count) ? '' : value.count} disabled={disabled} aria-invalid={!validCount}
          onChange={event => onChange({ ...value, count: event.target.value === '' ? NaN : Number(event.target.value) })} />
      </div>
    </div>
    {!compatible && <p className="field-error" role="alert">此模型不支持纯音乐，请选择其他模型。原有提示词未被删减。</p>}
    {!validCount && <p className="field-error" role="alert">请输入 1–20 的整数。</p>}
    {value.mode === 'song' && <details className="style-options">
      <summary>歌曲风格 <span className="muted">可选{value.styles.length ? ` · 已选 ${value.styles.length} 项` : ''}</span></summary>
      <div className="style-chips" role="group" aria-label="可选歌曲风格">
        {MUSIC_STYLES.map(style => <button type="button" key={style} className="chip" aria-pressed={value.styles.includes(style)} disabled={disabled}
          onClick={() => onChange({ ...value, styles: value.styles.includes(style) ? value.styles.filter(item => item !== style) : [...value.styles, style] })}>
          {styleLabels[style]}</button>)}
      </div>
    </details>}
  </div>
}

export function ImageParameters({ value, onChange, disabled = false }: {
  value: ImageDraft; onChange: (value: ImageDraft) => void; disabled?: boolean
}) {
  const id = useId()
  return <div className="parameters">
    <div className="field"><label htmlFor={`${id}-size`}>画面尺寸</label>
      <select id={`${id}-size`} value={value.size} disabled={disabled} onChange={event => onChange({ ...value, size: event.target.value })}>
        {IMAGE_SIZES.map(size => <option key={size} value={size}>{sizeLabels[size] ?? size}</option>)}
      </select>
    </div>
    <p className="image-model field-note" aria-label={`图片模型：${modelLabel(value.model)}`} title={value.model}>模型 · {modelLabel(value.model)}</p>
  </div>
}
