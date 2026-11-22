// 다시 만들기 판정(dev/schedule.ts)과 바뀜 확인 간격(dev/live-index.ts). 가짜 시계 · 가짜 부하만 쓴다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import type { CacheState, Signal } from '../src/dev/cache.ts'
import { readState, writeState } from '../src/dev/cache.ts'
import { LiveIndex } from '../src/dev/live-index.ts'
import { MIN, decide, type ScheduleInput, type Watch } from '../src/dev/schedule.ts'
import type { GitRun } from '../src/core/stale.ts'

const T0 = 1_000_000_000_000
const S1: Signal = { tree: 'a', outside: 0 }
const S2: Signal = { tree: 'b', outside: 0 }
const built: CacheState = { lastBuildEnd: T0, builtSignal: S1 }

/** 신호 S2 가 T0 에 바뀌고 그 뒤 조용했다(안정 대기를 지난 상태). */
const QUIET: Watch = { lastSeen: S2, lastChangeAt: T0, pendingSince: T0 }

const input = (o: Partial<ScheduleInput>): ScheduleInput => ({ now: T0, load: 1, cores: 10, signal: S1, hasCache: true, state: built, watch: {}, ...o })

/** 같은 신호를 시각만 바꿔 여러 번 판정한다. 관찰 값과 미룸 시각은 다음 판정으로 넘긴다. */
function run(steps: Array<Partial<ScheduleInput>>, base: Partial<ScheduleInput> = {}) {
  let watch: Watch = base.watch ?? {}
  let state: CacheState = base.state ?? built
  return steps.map((s) => {
    const d = decide(input({ ...base, ...s, watch, state }))
    watch = d.watch
    state = { ...state, deferredSince: d.deferredSince }
    return d
  })
}

describe('부하 문턱 (C02)', () => {
  it('캐시 없음 · 부하 20 · 코어 10 → 첫 색인 시작', () => {
    expect(decide(input({ hasCache: false, load: 20, state: { lastBuildEnd: 0 } })).action).toBe('start')
  })

  it('캐시 있음 · 부하 20 → 미룸, 미룬 분을 센다', () => {
    const [a, b] = run([{ now: T0 + 3 * MIN }, { now: T0 + 15 * MIN }], { load: 20, signal: S2, watch: QUIET })
    expect(a.action).toBe('defer')
    expect(a.deferredMin).toBe(0)
    expect(b.action).toBe('defer')
    expect(b.deferredMin).toBe(12)
  })

  it('처음 미룬 지 30분 → 부하 20 에서도 시작', () => {
    const r = run([{ now: T0 + 3 * MIN }, { now: T0 + 33 * MIN }], { load: 20, signal: S2, watch: QUIET })
    expect(r[1].action).toBe('start')
    expect(r[1].deferredSince).toBeUndefined()
  })

  it('미룸 시작 시각은 state.json 에 남아 다시 띄워도 이어진다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-sched-'))
    const first = decide(input({ now: T0 + 3 * MIN, load: 20, signal: S2, watch: QUIET }))
    expect(first.action).toBe('defer')
    writeState(dir, { ...built, deferredSince: first.deferredSince })
    // 다시 띄움: 관찰 값은 비고, 상태는 파일에서 읽는다.
    const again = decide(input({ now: T0 + 20 * MIN, load: 20, signal: S2, state: readState(dir), watch: {} }))
    expect(again.action).toBe('wait')
    const later = decide(input({ now: T0 + 20 * MIN + 31_000, load: 20, signal: S2, state: readState(dir), watch: again.watch }))
    expect(later.action).toBe('defer')
    expect(later.deferredMin).toBe(17)
  })
})

describe('안정 대기 · 최소 간격 (C03)', () => {
  it('변경 30초 안 → 대기, 30초 조용하면 시작', () => {
    const r = run([{ now: T0 + 5 * MIN }, { now: T0 + 5 * MIN + 20_000 }, { now: T0 + 5 * MIN + 30_000 }], { signal: S2 })
    expect(r.map((d) => d.action)).toEqual(['wait', 'wait', 'start'])
  })

  it('10초마다 바뀌어도 처음 변경 10분 뒤에는 시작', () => {
    const steps: Array<Partial<ScheduleInput>> = []
    for (let k = 0; k <= 60; k++) steps.push({ now: T0 + 5 * MIN + k * 10_000, signal: { tree: `t${k}`, outside: 0 } })
    const r = run(steps)
    const firstStart = r.findIndex((d) => d.action === 'start')
    expect(firstStart).toBe(60)
  })

  it('마지막 빌드 2분 안이면 작업 트리 신호가 바뀌어도 시작하지 않는다', () => {
    const r = run([{ now: T0 + 30_000 }, { now: T0 + 90_000 }, { now: T0 + 2 * MIN }], { signal: S2 })
    expect(r.map((d) => d.action)).toEqual(['wait', 'wait', 'start'])
  })

  it('바깥 신호만 바뀌면 10분 안에는 시작하지 않는다', () => {
    const outside: Signal = { tree: 'a', outside: 123 }
    const r = run([{ now: T0 + 3 * MIN }, { now: T0 + 9 * MIN }, { now: T0 + 10 * MIN }], { signal: outside })
    expect(r.map((d) => d.action)).toEqual(['wait', 'wait', 'start'])
  })

  it('신호가 마지막 빌드와 같으면 아무것도 하지 않는다', () => {
    expect(decide(input({ now: T0 + 60 * MIN })).action).toBe('idle')
  })

  it('첫 색인이 실패했으면 2분 뒤에 다시 시도한다', () => {
    const st: CacheState = { lastBuildEnd: T0, failed: true }
    expect(decide(input({ hasCache: false, now: T0 + MIN, state: st })).action).toBe('wait')
    expect(decide(input({ hasCache: false, now: T0 + 2 * MIN, state: st })).action).toBe('start')
  })
})

describe('바뀜 확인 간격', () => {
  it('질의가 잦아도 git 은 30초에 한 번(호출 2개: HEAD · status)만 부른다', async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-live-'))
    let now = T0
    let calls = 0
    const git: GitRun = (args) => {
      calls++
      return { code: 0, out: args[0] === 'rev-parse' ? 'abc\n' : '' }
    }
    const live = new LiveIndex({
      worktree: '/x/wt',
      configPath: '/x/cfg.json',
      cacheDir: path.join(cacheRoot, 'k'),
      lockRoot: cacheRoot,
      key: 'k',
      roots: ['docs'],
      outsideDirs: [],
      git,
      now: () => now,
      load: () => 1,
      cores: 10,
      pid: 1,
      alive: () => false,
      build: async () => ({ ok: false, reason: 'exit 1' }),
      log: () => {},
    })
    for (let k = 0; k < 5; k++) {
      live.snapshot()
      await live.idle()
      now += 5_000
    }
    expect(calls).toBe(2)
    now = T0 + 30_000
    live.snapshot()
    expect(calls).toBe(4)
  })
})
