// init 판정: 저장소 파일 목록을 보고 위키 원천(문서 폴더) · 제외 · 영역 · 등급 기본값을 정한다. 파일을 읽거나 쓰지 않는 순수 함수다.
// 부르는 곳: cli/init.ts. 결과 설정의 형식은 core/build.ts 의 WikiConfig 다.
// 먼저 읽을 파일: init/write.ts(정한 값을 파일로 쓰는 쪽).
import type { WikiConfig } from '../core/build.ts'
import { matchesAny } from '../core/util.ts'

/** 문서 폴더로 보는 맨 위 폴더 이름과 그 폴더의 영역(없으면 영역을 정하지 않는다). */
const DOC_DIRS: Readonly<Record<string, string | undefined>> = {
  docs: undefined, doc: undefined, documentation: undefined, wiki: 'wiki', notes: undefined, handbook: undefined,
  design: 'design', architecture: 'design', spec: 'design', specs: 'design',
  adr: 'decision', adrs: 'decision', decisions: 'decision', rfc: 'decision', rfcs: 'decision',
  guide: 'guide', guides: 'guide', ops: 'ops', runbooks: 'ops', reports: undefined, deliverables: undefined,
}

/** 문서 폴더 안에서 따로 영역을 주는 하위 폴더 이름. */
const AREA_SUBDIRS: Readonly<Record<string, string>> = {
  adr: 'decision', adrs: 'decision', decisions: 'decision', rfc: 'decision', rfcs: 'decision',
  design: 'design', architecture: 'design', ops: 'ops', runbooks: 'ops', guides: 'guide', wiki: 'wiki',
}

/** 어느 원천에도 넣지 않는 경로(빌드 산출물 · 의존성 · 위키 자신). */
export const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/vendor/**', '**/coverage/**', '.wiki/**']

export interface PlannedSource {
  /** 원천 이름 = 조각 ID 의 이름공간. */
  name: string
  root?: string
  include: string[]
  exclude: string[]
  area?: string
  files: number
}

export interface InitPlan {
  config: WikiConfig
  sources: PlannedSource[]
}

const isMarkdown = (p: string): boolean => /\.md$/i.test(p)
/** 숨김 폴더 안 파일. 색인기의 파일 훑기(core/util.ts walkFiles)도 숨김 폴더를 건너뛴다. */
const inHiddenDir = (p: string): boolean => p.split('/').slice(0, -1).some((s) => s.startsWith('.'))

export function bundleNameOf(repoName: string): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return /^[a-z0-9]/.test(slug) ? slug : 'project-wiki'
}

const nsOf = (folder: string): string => folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'docs'

function countMatching(files: string[], include: string[], exclude: string[]): number {
  return files.filter((f) => matchesAny(f, include) && !matchesAny(f, exclude)).length
}

/** 문서 폴더 하나: 영역 하위 폴더는 따로 떼고, 나머지는 폴더 원천 하나로 둔다. */
function folderSources(top: string, docs: string[]): PlannedSource[] {
  const subs = [...new Set(docs.filter((f) => f.startsWith(`${top}/`)).map((f) => f.split('/')[1]))]
    .filter((sub) => AREA_SUBDIRS[sub] && docs.some((f) => f.startsWith(`${top}/${sub}/`)))
    .sort()
  const out: PlannedSource[] = subs.map((sub) => {
    const root = `${top}/${sub}`
    const include = [`${root}/**/*.md`]
    return { name: nsOf(`${top}-${sub}`), root, include, exclude: DEFAULT_EXCLUDES, area: AREA_SUBDIRS[sub], files: countMatching(docs, include, DEFAULT_EXCLUDES) }
  })
  const exclude = [...DEFAULT_EXCLUDES, ...subs.map((sub) => `${top}/${sub}/**`)]
  const include = [`${top}/**/*.md`]
  const files = countMatching(docs, include, exclude)
  if (files) out.unshift({ name: nsOf(top), root: top, include, exclude, ...(DOC_DIRS[top] ? { area: DOC_DIRS[top] } : {}), files })
  return out
}

/** 문서 폴더 밖 Markdown: 맨 위 파일(README 등)과 그 밖 폴더의 파일. */
function looseSources(docs: string[], docTops: string[]): PlannedSource[] {
  const out: PlannedSource[] = []
  const rootFiles = countMatching(docs, ['*.md'], [])
  if (rootFiles) out.push({ name: 'root', include: ['*.md'], exclude: [], files: rootFiles })
  const exclude = [...DEFAULT_EXCLUDES, '*.md', ...docTops.map((t) => `${t}/**`)]
  const files = countMatching(docs, ['**/*.md'], exclude)
  if (files) out.push({ name: 'other', include: ['**/*.md'], exclude, files })
  return out
}

/** 저장소 파일 목록(저장소 기준 상대 경로)에서 위키 설정 초안을 정한다. */
export function planWiki(repoName: string, files: string[]): InitPlan {
  const docs = files.filter((f) => isMarkdown(f) && !inHiddenDir(f) && !matchesAny(f, DEFAULT_EXCLUDES))
  const docTops = Object.keys(DOC_DIRS).filter((top) => docs.some((f) => f.startsWith(`${top}/`))).sort()
  const sources = [...docTops.flatMap((top) => folderSources(top, docs)), ...looseSources(docs, docTops)]
  const config: WikiConfig = {
    schema: 1,
    bundle: { name: bundleNameOf(repoName), title: `${repoName} 위키` },
    pack: 'core',
    sources: sources.map((s) => ({
      adapter: 'markdown',
      ...(s.root ? { root: s.root } : {}),
      include: s.include,
      ...(s.exclude.length ? { exclude: s.exclude } : {}),
      level: 'internal',
      idNamespace: s.name,
      ...(s.area ? { area: s.area } : {}),
    })),
    security: { maxLevel: 'confidential', excludePaths: ['**/.env*'], onSecret: 'quarantine' },
  }
  return { config, sources }
}
