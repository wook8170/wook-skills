// 원천 파일마다 마지막으로 고친 날(git 커밋 날짜, `YYYY-MM-DD`)을 조각의 modifiedAt 에 싣는다.
// 부르는 곳: core/build.ts. 먼저 읽을 파일: core/build.ts.
// 머리말 `verified_at`(따로 확인한 날)이 있으면 읽는 쪽이 그 값을 먼저 쓴다. 여기서는 수정일만 구한다.
//
// - git 은 한 번만 부른다: `git log <묶음 커밋> --name-only` 를 새 커밋부터 훑어 파일마다 처음 만난 날을 쓴다.
//   파일 날짜는 그 파일을 고친 가장 최근의 일반 커밋 날짜다. 통합 브랜치에 병합한 날로 바뀌지 않게, 병합 커밋 날짜는
//   일반 커밋이 하나도 없는 파일(병합으로만 들어온 파일 — 다른 이력을 합친 경우)에만 쓴다. 병합 커밋의 파일 이름은
//   첫 부모와의 차이로 뽑는다(`--diff-merges=first-parent`). 그러지 않으면 병합 커밋에는 이름이 안 나와 그 파일 날짜가 빠진다.
// - 날짜는 작성자 날짜(`%ad`)다. 커미터 날짜는 리베이스 · 체리픽만 해도 바뀌어, 내용이 같은데 「확인」이 바뀌었다.
//   커밋에 기록된 시간대 그대로(`--date=format:`)라서, 만드는 머신의 시간대가 달라도 같은 커밋이면 같은 값이다.
// - `--diff-merges=first-parent` 는 git 2.31 이상에서만 된다. 그보다 낮으면 그 옵션 없이 부르고(병합으로만 들어온 파일은 「—」),
//   git 호출이 실패하면 수정일 없이 만든다. 두 경우 모두 빌드 경고로 남긴다(조용히 넘어가지 않는다).
// - 미커밋 변경이 있는 파일(`--allow-dirty` 로 만든 묶음)은 커밋 날짜가 내용보다 오래되므로 싣지 않는다(「—」).
// - 생성 장(`generated`)은 싣지 않는다. 날짜가 사람이 고친 날이 아니라 생성 스크립트를 다시 돌린 날이라서다.
import type { Chunk, SourceUnit } from './model.ts'

export type GitRun = (args: string[]) => string | null

const SEP = '\u0000'

/**
 * `git log` 출력(커밋마다 `\0날짜 부모…` 줄 뒤 파일 이름 줄, 새 커밋부터)을 파일 → 날짜로 읽는다.
 * 일반 커밋에서 처음 만난 날이 우선이고, 일반 커밋이 없는 파일만 처음 만난 병합 커밋 날을 쓴다.
 */
export function parseLastDates(out: string): Map<string, string> {
  const plain = new Map<string, string>()
  const merged = new Map<string, string>()
  for (const block of out.split(SEP)) {
    const [head, ...names] = block.split('\n')
    const [date, ...parents] = head.trim().split(' ')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue
    const into = parents.length > 1 ? merged : plain
    for (const n of names) if (n && !into.has(n)) into.set(n, date)
  }
  for (const [n, d] of merged) if (!plain.has(n)) plain.set(n, d)
  return plain
}

/** `--diff-merges` 가 들어온 git 버전. */
export const DIFF_MERGES_MIN: readonly [number, number] = [2, 31]

/** `git version` 출력(예: `git version 2.50.1 (Apple Git-155)`) → [주, 부]. 읽지 못하면 null. */
export function parseGitVersion(out: string | null): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(out ?? '')
  return m ? [Number(m[1]), Number(m[2])] : null
}

const atLeast = (v: [number, number], min: readonly [number, number]) => v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])

/**
 * 원천 폴더(경로 앞 두 단계) 아래 파일의 마지막 커밋 날짜와 빌드 경고.
 * 커밋을 모르면(git 저장소가 아님) 날짜 없이 경고도 없다. 버전이 낮거나 git 호출이 실패하면 경고를 돌려준다.
 */
export function lastCommitDates(run: GitRun, commit: string | null, units: SourceUnit[]): { dates: Map<string, string> | null; warnings: string[] } {
  if (!commit || !units.length) return { dates: null, warnings: [] }
  const warnings: string[] = []
  const version = parseGitVersion(run(['version']))
  const merges = !!version && atLeast(version, DIFF_MERGES_MIN)
  if (!merges) {
    const want = DIFF_MERGES_MIN.join('.')
    warnings.push(`수정일: git ${version ? version.join('.') : '버전 확인 실패'} — ${want} 이상이 필요하다. 병합으로만 들어온 파일은 수정일이 빠진다(「—」).`)
  }
  const roots = [...new Set(units.map((u) => u.path.split('/').slice(0, 2).join('/')))].sort()
  const args = ['-c', 'core.quotePath=false', 'log', commit, '--format=%x00%ad %p', '--date=format:%Y-%m-%d', '--name-only', '--no-renames', ...(merges ? ['--diff-merges=first-parent'] : []), '--', ...roots]
  const out = run(args)
  if (out === null) {
    warnings.push('수정일: git log 가 실패해 수정일 없이 만들었다. 모든 쪽의 「확인」이 「—」로 보인다(머리말 verified_at 이 있는 쪽 제외).')
    return { dates: null, warnings }
  }
  return { dates: parseLastDates(out), warnings }
}

/** 조각에 `modifiedAt` 을 붙인다. 생성 장 · 미커밋 변경 파일 · 날짜를 모르는 파일은 붙이지 않는다. */
export function annotateModified(chunks: Chunk[], units: SourceUnit[], dates: Map<string, string> | null, dirtyPaths: readonly string[]): void {
  if (!dates) return
  const dirty = new Set(dirtyPaths)
  const generated = new Set(units.filter((u) => u.generated).map((u) => u.path))
  for (const c of chunks) {
    const p = c.source.path
    const d = dates.get(p)
    if (d && !generated.has(p) && !dirty.has(p)) c.modifiedAt = d
  }
}
