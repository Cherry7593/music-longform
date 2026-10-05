import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePromptImport, PROMPT_IMPORT_MAX_BYTES, utf8ByteLength } from '../../src/shared/prompt-import'
import type { PromptParseResult } from '../../src/shared/prompt-import'
import { entryDraftSchema } from '../../src/shared/workbench-schemas'
import type { GenerationKind } from '../../src/shared/workbench-types'

const header = (kind: GenerationKind): string => kind === 'audio' ? '# 音乐提示词 v1' : '# 图片提示词 v1'
const withFields = (fields: string, kind: GenerationKind = 'audio'): string => `${header(kind)}\n## 条目 1\n${fields}`
const document = (prompt = '中文提示词', kind: GenerationKind = 'audio'): string => withFields(`### 提示词\n${prompt}`, kind)

function success(text: string, kind: GenerationKind = 'audio'): Extract<PromptParseResult, { ok: true }> {
  const result = parsePromptImport(text, kind)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result
}

function failure(text: string, kind: GenerationKind = 'audio'): Extract<PromptParseResult, { ok: false }> {
  const result = parsePromptImport(text, kind)
  expect(result.ok).toBe(false)
  expect(result).not.toHaveProperty('entries')
  expect(result).not.toHaveProperty('warnings')
  if (result.ok) throw new Error('Unexpected successful parse')
  expect(result.errors.length).toBeGreaterThan(0)
  for (const issue of result.errors) {
    expect(Number.isInteger(issue.line)).toBe(true)
    expect(issue.line).toBeGreaterThan(0)
    expect(issue.message.length).toBeGreaterThan(0)
  }
  return result
}

function batch(count: number, kind: GenerationKind = 'audio'): string {
  return [header(kind), ...Array.from({ length: count }, (_, index) => `## 条目 ${index + 1}\n### 提示词\n正文 ${index + 1}`)].join('\n')
}

describe('the unchanged, delivered v1 template examples', () => {
  it.each([
    ['音乐提示词模板.md', 'audio', '晚风来信'],
    ['图片提示词模板.md', 'image', '雨夜窗边']
  ] as const)('extracts and parses the exact example from %s', (filename, kind, title) => {
    const template = readFileSync(new URL(`../../docs/templates/${filename}`, import.meta.url), 'utf8')
    const examples = [...template.matchAll(/```markdown(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)```/g)]
    expect(examples).toHaveLength(1)
    const example = examples[0][1]
    const lines = example.split(/\r\n|\r|\n/)
    const parsed = success(example, kind)
    expect(parsed).toEqual({ ok: true, entries: [
      { number: 1, line: 3, title, prompt: lines.slice(7, 9).join('\n') },
      { number: 2, line: 11, prompt: lines.slice(12, 14).join('\n') }
    ], warnings: [] })
    expect(parsed.entries.every(entry => entry.prompt.length > 80)).toBe(true)
    const wrapped = success(examples[0][0], kind)
    expect(wrapped.entries).toEqual(parsed.entries.map(entry => ({ ...entry, line: entry.line + 1 })))
    // The explanatory template itself must not be heuristically mined for entries.
    expect(failure(template, kind).errors[0].line).toBe(1)
  })
})

describe('minimal tolerances, original line numbers and literal text', () => {
  const layouts = ['\n', '\r\n', '\r'].flatMap(newline => [false, true].flatMap(bom => [undefined, '', 'md', 'markdown'].map(label => ({ newline, bom, label }))))
  it.each(layouts)('preserves content and source lines for %j', ({ newline, bom, label }) => {
    const lines = ['', ' \t', ...(label === undefined ? [] : [`\`\`\`${label} \t`, '']),
      '# 音乐提示词 v1 \t', '', '## 条目 1', '### 名称 \t', '  名称  ', '', '### 提示词\t',
      ' \t', '  中文首行 \t', '', ' \t ', '\t尾行  ', '', '### 歌词', '', '[Verse]', '  歌词  ', '', '[Chorus]', '\t副歌', '',
      ...(label === undefined ? [] : ['``` \t']), '', ' \t']
    const input = `${bom ? '\uFEFF' : ''}${lines.join(newline)}`
    expect(success(input)).toEqual({ ok: true, entries: [{
      number: 1, line: lines.indexOf('## 条目 1') + 1, title: '  名称  ',
      prompt: '  中文首行 \t\n\n \t \n\t尾行  ', lyrics: '[Verse]\n  歌词  \n\n[Chorus]\n\t副歌'
    }], warnings: [] })
  })

  it('accepts mixed CRLF, CR and LF without adding empty lines', () => {
    expect(success('\uFEFF\r\n# 音乐提示词 v1\r## 条目 1\n### 提示词\r\n第一行\r第二行\n第三行\r').entries)
      .toEqual([{ number: 1, line: 3, prompt: '第一行\n第二行\n第三行' }])
  })

  it.each(['\n', '\r\n', '\r'])('reports original error lines after BOM, blanks and a fence (%j)', newline => {
    const input = ['\uFEFF', '', '```md', '', '# 音乐提示词 v1', '## 条目 1', '### 提示词', '正文', '## 条目 2', '### 模型', '错误字段', '```', ''].join(newline)
    expect(failure(input).errors[0]).toMatchObject({ line: 10, entry: 2, message: expect.stringContaining('未知字段') })
  })

  it('preserves summaries, inline heading/fence markers and ordinary pipes literally', () => {
    const prompt = ['第一段', '', '总结：以上是完整内容。', '正文里提及 ### 提示词 和 ## 条目 9', '内联 ```markdown 不是边界',
      '#hashtag 不是 Markdown 标题', 'C# 音阶', '风格 A | 风格 B', '`普通文本`', '\uFEFF正文内的 BOM 不应删除'].join('\n')
    expect(success(document(prompt)).entries[0].prompt).toBe(prompt)
  })

  it('returns untrusted HTML, URLs and file paths as text without interpreting them', () => {
    const prompt = '<script>throw new Error("not executed")</script>\n<img src="https://invalid.example/remote" onerror="alert(1)">\nhttps://invalid.example/api?key=not-a-secret\nfile:///C:/private/example.txt\nC:\\private\\example.txt\n[链接](javascript:alert(1))'
    const result = success(withFields(`### 名称\n<img onerror="alert(1)">\n### 提示词\n${prompt}\n### 歌词\n<script>literal</script>`))
    expect(result.entries[0]).toMatchObject({ title: '<img onerror="alert(1)">', prompt, lyrics: '<script>literal</script>' })
  })

  it.each(['audio', 'image'] as const)('allows optional absent/empty titles in %s', kind => {
    expect(success(document('正文', kind), kind).entries[0].title).toBeUndefined()
    expect(success(withFields('### 名称\n \t\n\n### 提示词\n正文', kind), kind).entries[0].title).toBeUndefined()
  })

  it('treats empty optional lyrics as undefined and resets all fields between entries', () => {
    const result = success(withFields('### 名称\n名称\n### 提示词\n一\n### 歌词\n \t\n\n## 条目 2\n### 提示词\n二'))
    expect(result.entries).toEqual([{ number: 1, line: 2, title: '名称', prompt: '一', lyrics: undefined }, { number: 2, line: 10, prompt: '二' }])
    expect(success(withFields('### 提示词\n正文\n### 歌词')).entries[0].lyrics).toBeUndefined()
  })

  it.each(['一\n二', '一\n\n二', '一\n \t\n二'])('rejects a multiline title (%j)', title => {
    expect(failure(withFields(`### 名称\n${title}\n### 提示词\n正文`)).errors[0])
      .toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('名称只能有一行') })
  })
})

describe('strict document, entry and field structure', () => {
  it.each(['', '\uFEFF \r\n\t', '```\n```', '```md\n \n```'])('rejects empty input %j', input => {
    expect(failure(input).errors[0].message).toContain('空')
  })

  it.each(['# 音乐提示词 v2', '#音乐提示词 v1', ' # 音乐提示词 v1', '# 音乐提示词 v1 #', '## 音乐提示词 v1', '\uFEFF\uFEFF# 音乐提示词 v1'])('does not repair invalid document headers %j', invalid => {
    expect(failure(`${invalid}\n## 条目 1\n### 提示词\n正文`).errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('首行') })
  })

  it.each(['audio', 'image'] as const)('rejects a document of the other kind in %s', kind => {
    expect(failure(`\uFEFF\n\n${document('正文', kind === 'audio' ? 'image' : 'audio')}`, kind).errors[0])
      .toMatchObject({ line: 3, message: expect.stringContaining('类型不符') })
  })

  it('rejects unsupported runtime kinds instead of treating them as images', () => {
    expect(failure(document(), 'video' as GenerationKind).errors[0].message).toContain('类型错误')
  })

  it.each(['# 音乐提示词 v1', '# 图片提示词 v1'])('rejects a second or mixed document header %j', repeated => {
    expect(failure(`${document()}\n${repeated}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('只能在首行') })
  })

  it.each(['### 歌词', '### 歌词\n歌词'])('rejects even an empty lyrics field in an image document (%j)', lyrics => {
    expect(failure(`${document('正文', 'image')}\n${lyrics}`, 'image').errors[0])
      .toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('图片条目不允许') })
  })

  it.each([
    ['### 提示词\n正文', 2, undefined],
    ['说明文字\n## 条目 1\n### 提示词\n正文', 2, undefined],
    ['## 条目 1\n字段前的正文\n### 提示词\n正文', 3, 1]
  ] as const)('rejects text or fields outside their required structure (%j)', (content, line, entry) => {
    expect(failure(`# 音乐提示词 v1\n${content}`).errors[0]).toMatchObject({ line })
    expect(failure(`# 音乐提示词 v1\n${content}`).errors[0].entry).toBe(entry)
  })

  it.each([
    ['### 名称\n甲\n### 名称\n乙\n### 提示词\n正文', 5],
    ['### 名称\n\n### 名称\n\n### 提示词\n正文', 5],
    ['### 提示词\n甲\n### 提示词\n乙', 5],
    ['### 提示词\n正文\n### 歌词\n甲\n### 歌词\n乙', 7],
    ['### 提示词\n正文\n### 歌词\n\n### 歌词', 7]
  ] as const)('rejects duplicate fields, including empty optional fields (%j)', (fields, line) => {
    expect(failure(withFields(fields)).errors[0]).toMatchObject({ line, entry: 1, message: expect.stringContaining('重复') })
  })

  it.each([
    ['### 提示词\n正文\n### 名称\n名称', 5],
    ['### 歌词\n歌词\n### 提示词\n正文', 3],
    ['### 名称\n名称\n### 歌词\n歌词\n### 提示词\n正文', 5],
    ['### 提示词\n正文\n### 歌词\n歌词\n### 名称\n名称', 7]
  ] as const)('rejects out-of-order fields (%j)', (fields, line) => {
    expect(failure(withFields(fields)).errors[0]).toMatchObject({ line, entry: 1, message: expect.stringContaining('顺序错误') })
  })

  it.each(['### 模型', '### API', '### 名称：', '### 提示词 extra', '### 提示词 ###', '###  提示词', '###'])('rejects unknown or inexact field headings %j', heading => {
    expect(failure(`${document()}\n${heading}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('未知字段') })
  })

  it.each(['# Verse', '## 提示词', '#### 提示词', '##### 名称', '####### 提示词', '  ### 名称', '\t### 提示词', '##  条目 2', '#'])('rejects other Markdown headings or wrong levels %j', heading => {
    expect(failure(`${document()}\n${heading}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('标题层级') })
  })

  it.each(['', ' \t\n\u3000', '\n\n'])('rejects empty/whitespace prompts (%j)', prompt => {
    expect(failure(document(prompt)).errors[0]).toMatchObject({ line: 3, entry: 1, message: expect.stringContaining('提示词不能为空') })
  })

  it('reports the original empty prompt field, even before a subsequent entry', () => {
    const input = '\uFEFF\n```markdown\n# 音乐提示词 v1\n## 条目 1\n### 提示词\n\t\n## 条目 2\n### 提示词\n有内容\n```'
    expect(failure(input).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('提示词不能为空') })
  })

  it.each(['## 条目 1', '## 条目 1\n### 名称\n名称', '## 条目 1\n### 名称\n\n## 条目 2\n### 提示词\n正文'])('rejects missing prompt fields (%j)', content => {
    expect(failure(`# 音乐提示词 v1\n${content}`).errors[0]).toMatchObject({ line: 2, entry: 1, message: expect.stringContaining('缺少') })
  })

  it.each([
    ['## 条目 2\n### 提示词\n正文', 2, 2],
    ['## 条目 1\n### 提示词\n甲\n## 条目 1\n### 提示词\n乙', 5, 1],
    ['## 条目 1\n### 提示词\n甲\n## 条目 3\n### 提示词\n乙', 5, 3],
    ['## 条目 1\n### 提示词\n甲\n## 条目 2\n### 提示词\n乙\n## 条目 1\n### 提示词\n丙', 8, 1]
  ] as const)('rejects noncontinuous, repeated or reversed entry numbers (%j)', (content, line, entry) => {
    expect(failure(`# 音乐提示词 v1\n${content}`).errors[0]).toMatchObject({ line, entry, message: expect.stringContaining('连续') })
  })

  it.each(['0', '01', '-1', '+1', '1.0', '1e0', '一', '１', '9007199254740993'])('does not repair invalid entry numbers %j', number => {
    expect(failure(`# 音乐提示词 v1\n## 条目 ${number}\n### 提示词\n正文`).errors[0])
      .toMatchObject({ line: 2, message: expect.stringMatching(/编号|条目标题/) })
  })

  it('discards all parsed entries and warnings if a later entry fails', () => {
    const input = `${document('重复')}\n## 条目 2\n### 提示词\n重复\n## 条目 3\n### 提示词\n正文\n### 不支持`
    expect(failure(input).errors[0]).toMatchObject({ line: 11, entry: 3, message: expect.stringContaining('未知字段') })
  })
})

describe('only one complete, supported outer fence; no Markdown tables or blocks', () => {
  it.each(['```text', '```json', '```MD', '``` markdown', '````md', '~~~md', ' ```md'])('rejects unsupported outer fences %j', opening => {
    expect(failure(`${opening}\n${document()}\n\`\`\``).errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('外层围栏只支持') })
  })

  it.each(['```', '```md', '```markdown'])('rejects unclosed fences %j with their original opening line', opening => {
    expect(failure(`\uFEFF\n\n${opening}\n${document()}\n`).errors[0]).toMatchObject({ line: 3, message: expect.stringContaining('未闭合') })
  })

  it('rejects a nonexact closing fence rather than repairing it', () => {
    expect(failure(`\`\`\`md\n${document()}\n\`\`\`markdown`).errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('未闭合') })
  })

  it('rejects outside explanations before the opening fence', () => {
    expect(failure(`\uFEFF\n说明文字\n\`\`\`md\n${document()}\n\`\`\``).errors[0])
      .toMatchObject({ line: 2, message: expect.stringContaining('只粘贴结果') })
  })

  it('rejects outside explanations after the closing fence', () => {
    expect(failure(`\uFEFF\n\`\`\`md\n${document()}\n\`\`\`\n\n这是解释\n`).errors[0])
      .toMatchObject({ line: 9, message: expect.stringContaining('围栏之外') })
  })

  it('rejects multiple complete content blocks rather than extracting or merging them', () => {
    expect(failure(`\`\`\`md\n${document()}\n\`\`\`\n\`\`\`md\n${document()}\n\`\`\``).errors[0])
      .toMatchObject({ line: 6, entry: 1, message: expect.stringContaining('多个内容代码块') })
  })

  it.each(['```', '```js', '````', '~~~', '  ```md'])('rejects fenced blocks nested in body text %j', nested => {
    expect(failure(`${document()}\n${nested}\n正文\n${nested}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('嵌套代码围栏') })
    expect(failure(`\`\`\`md\n${document()}\n${nested}\n正文\n\`\`\``).errors[0]).toMatchObject({ line: 6, entry: 1 })
  })

  it.each(['| 名称 | 提示词 |', '| --- | :---: |', '--- | :---:', '-|-', '| 单列 |'])('rejects table forms %j', table => {
    expect(failure(`${document()}\n${table}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('表格') })
  })

  it.each(['===', '---', '* * *', '___', '- - -'])('rejects Setext headings or Markdown separators %j', separator => {
    expect(failure(`${document()}\n${separator}`).errors[0]).toMatchObject({ line: 5, entry: 1, message: expect.stringContaining('标题或分隔线') })
  })
})

describe('batch, draft-field and raw UTF-8 limits', () => {
  it.each(['audio', 'image'] as const)('accepts 1 and exactly 500 entries but rejects 0 and 501 for %s', kind => {
    expect(success(batch(1, kind), kind).entries).toHaveLength(1)
    const maximum = success(batch(500, kind), kind)
    expect(maximum.entries).toHaveLength(500)
    expect(maximum.entries[499]).toEqual({ number: 500, line: 1499, prompt: '正文 500' })
    expect(failure(batch(0, kind), kind).errors[0].message).toContain('至少需要 1')
    expect(failure(batch(501, kind), kind).errors[0]).toMatchObject({ line: 1502, entry: 501, message: expect.stringContaining('最多导入 500') })
  })

  it.each([
    ['title', '名称', 500, 3], ['prompt', '提示词', 32000, 5], ['lyrics', '歌词', 32000, 7]
  ] as const)('matches the entryDraftSchema %s storage limit, not provider limits', (field, label, maximum, line) => {
    const fields = { title: '名称', prompt: '正文', lyrics: '歌词' }
    fields[field] = '中'.repeat(maximum)
    const input = (): string => withFields(`### 名称\n${fields.title}\n### 提示词\n${fields.prompt}\n### 歌词\n${fields.lyrics}`)
    const parsed = success(input()).entries[0]
    expect(parsed[field]).toBe(fields[field])
    expect(entryDraftSchema.safeParse({ model: '', title: parsed.title, prompt: parsed.prompt, lyrics: parsed.lyrics }).success).toBe(true)
    fields[field] += '中'
    expect(entryDraftSchema.safeParse({ model: '', ...fields }).success).toBe(false)
    expect(failure(input()).errors[0]).toMatchObject({ line, entry: 1, message: expect.stringContaining(`${label}超过草稿存储上限 ${maximum}`) })
  })

  it('counts meaningful spaces and newlines toward draft storage limits, just like the schema', () => {
    expect(failure(withFields(`### 名称\n ${'a'.repeat(500)}\n### 提示词\n正文`)).errors[0].message).toContain('500')
    expect(failure(document(`${'a'.repeat(16000)}\n${'b'.repeat(16000)}`)).errors[0].message).toContain('32000')
    expect(success(withFields(`### 名称\n${'🎵'.repeat(250)}\n### 提示词\n正文`)).entries[0].title).toHaveLength(500)
    expect(failure(withFields(`### 名称\n${'🎵'.repeat(251)}\n### 提示词\n正文`)).errors[0].message).toContain('500')
  })

  it.each(['*', '_', '-'])('preserves long spaced prose starting with %s, not treating it as a separator', marker => {
    const prompt = marker.repeat(3) + ' '.repeat(31994) + 'end'
    expect(success(document(prompt)).entries[0].prompt).toBe(prompt)
  })

  it.each([['', 0], ['abc', 3], ['中', 3], ['🎵', 4], ['a中🎵', 8], ['\uFEFF', 3], ['\ud800', 3]] as const)('uses TextEncoder UTF-8 byte length for %j', (text, length) => {
    expect(utf8ByteLength(text)).toBe(length)
  })

  it('accepts exactly 2 MiB raw bytes and rejects one byte more before trimming BOM/fences/blank lines', () => {
    expect(PROMPT_IMPORT_MAX_BYTES).toBe(2097152)
    const source = `\uFEFF\n\`\`\`md\n${document('中🎵')}\n\`\`\`\n`
    const input = source + ' '.repeat(PROMPT_IMPORT_MAX_BYTES - utf8ByteLength(source))
    expect(utf8ByteLength(input)).toBe(PROMPT_IMPORT_MAX_BYTES)
    expect(success(input).entries[0]).toEqual({ number: 1, line: 4, prompt: '中🎵' })
    expect(failure(`${input} `).errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('2 MiB') })
  })

  it('checks raw multibyte input rather than UTF-16 length, without truncating', () => {
    const input = document('中'.repeat(Math.ceil(PROMPT_IMPORT_MAX_BYTES / 3)))
    expect(input.length).toBeLessThan(PROMPT_IMPORT_MAX_BYTES)
    expect(utf8ByteLength(input)).toBeGreaterThan(PROMPT_IMPORT_MAX_BYTES)
    expect(failure(input).errors[0].message).toContain('2 MiB')
  })
})

describe('duplicate prompts are warning-only, exact and non-destructive', () => {
  it('keeps every entry in order and reports duplicate source lines after wrapper removal', () => {
    const input = '\uFEFF\n```md\n# 音乐提示词 v1\n## 条目 1\n### 名称\n甲\n### 提示词\n重复\n## 条目 2\n### 名称\n乙\n### 提示词\n\n重复\n\n## 条目 3\n### 提示词\n重复\n```'
    const result = success(input)
    expect(result.entries).toEqual([
      { number: 1, line: 4, title: '甲', prompt: '重复' },
      { number: 2, line: 9, title: '乙', prompt: '重复' },
      { number: 3, line: 16, prompt: '重复' }
    ])
    expect(result.warnings).toEqual([
      { line: 12, entry: 2, message: expect.stringContaining('条目 1 重复') },
      { line: 17, entry: 3, message: expect.stringContaining('条目 1 重复') }
    ])
  })

  it('does not normalize meaningful spaces or internal blank lines to guess duplicates', () => {
    const prompts = ['风格', ' 风格', '风格 ', '风\n格', '风\n\n格']
    const input = [header('image'), ...prompts.map((prompt, index) => `## 条目 ${index + 1}\n### 提示词\n${prompt}`)].join('\n')
    const result = success(input, 'image')
    expect(result.entries.map(entry => entry.prompt)).toEqual(prompts)
    expect(result.warnings).toEqual([])
  })
})
