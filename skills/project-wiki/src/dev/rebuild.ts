// 자식 빌드 실행과 묶음 바꿔 끼우기. 부르는 곳: dev/live-index.ts · dev/serve-root.ts. 먼저 읽을 파일: dev/cache.ts.
// 같은 런타임으로 `wiki-index build --profile local --allow-dirty --quiet` 를 돌리고, 우선순위를 10 으로 낮추고, 10분이 넘으면 끝낸다.
// 성공하면 bundle.next/ 를 bundle/ 자리로 옮긴다. 실패하면 bundle/ 을 그대로 둔다.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleDir, chunkCachePath, nextBundleDir, quarantinePath } from './cache.ts'

export const BUILD_TIMEOUT_MS = 10 * 60_000
export const CHILD_PRIORITY = 10

/** 자식 빌드로 띄울 실행 파일. 묶은 파일(bin/wiki-index.mjs)이든 원본(src/cli.ts)이든 지금 실행 중인 진입 파일을 쓴다. */
export const ENTRY_ENV = 'WIKI_INDEX_ENTRY'
export function entryScript(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[ENTRY_ENV] ?? process.argv[1] ?? '')
}

export interface BuildJob {
  worktree: string
  configPath: string
  cacheDir: string
  timeoutMs?: number
  /** 자식 프로세스를 띄운다. 시험이 가짜 자식을 넣는다. */
  spawnChild?: (args: string[]) => ChildProcess
  /** 한 줄 기록(수와 상태만). */
  log?: (line: string) => void
}

export interface BuildOutcome {
  ok: boolean
  /** 실패 까닭: exit(종료 코드) · timeout · spawn. */
  reason?: string
}

/**
 * 자식 빌드 인자. --quiet 라서 표준 오류에 경로 · 발췌가 나오지 않는다. 격리 목록은 색인 폴더 quarantine.txt 에만 쓴다.
 * 나누기 결과 캐시를 넘겨 바뀐 문서만 다시 나눈다.
 */
export function buildArgs(job: Pick<BuildJob, 'worktree' | 'configPath' | 'cacheDir'>): string[] {
  const { cacheDir } = job
  return ['build', '--config', job.configPath, '--root', job.worktree, '--out', nextBundleDir(cacheDir), '--profile', 'local', '--allow-dirty', '--quiet',
    '--quarantine-out', quarantinePath(cacheDir), '--chunk-cache', chunkCachePath(cacheDir)]
}

const defaultSpawn = (args: string[]): ChildProcess => spawn(process.execPath, [...process.execArgv, entryScript(), ...args], { stdio: 'ignore' })

/** 자식 우선순위를 낮춘다. 바꾸지 못하면 그대로 돌리고 한 줄을 남긴다. */
function lowerPriority(child: ChildProcess, log: (line: string) => void): void {
  if (child.pid === undefined) return
  try {
    os.setPriority(child.pid, CHILD_PRIORITY)
  } catch (e) {
    log(`우선순위를 낮추지 못함(${(e as NodeJS.ErrnoException).code ?? 'unknown'}) · 그대로 돌림`)
  }
}

/** 자식 빌드를 돌려 bundle.next/ 를 만든다. 시간 상한을 넘으면 자식을 끝내고 실패로 돌려준다. */
export function runChildBuild(job: BuildJob): Promise<BuildOutcome> {
  const log = job.log ?? (() => {})
  fs.rmSync(nextBundleDir(job.cacheDir), { recursive: true, force: true })
  const child = (job.spawnChild ?? defaultSpawn)(buildArgs(job))
  lowerPriority(child, log)
  return new Promise((resolve) => {
    let done = false
    const finish = (o: BuildOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(o)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, reason: 'timeout' })
    }, job.timeoutMs ?? BUILD_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', () => finish({ ok: false, reason: 'spawn' }))
    child.on('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code ?? 'signal'}` }))
  })
}

/** bundle.next/ 를 bundle/ 자리로 옮긴다. 옛 묶음은 bundle.old/ 로 비켜 두었다가 지운다. */
export function swapBundle(cacheDir: string): void {
  const cur = bundleDir(cacheDir)
  const old = path.join(cacheDir, 'bundle.old')
  fs.rmSync(old, { recursive: true, force: true })
  if (fs.existsSync(cur)) fs.renameSync(cur, old)
  fs.renameSync(nextBundleDir(cacheDir), cur)
  fs.rmSync(old, { recursive: true, force: true })
}

/** 빌드 하나: 자식 빌드 → 성공하면 바꿔 끼우기. 실패하면 bundle.next/ 를 지운다. */
export async function rebuild(job: BuildJob): Promise<BuildOutcome> {
  const r = await runChildBuild(job)
  if (r.ok && fs.existsSync(path.join(nextBundleDir(job.cacheDir), 'manifest.json'))) {
    swapBundle(job.cacheDir)
    return r
  }
  fs.rmSync(nextBundleDir(job.cacheDir), { recursive: true, force: true })
  return r.ok ? { ok: false, reason: 'no-bundle' } : r
}
