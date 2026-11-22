// 머신 전체가 함께 쓰는 빌드 잠금과 대기 순서.
// 부르는 곳: dev/live-index.ts · dev/refresh.ts · dev/serve-root.ts. 먼저 읽을 파일: dev/refresh.ts.
// 잠금 = <캐시 루트>/build.lock(배타 생성), 대기 목록 = <캐시 루트>/queue/<key>.json.
// 시각 · PID 생존 판정은 인자로 받는다. 그래서 시험은 프로세스 둘 대신 이 함수를 두 번 부른다.
import fs from 'node:fs'
import path from 'node:path'

/** 잠금이 이보다 오래되면 PID 가 살아 있어도 깨진 것으로 본다(PID 재사용 대비). */
export const LOCK_EXPIRE_MS = 30 * 60_000
/** 대기 항목이 이만큼 갱신되지 않으면 순서 비교에서 뺀다. */
export const QUEUE_EXPIRE_MS = 10 * 60_000

export interface LockInfo {
  pid: number
  startedAt: number
  key: string
}

export interface QueueEntry {
  pid: number
  lastBuildEnd: number
  requestedAt: number
  updatedAt: number
}

export interface LockDeps {
  now: number
  pid: number
  /** PID 가 살아 있으면 true. 기본은 `pidAlive`. */
  alive?: (pid: number) => boolean
}

export interface AcquireResult {
  acquired: boolean
  /** 정리한 깨진 잠금 수. 표준 오류에는 이 수만 적는다. */
  brokenCleared: number
  /** 잡지 못한 까닭. busy = 다른 빌드가 잠금을 듦, queued = 대기 순서가 아님. */
  reason?: 'busy' | 'queued'
}

/** `process.kill(pid, 0)` 으로 PID 가 살아 있는지 본다. 권한이 없어 거절되면 살아 있는 것이다. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const lockPath = (root: string): string => path.join(root, 'build.lock')
const queueDir = (root: string): string => path.join(root, 'queue')
const queuePath = (root: string, key: string): string => path.join(queueDir(root), `${key}.json`)

/** JSON 파일을 읽는다. 없거나 반쯤 쓰여 읽을 수 없으면 null. */
function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || e instanceof SyntaxError) return null
    throw e
  }
}

/** 대기 목록에 자기 항목을 쓰거나 갱신한다. requestedAt 은 처음 쓴 값을 유지한다. */
export function enqueue(root: string, key: string, e: { pid: number; lastBuildEnd: number; now: number }): void {
  fs.mkdirSync(queueDir(root), { recursive: true })
  const prev = readJson<QueueEntry>(queuePath(root, key))
  const entry: QueueEntry = { pid: e.pid, lastBuildEnd: e.lastBuildEnd, requestedAt: prev?.requestedAt ?? e.now, updatedAt: e.now }
  fs.writeFileSync(queuePath(root, key), JSON.stringify(entry) + '\n')
}

export function dequeue(root: string, key: string): void {
  fs.rmSync(queuePath(root, key), { force: true })
}

/** 살아 있는 대기 항목 가운데 lastBuildEnd 가 가장 이른 키(같으면 키 문자열 순서). 없으면 undefined. */
export function nextInQueue(root: string, d: LockDeps): string | undefined {
  const alive = d.alive ?? pidAlive
  if (!fs.existsSync(queueDir(root))) return undefined
  const live: Array<[string, QueueEntry]> = []
  for (const f of fs.readdirSync(queueDir(root))) {
    if (!f.endsWith('.json')) continue
    const e = readJson<QueueEntry>(path.join(queueDir(root), f))
    if (e && alive(e.pid) && d.now - e.updatedAt <= QUEUE_EXPIRE_MS) live.push([f.slice(0, -5), e])
  }
  live.sort((a, b) => a[1].lastBuildEnd - b[1].lastBuildEnd || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return live[0]?.[0]
}

/** 깨진 잠금(PID 없음 · 30분 지남)이면 지우고 true. */
function clearBroken(root: string, d: LockDeps): boolean {
  const info = readJson<LockInfo>(lockPath(root))
  const alive = d.alive ?? pidAlive
  if (info && alive(info.pid) && d.now - info.startedAt < LOCK_EXPIRE_MS) return false
  fs.rmSync(lockPath(root), { force: true })
  return true
}

/** 배타 생성으로 잠금을 만든다. 이미 있으면 false. */
function createLock(root: string, info: LockInfo): boolean {
  try {
    fs.writeFileSync(lockPath(root), JSON.stringify(info) + '\n', { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

/**
 * 잠금을 잡는다. 대기 순서가 자기 차례가 아니면 잡지 않는다. 잠금이 깨져 있으면 정리하고 한 번 더 시도한다.
 * 부르기 전에 enqueue 로 자기 항목을 써 둔다.
 */
export function tryAcquire(root: string, key: string, d: LockDeps): AcquireResult {
  fs.mkdirSync(root, { recursive: true })
  const turn = nextInQueue(root, d)
  if (turn !== undefined && turn !== key) return { acquired: false, brokenCleared: 0, reason: 'queued' }
  const info: LockInfo = { pid: d.pid, startedAt: d.now, key }
  if (createLock(root, info)) return { acquired: true, brokenCleared: 0 }
  if (!clearBroken(root, d)) return { acquired: false, brokenCleared: 0, reason: 'busy' }
  const ok = createLock(root, info)
  return ok ? { acquired: true, brokenCleared: 1 } : { acquired: false, brokenCleared: 1, reason: 'busy' }
}

/** 자기 잠금이면 풀고 자기 대기 항목을 지운다. 남의 잠금은 건드리지 않는다. */
export function release(root: string, key: string, pid: number): void {
  const info = readJson<LockInfo>(lockPath(root))
  if (info && info.key === key && info.pid === pid) fs.rmSync(lockPath(root), { force: true })
  dequeue(root, key)
}
