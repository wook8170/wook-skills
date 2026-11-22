// search · read · backlinks 명령. 원천은 세 가지다: 묶음 경로(첫 위치 인자), --root + --config(작업 트리 모드), 아무것도 없으면 프로젝트 모드.
// 프로젝트 모드는 원천이 바뀌었으면 먼저 바뀐 문서만 다시 나눠 색인을 새로 만든 뒤 답한다(--no-refresh 면 건너뛴다).
// 부르는 곳: cli/main.ts. 먼저 읽을 파일: core/search.ts · dev/refresh.ts.
import { readBundle } from '../core/bundle.ts'
import type { Chunk, Level, LinkKind } from '../core/model.ts'
import { parseLevel } from '../core/model.ts'
import { WikiIndex, isReadError } from '../core/search.ts'
import { bundleDir } from '../dev/cache.ts'
import { openRoot, rootContext } from '../dev/serve-root.ts'
import { UsageError, areaScope, err, list, out, str, type Opts } from './args.ts'
import { buildProject } from './build.ts'
import { isBundlePath, resolveProject } from './project.ts'

export function openBundleIndex(p: string | undefined): WikiIndex {
  if (!p) throw new UsageError('묶음 경로가 없다')
  return new WikiIndex(readBundle(p))
}

/** 프로젝트 모드: 바뀌었으면 다시 만들고(표준 오류에 한 줄) 색인 폴더의 묶음을 연다. */
async function openProject(opt: Opts): Promise<WikiIndex> {
  if (opt['no-refresh'] !== true) {
    const { result } = await buildProject({ ...opt, quiet: true }, false)
    if (result) err(`색인 새로 고침 · 다시 나눈 문서 ${result.chunking.chunked} · 그대로 쓴 문서 ${result.chunking.reused}`)
  }
  const project = resolveProject(opt)
  return new WikiIndex(readBundle(bundleDir(rootContext(project.root, project.configPath).cacheDir)))
}

/** 조회 명령의 색인과 나머지 위치 인자. */
export async function queryTarget(pos: string[], opt: Opts): Promise<{ index: WikiIndex; rest: string[] }> {
  const root = str(opt.root)
  if (root !== undefined && str(opt.config) !== undefined) {
    if (opt.bundle !== undefined) throw new UsageError('--bundle 과 --root 는 함께 줄 수 없다')
    return { index: (await openRoot(root, str(opt.config)!, err)).index, rest: pos }
  }
  if (isBundlePath(pos[0])) return { index: openBundleIndex(pos[0]), rest: pos.slice(1) }
  return { index: await openProject(opt), rest: pos }
}

export function capOf(index: WikiIndex, v: string | true | undefined): Level {
  return str(v) ? parseLevel(str(v)) : index.manifest.maxLevel
}

export async function cmdSearch(pos: string[], opt: Opts): Promise<number> {
  const scope = areaScope(opt)
  const { index, rest } = await queryTarget(pos, opt)
  const q = rest.join(' ')
  if (!q) throw new UsageError('질의가 없다')
  const r = index.search({
    q,
    cap: capOf(index, opt.level),
    kinds: list(opt.kind) as Chunk['kind'][] | undefined,
    ...scope,
    excludeStale: opt['exclude-stale'] === true,
    limit: Number(str(opt.limit) ?? 10),
  })
  if (opt.json === true) {
    out(JSON.stringify(r, null, 2))
    return 0
  }
  r.hits.forEach((h, i) => {
    out(`${String(i + 1).padStart(2)}. ${h.id}  (${h.score})${h.stale ? ` [${h.stale.state}]` : ''}`)
    out(`    ${h.titlePath.join(' › ')}`)
    out(`    ${h.snippet}`)
  })
  out(`합계 ${r.total} · 등급으로 뺀 조각 ${r.filteredCount}`)
  return 0
}

export async function cmdRead(pos: string[], opt: Opts): Promise<number> {
  const scope = areaScope(opt)
  const { index, rest } = await queryTarget(pos, opt)
  if (!rest[0]) throw new UsageError('ID 가 없다')
  const r = index.read(rest[0], { cap: capOf(index, opt.level), context: opt.context === true, ...scope })
  if (isReadError(r)) {
    err(`${r.error}: ${r.id}`)
    return 1
  }
  out(JSON.stringify(r, null, 2))
  return 0
}

export async function cmdBacklinks(pos: string[], opt: Opts): Promise<number> {
  const scope = areaScope(opt)
  const { index, rest } = await queryTarget(pos, opt)
  if (!rest[0]) throw new UsageError('대상이 없다')
  const kinds = list(opt.kind) as LinkKind[] | undefined
  out(JSON.stringify(index.backlinks(rest[0], { cap: capOf(index, opt.level), kinds, limit: Number(str(opt.limit) ?? 20), ...scope }), null, 2))
  return 0
}
