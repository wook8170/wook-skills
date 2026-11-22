// 다시 만들기 판정에 쓰는 변경 신호. 부르는 곳: dev/live-index.ts · dev/serve-root.ts. 먼저 읽을 파일: dev/schedule.ts.
// 작업 트리 신호 = HEAD 커밋 + 원천 폴더 `git status --porcelain` 출력의 해시. 바깥 신호 = git 밖 원천의 가장 늦은 수정 시각.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GitRun } from '../core/stale.ts'
import type { Signal } from './cache.ts'

/** 바깥 원천 감시에서 건너뛰는 폴더: 숨김 폴더 · 의존성 · 임시 폴더. 그 안이 바뀌어도 색인 내용은 같다. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'tmp', 'temp'])
export const isSkippedDirName = (name: string): boolean => name.startsWith('.') || SKIPPED_DIRS.has(name)

export interface TreeState {
  /** HEAD 커밋. 저장소가 아니거나 읽지 못하면 null. */
  head: string | null
  /** 원천 폴더 안 미커밋 파일 수(기준 줄 「미커밋 N편」). */
  dirtyFiles: number
  /** HEAD + status 해시. */
  tree: string
}

/** 작업 트리 신호. 원천 폴더(설정의 sources[].root)만 본다. git 호출은 두 번이다. */
export function readTree(git: GitRun, roots: string[]): TreeState {
  const h = git(['rev-parse', 'HEAD'])
  const head = h.code === 0 ? h.out.trim() || null : null
  const st = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...(roots.length ? roots : ['.'])])
  const status = st.code === 0 ? st.out : ''
  const dirtyFiles = status.split('\0').filter((e) => e.length > 3).length
  const tree = createHash('sha256').update(`${head ?? ''}\n${status}`).digest('hex').slice(0, 16)
  return { head, dirtyFiles, tree }
}

/**
 * 폴더들 아래 파일의 가장 늦은 수정 시각(ms). 폴더가 없으면 0. 심볼릭 링크는 따라가지 않는다.
 * 건너뛰는 폴더(`isSkippedDirName`)는 보지 않는다.
 */
export function latestMtime(dirs: string[]): number {
  let max = 0
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!isSkippedDirName(ent.name)) walk(p)
      }
      else if (ent.isFile()) max = Math.max(max, fs.statSync(p).mtimeMs)
    }
  }
  for (const d of dirs) if (fs.existsSync(d)) walk(d)
  return Math.floor(max)
}

/** 신호 둘을 함께 읽는다. */
export function readSignal(git: GitRun, roots: string[], outsideDirs: string[]): { signal: Signal; tree: TreeState } {
  const tree = readTree(git, roots)
  return { signal: { tree: tree.tree, outside: latestMtime(outsideDirs) }, tree }
}
