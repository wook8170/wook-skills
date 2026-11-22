// 어댑터 계약과 일반 Markdown 어댑터(핵심). 원천마다 다른 지식은 어댑터가 맡고, 엔진은 SourceUnit 만 본다.
// 부르는 곳: core/build.ts · core/mark-synced.ts · index.ts. 먼저 읽을 파일: core/model.ts(SourceUnit).
import fs from 'node:fs'
import path from 'node:path'
import type { FigureReader } from './chunk.ts'
import type { IdRule } from './links.ts'
import type { Anchor, Edge, Level, Part, SourceSpec, SourceUnit } from './model.ts'
import type { SecurityConfig } from './security.ts'
import { maxLevel, parseLevel } from './model.ts'
import { splitAnchorValues } from './stale.ts'
import { headFlags } from './head-shape.ts'
import { globFiles, parseFrontmatter, shortHash } from './util.ts'

export interface AdapterContext {
  repoRoot: string
  spec: SourceSpec & Record<string, unknown>
  /** 묶음 프로필. 묶음 만들기만 넘긴다(`stale` · `mark-synced` 는 없음). 저장소 밖 원천은 이 값으로 읽을지 정한다. */
  profile?: 'server' | 'local'
  /** 설정의 보안 항목(`allow` 대보기 등). */
  security?: SecurityConfig
}

/** 저장소 밖 원천의 가상 경로 앞부분과 실제 폴더. 링크 판정이 이 앞부분의 경로를 그 폴더 기준으로 확인한다. */
export interface Mount {
  prefix: string
  dir: string
}

export interface AdapterOutput {
  units: SourceUnit[]
  figures?: FigureReader
  /** 권 · 장 구조를 내는 어댑터의 권 목록(catalog.json 의 books). */
  catalog?: { categories: string[]; books: unknown[] }
  manuscripts?: Record<string, { manuscriptSha256: string; figuresSha256: string }>
  trace?: unknown[]
  /** 원천 글롭에 맞지만 심볼릭 링크라서 읽지 않은 문서 경로. 낡음 판정이 「상태를 읽지 못한 문서」로 센다. */
  links?: string[]
  mount?: Mount
}

export interface Adapter {
  name: string
  read(ctx: AdapterContext): AdapterOutput
}

/** 어댑터 묶음: 어댑터 목록과 ID 규칙. 핵심 묶음(corePack)은 일반 Markdown 어댑터 하나만 든다. */
export interface AdapterPack {
  adapters: Adapter[]
  idRules: IdRule[]
  /** ids.json 에 싣는 노드 종류. */
  idTypes: string[]
  /** 끊긴 링크로 판정할 노드 종류. 표기 변형이 많아 판정이 흔들리는 종류(예: API 경로)는 뺀다. */
  brokenTypes?: string[]
  /**
   * `mark-synced` 가 기준 커밋을 쓰는 방법(머리말이 아닌 원천용). 고친 원문을 돌려준다.
   * null 이면 이 원천에는 쓸 수 없고, undefined 면 핵심의 기본(머리말 `base_commit`)을 쓴다.
   */
  writeBaseCommit?: (u: SourceUnit, markdown: string, sha: string) => string | null | undefined
  /**
   * 색인하지 않고 묶음에 그대로 싣는 파일(묶음 안 이름, 바이트). manifest 해시 목록에 들어가므로 묶음 서명이 함께 덮는다.
   * 빈 목록이면 싣지 않는다. 색인기가 만드는 파일 이름과 겹치면 빌드가 멈춘다.
   */
  bundleExtras?: (repoRoot: string) => Array<[name: string, data: Buffer]>
}

/** 저장소 안 경로나 그 위 폴더 가운데 심볼릭 링크가 있는가. 저장소 루트 위의 링크는 보지 않는다. */
function throughLink(repoRoot: string, rel: string): boolean {
  const parts = rel.split('/')
  return parts.some((_, i) => fs.lstatSync(path.join(repoRoot, ...parts.slice(0, i + 1)), { throwIfNoEntry: false })?.isSymbolicLink() === true)
}

/**
 * 근거 파일 앵커. 파일이 있으면 내용 해시, 폴더 · 없는 파일이면 null.
 * 해시가 null 이어도 낡음 판정에서 빠지지는 않는다. 기준 커밋에 파일로 있었으면 판정한다(`stale.ts` `resolveMissing`).
 * 경로가 심볼릭 링크를 지나면 `link` 를 붙인다.
 */
export function fileAnchor(repoRoot: string, rel: string): Anchor {
  const abs = path.join(repoRoot, rel)
  let hash: string | null = null
  try {
    if (fs.statSync(abs).isFile()) hash = shortHash(fs.readFileSync(abs, 'utf8'))
  } catch {
    hash = null
  }
  return { kind: 'file', path: rel, hash, ...(throughLink(repoRoot, rel) ? { link: true as const } : {}) }
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) return [v]
  return []
}

const FENCE_LINE = /^\s*(```|~~~)/

/** 펜스 코드 밖의 줄만 돌려준다. 코드 블록 안 셸 주석(`# …`)을 제목으로 잡지 않기 위해서다. */
function linesOutsideFences(markdown: string): string[] {
  const out: string[] = []
  let fence = false
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE.test(line)) {
      fence = !fence
      continue
    }
    if (!fence) out.push(line)
  }
  return out
}

/** 펜스 코드 밖의 첫 `# ` 제목. 없으면 null. */
export function firstHeading(markdown: string): string | null {
  for (const line of linesOutsideFences(markdown)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) return m[1].trim()
  }
  return null
}

/** 제목 줄이 없을 때 쓰는 첫 문단 줄(인용 · 표 · 목록 · 제목 · 머리말 줄은 건너뛴다). 강조 기호를 지우고 80자로 자른다. */
export function firstParagraph(markdown: string): string | null {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '')
  for (const line of linesOutsideFences(body)) {
    const t = line.trim()
    if (!t || /^[>|#<-]/.test(t) || /^([*+]|\d+[.)])\s/.test(t)) continue
    const plain = t.replace(/[*_`]/g, '').trim()
    if (plain) return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain
  }
  return null
}

type Frontmatter = Record<string, unknown>

/** 페이지 키: 머리말 id, 없으면 root 를 뺀 경로에서 확장자를 뗀 값. */
function markdownKey(spec: AdapterContext['spec'], rel: string, data: Frontmatter): string {
  const base = spec.root && rel.startsWith(`${spec.root}/`) ? rel.slice(spec.root.length + 1) : rel
  return typeof data.id === 'string' && data.id ? data.id : base.replace(/\.md$/, '')
}

/** 제목: 머리말 title → 첫 `# ` 제목 → 첫 문단 줄 → 파일 이름 순서로 고른다. */
function markdownTitle(data: Frontmatter, markdown: string, rel: string): string {
  return (typeof data.title === 'string' && data.title) || firstHeading(markdown) || firstParagraph(markdown) || path.posix.basename(rel, '.md')
}

/** 머리말 등급은 원천 등급보다 올릴 수만 있다. */
function markdownLevel(spec: AdapterContext['spec'], data: Frontmatter): Level {
  return data.level !== undefined ? maxLevel(spec.level, parseLevel(data.level)) : spec.level
}

function markdownEdges(page: string, ns: string, data: Frontmatter): Edge[] {
  const edges: Edge[] = []
  for (const t of asList(data.supersedes)) edges.push([page, t.includes(':') ? t : `${ns}:${t}`, 'reverts'])
  for (const t of asList(data.implements)) edges.push([page, t, 'implements'])
  return edges
}

/**
 * 시작 버전 · 확인일(쪽 머리말 `since` · `verified_at`). 빈 값이면 키를 넣지 않는다.
 * 머리말 읽기는 숫자 꼴(`1.13`)을 수로 바꾸므로 글자로 되돌린다. 끝자리 0(`1.10`)을 지키려면 따옴표로 적는다.
 */
function pageDates(data: Frontmatter): { since?: string; verifiedAt?: string } {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '')
  const since = text(data.since)
  const verifiedAt = text(data.verified_at)
  return { ...(since ? { since } : {}), ...(verifiedAt ? { verifiedAt } : {}) }
}

/** 출하 차단 규칙: 영역이 결정 · 정책이고 `status: current` 인 페이지. */
export function isBlockingPage(area: string | undefined, status: string | undefined): boolean {
  return (area === 'decision' || area === 'policy') && status === 'current'
}

type WikiStaleFields = Pick<SourceUnit, 'anchors'> & Partial<Pick<SourceUnit, 'area' | 'status' | 'skippedAnchors' | 'baseCommit' | 'blockOnStale' | 'reviewInSameCommit'>>

/**
 * 머리말에서 영역 · 낡음 판정 칸을 읽는다. `category` 는 `area` 의 옛 이름이다.
 * 근거(sources)나 기준 커밋(base_commit)을 적은 페이지와 차단 대상은 위키 페이지 방식으로 판정한다.
 */
function wikiStaleFields(repoRoot: string, data: Record<string, unknown>, specArea: string | undefined): WikiStaleFields {
  const area = typeof data.area === 'string' ? data.area : typeof data.category === 'string' ? data.category : specArea
  const status = typeof data.status === 'string' ? data.status : undefined
  const base = data.base_commit === undefined || data.base_commit === '' ? undefined : String(data.base_commit)
  const { paths, skipped } = splitAnchorValues(asList(data.sources).map((s) => s.split('#')[0].split(':')[0]))
  const block = isBlockingPage(area, status)
  return {
    ...(area !== undefined ? { area } : {}),
    ...(status !== undefined ? { status } : {}),
    anchors: paths.map((p) => fileAnchor(repoRoot, p)),
    ...(skipped ? { skippedAnchors: skipped } : {}),
    ...(base ? { baseCommit: base } : {}),
    ...(block ? { blockOnStale: true } : {}),
    ...(block || base || data.sources !== undefined ? { reviewInSameCommit: true } : {}),
  }
}

/**
 * 일반 Markdown 어댑터. 머리말의 id · title · level · area(옛 이름 category) · status · since · verified_at · aliases · sources ·
 * base_commit · supersedes · implements 를 읽는다.
 * 페이지 ID = `<이름공간>:<머리말 id 또는 확장자 뺀 경로>`. 등급은 머리말로 올릴 수만 있다(내릴 수 없다).
 */
export const markdownAdapter: Adapter = {
  name: 'markdown',
  read({ repoRoot, spec }) {
    const include = spec.include ?? (spec.root ? [`${spec.root}/**/*.md`] : [])
    const ns = spec.idNamespace ?? 'wiki'
    const part = (spec.part as Part | undefined) ?? 'wiki'
    const units: SourceUnit[] = []
    const links: string[] = []
    for (const rel of globFiles(repoRoot, include, spec.exclude, links)) {
      const markdown = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
      const { data, unclosed } = parseFrontmatter(markdown)
      const page = `${ns}:${markdownKey(spec, rel, data)}`
      const title = markdownTitle(data, markdown, rel)
      const level = markdownLevel(spec, data)
      const edges = markdownEdges(page, ns, data)
      const stale = wikiStaleFields(repoRoot, data, spec.area)
      units.push({
        adapter: spec.adapter,
        path: rel,
        page,
        part,
        title,
        titlePrefix: (spec.titlePrefix as string[] | undefined) ?? [],
        level,
        ...pageDates(data),
        generated: false,
        markdown,
        ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
        ...stale,
        ...(unclosed ? { headUnclosed: true } : {}),
        ...headFlags(markdown, data, spec.area, stale.area, stale.status),
        aliases: asList(data.aliases).map((a) => (a.includes(':') ? a : `${ns}:${a}`)),
        extraEdges: edges,
      })
    }
    return { units, links }
  },
}
