// 절 단위 나누기. `#` · `##` · `###` 에서 나누고 `####` 이하는 부모 절에 둔다.
// 부르는 곳: core/adapter.ts · core/build.ts · index.ts. 먼저 읽을 파일: core/model.ts(Chunk).
// 긴 절은 문단 → 목록 항목 · `####` 경계 → 글자 수 순서로 자르고, 글자 수로 자를 때만 겹침을 둔다.
// 큰 표는 머리 행을 되풀이해 정해진 행 수씩 묶는다. 코드 울타리 안의 `#` 줄은 제목으로 보지 않는다.
import type { Chunk, Level, SourceUnit } from './model.ts'
import { levelMarks, sectionLevels } from './section-level.ts'
import { shortHash, slugify } from './util.ts'

export interface ChunkRules {
  maxChars: number
  overlapChars: number
  tableRowsPerChunk: number
}

export const DEFAULT_RULES: ChunkRules = { maxChars: 1800, overlapChars: 150, tableRowsPerChunk: 30 }

export function rulesLabel(r: ChunkRules): string {
  return `section/1 maxChars=${r.maxChars} overlap=${r.overlapChars} rows=${r.tableRowsPerChunk}`
}

/** 그림 줄 해석기. 맞으면 그림 조각 본문을 돌려준다. */
export interface FigureReader {
  match(line: string, unit: SourceUnit): { num: string; caption: string; text: string } | null
}

interface Line {
  no: number
  text: string
}

interface Section {
  depth: number
  heading: string
  parentHeading: string | null
  lines: Line[]
  headingLine: number
}

interface Block {
  lines: Line[]
  kind: 'para' | 'table' | 'code' | 'list'
  /** 표 묶음은 따로 조각이 된다. */
  standalone?: boolean
}

const FENCE = /^\s*(```|~~~)/

/** HTML 주석을 지운다. 줄 수는 그대로 둔다(여러 줄 주석은 빈 줄로). */
export function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
}

/** 머리말(`---` 로 감싼 첫 부분)을 빈 줄로 바꾼다. 줄 번호는 그대로 둔다. */
export function stripFrontmatter(md: string): string {
  if (!/^---\r?\n/.test(md)) return md
  const lines = md.split('\n')
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return md
  return lines.map((l, i) => (i <= end ? '' : l)).join('\n')
}

function splitSections(lines: Line[]): Section[] {
  const out: Section[] = []
  let cur: Section = { depth: 0, heading: '', parentHeading: null, lines: [], headingLine: lines[0]?.no ?? 1 }
  let fence = false
  let h2: string | null = null
  for (const l of lines) {
    if (FENCE.test(l.text)) fence = !fence
    const m = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l.text)
    if (m && !FENCE.test(l.text)) {
      out.push(cur)
      const depth = m[1].length
      if (depth <= 2) h2 = m[2]
      cur = { depth, heading: m[2].trim(), parentHeading: depth === 3 ? h2 : null, lines: [], headingLine: l.no }
      continue
    }
    cur.lines.push(l)
  }
  out.push(cur)
  return out
}

/**
 * 본문이 없는 `##` 라도 바로 아래에 `###` 가 오면 제목만 있는 조각을 남긴다. 빼면 차례 · 경로에서 큰 절이 사라지고
 * 아래 작은 절이 앞 큰 절에 붙는다. 검색에는 제목(가중치 3)으로만 걸린다. 페이지 제목과 같은 `##`(설계 산출물 장 제목)은 제외한다.
 */
function isBodylessParent(sections: Section[], si: number, hasContent: boolean, pageTitle: string): boolean {
  return !hasContent && sections[si].depth === 2 && sections[si].heading !== pageTitle && sections[si + 1]?.depth === 3
}

function isTableLine(t: string): boolean {
  return /^\s*\|/.test(t)
}

function isListLine(t: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(t)
}

/** 절 본문을 덩어리 단위(문단 · 표 · 코드 · 목록)로 나눈다. */
function toBlocks(lines: Line[], rules: ChunkRules): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const t = lines[i].text
    if (!t.trim()) {
      i++
      continue
    }
    if (FENCE.test(t)) {
      const start = i
      i++
      while (i < lines.length && !FENCE.test(lines[i].text)) i++
      i++
      blocks.push({ kind: 'code', lines: lines.slice(start, i) })
      continue
    }
    if (isTableLine(t)) {
      const start = i
      while (i < lines.length && isTableLine(lines[i].text)) i++
      blocks.push(...splitTable(lines.slice(start, i), rules))
      continue
    }
    const start = i
    const list = isListLine(t)
    i++
    while (i < lines.length && lines[i].text.trim() && !FENCE.test(lines[i].text) && !isTableLine(lines[i].text)) {
      // 목록 묶음은 다음 목록 항목마다 덩어리 경계 후보를 둔다(길 때만 쓰인다).
      i++
    }
    blocks.push({ kind: list ? 'list' : 'para', lines: lines.slice(start, i) })
  }
  return blocks
}

function splitTable(rows: Line[], rules: ChunkRules): Block[] {
  const chars = rows.reduce((n, r) => n + r.text.length + 1, 0)
  const hasHead = rows.length >= 2 && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1].text)
  const head = hasHead ? rows.slice(0, 2) : []
  const body = hasHead ? rows.slice(2) : rows
  if (body.length <= rules.tableRowsPerChunk && chars <= rules.maxChars) return [{ kind: 'table', lines: rows }]
  // 행 수 상한과 글자 수 상한을 함께 지키도록 묶는다.
  const headChars = head.reduce((n, r) => n + r.text.length + 1, 0)
  const out: Block[] = []
  let cur: Line[] = []
  let curChars = headChars
  for (const r of body) {
    if (cur.length && (cur.length >= rules.tableRowsPerChunk || curChars + r.text.length + 1 > rules.maxChars)) {
      out.push({ kind: 'table', lines: [...head, ...cur], standalone: true })
      cur = []
      curChars = headChars
    }
    cur.push(r)
    curChars += r.text.length + 1
  }
  if (cur.length) out.push({ kind: 'table', lines: [...head, ...cur], standalone: true })
  return out
}

function blockText(b: Block): string {
  return b.lines.map((l) => l.text).join('\n')
}

/** 한 덩어리가 상한보다 길면 목록 항목 · `####` 경계로, 그래도 길면 글자 수로 자른다. */
function splitLongBlock(b: Block, rules: ChunkRules): Block[] {
  if (blockText(b).length <= rules.maxChars) return [b]
  // 1) 목록 항목 · `####` 경계
  const packed = packLineGroups(groupAtItemBoundaries(b.lines), b.kind, rules.maxChars)
  // 2) 글자 수(겹침 포함)
  const out: Block[] = []
  for (const p of packed) {
    if (blockText(p).length <= rules.maxChars) out.push(p)
    else splitByChars(p, rules, out)
  }
  return out
}

/** 최상위 목록 항목 줄 · `####` 줄 앞에서 줄 묶음을 나눈다. */
function groupAtItemBoundaries(lines: Line[]): Line[][] {
  const groups: Line[][] = []
  let cur: Line[] = []
  for (const l of lines) {
    if (cur.length && (isListLine(l.text) && !/^\s{2,}/.test(l.text) || /^####/.test(l.text))) {
      groups.push(cur)
      cur = []
    }
    cur.push(l)
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** 줄 묶음을 상한 안에서 앞에서부터 이어 담는다. */
function packLineGroups(groups: Line[][], kind: Block['kind'], maxChars: number): Block[] {
  const packed: Block[] = []
  let acc: Line[] = []
  for (const g of groups) {
    const len = (ls: Line[]) => ls.reduce((n, l) => n + l.text.length + 1, 0)
    if (acc.length && len(acc) + len(g) > maxChars) {
      packed.push({ kind, lines: acc })
      acc = []
    }
    acc = acc.concat(g)
  }
  if (acc.length) packed.push({ kind, lines: acc })
  return packed
}

/** 덩어리를 글자 수로 자른다. 조각끼리 overlapChars 만큼 겹치고, 각 조각은 따로 선다. */
function splitByChars(p: Block, rules: ChunkRules, out: Block[]): void {
  const text = blockText(p)
  const step = rules.maxChars - rules.overlapChars
  for (let s = 0; s < text.length; s += step) {
    const piece = text.slice(s, s + rules.maxChars)
    const before = text.slice(0, s).split('\n').length - 1
    const no = p.lines[Math.min(before, p.lines.length - 1)].no
    out.push({ kind: p.kind, lines: [{ no, text: piece }], standalone: true })
    if (s + rules.maxChars >= text.length) break
  }
}

/** 절 본문 덩어리를 상한 안에서 앞에서부터 담는다. 따로 서는 덩어리(표 묶음 · 글자 수 조각)는 혼자 조각이 된다. */
function packParts(blocks: Block[], rules: ChunkRules): Block[][] {
  const parts: Block[][] = []
  let cur: Block[] = []
  let curLen = 0
  const flush = () => {
    if (cur.length) parts.push(cur)
    cur = []
    curLen = 0
  }
  for (const b0 of blocks) {
    for (const b of splitLongBlock(b0, rules)) {
      const len = blockText(b).length + 2
      if (b.standalone) {
        flush()
        parts.push([b])
        continue
      }
      if (cur.length && curLen + len > rules.maxChars) flush()
      cur.push(b)
      curLen += len
    }
  }
  flush()
  return parts
}

/** 첫 문장 요약(LLM 없음). 표 · 목록 · 코드 · 그림 줄은 건너뛴다. */
export function leadSentence(text: string): string {
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t || isTableLine(t) || FENCE.test(t) || /^[>#[]/.test(t) || isListLine(t)) continue
    const m = /^(.+?(?:다|요|음)\.)(\s|$)/.exec(t) ?? /^(.+?[.!?])(\s|$)/.exec(t)
    const s = (m ? m[1] : t).replace(/\*\*/g, '')
    return s.length > 160 ? `${s.slice(0, 157)}…` : s
  }
  return ''
}

/** 조각 하나에 실을 값(단위에서 물려받지 않는 것). */
interface ChunkPlace {
  heading: string
  titlePath: string[]
  text: string
  lines: [number, number]
  id: string
  kind: Chunk['kind']
  level: Level
}

/** 단위의 공통 칸과 자리 값으로 조각을 만든다. 요약은 다 나눈 뒤 채운다. */
function makeChunk(unit: SourceUnit, place: ChunkPlace, seq: number): Chunk {
  const { heading, titlePath, text, lines, id, kind, level } = place
  return {
    id,
    page: unit.page,
    contentHash: shortHash(text),
    kind,
    part: unit.part,
    titlePath,
    heading,
    text,
    summary: '',
    source: { adapter: unit.adapter, path: unit.path, lines },
    anchors: unit.anchors,
    level,
    ...(unit.area ? { area: unit.area } : {}),
    ...(unit.status ? { status: unit.status } : {}),
    ...(unit.since ? { since: unit.since } : {}),
    ...(unit.verifiedAt ? { verifiedAt: unit.verifiedAt } : {}),
    generated: unit.generated,
    stale: null,
    seq,
    ...(unit.book ? { book: unit.book } : {}),
    ...(unit.chapter ? { chapter: unit.chapter } : {}),
  }
}

/** 절 줄을 본문 줄과 그림 줄로 나눈다. 그림을 읽는 원천이 아니면 모두 본문이다. */
function splitFigureLines(lines: Line[], unit: SourceUnit, figures: FigureReader | undefined): { body: Line[]; figs: Line[] } {
  if (!figures) return { body: lines, figs: [] }
  const body: Line[] = []
  const figs: Line[] = []
  for (const l of lines) (figures.match(l.text, unit) ? figs : body).push(l)
  return { body, figs }
}

/** 절의 제목 경로: 앞부분 · 페이지 제목 · 부모 절 · 이 절. */
function titlePathOf(unit: SourceUnit, sec: Section, heading: string): string[] {
  const path = [...unit.titlePrefix, unit.title]
  if (sec.parentHeading && sec.parentHeading !== unit.title) path.push(sec.parentHeading)
  if (sec.depth > 0 && heading !== path[path.length - 1]) path.push(heading)
  return path
}

/** 같은 슬러그가 다시 나오면 `~2` · `~3` 을 붙인다. */
function slugCounter(): (slug: string) => string {
  const used = new Map<string, number>()
  return (slug) => {
    const n = (used.get(slug) ?? 0) + 1
    used.set(slug, n)
    return n === 1 ? slug : `${slug}~${n}`
  }
}

/** 절 하나의 자리 값들: 본문 없는 부모 절 표시 · 길이로 자른 본문 조각 · 그림 조각. */
function sectionPlaces(o: { unit: SourceUnit; sections: Section[]; si: number; level: Level; rules: ChunkRules; figures?: FigureReader; uniq: (slug: string) => string }): ChunkPlace[] {
  const { unit, sections, si, level, rules, figures, uniq } = o
  const sec = sections[si]
  const { body, figs } = splitFigureLines(sec.lines, unit, figures)
  const heading = sec.depth === 0 ? unit.title : sec.heading
  const titlePath = titlePathOf(unit, sec, heading)
  const hasBody = body.some((l) => l.text.trim())
  const parentOnly = isBodylessParent(sections, si, hasBody || figs.length > 0, unit.title)
  if (!hasBody && !figs.length && !parentOnly) return []
  const sectionId = `${unit.page}#${uniq(slugify(heading))}`
  const places: ChunkPlace[] = []
  if (parentOnly) places.push({ heading, titlePath, text: '', lines: [sec.headingLine, sec.headingLine], id: sectionId, kind: 'section', level })
  if (hasBody) {
    packParts(toBlocks(body, rules), rules).forEach((part, i) => {
      const all = part.flatMap((b) => b.lines)
      const lines: [number, number] = [i === 0 ? sec.headingLine : all[0].no, all[all.length - 1].no]
      const text = part.map(blockText).join('\n\n').trim()
      places.push({ heading, titlePath, text, lines, id: i === 0 ? sectionId : `${sectionId}@${i + 1}`, kind: 'section', level })
    })
  }
  for (const fl of figs) {
    const f = figures!.match(fl.text, unit)!
    const id = `${unit.page}#${uniq(slugify(`그림-${f.num}`))}`
    places.push({ heading: `그림 ${f.num} ${f.caption}`, titlePath: [...titlePath, `그림 ${f.num}`], text: f.text, lines: [fl.no, fl.no], id, kind: 'figure', level })
  }
  return places
}

/** SourceUnit 하나를 조각 목록으로 나눈다. ID 는 `<페이지>#<절 슬러그>`, 같은 제목은 `~2`, 길이로 자른 뒷조각은 `@2`. */
export function chunkUnit(unit: SourceUnit, rules: ChunkRules = DEFAULT_RULES, figures?: FigureReader): Chunk[] {
  const lines: Line[] = stripFrontmatter(stripComments(unit.markdown))
    .split('\n')
    .map((text, i) => ({ no: i + 1, text: text.replace(/\r$/, '') }))
  const sections = splitSections(lines)
  const levels = sectionLevels(sections, levelMarks(stripFrontmatter(unit.markdown), unit.path), unit.level, unit.path)
  const uniq = slugCounter()
  const places = sections.flatMap((_, si) => sectionPlaces({ unit, sections, si, level: levels[si], rules, figures, uniq }))
  const chunks = places.map((place, seq) => makeChunk(unit, place, seq))
  chunks.forEach((c, i) => {
    c.summary = i === 0 && unit.summary ? unit.summary : leadSentence(c.text)
  })
  return chunks
}
