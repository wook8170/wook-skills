// wiki-index 명령 진입. 명령 이름으로 cli/ 아래 처리 함수를 고르고, 오류 종류를 종료 코드로 바꾼다.
// 부르는 곳: bin/wiki-index.mjs(이 파일을 묶은 실행 파일) · `node src/cli/main.ts`.
// 종료 코드: 0 통과 · 1 검사 실패 · 2 설정 · 입력 오류 · 3 색인 준비 안 됨. 네트워크를 쓰지 않는다.
// 먼저 읽을 파일: cli/project.ts(설정 찾기) · cli/build.ts · cli/query.ts.
import { BaselineError } from '../core/stale-baseline.ts'
import { ConfigError, DirtyError, SecurityError } from '../core/build.ts'
import { MarkSyncedError } from '../core/mark-synced.ts'
import { TarError } from '../core/tar.ts'
import { IndexNotReadyError } from '../dev/serve-root.ts'
import { UsageError, err, out, parseArgs, type Opts } from './args.ts'
import { QuietSecurityError, cmdBuild, cmdCheck } from './build.ts'
import { cmdDiff, cmdEval } from './eval.ts'
import { cmdInit } from './init.ts'
import { cmdBacklinks, cmdRead, cmdSearch } from './query.ts'
import { cmdServeMcp } from './serve.ts'
import { cmdMarkSynced, cmdStale } from './stale.ts'

const USAGE = `wiki-index <명령> [옵션]

프로젝트 모드(옵션 없이): 지금 폴더에서 위로 .wiki/config.json 을 찾아 쓴다. --wiki-dir <폴더> 나 --config <파일> 로 바꾼다.

  init       [--root <저장소>] [--wiki-dir <폴더>] [--json]     문서 폴더를 찾아 설정을 만든다(있으면 덮어쓰지 않는다)
  build      [--if-changed] [--quiet]                           프로젝트 색인(.wiki/index/)을 만든다
  build      --config <설정.json> --out <폴더> [--root <저장소>] [--tar <파일.tar.gz>] [--profile server|local]
             [--reproducible] [--version <버전>] [--prev <이전 묶음>] [--no-stale] [--allow-dirty] [--quiet]
             [--quarantine-out <파일>] [--chunk-cache <파일>]
  search     [<묶음>] <질의> [--level <등급>] [--kind section,figure] [--area <영역,…> | --exclude-area <영역,…>] [--exclude-stale] [--limit <n>] [--json] [--no-refresh]
  read       [<묶음>] <ID> [--level <등급>] [--context] [--area … | --exclude-area …] [--no-refresh]
  backlinks  [<묶음>] <대상 ID | code:경로> [--level <등급>] [--kind ref,evidence,…] [--limit <n>] [--area … | --exclude-area …] [--no-refresh]
  stale      [--config <설정.json>] [--root <저장소>] [--json] [--require-baseline] [--update-baseline] [--accept-new <경로>]…
             (종료 코드: 출하 차단 0건 0 · 1건 이상 1)
  mark-synced [--config <설정.json>] <문서 경로…>               문서의 기준 커밋 칸을 HEAD 로 쓴다(커밋하지 않는다)
  serve-mcp  [--bundle <묶음>] [--level <등급>] [--area <영역,…> | --exclude-area <영역,…>]   표준 입출력 MCP 서버
  check      <묶음> [--strict] [--profile server|local]
  diff       <옛 묶음> <새 묶음> [--json]
  eval       <묶음> --questions <파일.json> [--level <등급>] [--baseline <파일.json>] [--update-baseline] [--out <결과.json>]

<묶음> 은 묶음 폴더(manifest.json 이 있는 폴더) 또는 tar.gz 파일이다. --root <작업 트리> --config <설정> 을 주면 작업 트리 모드다.
등급: public · internal · confidential(공개 · 사내 · 대외비). 등급을 주지 않으면 묶음의 상한(manifest.maxLevel)을 쓴다.`

type Command = (pos: string[], opt: Opts) => number | Promise<number>

const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  build: cmdBuild,
  check: cmdCheck,
  search: cmdSearch,
  read: cmdRead,
  backlinks: cmdBacklinks,
  diff: cmdDiff,
  eval: cmdEval,
  'serve-mcp': cmdServeMcp,
  stale: cmdStale,
  'mark-synced': cmdMarkSynced,
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === 'help') {
    out(USAGE)
    return cmd ? 0 : 2
  }
  const { pos, opt } = parseArgs(rest)
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined
  if (!run) throw new UsageError(`알 수 없는 명령: ${cmd}`)
  return run(pos, opt)
}

/** 설정 · 입력 오류(종료 2, 메시지 한 줄). */
const INPUT_ERRORS = [UsageError, ConfigError, BaselineError, MarkSyncedError, TarError, SyntaxError]

/** 오류를 표준 오류 줄과 종료 코드로 바꾼다. */
function exitCodeOf(e: unknown): number {
  if (e instanceof IndexNotReadyError) {
    err(e.message)
    return e.exitCode
  }
  if (e instanceof QuietSecurityError) {
    err(e.message)
    return 1
  }
  if (e instanceof SecurityError) {
    for (const f of e.findings) err(`보안 실패 ${f.rule} ${f.path}:${f.line} ${f.excerpt}`)
    err(`${e.message}. 비밀값이 든 문서만 빼려면 설정의 security.onSecret 을 "quarantine" 으로 둔다`)
    return 1
  }
  if (e instanceof DirtyError) {
    for (const p of e.paths.slice(0, 20)) err(`  미커밋 ${p}`)
    err(`오류: ${e.message}`)
    return 2
  }
  if (INPUT_ERRORS.some((c) => e instanceof c)) {
    err(`오류: ${(e as Error).message}`)
    if (e instanceof UsageError) err(USAGE)
    return 2
  }
  err(`오류: ${(e as Error)?.stack ?? String(e)}`)
  return 2
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.exitCode = exitCodeOf(e)
  },
)
