// 낡음 판정(위키 페이지 · 개발 문서 방식)에 넣을 근거를 고른다.
// 부르는 곳: core/stale.ts. 먼저 읽을 파일: core/stale.ts.
// 문서에 적힌 근거 경로를 git 이 기록한 철자로 바꾸고, 지금 추적하지 않는 근거는 기준 커밋의 파일 목록으로 확인한다.
import type { Spelling } from './git-spelling.ts'
import type { Anchor, SourceUnit } from './model.ts'
import { cmp } from './util.ts'

/**
 * 위키 페이지 · 개발 문서 방식에서 바로 판정할 수 있는 근거: 지금 저장소에 있는 파일.
 * 지금 없는 경로(해시가 null)는 기준 커밋에 파일로 있었는지 git 으로 확인한 뒤 판정에 넣는다(`resolveMissing`).
 * 심볼릭 링크를 지나는 근거(`link`)는 판정하지 않는다. git 이력에 대상 파일의 변경이 나오지 않아서다.
 */
export function isJudgeable(a: Anchor): boolean {
  return a.kind === 'file' && a.hash !== null && !a.link
}

export function groupByCommit<T>(items: T[], commitOf: (t: T) => string, pathsOf: (t: T) => string[]): Map<string, { items: T[]; paths: string[] }> {
  const out = new Map<string, { items: T[]; paths: string[] }>()
  for (const it of items) {
    const g = out.get(commitOf(it)) ?? { items: [], paths: [] }
    g.items.push(it)
    for (const p of pathsOf(it)) if (!g.paths.includes(p)) g.paths.push(p)
    out.set(commitOf(it), g)
  }
  for (const g of out.values()) g.paths.sort(cmp)
  return out
}

export interface Pending {
  u: SourceUnit
  /** 판정할 근거 경로(git 의 철자). */
  anchors: string[]
  /** git 의 철자 → 문서에 적힌 철자. 판정 결과는 적힌 철자로 싣는다(조각의 앵커와 맞춘다). */
  written: Map<string, string>
  /**
   * HEAD 에 없는 파일 근거. 파일이 없는 근거와, 파일은 있는데 git 이 추적하지 않는 근거다.
   * 기준 커밋에 파일로 있었으면 `anchors` 로 옮긴다(`resolveMissing`).
   */
  missing: string[]
  /**
   * 문서가 적은 철자로는 파일이 없는데, 대소문자만 바꾸면 지금 추적 중인 파일(git 의 철자).
   * 대소문자를 가리는 볼륨에서 생긴다. 차단 사유를 「대소문자가 다름」으로 나눠 적으려고 따로 둔다.
   */
  caseOnly: string[]
  /** 추적 파일 목록이나 기준 커밋의 파일 목록을 읽지 못했다. */
  failed?: true
}

const folded = (p: string) => p.normalize('NFC').toLowerCase()

/** 지금 추적하는 철자 s 가 적힌 철자 w 와 대소문자만 다른가. */
function caseOnlyOf(w: string, s: string | null | undefined): s is string {
  return !!s && s.normalize('NFC') !== w.normalize('NFC') && folded(s) === folded(w)
}

/**
 * 판정할 단위. 있는 파일 근거는 git 이 추적하는 철자로 바꾼다(유니코드 정규화 · 대소문자 차이).
 * 철자를 찾지 못한 근거는 버리지 않고 HEAD 에 없는 근거로 둔다. 추적에서 뺀 근거가 작업 폴더에 남아도
 * 기준 커밋과 견줘 낡음으로 잡기 위해서다. 추적 목록을 읽지 못하면 git 실패로 다룬다.
 */
export function toPending(u: SourceUnit, sp: Spelling | null): Pending {
  const written = new Map<string, string>()
  const missing: string[] = []
  const caseOnly: string[] = []
  for (const a of u.anchors) {
    // 링크 근거는 HEAD 에 없는 근거로도 넣지 않는다. 넣으면 기준 커밋의 링크 경로와 견줘 「바뀜」으로 잡힌다.
    if (a.kind !== 'file' || a.link) continue
    const s = isJudgeable(a) ? sp?.resolve(a.path) : null
    if (s) {
      if (!written.has(s)) written.set(s, a.path)
      continue
    }
    if (!missing.includes(a.path)) missing.push(a.path)
    const c = sp?.resolve(a.path)
    if (caseOnlyOf(a.path, c) && !caseOnly.includes(c)) caseOnly.push(c)
  }
  return { u, anchors: [...written.keys()], written, missing, caseOnly, ...(sp ? {} : { failed: true as const }) }
}

/** 기준 커밋마다 한 번 git 을 불러 파일 철자 목록을 돌려준다. git 이 실패하면 null. */
export type TreeAt = (commit: string) => Spelling | null

/**
 * HEAD 에 없는 근거 가운데 기준 커밋에 파일로 있던 것을 판정에 넣는다. 그래서 근거를 지우거나 이름을 바꾸거나
 * 추적에서 빼면 낡음이 된다. 기준 커밋에 없던 경로는 기준 커밋과 HEAD 사이의 기록(`addedSince`)에서 찾는다.
 * 기록에서 더해진 적이 있으면 「있었다가 사라진」 근거라 판정에 넣고, 기록에도 없던 경로만 판정하지 않는다(근거 확인 불가).
 * 두 목록 모두 철자를 맞춘다(유니코드 정규화 · 대소문자). 그래서 NFD 로 적은 근거를 지워도 잡는다.
 * 찾은 근거는 목록의 철자로 `anchors` 와 `missing` 에 둔다. 기록은 기준 커밋에서 못 찾은 근거가 있을 때만 읽는다.
 */
export function resolveMissing(pending: Pending[], treeAt: TreeAt, addedSince: TreeAt): void {
  for (const p of pending) {
    if (!p.missing.length) continue
    const commit = p.u.baseCommit!
    const tree = treeAt(commit)
    const rest = tree ? p.missing.filter((m) => !take(p, m, tree.resolve(m))) : []
    const added = rest.length ? addedSince(commit) : null
    if (!tree || (rest.length && !added)) {
      p.failed = true
      continue
    }
    for (const m of rest) take(p, m, added!.resolve(m))
    p.missing = p.anchors.filter((a) => p.missing.some((m) => p.written.get(a) === m))
  }
}

/** 찾은 철자 s 를 판정할 근거로 넣는다. 찾지 못했으면 false. */
function take(p: Pending, m: string, s: string | null): boolean {
  if (!s) return false
  if (!p.anchors.includes(s)) {
    p.anchors.push(s)
    p.written.set(s, m)
  }
  return true
}

/** 판정하지 않은 근거 수: 앵커로 넣지 않은 값 + 판정에 넣지 못한 앵커. */
export function unjudged(u: SourceUnit, judged: number): number {
  return (u.skippedAnchors ?? 0) + u.anchors.length - judged
}
