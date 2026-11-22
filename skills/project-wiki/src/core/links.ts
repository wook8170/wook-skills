// 링크 수집 · 역링크 계산 · 끊긴 링크 검사. 역링크는 묶음을 만들 때 미리 계산해 links.json 에 둔다.
// 부르는 곳: core/adapter.ts · core/build.ts · index.ts. 먼저 읽을 파일: core/model.ts(LinksFile).
import path from 'node:path'
import type { Chunk, Edge, Level, LinkKind, LinkNode, LinksFile, SourceUnit } from './model.ts'
import { cmp, slugify } from './util.ts'

/** 본문의 ID 언급을 노드로 바꾸는 규칙. 어댑터 묶음이 정한다(핵심 묶음은 규칙이 없다). */
export interface IdRule {
  type: string
  re: RegExp
  /** 맞은 문자열 → 노드 ID. 없으면 `<type>:<맞은 문자열>`. null 이면 링크로 잇지 않는다. */
  node?: (match: string, chunk: Chunk) => string | null
}

const CODE_EXT = /\.(ts|tsx|mts|mjs|js|cjs|vue|py|sql|json|ya?ml|sh|css|md|toml|go|rs|java)$/
const BACKTICK = /`([^`\n]+)`/g
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const WIKI_LINK = /\[\[([^\]|]+)\]\]/g

/** `apps/x/y.ts:12-30` · `apps/x/y.ts#sym` → `code:apps/x/y.ts`(심볼이 있으면 `#심볼`). 경로가 아니면 null. */
export function codeNode(raw: string): string | null {
  const t = raw.trim()
  if (/\s/.test(t) || !t.includes('/') || /^[a-z]+:\/\//i.test(t) || t.startsWith('/')) return null
  const m = /^([A-Za-z0-9_.@/-]+?)(?::\d+(?:-\d+)?)?(?:#([A-Za-z_$][\w$]*))?$/.exec(t)
  if (!m || !CODE_EXT.test(m[1])) return null
  return `code:${m[1].replace(/^\.\//, '')}${m[2] ? `#${m[2]}` : ''}`
}

export interface LinkInput {
  chunks: Chunk[]
  units: SourceUnit[]
  rules: IdRule[]
  /** 끊긴 링크로 판정할 노드 종류. 없으면 정의가 하나라도 있는 모든 종류. */
  brokenTypes?: string[]
  /** 묶음 밖 저장소 파일이 있는지. 있으면 그 파일로의 링크는 `code:` 참조로 두고 끊긴 링크로 보지 않는다. */
  fileExists?: (rel: string) => boolean
}

/** 링크를 모으는 동안 쓰는 상태. */
interface LinkGraph {
  nodes: Record<string, LinkNode>
  edges: Edge[]
  edgeKeys: Set<string>
  broken: Edge[]
  chunkById: Map<string, Chunk>
  pageByPath: Map<string, string>
  fileExists?: (rel: string) => boolean
}

/** 간선을 더한다. 제자리 간선과 이미 있는 간선은 넣지 않는다. */
function addEdge(g: LinkGraph, e: Edge): void {
  if (e[0] === e[1]) return
  const k = e.join('\u0000')
  if (g.edgeKeys.has(k)) return
  g.edgeKeys.add(k)
  g.edges.push(e)
}

/** 노드가 없으면 만들고, 있든 없든 그 노드를 돌려준다. */
function touch(g: LinkGraph, id: string, type: string, level: Level = 'public'): LinkNode {
  if (!g.nodes[id]) g.nodes[id] = { type, level }
  return g.nodes[id]
}

function addUnits(g: LinkGraph, units: SourceUnit[]): void {
  for (const u of units) {
    touch(g, u.page, 'page', u.level).title = u.title
    for (const [id, n] of Object.entries(u.extraNodes ?? {})) g.nodes[id] = { ...g.nodes[id], ...n }
    for (const e of u.extraEdges ?? []) addEdge(g, e)
  }
}

function ruleNodeId(r: IdRule, match: string, c: Chunk): string | null {
  return r.node ? r.node(match, c) : `${r.type}:${match}`
}

/** 본문의 ID 언급을 ref 간선으로 잇는다. */
function linkRuleRefs(g: LinkGraph, c: Chunk, r: IdRule): void {
  for (const m of c.text.matchAll(r.re)) {
    const id = ruleNodeId(r, m[0], c)
    if (!id) continue
    touch(g, id, r.type)
    addEdge(g, [c.id, id, 'ref'])
  }
}

/** 절 제목 · `####` 제목이 ID 로 시작하면 그 조각이 그 ID 를 정의한다(먼저 나온 정의가 이긴다). */
function linkRuleDefinitions(g: LinkGraph, c: Chunk, r: IdRule): void {
  const defineFrom = [c.heading, ...[...c.text.matchAll(/^#{4,6}\s+(.+)$/gm)].map((m) => m[1])]
  for (const h of defineFrom) {
    r.re.lastIndex = 0
    const m = r.re.exec(h)
    r.re.lastIndex = 0
    const id = m && m.index === 0 ? ruleNodeId(r, m[0], c) : null
    if (!m || !id) continue
    const n = touch(g, id, r.type)
    if (n.defined) continue
    n.defined = c.id
    n.level = c.level
    n.title = h.slice(m[0].length).trim() || n.title
  }
}

/** 백틱 안의 코드 위치를 code: 노드로 잇는다. */
function linkCodeSpans(g: LinkGraph, c: Chunk): void {
  for (const m of c.text.matchAll(BACKTICK)) {
    const id = codeNode(m[1])
    if (!id) continue
    touch(g, id, 'code')
    addEdge(g, [c.id, id, 'ref'])
  }
}

/** Markdown 링크 하나. 묶음 안 페이지면 그 절(없으면 페이지)로, 저장소 파일이면 code: 로, 둘 다 아니면 끊긴 링크다. */
function linkMarkdownHref(g: LinkGraph, c: Chunk, dir: string, href: string): void {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return
  const [p, frag] = href.split('#')
  if (!p.endsWith('.md')) return
  const target = path.posix.normalize(path.posix.join(dir, decodeURIComponent(p)))
  const page = g.pageByPath.get(target)
  if (!page) {
    if (g.fileExists?.(target)) {
      touch(g, `code:${target}`, 'code')
      addEdge(g, [c.id, `code:${target}`, 'ref'])
    } else g.broken.push([c.id, `file:${target}`, 'ref'])
    return
  }
  const cid = frag ? `${page}#${slugify(decodeURIComponent(frag))}` : page
  addEdge(g, [c.id, g.chunkById.has(cid) ? cid : page, 'ref'])
}

function linkWikiLinks(g: LinkGraph, c: Chunk): void {
  for (const m of c.text.matchAll(WIKI_LINK)) {
    const t = m[1].trim()
    if (/^그림\s/.test(t)) continue
    if (g.chunkById.has(t) || g.nodes[t]?.type === 'page') addEdge(g, [c.id, t, 'ref'])
    else g.broken.push([c.id, t, 'ref'])
  }
}

function linkChunk(g: LinkGraph, c: Chunk, rules: IdRule[]): void {
  addEdge(g, [c.page, c.id, 'contains'])
  for (const a of c.anchors) {
    const id = codeNode(a.path) ?? `code:${a.path}`
    touch(g, id, 'code')
    addEdge(g, [c.id, id, 'evidence'])
  }
  // ID 언급과 정의
  for (const r of rules) {
    linkRuleRefs(g, c, r)
    linkRuleDefinitions(g, c, r)
  }
  // 코드 위치
  linkCodeSpans(g, c)
  // Markdown 링크 · 위키 링크
  const dir = path.posix.dirname(c.source.path)
  for (const m of c.text.matchAll(MD_LINK)) linkMarkdownHref(g, c, dir, m[1])
  linkWikiLinks(g, c)
}

/** 정의가 하나라도 있는 종류에서 정의 없는 ID 를 가리키면 끊긴 링크다. */
function markUndefinedRefs(g: LinkGraph, brokenTypes: string[] | undefined): void {
  const definedTypes = new Set(Object.values(g.nodes).filter((n) => n.defined).map((n) => n.type))
  for (const e of g.edges) {
    if (e[2] !== 'ref') continue
    const n = g.nodes[e[1]]
    if (!n || n.defined || n.type === 'page' || n.type === 'code' || !definedTypes.has(n.type)) continue
    if (brokenTypes && !brokenTypes.includes(n.type)) continue
    if (e[1].startsWith(`${n.type}:`)) g.broken.push(e)
  }
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of Object.keys(rec).sort(cmp)) out[k] = rec[k]
  return out
}

/** 역링크(대상 → 종류 → 출발 목록)와 노드별 들어옴 · 나감 수. 키와 목록은 정렬한다. */
function backlinksAndCounts(edges: Edge[]): { backlinks: LinksFile['backlinks']; counts: LinksFile['counts'] } {
  const backlinks: LinksFile['backlinks'] = {}
  const counts: LinksFile['counts'] = {}
  const cnt = (id: string) => (counts[id] ??= { in: 0, out: 0 })
  for (const [from, to, kind] of edges) {
    ;((backlinks[to] ??= {})[kind] ??= []).push(from)
    cnt(from).out++
    cnt(to).in++
  }
  const sortedBack: LinksFile['backlinks'] = {}
  for (const k of Object.keys(backlinks).sort(cmp)) {
    const byKind = backlinks[k]
    const o: Partial<Record<LinkKind, string[]>> = {}
    for (const kind of Object.keys(byKind).sort(cmp) as LinkKind[]) o[kind] = byKind[kind]!.sort(cmp)
    sortedBack[k] = o
  }
  return { backlinks: sortedBack, counts: sortedRecord(counts) }
}

export function buildLinks({ chunks, units, rules, brokenTypes, fileExists }: LinkInput): LinksFile {
  const g: LinkGraph = {
    nodes: {},
    edges: [],
    edgeKeys: new Set<string>(),
    broken: [],
    chunkById: new Map(chunks.map((c) => [c.id, c])),
    pageByPath: new Map(units.map((u) => [u.path, u.page])),
    fileExists,
  }
  addUnits(g, units)
  for (const c of chunks) linkChunk(g, c, rules)
  markUndefinedRefs(g, brokenTypes)

  const { edges, broken } = g
  edges.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]))
  broken.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]))
  const { backlinks, counts } = backlinksAndCounts(edges)
  return { nodes: sortedRecord(g.nodes), edges, backlinks, counts, broken }
}

/** ids.json: 지정한 종류의 ID → 정의 · 나오는 조각 목록. */
export function buildIds(links: LinksFile, types: string[], trace: unknown[] = []): Record<string, unknown> {
  const ids: Record<string, { type: string; title?: string; defined?: string; chunks: string[] }> = {}
  for (const [node, n] of Object.entries(links.nodes)) {
    if (!types.includes(n.type)) continue
    const raw = node.slice(node.indexOf(':') + 1)
    const chunks = links.backlinks[node]?.ref ?? []
    ids[raw] = { type: n.type, ...(n.title ? { title: n.title } : {}), ...(n.defined ? { defined: n.defined } : {}), chunks }
  }
  return { ids, trace }
}

/**
 * 조각 본문에서 `id` 의 정의 글만 잘라 낸다. 한 절에 `#### REQ-SEC-01 …` · `#### REQ-SEC-02 …` 처럼 정의가 여럿 있으면,
 * 그 ID 로 시작하는 `####` 제목 줄부터 다음 제목 줄(`#` 1~6개) 앞까지만 돌려준다. 그런 제목 줄이 없으면 본문 전체다.
 */
export function definitionText(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => {
    const m = /^#{4,6}\s+(.+)$/.exec(l)
    return !!m && m[1].startsWith(id) && !/[\w-]/.test(m[1].charAt(id.length))
  })
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}
