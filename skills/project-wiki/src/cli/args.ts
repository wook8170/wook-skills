// 명령 인자 읽기와 출력 도우미. 부르는 곳: cli/ 아래 명령 파일 전부.
// 위치 인자와 `--이름 값` · `--깃발` 을 나눈다. 값이 필요한 옵션에 값이 없으면 사용법 오류(종료 2)다.
// 먼저 읽을 파일: cli/main.ts.

export class UsageError extends Error {}

export type Opts = Record<string, string | true>

/** 값 없이 쓰는 옵션. */
const FLAGS = new Set(['reproducible', 'no-stale', 'allow-dirty', 'strict', 'exclude-stale', 'json', 'context', 'update-baseline', 'require-baseline', 'help', 'quiet', 'no-refresh', 'force', 'if-changed'])
/** 여러 번 줄 수 있는 옵션. 값은 NUL 로 이어 둔다(명령 인자에는 NUL 이 들어갈 수 없다). `many` 로 나눠 읽는다. */
const REPEATABLE = new Set(['accept-new'])

export function parseArgs(argv: string[]): { pos: string[]; opt: Opts } {
  const pos: string[] = []
  const opt: Opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      pos.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (FLAGS.has(key)) {
      opt[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new UsageError(`--${key} 에 값이 없다`)
    opt[key] = REPEATABLE.has(key) && typeof opt[key] === 'string' ? `${opt[key]}\0${value}` : value
  }
  return { pos, opt }
}

export const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined)
export const list = (v: string | true | undefined): string[] | undefined => str(v)?.split(',').map((s) => s.trim()).filter(Boolean)
export const many = (v: string | true | undefined): string[] => str(v)?.split('\0') ?? []

export const out = (line: string): void => {
  process.stdout.write(line + '\n')
}
export const err = (line: string): void => {
  process.stderr.write(line + '\n')
}

/** 영역 범위 옵션. --area 와 --exclude-area 를 함께 주면 사용법 오류다. */
export function areaScope(opt: Opts): { areas?: string[]; excludeAreas?: string[] } {
  if (opt.area !== undefined && opt['exclude-area'] !== undefined) throw new UsageError('--area 와 --exclude-area 는 함께 줄 수 없다')
  return { areas: list(opt.area), excludeAreas: list(opt['exclude-area']) }
}

/** 빌드 프로필. 기본은 local 이다. */
export function buildProfile(opt: Opts): 'server' | 'local' {
  const profile = str(opt.profile) ?? 'local'
  if (profile !== 'server' && profile !== 'local') throw new UsageError('--profile 은 server 또는 local')
  return profile
}
