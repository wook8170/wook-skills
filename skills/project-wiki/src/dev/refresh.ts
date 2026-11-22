// 프로젝트 모드의 색인 새로 고침. 원천 폴더가 지난 빌드 뒤 바뀌었는지 판정하고, 바뀌었으면 잠금을 잡고 다시 만든다.
// 부르는 곳: cli/build.ts(build) · cli/query.ts(search · read · backlinks 앞). MCP 서버의 뒤쪽 다시 만들기는 dev/live-index.ts 가 맡는다.
// 먼저 읽을 파일: dev/cache.ts · dev/lock.ts.
import { gitRunner, type GitRun } from '../core/stale.ts'
import { hasBundle, prepareCacheDir, readState, writeState, type Signal } from './cache.ts'
import { enqueue, release, tryAcquire } from './lock.ts'
import { swapBundle } from './rebuild.ts'
import { IndexNotReadyError, CLI_WAIT_MS, type RootContext } from './serve-root.ts'
import { readSignal } from './signals.ts'

/** 판정: 쓸 묶음이 있고, 지난 성공 빌드의 신호가 지금 신호와 같으면 다시 만들 필요가 없다. */
export function isIndexCurrent(hasCache: boolean, built: Signal | undefined, now: Signal): boolean {
  return hasCache && built !== undefined && built.tree === now.tree && built.outside === now.outside
}

export interface RefreshDeps {
  git?: GitRun
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pid?: number
  alive?: (pid: number) => boolean
  waitMs?: number
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 잠금을 잡을 때까지 기다린다(상한 waitMs). 잡으면 true. */
async function acquireWaiting(ctx: RootContext, d: RefreshDeps): Promise<boolean> {
  const now = d.now ?? Date.now
  const pid = d.pid ?? process.pid
  const until = now() + (d.waitMs ?? CLI_WAIT_MS)
  const st = readState(ctx.cacheDir)
  for (;;) {
    enqueue(ctx.lockRoot, ctx.key, { pid, lastBuildEnd: st.lastBuildEnd, now: now() })
    if (tryAcquire(ctx.lockRoot, ctx.key, { now: now(), pid, alive: d.alive }).acquired) return true
    if (now() >= until) return false
    await (d.sleep ?? realSleep)(2_000)
  }
}

/**
 * 원천이 바뀌었거나 force 면 잠금 안에서 build(outDir) 로 bundle.next/ 를 만들고 bundle/ 자리로 옮긴다.
 * 다시 만들었으면 true. 잠금을 잡지 못했는데 쓸 묶음도 없으면 IndexNotReadyError(종료 3)다.
 */
export async function refreshIndex(ctx: RootContext, build: () => void, o: { force?: boolean } & RefreshDeps = {}): Promise<boolean> {
  prepareCacheDir(ctx.cacheDir, ctx.worktree)
  const { signal } = readSignal(o.git ?? gitRunner(ctx.worktree), ctx.roots, ctx.outsideDirs)
  if (!o.force && isIndexCurrent(hasBundle(ctx.cacheDir), readState(ctx.cacheDir).builtSignal, signal)) return false
  if (!(await acquireWaiting(ctx, o))) {
    if (hasBundle(ctx.cacheDir)) return false
    throw new IndexNotReadyError()
  }
  const now = o.now ?? Date.now
  try {
    build()
    swapBundle(ctx.cacheDir)
    writeState(ctx.cacheDir, { lastBuildEnd: now(), builtSignal: signal })
  } catch (e) {
    writeState(ctx.cacheDir, { ...readState(ctx.cacheDir), lastBuildEnd: now(), failed: true })
    throw e
  } finally {
    release(ctx.lockRoot, ctx.key, o.pid ?? process.pid)
  }
  return true
}
