// 작업 트리 모드(--root · --config) 진입. 부르는 곳: cli/query.ts · cli/serve.ts.
// serve-mcp 는 작업 트리 색인(live-index.ts)으로 MCP 서버를 띄운다. search · read · backlinks 는 색인 폴더의 묶음을 열어 답한다.
// 먼저 읽을 파일: dev/cache.ts(색인 폴더 위치) · dev/live-index.ts(다시 만들기).
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type WikiConfig } from '../core/build.ts'
import { parseLevel, type Level } from '../core/model.ts'
import { WikiIndex } from '../core/search.ts'
import { gitRunner, type GitRun } from '../core/stale.ts'
import { readBundle } from '../core/bundle.ts'
import { cmp } from '../core/util.ts'
import { serveStdio } from '../mcp/server.ts'
import { headMismatchWarning } from './basis.ts'
import { bundleDir, cacheDirFor, cacheKey, cacheRoot, hasBundle, prepareCacheDir, readState, writeState } from './cache.ts'
import { LiveIndex } from './live-index.ts'
import { enqueue, release, tryAcquire } from './lock.ts'
import { rebuild, type BuildJob, type BuildOutcome } from './rebuild.ts'
import { readSignal, readTree } from './signals.ts'

/** CLI 가 캐시 없이 잠금을 기다리는 상한. */
export const CLI_WAIT_MS = 60_000
const CLI_POLL_MS = 2_000

/** 색인 준비 안 됨. CLI 는 표준 오류 한 줄을 내고 종료 코드 3 으로 끝난다. */
export class IndexNotReadyError extends Error {
  readonly exitCode = 3
  constructor() {
    super('색인 중 · rg -a 로 찾으세요')
  }
}

export interface RootContext {
  worktree: string
  configPath: string
  cfg: WikiConfig
  cacheDir: string
  lockRoot: string
  key: string
  /** 원천 폴더(작업 트리 기준 상대 경로, 중복 없음). */
  roots: string[]
  /** git 밖 원천의 감시 폴더. 핵심 묶음은 쓰지 않아 빈 목록이다. */
  outsideDirs: string[]
}

export function rootContext(root: string, config: string, env: NodeJS.ProcessEnv = process.env): RootContext {
  const worktree = path.resolve(root)
  const configPath = path.resolve(config)
  const cfg = loadConfig(configPath)
  const roots = [...new Set(cfg.sources.map((s) => s.root).filter((r): r is string => !!r))].sort(cmp)
  return { worktree, configPath, cfg, cacheDir: cacheDirFor(worktree, configPath, env), lockRoot: cacheRoot(env), key: cacheKey(worktree), roots, outsideDirs: [] }
}

/** 등급을 주지 않으면 설정의 묶음 상한(없으면 대외비)을 쓴다. 묶음 상한과 같은 값이다. */
export function rootCap(ctx: RootContext, level: string | undefined): Level {
  return level ? parseLevel(level) : parseLevel(ctx.cfg.security?.maxLevel ?? 'confidential')
}

export interface ServeRootOptions {
  root: string
  config: string
  level?: string
  areas?: string[]
  excludeAreas?: string[]
  log: (line: string) => void
}

/** serve-mcp --root. 캐시가 있으면 바로 답하고, 바뀜은 질의 때 확인해 뒤에서 다시 만든다. */
export async function serveRoot(o: ServeRootOptions): Promise<void> {
  const ctx = rootContext(o.root, o.config)
  const cap = rootCap(ctx, o.level)
  const live = new LiveIndex({
    ...ctx,
    git: gitRunner(ctx.worktree),
    now: Date.now,
    load: () => os.loadavg()[0],
    cores: os.availableParallelism(),
    pid: process.pid,
    log: o.log,
  })
  const scope = o.excludeAreas?.length ? ` · 뺀 영역 ${o.excludeAreas.join(',')}` : ''
  o.log(`wiki-index MCP: 작업 트리 ${ctx.key} · 등급 상한 ${cap}${o.areas ? ` · 영역 ${o.areas.join(',')}` : ''}${scope}`)
  await serveStdio(live, { cap, areas: o.areas, excludeAreas: o.excludeAreas })
}

export interface OpenRootDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pid?: number
  alive?: (pid: number) => boolean
  git?: GitRun
  build?: (job: BuildJob) => Promise<BuildOutcome>
  waitMs?: number
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 캐시가 없을 때: 잠금을 60초까지 기다려 잡으면 직접 만든다. 그 사이 다른 서버가 만들면 그 묶음을 쓴다. */
async function buildOrWait(ctx: RootContext, d: OpenRootDeps): Promise<void> {
  const now = d.now ?? Date.now
  const pid = d.pid ?? process.pid
  const until = now() + (d.waitMs ?? CLI_WAIT_MS)
  const st = readState(ctx.cacheDir)
  while (!hasBundle(ctx.cacheDir)) {
    enqueue(ctx.lockRoot, ctx.key, { pid, lastBuildEnd: st.lastBuildEnd, now: now() })
    if (tryAcquire(ctx.lockRoot, ctx.key, { now: now(), pid, alive: d.alive }).acquired) {
      try {
        // 서버와 같은 신호를 남겨, 뒤에 뜬 서버가 같은 내용을 다시 만들지 않게 한다.
        const { signal } = readSignal(d.git ?? gitRunner(ctx.worktree), ctx.roots, ctx.outsideDirs)
        const r = await (d.build ?? rebuild)({ worktree: ctx.worktree, configPath: ctx.configPath, cacheDir: ctx.cacheDir })
        writeState(ctx.cacheDir, r.ok ? { lastBuildEnd: now(), builtSignal: signal } : { lastBuildEnd: now(), failed: true })
      } finally {
        release(ctx.lockRoot, ctx.key, pid)
      }
      if (!hasBundle(ctx.cacheDir)) throw new IndexNotReadyError()
      return
    }
    if (now() >= until) break
    await (d.sleep ?? realSleep)(CLI_POLL_MS)
  }
  if (!hasBundle(ctx.cacheDir)) {
    release(ctx.lockRoot, ctx.key, pid)
    throw new IndexNotReadyError()
  }
}

/**
 * search · read · backlinks 의 작업 트리 모드. 캐시 묶음으로 답한다. 캐시가 없으면 60초까지 기다려 만들고,
 * 그래도 없으면 IndexNotReadyError(종료 3). 묶음의 기준 커밋이 HEAD 와 다르면 경고 한 줄을 낸다.
 */
export async function openRoot(root: string, config: string, warn: (line: string) => void, d: OpenRootDeps = {}): Promise<{ index: WikiIndex; ctx: RootContext }> {
  const ctx = rootContext(root, config)
  prepareCacheDir(ctx.cacheDir, ctx.worktree)
  if (!hasBundle(ctx.cacheDir)) await buildOrWait(ctx, d)
  const index = new WikiIndex(readBundle(bundleDir(ctx.cacheDir)))
  const w = headMismatchWarning(index.manifest.commit, readTree(d.git ?? gitRunner(ctx.worktree), ctx.roots).head)
  if (w) warn(w)
  return { index, ctx }
}
