// 공용 잠금 · 대기 순서(dev/lock.ts)와 CLI 60초 대기(dev/serve-root.ts).
// 프로세스 둘 대신 잠금 함수를 두 번 부른다. 시각 · PID 생존은 주입한다. 실제 ~/.cache 를 쓰지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { cacheKey } from '../src/dev/cache.ts'
import { LOCK_EXPIRE_MS, QUEUE_EXPIRE_MS, enqueue, nextInQueue, release, tryAcquire } from '../src/dev/lock.ts'
import { CLI_WAIT_MS, IndexNotReadyError, openRoot } from '../src/dev/serve-root.ts'

const T0 = 1_000_000_000_000
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const lockFile = (root: string) => path.join(root, 'build.lock')
const allAlive = () => true

describe('잠금', () => {
  it('둘이 동시에 잡으면 하나만 잡는다', () => {
    const root = tmp('wiki-lock-')
    const a = tryAcquire(root, 'aaa', { now: T0, pid: 101, alive: allAlive })
    const b = tryAcquire(root, 'bbb', { now: T0, pid: 202, alive: allAlive })
    expect(a.acquired).toBe(true)
    expect(b).toMatchObject({ acquired: false, reason: 'busy' })
    expect(JSON.parse(fs.readFileSync(lockFile(root), 'utf8'))).toEqual({ pid: 101, startedAt: T0, key: 'aaa' })
    release(root, 'aaa', 101)
    expect(tryAcquire(root, 'bbb', { now: T0, pid: 202, alive: allAlive }).acquired).toBe(true)
  })

  it('PID 가 없는 잠금은 넘겨받고 정리 수를 센다', () => {
    const root = tmp('wiki-lock-')
    tryAcquire(root, 'aaa', { now: T0, pid: 101, alive: allAlive })
    const r = tryAcquire(root, 'bbb', { now: T0 + 1000, pid: 202, alive: (pid) => pid !== 101 })
    expect(r).toEqual({ acquired: true, brokenCleared: 1 })
  })

  it('PID 가 살아 있어도 30분 지난 잠금은 넘겨받는다', () => {
    const root = tmp('wiki-lock-')
    tryAcquire(root, 'aaa', { now: T0, pid: 101, alive: allAlive })
    expect(tryAcquire(root, 'bbb', { now: T0 + LOCK_EXPIRE_MS - 1, pid: 202, alive: allAlive }).acquired).toBe(false)
    expect(tryAcquire(root, 'bbb', { now: T0 + LOCK_EXPIRE_MS, pid: 202, alive: allAlive }).acquired).toBe(true)
  })

  it('남의 잠금은 풀지 않는다', () => {
    const root = tmp('wiki-lock-')
    tryAcquire(root, 'aaa', { now: T0, pid: 101, alive: allAlive })
    release(root, 'bbb', 202)
    expect(fs.existsSync(lockFile(root))).toBe(true)
  })
})

describe('대기 순서', () => {
  it('lastBuildEnd 가 이른 쪽이 먼저 잡고, 둘 다 계속 바뀌면 번갈아 잡는다', () => {
    const root = tmp('wiki-queue-')
    const end: Record<string, number> = { aaa: T0 + 500, bbb: T0 + 100 }
    const pid: Record<string, number> = { aaa: 101, bbb: 202 }
    const order: string[] = []
    let now = T0 + 1000
    for (let round = 0; round < 4; round++) {
      for (const k of ['aaa', 'bbb']) enqueue(root, k, { pid: pid[k], lastBuildEnd: end[k], now })
      const winner = ['aaa', 'bbb'].find((k) => tryAcquire(root, k, { now, pid: pid[k], alive: allAlive }).acquired)!
      order.push(winner)
      now += 60_000
      end[winner] = now
      release(root, winner, pid[winner])
    }
    expect(order).toEqual(['bbb', 'aaa', 'bbb', 'aaa'])
  })

  it('같은 lastBuildEnd 면 키 문자열 순서', () => {
    const root = tmp('wiki-queue-')
    enqueue(root, 'bbb', { pid: 2, lastBuildEnd: 0, now: T0 })
    enqueue(root, 'aaa', { pid: 1, lastBuildEnd: 0, now: T0 })
    expect(nextInQueue(root, { now: T0, pid: 9, alive: allAlive })).toBe('aaa')
    expect(tryAcquire(root, 'bbb', { now: T0, pid: 2, alive: allAlive })).toMatchObject({ acquired: false, reason: 'queued' })
  })

  it('10분 넘게 갱신 없는 항목 · PID 없는 항목은 순서에서 빠진다', () => {
    const root = tmp('wiki-queue-')
    enqueue(root, 'old', { pid: 1, lastBuildEnd: 0, now: T0 })
    enqueue(root, 'dead', { pid: 2, lastBuildEnd: 0, now: T0 + QUEUE_EXPIRE_MS })
    enqueue(root, 'mine', { pid: 3, lastBuildEnd: T0, now: T0 + QUEUE_EXPIRE_MS })
    const d = { now: T0 + QUEUE_EXPIRE_MS + 1, pid: 3, alive: (p: number) => p !== 2 }
    expect(nextInQueue(root, d)).toBe('mine')
    expect(tryAcquire(root, 'mine', d).acquired).toBe(true)
  })
})

describe('CLI 작업 트리 모드 대기', () => {
  it('캐시가 없고 60초 동안 잠금을 못 잡으면 IndexNotReadyError(종료 3)', async () => {
    const cache = tmp('wiki-cli-')
    const prev = process.env.WIKI_INDEX_CACHE_DIR
    process.env.WIKI_INDEX_CACHE_DIR = cache
    try {
      const wt = tmp('wiki-wt-')
      const cfg = path.join(wt, 'cfg.json')
      fs.writeFileSync(cfg, JSON.stringify({ schema: 1, bundle: { name: 'x', title: 'x' }, sources: [{ adapter: 'markdown', root: 'docs', level: 'internal' }] }))
      // 다른 작업 트리의 빌드가 잠금을 들고 있다.
      tryAcquire(cache, 'other', { now: T0, pid: 999, alive: allAlive })
      let now = T0
      let slept = 0
      const p = openRoot(wt, cfg, () => {}, {
        now: () => now,
        sleep: async (ms) => {
          slept += ms
          now += ms
        },
        alive: allAlive,
        build: async () => {
          throw new Error('잠금을 잡지 못했으니 부르면 안 된다')
        },
      })
      const e = await p.catch((x: unknown) => x)
      expect(e).toBeInstanceOf(IndexNotReadyError)
      expect((e as IndexNotReadyError).exitCode).toBe(3)
      expect((e as Error).message).toBe('색인 중 · rg -a 로 찾으세요')
      expect(slept).toBeGreaterThanOrEqual(CLI_WAIT_MS)
      expect(fs.existsSync(path.join(cache, 'queue', `${cacheKey(wt)}.json`))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.WIKI_INDEX_CACHE_DIR
      else process.env.WIKI_INDEX_CACHE_DIR = prev
    }
  })
})
