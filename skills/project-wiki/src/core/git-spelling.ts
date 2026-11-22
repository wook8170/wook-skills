// 근거 경로를 git 색인의 철자로 맞춘다.
// 부르는 곳: core/stale-pending.ts · core/stale.ts. 먼저 읽을 파일: core/stale-pending.ts.
// 문서에 적은 경로와 git 이 기록한 경로는 유니코드 정규화(NFC · NFD)나 대소문자가 다를 수 있다.
// macOS 기본 볼륨은 둘 다 가리지 않아서 파일은 읽히는데, git 출력과 철자가 달라 변경을 놓친다.

/** git 이 추적하는 경로 목록에서 근거 경로의 철자를 찾는다. */
export interface Spelling {
  /** git 이 기록한 철자. 정확히 같은 경로 → NFC 가 같은 경로 하나 → NFC 와 소문자가 같은 경로 하나 순서로 찾는다. 없거나 여럿이면 null. */
  resolve(p: string): string | null
}

const nfc = (p: string) => p.normalize('NFC')
const folded = (p: string) => nfc(p).toLowerCase()

function index(paths: string[], key: (p: string) => string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const p of paths) m.set(key(p), [...(m.get(key(p)) ?? []), p])
  return m
}

/** `git ls-files -z` 의 경로 목록으로 만든다. */
export function spellingOf(tracked: string[]): Spelling {
  const exact = new Set(tracked)
  const byNfc = index(tracked, nfc)
  const byFold = index(tracked, folded)
  const only = (list: string[] | undefined) => (list?.length === 1 ? list[0] : null)
  return {
    resolve(p) {
      if (exact.has(p)) return p
      return only(byNfc.get(nfc(p))) ?? only(byFold.get(folded(p)))
    },
  }
}
