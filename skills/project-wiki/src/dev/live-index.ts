// 지금 쓰는 색인을 들고 있다가, 다시 만든 묶음이 생기면 바꿔 끼운다. 부르는 곳: dev/serve-root.ts(serve-mcp --root).
// 질의가 올 때 30초에 한 번까지 신호를 읽고, 판정(schedule.ts) → 잠금(lock.ts) → 자식 빌드(rebuild.ts) 순서로 간다.
// 빌드하는 동안 질의는 이전 색인으로 답한다. 캐시가 없으면 색인 없음(null)으로 답한다(서버가 index_building 을 돌려준다).
import { readBundle } from '../core/bundle.ts'
import { WikiIndex } from '../core/search.ts'
import type { GitRun } from '../core/stale.ts'
import { basisLine, type Basis, type LiveState, type Snapshot } from './basis.ts'
import { bundleDir, hasBundle, prepareCacheDir, readState, writeState, type CacheState, type Signal } from './cache.ts'
import { enqueue, release, tryAcquire } from './lock.ts'
import { rebuild, type BuildJob, type BuildOutcome } from './rebuild.ts'
import { CHECK_INTERVAL_MS, decide, type Watch } from './schedule.ts'
import { readSignal, type TreeState } from './signals.ts'

export interface LiveDeps {
  worktree: string
  configPath: string
  /** 이 작업 트리의 캐시 폴더. */
  cacheDir: string
  /** 머신 전체 캐시 루트(잠금 · 대기 목록 자리). */
  lockRoot: string
  key: string
  /** 원천 폴더(설정의 sources[].root, 작업 트리 기준 상대 경로). */
  roots: string[]
  /** git 밖 원천 폴더. 핵심 묶음은 쓰지 않아 빈 목록이다. */
  outsideDirs: string[]
  git: GitRun
  now: () => number
  load: () => number
  cores: number
  pid: number
  alive?: (pid: number) => boolean
  build?: (job: BuildJob) => Promise<BuildOutcome>
  open?: (cacheDir: string) => WikiIndex
  log: (line: string) => void
}

const openCached = (cacheDir: string): WikiIndex => new WikiIndex(readBundle(bundleDir(cacheDir)))

export class LiveIndex {
  private index: WikiIndex | null = null
  private state: LiveState = 'ready'
  private watch: Watch = {}
  private lastCheck = Number.NEGATIVE_INFINITY
  private tree: TreeState | null = null
  private deferredMin: number | undefined
  private building: Promise<void> | null = null
  private readonly d: LiveDeps

  constructor(d: LiveDeps) {
    this.d = d
    prepareCacheDir(d.cacheDir, d.worktree)
    this.index = this.load()
    const st = readState(d.cacheDir)
    if (st.failed) this.state = 'failed'
  }

  /** 지금 답할 색인과 기준. 부를 때마다 바뀜을 확인한다(30초에 한 번까지). */
  snapshot(): Snapshot {
    this.check()
    const b: Basis = { commit: this.index?.manifest.commit ?? null, dirtyFiles: this.tree?.dirtyFiles ?? 0, state: this.state }
    if (this.state === 'deferred') b.deferredMin = this.deferredMin
    const quarantined = this.index?.manifest.quarantined
    if (quarantined) b.quarantined = quarantined
    return { index: this.index, basis: b, line: basisLine(b) }
  }

  /** 진행 중인 빌드가 끝날 때까지 기다린다(시험 · CLI 용). */
  async idle(): Promise<void> {
    await this.building
  }

  /** 바뀜을 확인하고 필요하면 빌드를 시작한다. 빌드 중이면 확인하지 않는다. */
  check(): void {
    const now = this.d.now()
    if (this.building || now - this.lastCheck < CHECK_INTERVAL_MS) return
    this.lastCheck = now
    const { signal, tree } = readSignal(this.d.git, this.d.roots, this.d.outsideDirs)
    this.tree = tree
    const st = readState(this.d.cacheDir)
    const r = decide({ now, load: this.d.load(), cores: this.d.cores, signal, hasCache: this.index !== null, state: st, watch: this.watch })
    this.watch = r.watch
    if (r.deferredSince !== st.deferredSince) writeState(this.d.cacheDir, { ...st, deferredSince: r.deferredSince })
    if (r.action === 'defer') {
      this.state = 'deferred'
      this.deferredMin = r.deferredMin
    } else if (this.state === 'deferred') this.state = st.failed ? 'failed' : 'ready'
    if (r.action === 'start') this.start(signal, st, now)
  }

  private load(): WikiIndex | null {
    if (!hasBundle(this.d.cacheDir)) return null
    try {
      return (this.d.open ?? openCached)(this.d.cacheDir)
    } catch (e) {
      this.d.log(`캐시 묶음을 열지 못함 · 다시 만든다(${(e as Error).message.slice(0, 80)})`)
      return null
    }
  }

  /** 대기 목록에 오르고 잠금을 잡으면 빌드한다. 잡지 못하면 이전 색인으로 답하고 다음 확인 때 다시 시도한다. */
  private start(signal: Signal, st: CacheState, now: number): void {
    const { lockRoot, key, pid } = this.d
    enqueue(lockRoot, key, { pid, lastBuildEnd: st.lastBuildEnd, now })
    const got = tryAcquire(lockRoot, key, { now, pid, alive: this.d.alive })
    if (got.brokenCleared) this.d.log(`깨진 잠금 정리 ${got.brokenCleared}`)
    if (!got.acquired) return
    this.state = 'building'
    this.building = this.run(signal, st)
      .catch((e: unknown) => {
        this.state = 'failed'
        this.d.log(`다시 만들기 오류(${(e as Error).message.slice(0, 80)})`)
      })
      .finally(() => {
        release(lockRoot, key, pid)
        this.building = null
      })
  }

  private async run(signal: Signal, st: CacheState): Promise<void> {
    const job: BuildJob = { worktree: this.d.worktree, configPath: this.d.configPath, cacheDir: this.d.cacheDir, log: this.d.log }
    const r = await (this.d.build ?? rebuild)(job)
    const next = r.ok ? this.load() : null
    const ok = next !== null
    const done: CacheState = { lastBuildEnd: this.d.now(), builtSignal: ok ? signal : st.builtSignal, failed: !ok }
    if (ok) this.index = next
    writeState(this.d.cacheDir, done)
    this.state = ok ? 'ready' : 'failed'
    const quarantined = next?.manifest.quarantined
    this.d.log(ok ? `다시 만들기 끝 · 조각 ${next?.chunks.length ?? 0}${quarantined ? ` · 격리 ${quarantined}` : ''}` : `다시 만들기 실패(${r.reason ?? 'open'})`)
  }
}
