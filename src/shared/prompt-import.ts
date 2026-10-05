import type { GenerationKind } from './workbench-types'

export const PROMPT_IMPORT_MAX_BYTES = 2 * 1024 * 1024

export interface PromptTextEntry {
  number: number
  /** One-based entry heading line in the original pasted text. */
  line: number
  title?: string
  prompt: string
  lyrics?: string
}

export interface PromptImportIssue {
  line: number
  entry?: number
  message: string
}

export type PromptParseResult =
  | { ok: true; entries: PromptTextEntry[]; warnings: PromptImportIssue[] }
  | { ok: false; errors: PromptImportIssue[] }

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

type Field = 'title' | 'prompt' | 'lyrics'
const fieldLabels: Record<Field, string> = { title: '名称', prompt: '提示词', lyrics: '歌词' }
const fieldOrder: Record<Field, number> = { title: 0, prompt: 1, lyrics: 2 }
// Storage limits from entryDraftSchema, not provider-specific generation limits.
const fieldLimits: Record<Field, number> = { title: 500, prompt: 32000, lyrics: 32000 }
const headers = { audio: '# 音乐提示词 v1', image: '# 图片提示词 v1' } as const
const blank = (line: string): boolean => line.trim().length === 0
const fence = (line: string): boolean => /^\s*(?:`{3,}|~{3,})/.test(line)

function failure(line: number, message: string, entry?: number): PromptParseResult {
  return { ok: false, errors: [{ line, ...(entry === undefined ? {} : { entry }), message }] }
}

function tableLine(line: string): boolean {
  const value = line.trim()
  if (/^\|.*\|$/.test(value)) return true
  // Also reject Markdown table delimiters without outside pipes; ordinary A | B is text.
  return value.includes('|') && value.replace(/^\||\|$/g, '').split('|').every(cell => /^:?-+:?$/.test(cell.trim()))
}

/** Strict v1 protocol only. Failure never exposes even the already parsed entries. */
export function parsePromptImport(text: string, kind: GenerationKind): PromptParseResult {
  if (utf8ByteLength(text) > PROMPT_IMPORT_MAX_BYTES) return failure(1, '粘贴原文超过 2 MiB（UTF-8 字节）上限，请分批导入；不会截断内容。')
  if (kind !== 'audio' && kind !== 'image') return failure(1, '导入类型错误，只支持音乐或图片。')

  // Keep indices in this original line array: removing wrappers must not renumber diagnostics.
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  let start = 0
  let end = lines.length
  const trimBlankLines = (): void => {
    while (start < end && blank(lines[start])) start++
    while (end > start && blank(lines[end - 1])) end--
  }
  trimBlankLines()
  if (start === end) return failure(1, '粘贴内容为空，请粘贴包含 1–500 个条目的完整结果。')

  if (/^```(?:md|markdown)?$/.test(lines[start].trimEnd())) {
    const opening = start
    if (end - start < 2 || lines[end - 1].trimEnd() !== '```') {
      const closing = lines.findIndex((line, index) => index > opening && index < end && line.trimEnd() === '```')
      if (closing !== -1) {
        let outside = closing + 1
        while (outside < end && blank(lines[outside])) outside++
        return failure(outside + 1, '外层代码围栏之外有非空说明，请只粘贴完整结果。')
      }
      return failure(opening + 1, '外层三反引号代码围栏未闭合，结束围栏必须是独立一行的 ```。')
    }
    start++
    end--
    trimBlankLines()
    if (start === end) return failure(opening + 1, '外层代码围栏内为空，请粘贴完整结果。')
  } else if (fence(lines[start])) {
    return failure(start + 1, '外层围栏只支持一个完整的三反引号代码块，标签只能为空、md 或 markdown，且不得缩进。')
  }

  const header = lines[start].trimEnd()
  if (header !== headers[kind]) {
    if (header === headers.audio || header === headers.image) return failure(start + 1, `文档类型不符：当前需要 ${headers[kind]}，不能混用音乐与图片。`)
    return failure(start + 1, `首行必须精确为 ${headers[kind]}；请只粘贴结果，不要包含围栏外说明。`)
  }

  const entries: PromptTextEntry[] = []
  const warnings: PromptImportIssue[] = []
  const prompts = new Map<string, number>()
  let current: PromptTextEntry | undefined
  let field: Field | undefined
  let fieldLine = 0
  let bodyStart = 0
  let promptLine = 0
  let lastOrder = -1
  const seenFields = new Set<Field>()

  const finishField = (stop: number): PromptImportIssue | undefined => {
    if (!current || !field) return
    let first = bodyStart
    while (first < stop && blank(lines[first])) first++
    while (stop > first && blank(lines[stop - 1])) stop--
    if (field === 'title' && stop - first > 1) return { line: first + 2, entry: current.number, message: '名称只能有一行内容，不能包含内部空行或多行。' }
    const value = lines.slice(first, stop).join('\n')
    if (value.length > fieldLimits[field]) return { line: fieldLine, entry: current.number, message: `${fieldLabels[field]}超过草稿存储上限 ${fieldLimits[field]} 个字符，不会截断内容。` }
    if (field === 'prompt') {
      if (!value) return { line: fieldLine, entry: current.number, message: '提示词不能为空。' }
      current.prompt = value
    } else {
      current[field] = value || undefined
    }
  }

  const finishEntry = (stop: number): PromptImportIssue | undefined => {
    if (!current) return
    const issue = finishField(stop)
    if (issue) return issue
    if (!seenFields.has('prompt')) return { line: current.line, entry: current.number, message: '条目缺少必须且只能出现一次的 ### 提示词 字段。' }
    const duplicate = prompts.get(current.prompt)
    if (duplicate !== undefined) warnings.push({ line: promptLine, entry: current.number, message: `提示词与条目 ${duplicate} 重复，已保留全部条目，不会合并或删除。` })
    else prompts.set(current.prompt, current.number)
    entries.push(current)
  }

  for (let index = start + 1; index < end; index++) {
    const raw = lines[index]
    const heading = raw.trimEnd()
    const line = index + 1
    const entryHeading = /^## 条目 (\d+)$/.exec(heading)
    if (entryHeading) {
      const issue = finishEntry(index)
      if (issue) return { ok: false, errors: [issue] }
      const number = Number(entryHeading[1])
      if (!Number.isSafeInteger(number) || !/^[1-9]\d*$/.test(entryHeading[1])) return failure(line, '条目编号必须为从 1 开始的正整数，不能有前导零。', Number.isSafeInteger(number) ? number : undefined)
      const expected = entries.length + 1
      if (number !== expected) return failure(line, `条目编号必须从 1 连续，不得重复或跳号：应为 ${expected}，实际为 ${number}。`, number)
      if (expected > 500) return failure(line, '单次最多导入 500 个条目，请分批导入；不会截断内容。', number)
      current = { number, line, prompt: '' }
      field = undefined
      seenFields.clear()
      lastOrder = -1
      continue
    }

    const fieldHeading = /^### (名称|提示词|歌词)$/.exec(heading)
    if (fieldHeading) {
      if (!current) return failure(line, '字段必须位于条目内，请先填写 ## 条目 1。')
      const issue = finishField(index)
      if (issue) return { ok: false, errors: [issue] }
      const next: Field = fieldHeading[1] === '名称' ? 'title' : fieldHeading[1] === '提示词' ? 'prompt' : 'lyrics'
      if (next === 'lyrics' && kind === 'image') return failure(line, '图片条目不允许 ### 歌词 字段。', current.number)
      if (seenFields.has(next)) return failure(line, `${fieldLabels[next]}字段重复，每个字段只能出现一次。`, current.number)
      if (fieldOrder[next] < lastOrder || (next === 'lyrics' && !seenFields.has('prompt'))) return failure(line, '字段顺序错误：应为名称（可选）、提示词、歌词（音乐可选）。', current.number)
      field = next
      fieldLine = line
      bodyStart = index + 1
      lastOrder = fieldOrder[next]
      seenFields.add(next)
      if (next === 'prompt') promptLine = line
      continue
    }

    if (heading === headers.audio || heading === headers.image) return failure(line, '文档标题只能在首行出现一次，音乐与图片类型不能混用。', current?.number)
    if (fence(raw)) return failure(line, '正文不允许嵌套代码围栏或多个内容代码块；仅支持一个完整外层围栏，围栏之外不得有说明。', current?.number)
    if (/^\s*#+(?:\s|$)/.test(raw)) {
      if (/^###(?:\s|$)/.test(raw)) return failure(line, '未知字段或字段标题格式错误：仅支持独立的 ### 名称、### 提示词，以及音乐的 ### 歌词。', current?.number)
      if (/^## 条目(?:\s|$)/.test(raw)) return failure(line, '条目标题格式错误，必须精确为 ## 条目 N，编号从 1 连续。', current?.number)
      return failure(line, '标题层级或格式错误：只允许固定文档、条目、字段标题，不得缩进或在正文中使用其他 Markdown 标题。', current?.number)
    }
    if (tableLine(raw)) return failure(line, '不支持表格形式，请使用固定条目和字段标题。', current?.number)
    // Strip horizontal spacing before testing separators, avoiding nested whitespace backtracking.
    const plain = raw.trim()
    if (/^(?:=+|-+)$/.test(plain) || /^(?:\*{3,}|_{3,}|-{3,})$/.test(plain.replace(/[ \t]/g, ''))) return failure(line, '不支持 Markdown 下划线标题或分隔线，请使用固定标题和纯文本正文。', current?.number)
    if (!blank(raw) && (!current || !field)) return failure(line, '正文必须位于条目的字段标题下；请只粘贴结果，不要附加说明。', current?.number)
  }

  const issue = finishEntry(end)
  if (issue) return { ok: false, errors: [issue] }
  if (entries.length === 0) return failure(start + 1, '至少需要 1 个条目，单次最多 500 个。')
  return { ok: true, entries, warnings }
}
