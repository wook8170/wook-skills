// 묶음 하나를 열어 검색 · 읽기 · 역링크를 제공한다. 부르는 곳: cli/query.ts · mcp/tools.ts · dev/live-index.ts.
// 모든 함수는 등급 상한(cap)을 필수로 받는다. 상한보다 높은 조각은 순위 계산 전에 빠지고, 빠진 수만 돌려준다.
import { LexicalIndex, buildLexical, extractLinkTerms, type LexicalFiles } from './lexical.ts'
import type { Chunk, ChunkKind, Level, LinkKind, LinksFile, Manifest, Part, StaleMark } from './model.ts'
import { levelAllowed } from './model.ts'
import { TOKENIZER, queryPhrases, queryTerms } from './tokenize.ts'
import { verifyBundle, type BundleFiles } from './bundle.ts'
import { areaAllowed, areaUnscoped, type AreaScope } from './scope.ts'

/** 생성 장(목록) 조각의 순위 가중. 생성 목록이 검색 상위를 채우지 않게 한다. */
export const GENERATED_WEIGHT = 0.8
/**
 * 영역별 순위 가중(없는 영역은 1). 시험 시나리오 문서(`testing`)는 기능 낱말이 많아 다른 질문의 상위를 채우므로 낮춘다.
 * 값은 검색 평가(eval 명령)로 정했다.
 */
export const AREA_WEIGHT: Readonly<Record<string, number>> = { testing: 0.95 }
const PHRASE_BONUS = 0.6
const DEFINE_BONUS = 4
const RERANK_TOP = 300

/** 조각 하나의 순위 가중 = 생성 장 가중 × 영역 가중. */
function chunkWeight(c: Chunk): number {
  return (c.generated ? GENERATED_WEIGHT : 1) * (AREA_WEIGHT[c.area ?? ''] ?? 1)
}

export interface CatalogBook {
  id: string
  category: string
  title: string
  status?: string
  edition?: string
  syncedCommit?: string
  dir: string
  chapters: Array<{ no: number; file: string; title: string; summary?: string; page: string; generated: boolean; sections: number }>
}

export interface Catalog {
  categories: string[]
  books: CatalogBook[]
}

export interface SearchOptions {
  q: string
  cap: Level
  kinds?: ChunkKind[]
  areas?: string[]
  /** 이 영역은 빼고 찾는다(area 가 없는 조각은 남는다). */
  excludeAreas?: string[]
  parts?: Part[]
  book?: string
  category?: string
  excludeStale?: boolean
  limit?: number
  offset?: number
}

export interface SearchHit {
  id: string
  bundle: string
  kind: ChunkKind
  part: Part
  titlePath: string[]
  heading: string
  summary: string
  snippet: string
  score: number
  source: { path: string; lines: [number, number]; commit: string | null }
  stale: StaleMark | null
  level: Level
  area?: string
  book?: string
  chapter?: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** 등급 거르기 뒤 낱말이 맞은 조각 수. */
  total: number
  /** 등급 상한 때문에 뺀 조각 가운데 낱말이 맞은 수. */
  filteredCount: number
}

export type ReadError = { error: 'not_found' | 'wiki_level_required'; id: string }

export interface BacklinkItem {
  id: string
  title: string
  level: Level
}

export interface ReadResult {
  id: string
  resolvedFrom?: string
  kind: 'chunk' | 'page'
  part: Part
  title: string
  titlePath: string[]
  text: string
  source: { path: string; lines: [number, number]; commit: string | null }
  evidence: string[]
  stale: StaleMark | null
  level: Level
  /** 페이지 읽기: 쪽 머리말의 시작 버전 · 확인일(첫 조각에 실린 값). 없으면 칸이 없다. */
  since?: string
  verifiedAt?: string
  /** 원천 파일을 마지막으로 고친 날(git). 없으면 칸이 없다. */
  modifiedAt?: string
  chunks?: Array<{ id: string; heading: string }>
  context?: { prev: { id: string; heading: string; text: string } | null; next: { id: string; heading: string; text: string } | null }
  backlinks: Partial<Record<LinkKind, { count: number; top: BacklinkItem[] }>>
  filteredCount: number
}

function isError<T extends object>(v: T | ReadError): v is ReadError {
  return 'error' in v
}
export { isError as isReadError }

/** 종류 · 영역 · 부 조건에 맞지 않으면 true. */
function outOfKindScope(c: Chunk, o: SearchOptions): boolean {
  if (o.kinds?.length && !o.kinds.includes(c.kind)) return true
  if (!areaAllowed(c.area, o)) return true
  return !!(o.parts?.length && !o.parts.includes(c.part))
}

/** 등급 외 범위 조건(종류 · 영역 · 부 · 권 · 분류 · 낡음)에 하나라도 걸리면 true. 순위 계산 전에 쓴다. */
function outOfScope(c: Chunk, o: SearchOptions, bookCat: Map<string, string>): boolean {
  if (outOfKindScope(c, o)) return true
  if (o.book && c.book !== o.book) return true
  if (o.category && bookCat.get(c.book ?? '') !== o.category) return true
  return !!(o.excludeStale && c.stale?.state === 'stale')
}

/** 페이지 읽기의 날짜 칸(시작 · 확인일 · 수정일) — 값이 있는 칸만 싣는다(첫 조각 기준). */
function pageDateFields(c: { since?: string; verifiedAt?: string; modifiedAt?: string }): Pick<ReadResult, 'since' | 'verifiedAt' | 'modifiedAt'> {
  const out: Pick<ReadResult, 'since' | 'verifiedAt' | 'modifiedAt'> = {}
  if (c.since) out.since = c.since
  if (c.verifiedAt) out.verifiedAt = c.verifiedAt
  if (c.modifiedAt) out.modifiedAt = c.modifiedAt
  return out
}

export class WikiIndex {
  readonly manifest: Manifest
  readonly chunks: Chunk[]
  readonly links: LinksFile
  readonly catalog: Catalog
  readonly ids: { ids: Record<string, { type: string; title?: string; defined?: string; chunks: string[] }>; trace: unknown[] }
  readonly aliases: Record<string, string>
  private readonly lexical: LexicalIndex
  private readonly byId = new Map<string, number>()
  private readonly pages = new Map<string, number[]>()
  private readonly definedBy = new Map<string, number[]>()
  private readonly files: BundleFiles

  constructor(files: BundleFiles, opts: { skipVerify?: boolean } = {}) {
    if (!opts.skipVerify) {
      const v = verifyBundle(files)
      if (!v.ok) throw new Error(`묶음 검증 실패: ${v.issues.map((i) => `${i.code} ${i.message}`).join('; ')}`)
    }
    this.files = files
    const json = <T>(name: string, fallback: T): T => (files.has(name) ? (JSON.parse(files.get(name)!.toString('utf8')) as T) : fallback)
    this.manifest = json<Manifest>('manifest.json', {} as Manifest)
    this.chunks = files
      .get('chunks.jsonl')!
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Chunk)
    this.links = json<LinksFile>('links.json', { nodes: {}, edges: [], backlinks: {}, counts: {}, broken: [] })
    this.catalog = json<Catalog>('catalog.json', { categories: [], books: [] })
    this.ids = json('ids.json', { ids: {}, trace: [] })
    this.aliases = json<Record<string, string>>('aliases.json', {})
    this.chunks.forEach((c, i) => {
      this.byId.set(c.id, i)
      const p = this.pages.get(c.page)
      if (p) p.push(i)
      else this.pages.set(c.page, [i])
    })
    for (const [node, n] of Object.entries(this.links.nodes)) {
      if (!n.defined) continue
      const i = this.byId.get(n.defined)
      if (i === undefined) continue
      const key = node.slice(node.indexOf(':') + 1).toLowerCase()
      const list = this.definedBy.get(key) ?? []
      list.push(i)
      this.definedBy.set(key, list)
    }
    const docs = files.get('lexical/docs.json')
    const sameTokenizer = docs && (JSON.parse(docs.toString('utf8')) as { tokenizer: string }).tokenizer === TOKENIZER
    // 토큰화 규칙 버전이 다르면 chunks.jsonl 에서 색인을 다시 만든다(옛 묶음도 쓸 수 있게).
    this.lexical = new LexicalIndex(sameTokenizer ? (Object.fromEntries([...files].filter(([k]) => k.startsWith('lexical/'))) as unknown as LexicalFiles) : buildLexical(this.chunks))
  }

  /** 묶음 안 원본 Markdown 사본. */
  pageSource(path: string): string | null {
    return this.files.get(`pages/${path}`)?.toString('utf8') ?? null
  }

  /** 고객 보고 글에서 자동 연결 낱말(식별자 · ID · 버전 꼴이면서 이 묶음 사전에 있는 낱말)을 뽑는다. */
  linkTerms(text: string): string[] {
    return extractLinkTerms(text, this.lexical)
  }

  resolve(id: string): string {
    let cur = id
    for (let i = 0; i < 8 && this.aliases[cur]; i++) cur = this.aliases[cur]
    return cur
  }

  private allowedMask(cap: Level): Uint8Array {
    const m = new Uint8Array(this.chunks.length)
    this.chunks.forEach((c, i) => {
      m[i] = levelAllowed(c.level, cap) ? 1 : 0
    })
    return m
  }

  private nodeLevel(id: string): Level {
    const i = this.byId.get(id)
    if (i !== undefined) return this.chunks[i].level
    return this.links.nodes[id]?.level ?? 'public'
  }

  /**
   * 페이지 등급 = 원천(페이지) 등급. 절 단위 등급 표시는 올릴 수만 있어서, 페이지 안 조각 등급의 가장 낮은 값과 같다.
   * 페이지는 이 등급으로 열리고, 상한보다 높은 절만 빠진다.
   */
  pageLevel(pageId: string): Level | null {
    const node = this.links.nodes[pageId]
    if (node?.type === 'page') return node.level
    const list = this.pages.get(pageId)
    if (!list?.length) return null
    const levels = list.map((j) => this.chunks[j].level)
    return levels.reduce((a, b) => (levelAllowed(a, b) ? a : b), levels[0])
  }

  /** 조각 · 페이지 ID 가 영역 범위 밖이면 true. 범위가 없거나 없는 ID 면 false. */
  private outOfArea(id: string, scope: AreaScope): boolean {
    if (areaUnscoped(scope) || (!this.byId.has(id) && !this.pages.has(id))) return false
    return !areaAllowed(this.nodeArea(id), scope)
  }

  /** 조각 · 페이지 ID 의 영역. 조각이 아닌 노드(추적 데이터 등)는 영역이 없다. */
  private nodeArea(id: string): string | undefined {
    const i = this.byId.get(id) ?? this.pages.get(id)?.[0]
    return i === undefined ? undefined : this.chunks[i].area
  }

  private nodeTitle(id: string): string {
    const i = this.byId.get(id)
    if (i !== undefined) return this.chunks[i].titlePath.join(' › ')
    return this.links.nodes[id]?.title ?? id
  }

  private snippet(c: Chunk, phrases: string[], terms: string[]): string {
    const text = c.text.replace(/\s+/g, ' ')
    const lower = text.toLowerCase()
    const keys = [...phrases, ...terms].sort((a, b) => b.length - a.length)
    let at = -1
    for (const k of keys) {
      at = lower.indexOf(k.toLowerCase())
      if (at >= 0) break
    }
    if (at < 0) return text.slice(0, 200)
    const start = Math.max(0, at - 80)
    return (start > 0 ? '…' : '') + text.slice(start, start + 200) + (start + 200 < text.length ? '…' : '')
  }

  search(o: SearchOptions): SearchResult {
    const terms = queryTerms(o.q)
    const phrases = queryPhrases(o.q)
    const limit = Math.min(Math.max(o.limit ?? 10, 1), 50)
    const offset = Math.max(o.offset ?? 0, 0)
    const allowed = this.allowedMask(o.cap)
    const bookCat = new Map(this.catalog.books.map((b) => [b.id, b.category]))
    // 범위 거르기(등급 외): 순위 계산 전에 적용한다.
    this.chunks.forEach((c, i) => {
      if (allowed[i] && outOfScope(c, o, bookCat)) allowed[i] = 2
    })
    // 등급으로 뺀 것(0)과 범위로 뺀 것(2)을 나눠 센다. 점수 계산에는 1 만 넣는다.
    const levelOnly = Uint8Array.from(allowed, (v) => (v === 0 ? 0 : 1))
    const { excluded } = this.lexical.score(terms, levelOnly)
    const scopeMask = Uint8Array.from(allowed, (v) => (v === 1 ? 1 : 0))
    const { scores } = this.lexical.score(terms, scopeMask)
    let ranked = [...scores].map(([d, s]) => [d, s * chunkWeight(this.chunks[d])] as [number, number])
    ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0])
    // 근접 가중 · ID 정의 가산: 상위 일부만 다시 매긴다.
    const top = ranked.slice(0, RERANK_TOP).map(([d, s]) => {
      const c = this.chunks[d]
      const hay = `${c.heading} ${c.text}`.toLowerCase()
      let bonus = 0
      for (const p of phrases) if (hay.includes(p)) bonus += PHRASE_BONUS * Math.min(p.length, 8)
      for (const t of terms) if (this.definedBy.get(t)?.includes(d)) bonus += DEFINE_BONUS * 2
      return [d, s + bonus] as [number, number]
    })
    for (const t of terms) {
      for (const d of this.definedBy.get(t) ?? []) {
        if (scopeMask[d] && !top.some(([x]) => x === d)) top.push([d, DEFINE_BONUS * 2])
      }
    }
    top.sort((a, b) => b[1] - a[1] || a[0] - b[0])
    const inTop = new Set(top.map(([d]) => d))
    ranked = [...top, ...ranked.slice(RERANK_TOP).filter(([d]) => !inTop.has(d))]
    const commit = this.manifest.commit
    const hits = ranked.slice(offset, offset + limit).map(([d, score]) => {
      const c = this.chunks[d]
      return {
        id: c.id,
        bundle: this.manifest.name,
        kind: c.kind,
        part: c.part,
        titlePath: c.titlePath,
        heading: c.heading,
        summary: c.summary,
        snippet: this.snippet(c, phrases, terms),
        score: Math.round(score * 1000) / 1000,
        source: { path: c.source.path, lines: c.source.lines, commit },
        stale: c.stale,
        level: c.level,
        ...(c.area ? { area: c.area } : {}),
        ...(c.book ? { book: c.book } : {}),
        ...(c.chapter ? { chapter: c.chapter } : {}),
      }
    })
    return { hits, total: ranked.length, filteredCount: excluded }
  }

  /** 역링크 요약. 등급 상한 밖과 영역 범위 밖의 가리키는 곳은 제목 · ID 를 내지 않고 건수(filteredCount)에만 넣는다. */
  private backlinkSummary(target: string, cap: Level, kinds: LinkKind[] | undefined, limit: number, scope: AreaScope = {}) {
    const visible = (id: string) => levelAllowed(this.nodeLevel(id), cap) && (areaUnscoped(scope) || areaAllowed(this.nodeArea(id), scope))
    const byKind = this.links.backlinks[target] ?? {}
    const out: Partial<Record<LinkKind, { count: number; top: BacklinkItem[] }>> = {}
    let filtered = 0
    for (const [kind, list] of Object.entries(byKind) as Array<[LinkKind, string[]]>) {
      if (kinds?.length && !kinds.includes(kind)) continue
      if (kind === 'contains') continue
      const ok = list.filter(visible)
      filtered += list.length - ok.length
      if (!ok.length) continue
      out[kind] = { count: ok.length, top: ok.slice(0, limit).map((id) => ({ id, title: this.nodeTitle(id), level: this.nodeLevel(id) })) }
    }
    return { backlinks: out, filteredCount: filtered }
  }

  /** 조각 · 페이지 읽기. 영역 범위 밖이면 등급과 관계없이 찾지 못한 것과 같게 돌려준다(있는지도 알리지 않는다). */
  read(id: string, o: { cap: Level; context?: boolean } & AreaScope): ReadResult | ReadError {
    const rid = this.resolve(id)
    const from = rid !== id ? { resolvedFrom: id } : {}
    if (this.outOfArea(rid, o)) return { error: 'not_found', id: rid }
    const i = this.byId.get(rid)
    if (i !== undefined) return this.readChunk(i, from, o)
    const page = this.pages.get(rid)
    if (!page) return { error: 'not_found', id: rid }
    return this.readPage(rid, page, from, o)
  }

  private readChunk(i: number, from: { resolvedFrom?: string }, o: { cap: Level; context?: boolean } & AreaScope): ReadResult | ReadError {
    const c = this.chunks[i]
    if (!levelAllowed(c.level, o.cap)) return { error: 'wiki_level_required', id: c.id }
    const { backlinks, filteredCount } = this.backlinkSummary(c.id, o.cap, undefined, 5, o)
    const r: ReadResult = {
      id: c.id,
      ...from,
      kind: 'chunk',
      part: c.part,
      title: c.heading,
      titlePath: c.titlePath,
      text: c.text,
      source: { path: c.source.path, lines: c.source.lines, commit: this.manifest.commit },
      evidence: c.anchors.map((a) => a.path),
      stale: c.stale,
      level: c.level,
      backlinks,
      filteredCount,
    }
    if (o.context) r.context = this.neighbors(i, o.cap)
    return r
  }

  /** 같은 페이지의 앞뒤 조각. 볼 수 없는 등급이면 null. */
  private neighbors(i: number, cap: Level): ReadResult['context'] {
    const sib = this.pages.get(this.chunks[i].page) ?? []
    const pos = sib.indexOf(i)
    const pick = (j: number | undefined) => {
      if (j === undefined) return null
      const s = this.chunks[j]
      return levelAllowed(s.level, cap) ? { id: s.id, heading: s.heading, text: s.text } : null
    }
    return { prev: pick(sib[pos - 1]), next: pick(sib[pos + 1]) }
  }

  private readPage(rid: string, page: number[], from: { resolvedFrom?: string }, o: { cap: Level } & AreaScope): ReadResult | ReadError {
    const level = this.pageLevel(rid)!
    if (!levelAllowed(level, o.cap)) return { error: 'wiki_level_required', id: rid }
    const parts = page.map((j) => this.chunks[j]).filter((c) => levelAllowed(c.level, o.cap))
    // 절 단위 등급으로 빠진 절도 거른 건수에 넣는다(읽는 쪽이 「볼 수 없는 내용이 있다」고 알릴 수 있게).
    const head = this.chunks[page[0]]
    const first = levelAllowed(head.level, o.cap) ? head : (parts[0] ?? head)
    const links = this.backlinkSummary(rid, o.cap, undefined, 5, o)
    return {
      id: rid,
      ...from,
      kind: 'page',
      part: first.part,
      title: this.links.nodes[rid]?.title ?? first.titlePath[first.titlePath.length - 1],
      titlePath: first.titlePath.slice(0, -1),
      text: parts.map((c) => (c.kind === 'figure' ? `[${c.heading}]` : `## ${c.heading}\n\n${c.text}`)).join('\n\n'),
      source: { path: first.source.path, lines: [1, Math.max(1, ...parts.map((c) => c.source.lines[1]))], commit: this.manifest.commit },
      evidence: first.anchors.map((a) => a.path),
      stale: parts.find((c) => c.stale)?.stale ?? null,
      level,
      ...pageDateFields(first),
      chunks: parts.map((c) => ({ id: c.id, heading: c.heading })),
      backlinks: links.backlinks,
      filteredCount: links.filteredCount + (page.length - parts.length),
    }
  }

  backlinks(target: string, o: { cap: Level; kinds?: LinkKind[]; limit?: number } & AreaScope) {
    const t = this.resolve(target)
    const exists = this.byId.has(t) || !!this.links.nodes[t] || !!this.links.backlinks[t]
    const { backlinks, filteredCount } = this.backlinkSummary(t, o.cap, o.kinds, Math.min(o.limit ?? 20, 100), o)
    const broken = this.links.broken.filter((e) => e[1] === t).length
    return { target: t, exists, backlinks, filteredCount, ...(exists ? {} : { note: '대상 없음' }), ...(broken ? { brokenRefs: broken } : {}) }
  }
}
