// 다시 만들기 판정. 시각 · 부하 · 코어 수 · 신호 · 상태를 인자로 받는 순수 함수다.
// 부르는 곳: dev/live-index.ts. 먼저 읽을 파일: dev/live-index.ts.
// 시험이 가짜 시계 · 가짜 부하를 넣을 수 있게 os 를 직접 읽지 않는다.
import type { CacheState, Signal } from './cache.ts'

export const MIN = 60_000
/** 질의 때 바뀜을 확인하는 간격(서버마다). */
export const CHECK_INTERVAL_MS = 30_000
/** 마지막 변경에서 이만큼 조용해야 시작한다. */
export const STABLE_MS = 30_000
/** 처음 변경을 본 뒤 이만큼 지나면 안정과 관계없이 시작한다. */
export const STABLE_CAP_MS = 10 * MIN
/** 마지막 빌드 끝에서 작업 트리 신호가 바뀐 경우의 최소 간격. */
export const TREE_GAP_MS = 2 * MIN
/** 바깥 신호(git 밖 원천)만 바뀐 경우의 최소 간격. */
export const OUTSIDE_GAP_MS = 10 * MIN
/** 부하로 미룰 수 있는 상한. 처음 미룬 시각에서 이만큼 지나면 부하와 관계없이 시작한다. */
export const DEFER_CAP_MS = 30 * MIN
/** 부하 문턱 = 논리 코어 수 × 이 값. */
export const LOAD_FACTOR = 1.5

/** 서버 메모리에만 두는 관찰 값. 다시 띄우면 처음부터 센다(첫 관찰을 변경으로 본다). */
export interface Watch {
  lastSeen?: Signal
  /** 신호가 마지막으로 바뀐 것을 본 시각. */
  lastChangeAt?: number
  /** 마지막 빌드 뒤 처음 바뀜을 본 시각. */
  pendingSince?: number
}

export interface ScheduleInput {
  now: number
  /** 1분 부하(`os.loadavg()[0]`). */
  load: number
  /** 논리 코어 수(`os.availableParallelism()`). */
  cores: number
  signal: Signal
  hasCache: boolean
  state: CacheState
  watch: Watch
}

export type Action = 'start' | 'wait' | 'defer' | 'idle'

export interface Decision {
  action: Action
  /** 다음 판정에 넘길 관찰 값. */
  watch: Watch
  /** 바뀐 미룸 시각(undefined 면 미룸 없음). state.json 에 남긴다. */
  deferredSince: number | undefined
  /** 부하로 미룬 분(기준 줄 「부하로 N분 미룸」). */
  deferredMin?: number
}

const sameSignal = (a: Signal | undefined, b: Signal): boolean => !!a && a.tree === b.tree && a.outside === b.outside

/** 관찰 값을 갱신한다. 신호가 직전 관찰과 다르면 변경 시각을 지금으로 둔다. */
function observe(w: Watch, signal: Signal, now: number): Watch {
  if (sameSignal(w.lastSeen, signal)) return w
  return { lastSeen: signal, lastChangeAt: now, pendingSince: w.pendingSince ?? now }
}

/** 부하 판정. 문턱을 넘으면 미루고, 처음 미룬 지 30분이 지나면 시작한다. */
function loadGate(i: ScheduleInput, watch: Watch): Decision {
  const since = i.state.deferredSince
  if (i.load <= i.cores * LOAD_FACTOR) return { action: 'start', watch, deferredSince: undefined }
  const first = since ?? i.now
  if (i.now - first >= DEFER_CAP_MS) return { action: 'start', watch, deferredSince: undefined }
  return { action: 'defer', watch, deferredSince: first, deferredMin: Math.floor((i.now - first) / MIN) }
}

/** 판정 하나. `start` 를 받은 쪽은 공용 잠금 · 대기 순서(lock.ts)를 거쳐 빌드한다. */
export function decide(i: ScheduleInput): Decision {
  // 첫 색인(캐시 없음)은 부하 문턱 · 안정 대기를 보지 않는다. 첫 색인이 실패했으면 최소 간격 뒤에 다시 한다.
  if (!i.hasCache) {
    const retryWait = i.state.failed && i.now - i.state.lastBuildEnd < TREE_GAP_MS
    return { action: retryWait ? 'wait' : 'start', watch: i.watch, deferredSince: undefined }
  }
  if (sameSignal(i.state.builtSignal, i.signal)) return { action: 'idle', watch: {}, deferredSince: undefined }
  const watch = observe(i.watch, i.signal, i.now)
  const treeChanged = i.state.builtSignal?.tree !== i.signal.tree
  const gap = treeChanged ? TREE_GAP_MS : OUTSIDE_GAP_MS
  if (i.now - i.state.lastBuildEnd < gap) return { action: 'wait', watch, deferredSince: i.state.deferredSince }
  const quiet = i.now - (watch.lastChangeAt ?? i.now) >= STABLE_MS
  const capped = i.now - (watch.pendingSince ?? i.now) >= STABLE_CAP_MS
  if (!quiet && !capped) return { action: 'wait', watch, deferredSince: i.state.deferredSince }
  return loadGate(i, watch)
}
