// 낡음 판정: 근거 파일이 기준 커밋 뒤 바뀌었는지 본다. 묶음 만들기(build)와 출하 관문(stale 명령)이 같은 판정을 쓴다.
// 부르는 곳: cli/stale.ts · core/adapter.ts · core/build.ts · core/stale-baseline.ts 등. 먼저 읽을 파일: core/stale-pending.ts.
//
// 단위는 두 방식으로 판정한다.
// - 지금 방식(설계 산출물): 근거 경로가 폴더여도 접두로 비교하고, 판정할 수 없으면 판정 불가 수만 센다.
// - 위키 페이지 · 개발 문서 방식(`reviewInSameCommit` 또는 `blockOnStale` 단위): 저장소 안의 파일 근거만 판정한다.
//   HEAD 에 없는 파일(지운 파일 · 추적하지 않는 파일)도 기준 커밋에 있었으면 판정한다(`stale-pending.ts`).
//   그래서 근거를 지우거나 이름을 바꾸거나 추적에서 빼면 낡음이 된다.
//   근거와 문서가 같은 커밋에서 함께 바뀌었으면 그 변경은 확인한 것으로 본다(같은 커밋 규칙).
//   출하 차단 대상(`blockOnStale`)은 근거가 바뀌었거나 판정할 수 없으면 `stale` 이 된다.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { LOG_FORMAT, parseLogZ, splitZ, type LogCommit } from './git-out.ts'
import { spellingOf, type Spelling } from './git-spelling.ts'
import { groupByCommit, isJudgeable, resolveMissing, toPending, unjudged, type Pending, type TreeAt } from './stale-pending.ts'
import { countNoStatus } from './stale-status.ts'
import type { Anchor, Chunk, SourceUnit } from './model.ts'
import { cmp } from './util.ts'

export { isJudgeable } from './stale-pending.ts'

/**
 * 같은 커밋 규칙을 출하 차단 대상 페이지에도 적용할지. 지금은 적용하지 않는다. 그래서 차단 대상 페이지는 문서와 근거를 한 커밋에서 고쳐도 낡음으로 센다.
 */
export const SAME_COMMIT_FOR_BLOCKING = false

/** 출하 차단 사유. 경로를 넣지 않는다(읽는 화면에 그대로 보인다). */
export const BLOCK_REASON = {
  noCommit: '출하 차단 — 기준 커밋 없음',
  badCommit: '출하 차단 — 기준 커밋을 찾을 수 없음',
  shallow: '출하 차단 — 얕은 복제라 기준 커밋을 찾지 못함, 전체 이력으로 받으세요',
  noAnchor: '출하 차단 — 확인할 근거 없음',
  headUnclosed: '출하 차단 — 머리말이 닫히지 않음',
  gitFailed: '출하 차단 — 근거 변경을 확인하지 못함',
  changed: (n: number) => `출하 차단 — 근거 파일 ${n}개 바뀜`,
  caseMismatch: (n: number) => `출하 차단 — 근거 경로 ${n}개의 대소문자가 추적 파일과 다름`,
  noStatusNew: '출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록에 없음)',
  noStatusChanged: (was: string, now: string) => `출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록의 사유 「${was}」과 지금 사유 「${now}」이 다름)`,
  headMisshapen: '출하 차단 — 머리말 모양이 어긋나 상태를 읽지 못함, 머리말 모양(첫 줄 `---`)을 확인하세요',
  link: '출하 차단 — 문서가 심볼릭 링크라 상태를 읽지 못함, 링크를 실제 파일로 바꾸세요',
  anchorLink: '출하 차단 — 근거가 심볼릭 링크라 변경을 확인하지 못함, 근거에 실제 경로를 적으세요',
} as const

/** 낡은 근거 수와 대소문자만 다른 근거 수로 차단 사유를 만든다. 둘 다 있으면 한 줄에 함께 적는다. */
export function changedReason(changed: number, caseOnly: number): string {
  if (!caseOnly) return BLOCK_REASON.changed(changed)
  if (!changed) return BLOCK_REASON.caseMismatch(caseOnly)
  return `${BLOCK_REASON.changed(changed)} · ${BLOCK_REASON.caseMismatch(caseOnly).replace('출하 차단 — ', '')}`
}

export interface GitResult {
  code: number
  out: string
}
export type GitRun = (args: string[]) => GitResult

/**
 * 저장소에서 git 을 동기로 부른다. git 을 찾지 못하면 code 가 -1 이다.
 * `core.quotepath=false` 를 모든 호출에 넣는다. 기본값이면 `log` · `diff` 가 한글 등 비 ASCII 경로를
 * `"src/\355\225\234…"` 꼴로 감싸서, 근거 경로와 철자가 맞지 않아 변경을 놓친다.
 * 출력은 다듬지 않는다. `-z` 출력의 경로가 공백으로 시작하거나 끝날 수 있어서다.
 */
export function gitRunner(repoRoot: string): GitRun {
  return (args) => {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    return { code: r.status ?? -1, out: r.stdout ?? '' }
  }
}

export type StaleVerdict = { kind: 'block'; reason: string } | { kind: 'candidate'; commit: string; changed: Set<string>; prefix: boolean }

/** 상태를 읽지 못한 사유 종류: 머리말 없음 · status 없음 · 머리말 모양 · 표기 어긋남 · 심볼릭 링크(`stale-status.ts`). */
export type NoStatusKind = 'no-frontmatter' | 'no-status' | 'misshapen' | 'link'

export interface StaleReport {
  /** 출하 차단 페이지. */
  block: Array<{ id: string; title: string; reason: string }>
  /** 낡음 후보(경고) 단위 수. */
  warn: number
  /** 기준 커밋이 없거나 찾지 못했거나 git 이 실패해 판정하지 못한 단위 수(차단 대상 제외). */
  unverifiable: number
  /** 판정할 수 있는 근거가 0개인 문서 수(차단 대상 제외). */
  noAnchorDocs: number
  /**
   * 폴더 · 글롭 · 저장소 밖 · 기준 커밋에도 없던 경로 · 경로가 아닌 값이라 판정하지 않은 근거 수.
   * 같은 커밋 규칙으로 변경을 확인했지만 HEAD 에 없는 근거(문서가 지우거나 옮긴 옛 경로를 가리킴)도 센다.
   */
  unverifiableAnchors: number
  /**
   * 영역이 결정 · 정책인데 상태(`status`)를 읽지 못해 출하 차단 대상에서 빠진 문서 수.
   * 머리말 모양이 어긋나 영역부터 읽지 못한 문서도 센다(결정 · 정책일 수 있어서다).
   */
  noStatusDocs: number
  /** `noStatusDocs` 로 센 문서와 사유 종류. 기준 목록 잠금(`stale-baseline.ts`)이 쓴다. */
  noStatusList: Array<{ path: string; id: string; title: string; kind: NoStatusKind }>
  /** 기준 목록에는 있는데 지금은 상태를 읽지 못한 문서로 세지 않는 문서 수. 기준 목록을 쓸 때만 채운다. */
  noStatusGone?: number
  /** 사람이 볼 경고 줄. */
  warnings: string[]
}

// ── 근거 경로 처리 ────────────────────────────────────────────────────────────

/** 중괄호 표기를 한 단계만 푼다. `a/{b,c}.ts` → `a/b.ts`, `a/c.ts`. 중괄호가 없으면 그대로 돌려준다. */
export function expandBraces(v: string): string[] {
  const m = /^([^{}]*)\{([^{}]*)\}(.*)$/.exec(v)
  if (!m) return [v]
  return m[2].split(',').map((alt) => `${m[1]}${alt.trim()}${m[3]}`)
}

/**
 * 근거 값을 앵커로 넣을 경로와 넣지 않을 값으로 나눈다.
 * 글롭 · 저장소 밖(절대 경로 · `..`) · 경로가 아닌 값(`/` 도 `.` 도 없음)은 앵커로 넣지 않고 수만 센다.
 * 넣는 경로는 정규화하고 앞의 `./` 를 뗀다(`./src//x/../a.ts` → `src/a.ts`).
 * 폴더 · 없는 경로는 앵커로 넣는다(해시가 null). 위키 페이지 · 개발 문서 방식에서 폴더는 판정하지 않고,
 * 없는 경로는 기준 커밋에 파일로 있었을 때만 판정한다(지우거나 이름을 바꾼 근거).
 */
export function splitAnchorValues(values: string[]): { paths: string[]; skipped: number } {
  const paths: string[] = []
  let skipped = 0
  for (const raw of values) {
    for (const v of expandBraces(raw.trim())) {
      const p = v.replace(/\/+$/, '')
      const outside = path.posix.isAbsolute(p) || path.posix.normalize(p).startsWith('..')
      if (!p || /[*?[\]{}]/.test(p) || !/[/.]/.test(p) || outside) skipped++
      else {
        // `./src/a.ts` · `src//a.ts` · `src/x/../a.ts` 를 git 이 쓰는 철자(`src/a.ts`)로 맞춘다. 그대로 두면 git 출력과 맞지 않는다.
        const n = path.posix.normalize(p).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
        if (!paths.includes(n)) paths.push(n)
      }
    }
  }
  return { paths, skipped }
}

function isStrict(u: SourceUnit): boolean {
  return u.reviewInSameCommit === true || u.blockOnStale === true
}

function appliesSameCommit(u: SourceUnit): boolean {
  return u.reviewInSameCommit === true && (u.blockOnStale !== true || SAME_COMMIT_FOR_BLOCKING)
}

// ── git 조회(기준 커밋마다 한 번) ────────────────────────────────────────────

type CommitState = 'ok' | 'bad' | 'shallow' | 'git-failed'

interface GitCache {
  commitState(commit: string): CommitState
  /** `<기준>..HEAD` 커밋마다 바뀐 파일(경로 한정). git 이 실패하면 null. */
  log(commit: string, paths: string[]): LogCommit[] | null
  /** `<기준>..HEAD` 병합 커밋마다 모든 부모와 다른 파일(결합 차이). git 이 실패하면 null. */
  mergeOwn(commit: string, paths: string[]): Map<string, Set<string>> | null
  diff(commit: string, paths: string[]): Set<string> | null
  /** 기준 커밋에 있던 파일의 철자(커밋마다 한 번만 읽는다). git 이 실패하면 null. */
  treeAt: TreeAt
  /** `<기준>..HEAD` 에서 더해진 적이 있는 파일의 철자(커밋마다 한 번만 읽는다). git 이 실패하면 null. */
  addedSince: TreeAt
  /** git 이 추적하는 경로의 철자(`ls-files`, 한 번만 읽는다). git 이 실패하면 null. */
  spelling(): Spelling | null
}

/** 커밋마다 git 을 한 번 불러 경로 목록의 철자를 만든다. 같은 커밋은 다시 부르지 않는다. */
function spellingPerCommit(read: (c: string) => string[] | null): TreeAt {
  const memo = new Map<string, Spelling | null>()
  return (c) => {
    if (!memo.has(c)) {
      const paths = read(c)
      memo.set(c, paths ? spellingOf(paths) : null)
    }
    return memo.get(c)!
  }
}

function gitCache(git: GitRun): GitCache {
  let headOk: boolean | undefined
  let shallow: boolean | undefined
  const states = new Map<string, CommitState>()
  let spelling: Spelling | null | undefined
  const state = (c: string): CommitState => {
    headOk ??= git(['rev-parse', '--verify', '--quiet', 'HEAD']).code === 0
    if (!headOk) return 'git-failed'
    if (!/^[0-9a-f]{7,40}$/i.test(c)) return 'bad'
    // 얕은 복제는 기준 커밋이 있어도 그 뒤 이력이 잘려 있을 수 있다. 그래서 조상 여부와 관계없이 전체 이력으로 받으라고 한다.
    shallow ??= git(['rev-parse', '--is-shallow-repository']).out.trim() === 'true'
    if (shallow) return 'shallow'
    return git(['merge-base', '--is-ancestor', c, 'HEAD']).code === 0 ? 'ok' : 'bad'
  }
  return {
    commitState(c) {
      if (!states.has(c)) states.set(c, state(c))
      return states.get(c)!
    },
    log(c, paths) {
      // 이름 바꾸기를 짝짓지 않아야 옛 경로가 「지워짐」으로 나온다. 짝지으면 새 경로만 나와 옛 근거의 변경을 놓친다.
      // 병합 커밋은 첫 부모와 비교한 파일을 낸다. 기본값이면 병합 커밋의 파일을 내지 않아, 충돌 해결처럼 병합 커밋에서만 생긴 변경을 놓친다.
      // -z: 큰따옴표 · 역슬래시 · 탭이 든 경로는 core.quotepath=false 여도 감싸서 나온다. NUL 로 끊어 받으면 철자 그대로다.
      const r = git(['log', '-z', '--no-renames', '--diff-merges=first-parent', LOG_FORMAT, '--name-only', `${c}..HEAD`, '--', ...paths])
      return r.code === 0 ? parseLogZ(r.out) : null
    },
    mergeOwn(c, paths) {
      // 결합 차이는 어느 부모와도 내용이 다른 파일만 낸다. 병합 커밋이 스스로 만든 변경(충돌 해결 등)이다.
      const r = git(['log', '-z', '--merges', '--no-renames', '--diff-merges=combined', LOG_FORMAT, '--name-only', `${c}..HEAD`, '--', ...paths])
      return r.code === 0 ? new Map(parseLogZ(r.out).map((m) => [m.hash, m.files])) : null
    },
    diff(c, paths) {
      // log 와 같은 까닭으로 이름 바꾸기를 짝짓지 않는다. 짝지으면 새 경로만 나와, 옛 경로를 근거로 둔 장을 놓친다.
      const r = git(['diff', '-z', '--no-renames', '--name-only', c, 'HEAD', '--', ...paths])
      return r.code === 0 ? new Set(splitZ(r.out)) : null
    },
    spelling() {
      if (spelling === undefined) {
        const r = git(['ls-files', '-z'])
        spelling = r.code === 0 ? spellingOf(splitZ(r.out)) : null
      }
      return spelling
    },
    // 경로를 좁히지 않고 전체 목록을 받는다. 경로 인자는 철자가 정확히 같아야 맞아서, NFD 로 적은 근거를 놓친다.
    // -z: 따옴표 · 줄바꿈이 든 경로도 감싸지 않고 그대로 받는다.
    treeAt: spellingPerCommit((c) => {
      const r = git(['ls-tree', '-r', '-z', '--name-only', c])
      return r.code === 0 ? splitZ(r.out) : null
    }),
    // 기준 커밋 뒤에 더해진 파일. 곁가지에서 더한 파일도 그 커밋에서 나오고, 병합 커밋은 첫 부모와 비교한다.
    addedSince: spellingPerCommit((c) => {
      const r = git(['log', '-z', '--no-renames', '--diff-filter=A', '--diff-merges=first-parent', LOG_FORMAT, '--name-only', `${c}..HEAD`])
      return r.code === 0 ? parseLogZ(r.out).flatMap((m) => [...m.files]) : null
    }),
  }
}

// ── 판정 ────────────────────────────────────────────────────────────────────

function emptyReport(): StaleReport {
  return { block: [], warn: 0, unverifiable: 0, noAnchorDocs: 0, unverifiableAnchors: 0, noStatusDocs: 0, noStatusList: [], warnings: [] }
}

/** 설계 산출물(지금 방식): 근거가 폴더면 접두로 비교한다. git 이 실패하면 판정 불가로 센다. */
function judgeLegacy(units: SourceUnit[], g: GitCache, verdicts: Map<string, StaleVerdict>, report: StaleReport): void {
  // 심볼릭 링크를 지나는 근거는 판정하지 않고 근거 확인 불가로 센다.
  const own = (u: SourceUnit) => u.anchors.filter((a) => !a.link)
  for (const u of units) report.unverifiableAnchors += u.anchors.length - own(u).length
  const todo = units.filter((u) => u.baseCommit && own(u).length)
  // 있는 파일 근거는 git 의 철자로 바꿔 비교한다. 철자를 찾지 못하면(폴더 · 추적 안 함) 적힌 그대로 둔다.
  const sp = todo.length ? g.spelling() : null
  const spell = (a: Anchor) => (isJudgeable(a) && sp?.resolve(a.path)) || a.path
  const groups = groupByCommit(todo, (u) => u.baseCommit!, (u) => own(u).map(spell))
  for (const [commit, { items, paths }] of groups) {
    const changed = g.diff(commit, paths)
    if (!changed) {
      report.unverifiable += items.length
      report.warnings.push(`기준 커밋 ${commit} 과 HEAD 를 비교하지 못함(단위 ${items.length}개)`)
      continue
    }
    for (const u of items) {
      if (!own(u).some((a) => hitsPath(spell(a), changed, true))) continue
      // 조각의 앵커는 문서에 적힌 철자다. 그래서 git 철자와 다른 근거는 적힌 철자도 함께 싣는다.
      const shown = new Set([...changed, ...own(u).filter((a) => changed.has(spell(a))).map((a) => a.path)])
      verdicts.set(u.path, { kind: 'candidate', commit, changed: shown, prefix: true })
      report.warn++
    }
  }
}

function hitsPath(anchor: string, changed: Set<string>, prefix: boolean): boolean {
  return changed.has(anchor) || (prefix && [...changed].some((f) => f.startsWith(`${anchor}/`)))
}

type Early = { block: string } | { count: 'unverifiable' | 'noAnchorDocs'; warning?: string }

/** 기준 커밋을 확인하기만 해도 결론이 나는 경우. 판정을 이어 가면 null. */
function precheck(u: SourceUnit, g: GitCache): Early | null {
  const block = u.blockOnStale === true
  if (!u.baseCommit) return block ? { block: BLOCK_REASON.noCommit } : { count: 'unverifiable' }
  const st = g.commitState(u.baseCommit)
  if (st === 'git-failed') return gitFailed(u, `${u.path}: git 을 실행하지 못해 근거 변경을 확인하지 못함`)
  if (st !== 'ok') {
    const reason = st === 'shallow' ? BLOCK_REASON.shallow : BLOCK_REASON.badCommit
    return block ? { block: reason } : { count: 'unverifiable', warning: `${u.path}: 기준 커밋 ${u.baseCommit} 을 찾을 수 없음${st === 'shallow' ? '(얕은 복제)' : ''}` }
  }
  return null
}

/** 차단 대상 문서의 근거가 심볼릭 링크를 지나면 막는다. 다른 문서는 그 근거만 판정에서 뺀다(`isJudgeable`). */
function linkedAnchor(u: SourceUnit): Early | null {
  return u.blockOnStale && u.anchors.some((a) => a.link) ? { block: BLOCK_REASON.anchorLink } : null
}

function gitFailed(u: SourceUnit, warning: string): Early {
  return u.blockOnStale ? { block: BLOCK_REASON.gitFailed } : { count: 'unverifiable', warning }
}

function settle(u: SourceUnit, e: Early, verdicts: Map<string, StaleVerdict>, report: StaleReport): void {
  if ('block' in e) {
    verdicts.set(u.path, { kind: 'block', reason: e.block })
    report.block.push({ id: u.page, title: u.title, reason: e.block })
    return
  }
  report[e.count]++
  if (e.warning) report.warnings.push(e.warning)
}

type MergeOwn = () => Map<string, Set<string>> | null

/** 같은 커밋 규칙을 반영해 낡은 근거 경로를 고른다. */
function staleAnchors(u: SourceUnit, anchors: string[], commits: LogCommit[], mergeOwn: MergeOwn): string[] {
  const same = appliesSameCommit(u)
  const hit = new Set<string>()
  for (const c of commits) {
    for (const a of anchors) if (c.files.has(a) && !(same && reviewedTogether(u.path, a, c, commits, mergeOwn))) hit.add(a)
  }
  return [...hit].sort(cmp)
}

/**
 * 커밋 c 의 근거 a 변경을 문서와 함께 확인한 것으로 볼지(같은 커밋 규칙).
 * 병합 커밋의 파일 목록은 첫 부모와의 차이라서, 문서가 곁가지의 다른 커밋에서 바뀌어도 함께 나온다.
 * 그래서 병합 커밋은 근거 내용이 다른 부모에서 그대로 왔고(결합 차이에 없음), 근거와 문서를 함께 고친
 * 보통 커밋이 범위 안에 있을 때만 확인한 것으로 본다. 결합 차이를 읽지 못하면 확인하지 않은 것으로 본다.
 */
function reviewedTogether(doc: string, a: string, c: LogCommit, commits: LogCommit[], mergeOwn: MergeOwn): boolean {
  if (!c.files.has(doc)) return false
  if (!c.merge) return true
  const own = mergeOwn()
  if (!own || own.get(c.hash)?.has(a)) return false
  return commits.some((o) => !o.merge && o.files.has(a) && o.files.has(doc))
}

/** 기준 커밋 · 근거 수로 결론이 나는 단위를 정리하고, git 로그로 판정할 단위를 돌려준다. */
function strictPending(units: SourceUnit[], g: GitCache, verdicts: Map<string, StaleVerdict>, report: StaleReport): Pending[] {
  const pending: Pending[] = []
  for (const u of units) {
    const anchors = u.anchors.filter(isJudgeable).map((a) => a.path)
    const early = precheck(u, g) ?? linkedAnchor(u)
    if (!early) {
      pending.push(toPending(u, g.spelling()))
      continue
    }
    report.unverifiableAnchors += unjudged(u, anchors.length)
    settle(u, early, verdicts, report)
  }
  resolveMissing(pending, g.treeAt, g.addedSince)
  return pending.filter((p) => {
    report.unverifiableAnchors += unjudged(p.u, p.anchors.length)
    const early = afterResolve(p)
    if (early) settle(p.u, early, verdicts, report)
    return !early
  })
}

/** 기준 커밋의 파일 목록을 본 뒤 결론이 나는 경우(목록을 읽지 못함 · 판정할 근거 0개). */
function afterResolve(p: Pending): Early | null {
  if (p.failed) return gitFailed(p.u, `${p.u.path}: 추적 파일 목록이나 기준 커밋 ${p.u.baseCommit} 의 파일 목록을 읽지 못함`)
  if (p.anchors.length) return null
  return p.u.blockOnStale ? { block: BLOCK_REASON.noAnchor } : { count: 'noAnchorDocs' }
}

/**
 * 이력(첫 부모 기준)에 한 번도 나오지 않았는데 기준 커밋과 HEAD 의 내용이 다른 근거를 낡은 근거에 더한다.
 * 병합이 기준 커밋 쪽의 근거 변경을 버리고 첫 부모는 근거를 고치지 않은 경우다. 같은 커밋 규칙을 쓰지 않는 단위는
 * HEAD 에 없는 근거(기준 커밋에는 있었음)도 더한다.
 */
function withNetChanges(u: SourceUnit, hit: string[], o: { anchors: string[]; missing: string[]; commits: LogCommit[]; net: Set<string> }): string[] {
  const unseen = o.anchors.filter((a) => o.net.has(a) && !o.commits.some((c) => c.files.has(a)))
  const gone = appliesSameCommit(u) ? [] : o.missing.filter((m) => o.anchors.includes(m))
  return [...new Set([...hit, ...unseen, ...gone])].sort(cmp)
}

interface History {
  commit: string
  commits: LogCommit[]
  net: Set<string>
  mergeOwn: MergeOwn
}

/** 한 단위를 기준 커밋 뒤 기록으로 판정한다. */
function judgeOne(p: Pending, h: History, verdicts: Map<string, StaleVerdict>, report: StaleReport): void {
  const { u, anchors, missing, written } = p
  const real = withNetChanges(u, staleAnchors(u, anchors, h.commits, h.mergeOwn), { anchors, missing: [], commits: h.commits, net: h.net })
  const hit = withNetChanges(u, real, { anchors, missing, commits: h.commits, net: h.net })
  // 같은 커밋 규칙으로 변경을 확인했어도 그 근거는 HEAD 에 없다. 그래서 판정한 근거로 세지 않고 근거 확인 불가로 센다.
  report.unverifiableAnchors += missing.filter((m) => anchors.includes(m) && !hit.includes(m)).length
  if (!hit.length) return
  if (u.blockOnStale) {
    // 대소문자만 다른 근거는 파일이 바뀌지 않았어도 HEAD 의 철자로는 없어 「없어진 근거」로 잡힌다. 사유를 나눠 적는다.
    const caseOnly = hit.filter((a) => !real.includes(a) && p.caseOnly.includes(a)).length
    settle(u, { block: changedReason(hit.length - caseOnly, caseOnly) }, verdicts, report)
    return
  }
  verdicts.set(u.path, { kind: 'candidate', commit: h.commit, changed: new Set(hit.map((x) => written.get(x) ?? x)), prefix: false })
  report.warn++
}

/** 위키 페이지 · 개발 문서 방식. */
function judgeStrict(units: SourceUnit[], g: GitCache, verdicts: Map<string, StaleVerdict>, report: StaleReport): void {
  const pending = strictPending(units, g, verdicts, report)
  const groups = groupByCommit(pending, (p) => p.u.baseCommit!, (p) => [...p.anchors, p.u.path])
  for (const [commit, { items, paths }] of groups) {
    const commits = g.log(commit, paths)
    const net = commits && g.diff(commit, paths)
    let own: ReturnType<MergeOwn> | undefined
    const mergeOwn: MergeOwn = () => (own === undefined ? (own = g.mergeOwn(commit, paths)) : own)
    for (const p of items) {
      if (commits && net) judgeOne(p, { commit, commits, net, mergeOwn }, verdicts, report)
      else settle(p.u, p.u.blockOnStale ? { block: BLOCK_REASON.gitFailed } : { count: 'unverifiable', warning: `${p.u.path}: 기준 커밋 ${commit} 뒤 이력을 읽지 못함` }, verdicts, report)
    }
  }
}

/** 단위마다 낡음을 판정한다. 결과는 단위 경로 → 판정과 수치 보고다. */
export function judgeStale(units: SourceUnit[], git: GitRun): { verdicts: Map<string, StaleVerdict>; report: StaleReport } {
  const g = gitCache(git)
  const verdicts = new Map<string, StaleVerdict>()
  const report = emptyReport()
  // 머리말이 닫히지 않은 문서는 차단 대상인지 알 수 없다. 그래서 머리말 없는 문서로 넘기지 않고 출하를 막는다.
  for (const u of units.filter((x) => x.headUnclosed)) settle(u, { block: BLOCK_REASON.headUnclosed }, verdicts, report)
  const readable = units.filter((u) => !u.headUnclosed)
  judgeLegacy(readable.filter((u) => !isStrict(u)), g, verdicts, report)
  judgeStrict(readable.filter(isStrict), g, verdicts, report)
  countNoStatus(readable, report)
  report.block.sort((a, b) => cmp(a.id, b.id))
  return { verdicts, report }
}

/** 판정을 조각에 싣는다. 차단은 페이지의 모든 조각에, 낡음 후보는 바뀐 근거를 가진 조각에만 붙는다. */
export function applyStale(chunks: Chunk[], verdicts: Map<string, StaleVerdict>): void {
  for (const c of chunks) {
    const v = verdicts.get(c.source.path)
    if (!v) continue
    if (v.kind === 'block') {
      c.stale = { state: 'stale', reason: v.reason }
      continue
    }
    const hit = c.anchors.filter((a) => hitsPath(a.path, v.changed, v.prefix)).map((a) => a.path)
    if (hit.length) c.stale = { state: 'stale-candidate', reason: `근거 파일이 기준 커밋 ${v.commit} 뒤 바뀜: ${hit.join(', ')}` }
  }
}

/** 묶음 만들기용: 판정하고 조각에 싣는다. */
export function markStale(units: SourceUnit[], chunks: Chunk[], git: GitRun): StaleReport {
  const { verdicts, report } = judgeStale(units, git)
  applyStale(chunks, verdicts)
  return report
}

/** `stale --json` 출력 형식. */
export function staleJson(r: StaleReport): Omit<StaleReport, 'warnings' | 'noStatusList'> {
  return { block: r.block, warn: r.warn, unverifiable: r.unverifiable, noAnchorDocs: r.noAnchorDocs, unverifiableAnchors: r.unverifiableAnchors, noStatusDocs: r.noStatusDocs, ...(r.noStatusGone !== undefined ? { noStatusGone: r.noStatusGone } : {}) }
}
