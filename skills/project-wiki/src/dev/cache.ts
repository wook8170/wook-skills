// 작업 트리 색인 폴더의 경로 규칙. 부르는 곳: dev/serve-root.ts · dev/live-index.ts · cli/build.ts. 먼저 읽을 파일: dev/serve-root.ts.
// 색인 폴더 = 설정 파일 옆 index/(예: .wiki/index/). WIKI_INDEX_CACHE_DIR 가 있으면 <그 값>/<작업 트리 경로 해시 12자>/ 다.
// 색인 폴더 안: bundle/(지금 쓰는 묶음) · bundle.next/(다시 만드는 중) · worktree.txt · state.json · chunks-cache.json · quarantine.txt(권한 600).
// 잠금(build.lock)과 대기 목록(queue/)은 잠금 루트(~/.cache/project-wiki)에 머신 전체 하나다(lock.ts).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CACHE_DIR_ENV = 'WIKI_INDEX_CACHE_DIR'

/** 머신 전체가 함께 쓰는 잠금 루트. 시험은 환경 변수로 바꾼다. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const v = env[CACHE_DIR_ENV]
  return v ? path.resolve(v) : path.join(home, '.cache', 'project-wiki')
}

/** 작업 트리 절대 경로의 sha256 앞 12자. 다른 저장소에 같은 이름의 워크트리가 있어도 키가 다르다. */
export function cacheKey(worktree: string): string {
  return createHash('sha256').update(path.resolve(worktree)).digest('hex').slice(0, 12)
}

/** 작업 트리 하나의 색인 폴더. 환경 변수가 없으면 설정 파일 옆 index/ 다. */
export function cacheDirFor(worktree: string, configPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[CACHE_DIR_ENV]
  return v ? path.join(path.resolve(v), cacheKey(worktree)) : path.join(path.dirname(path.resolve(configPath)), 'index')
}

/** 다시 만들기 판정에 쓰는 변경 신호. tree = HEAD + 원천 폴더 git status 해시, outside = git 밖 원천의 가장 늦은 수정 시각(ms, 없으면 0). */
export interface Signal {
  tree: string
  outside: number
}

/** 캐시 폴더의 state.json. 서버를 다시 띄워도 간격 · 미룸 시각을 이어서 센다. */
export interface CacheState {
  /** 마지막 빌드(성공 · 실패)가 끝난 시각. 없으면 0. */
  lastBuildEnd: number
  /** 마지막으로 성공한 빌드를 시작할 때 본 신호. */
  builtSignal?: Signal
  /** 부하로 처음 미룬 시각. 미루지 않는 동안에는 없다. */
  deferredSince?: number
  /** 마지막 시도가 실패했으면 true. 기준 줄에 「다시 만들기 실패」를 적는다. */
  failed?: boolean
}

export const bundleDir = (dir: string): string => path.join(dir, 'bundle')
export const nextBundleDir = (dir: string): string => path.join(dir, 'bundle.next')
/** 비밀값으로 격리한 경로 목록. 표준 출력 · 묶음에는 수만 남는다. */
export const quarantinePath = (dir: string): string => path.join(dir, 'quarantine.txt')
/** 나누기 결과 캐시(core/chunk-cache.ts). */
export const chunkCachePath = (dir: string): string => path.join(dir, 'chunks-cache.json')
const statePath = (dir: string): string => path.join(dir, 'state.json')

/** 캐시 폴더를 만들고 worktree.txt 에 작업 트리 절대 경로를 적는다(사람이 어느 폴더의 캐시인지 알아보게). */
export function prepareCacheDir(dir: string, worktree: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'worktree.txt'), path.resolve(worktree) + '\n')
}

/** state.json 을 읽는다. 없거나 깨졌으면 처음 상태(lastBuildEnd 0)다. */
export function readState(dir: string): CacheState {
  const p = statePath(dir)
  if (!fs.existsSync(p)) return { lastBuildEnd: 0 }
  let raw: Partial<CacheState> | null
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<CacheState> | null
  } catch (e) {
    if (e instanceof SyntaxError) return { lastBuildEnd: 0 }
    throw e
  }
  return { ...raw, lastBuildEnd: typeof raw?.lastBuildEnd === 'number' ? raw.lastBuildEnd : 0 }
}

/** state.json 을 쓴다. 임시 파일에 쓰고 이름을 바꿔, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다. */
export function writeState(dir: string, st: CacheState): void {
  const p = statePath(dir)
  fs.writeFileSync(p + '.tmp', JSON.stringify(st) + '\n')
  fs.renameSync(p + '.tmp', p)
}

/** 쓸 수 있는 묶음이 캐시에 있으면 true. */
export function hasBundle(dir: string): boolean {
  return fs.existsSync(path.join(bundleDir(dir), 'manifest.json'))
}
