// 낡음 판정이 읽는 git 출력(`-z`). 경로를 NUL 로 끊어 받아서, 큰따옴표 · 역슬래시 · 탭 · 앞뒤 공백이 든 경로도
// 부르는 곳: core/stale.ts. 먼저 읽을 파일: core/stale.ts.
// git 이 감싸거나 바꾸지 않은 철자 그대로 읽는다.

/** `log` 형식 문자열. 커밋마다 머리 줄이 `\x01C <해시> <부모 해시…>` 로 시작한다. */
export const LOG_FORMAT = '--format=%x00%x01C %H %P'

// 부모가 없는 뿌리 커밋은 `%P` 가 비어 머리 줄이 공백으로 끝난다. 그래서 끝 공백 하나를 받는다.
const HEADER = /^\n?\x01C ([0-9a-f]+)((?: [0-9a-f]+)*) ?$/

export interface LogCommit {
  hash: string
  files: Set<string>
  /** 부모가 둘 이상이다. */
  merge: boolean
}

/** `-z --name-only` 처럼 NUL 로 끝나는 경로 목록. */
export function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

/**
 * `git log -z LOG_FORMAT --name-only` 출력. 머리 줄 뒤 첫 경로 앞에는 git 이 줄바꿈 하나를 넣는다(병합 결합 차이는 NUL).
 * 그래서 머리 줄 바로 뒤 경로에서만 앞 줄바꿈 하나를 뗀다.
 */
export function parseLogZ(out: string): LogCommit[] {
  const commits: LogCommit[] = []
  let fresh = false
  for (const tok of out.split('\0')) {
    const h = HEADER.exec(tok)
    if (h) {
      commits.push({ hash: h[1], files: new Set(), merge: h[2].trim().split(' ').filter(Boolean).length > 1 })
      fresh = true
    } else if (tok && commits.length) {
      commits[commits.length - 1].files.add(fresh && tok.startsWith('\n') ? tok.slice(1) : tok)
      fresh = false
    }
  }
  return commits
}
