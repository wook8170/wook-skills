// 작업 트리 색인 다시 만들기(dev/live-index.ts · dev/rebuild.ts)와 build --quiet.
// 가짜 시계 · 가짜 빌드 · 임시 캐시 폴더를 쓴다. 실제 자식 빌드는 두 번만 띄운다.
import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { corePack } from '../src/index.ts'
import { buildBundle } from '../src/core/build.ts'
import { readBundle, writeBundleDir } from '../src/core/bundle.ts'
import { WikiIndex } from '../src/core/search.ts'
import type { GitRun } from '../src/core/stale.ts'
import { handleRpc } from '../src/mcp/server.ts'
import { bundleDir, cacheDirFor, nextBundleDir, prepareCacheDir, writeState } from '../src/dev/cache.ts'
import { LiveIndex, type LiveDeps } from '../src/dev/live-index.ts'
import { rebuild, runChildBuild, swapBundle, type BuildJob, type BuildOutcome } from '../src/dev/rebuild.ts'
import { CLI, CONFIG, makeRepo } from './helpers.ts'

const T0 = 1_000_000_000_000
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const fakeGit: GitRun = (args) => ({ code: 0, out: args[0] === 'rev-parse' ? 'h1\n' : '' })

function bundleOf(overrides: Record<string, string | null> = {}) {
  return buildBundle(CONFIG, { repoRoot: makeRepo(overrides), pack: corePack, profile: 'local', identity: { reproducible: true, version: '1.0.0' } })
}

/** 캐시에 묶음 하나를 두고, 마지막 빌드 신호를 지금과 다르게 둔 LiveIndex. */
function liveWithCache(build: (job: BuildJob) => Promise<BuildOutcome>, clock: { now: number }) {
  const root = tmp('wiki-live-')
  const cacheDir = path.join(root, 'k')
  const old = bundleOf()
  writeBundleDir(bundleDir(cacheDir), old.files, old.manifest)
  writeState(cacheDir, { lastBuildEnd: 0, builtSignal: { tree: 'old', outside: 0 } })
  const deps: LiveDeps = {
    worktree: '/x/wt',
    configPath: '/x/cfg.json',
    cacheDir,
    lockRoot: root,
    key: 'k',
    roots: ['docs'],
    outsideDirs: [],
    git: fakeGit,
    now: () => clock.now,
    load: () => 1,
    cores: 10,
    pid: process.pid,
    build,
    log: () => {},
  }
  return { live: new LiveIndex(deps), cacheDir, root }
}

/** 신호가 바뀐 것을 보고(대기) 30초 뒤 다시 보아 빌드를 시작시킨다. */
function triggerBuild(live: LiveIndex, clock: { now: number }) {
  clock.now = T0
  live.snapshot()
  clock.now = T0 + 30_000
  return live.snapshot()
}

/** 새 묶음을 bundle.next/ 에 쓰고 바꿔 끼우는 가짜 빌드. */
function writeNext(cacheDir: string, overrides: Record<string, string | null>) {
  const b = bundleOf(overrides)
  writeBundleDir(nextBundleDir(cacheDir), b.files, b.manifest)
  swapBundle(cacheDir)
}

const EXTRA = { 'docs/wiki/feature/extra.md': '# 추가\n\n## 새 절\n\n새로 더한 절이다.\n' }

describe('바꿔 끼우기', () => {
  it('빌드 중 질의는 이전 색인으로, 끝나면 새 색인으로 답한다', async () => {
    const clock = { now: T0 }
    let finish: () => void = () => {}
    const gate = new Promise<void>((r) => (finish = r))
    const ref: { cacheDir?: string } = {}
    const { live, cacheDir } = liveWithCache(async () => {
      await gate
      writeNext(ref.cacheDir!, EXTRA)
      return { ok: true }
    }, clock)
    ref.cacheDir = cacheDir
    const before = live.snapshot().index!
    const during = triggerBuild(live, clock)
    expect(during.index).toBe(before)
    expect(during.basis.state).toBe('building')
    expect(during.line).toContain('다시 만드는 중')
    finish()
    await live.idle()
    const after = live.snapshot()
    expect(after.index).not.toBe(before)
    expect(after.index!.chunks.length).toBe(before.chunks.length + 1)
    expect(after.basis.state).toBe('ready')
  })

  it('빌드가 실패하면 이전 묶음을 계속 쓰고 기준 줄에 「다시 만들기 실패」', async () => {
    const clock = { now: T0 }
    const { live, cacheDir } = liveWithCache(async () => ({ ok: false, reason: 'exit 1' }), clock)
    const before = live.snapshot().index!
    triggerBuild(live, clock)
    await live.idle()
    const s = live.snapshot()
    expect(s.index).toBe(before)
    expect(s.basis.state).toBe('failed')
    expect(s.line).toContain('다시 만들기 실패')
    expect(fs.existsSync(path.join(bundleDir(cacheDir), 'manifest.json'))).toBe(true)
  })

  it('자식 빌드가 시간 상한을 넘으면 끝내고 잠금을 푼다', async () => {
    const clock = { now: T0 }
    const killed: string[] = []
    const fakeChild = () => {
      const c = new EventEmitter() as ChildProcess
      ;(c as { kill: (s?: string) => boolean }).kill = (s?: string) => {
        killed.push(String(s))
        return true
      }
      return c
    }
    const { live, root } = liveWithCache((job) => rebuild({ ...job, spawnChild: fakeChild, timeoutMs: 20 }), clock)
    triggerBuild(live, clock)
    expect(fs.existsSync(path.join(root, 'build.lock'))).toBe(true)
    await live.idle()
    expect(killed).toEqual(['SIGKILL'])
    expect(fs.existsSync(path.join(root, 'build.lock'))).toBe(false)
    expect(live.snapshot().basis.state).toBe('failed')
  })

  it('캐시가 없고 빌드 중이면 도구 호출은 index_building 오류', () => {
    const root = tmp('wiki-live-')
    const live = new LiveIndex({
      worktree: '/x/wt',
      configPath: '/x/cfg.json',
      cacheDir: path.join(root, 'k'),
      lockRoot: root,
      key: 'k',
      roots: [],
      outsideDirs: [],
      git: fakeGit,
      now: () => T0,
      load: () => 50,
      cores: 10,
      pid: process.pid,
      build: () => new Promise(() => {}),
      log: () => {},
    })
    const res = handleRpc(live, { cap: 'internal' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wiki_search', arguments: { q: '피벗' } } }) as {
      result: { isError: boolean; structuredContent: { error: string; message: string } }
    }
    expect(res.result.isError).toBe(true)
    expect(res.result.structuredContent).toEqual({ error: 'index_building', message: '색인을 만드는 중이다 · rg -a 로 찾으세요' })
    const init = handleRpc(live, { cap: 'internal' }, { jsonrpc: '2.0', id: 2, method: 'initialize' }) as { result: { instructions: string } }
    expect(init.result.instructions).toContain('결과의 첫 줄이 기준이다')
  })

  it('작업 트리 색인의 도구 결과는 첫 줄이 기준 줄이고 structuredContent 에 basis 가 있다', () => {
    const clock = { now: T0 }
    const { live } = liveWithCache(() => new Promise(() => {}), clock)
    const res = handleRpc(live, { cap: 'internal' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wiki_search', arguments: { q: '피벗' } } }) as {
      result: { content: Array<{ text: string }>; structuredContent: { basis: { state: string }; results: unknown[] } }
    }
    const [first, json] = res.result.content[0].text.split('\n')
    expect(first.startsWith('기준 ')).toBe(true)
    expect(JSON.parse(json).results.length).toBeGreaterThan(0)
    expect(res.result.structuredContent.basis.state).toBe('ready')
  })
})

describe('실제 자식 빌드', () => {
  it('--root 로 만든 묶음은 같은 원천의 --bundle 묶음과 조각 ID · 수가 같다', async () => {
    const repo = makeRepo()
    const cfg = path.join(tmp('wiki-cfg-'), 'cfg.json')
    fs.writeFileSync(cfg, JSON.stringify(CONFIG))
    const cacheDir = path.join(tmp('wiki-cache-'), 'k')
    prepareCacheDir(cacheDir, repo)
    const r = await rebuild({ worktree: repo, configPath: cfg, cacheDir })
    expect(r).toEqual({ ok: true })
    const viaRoot = new WikiIndex(readBundle(bundleDir(cacheDir)))
    const direct = new WikiIndex(buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'local', identity: { allowDirty: true } }).files)
    expect(viaRoot.chunks.map((c) => c.id)).toEqual(direct.chunks.map((c) => c.id))
    expect(fs.existsSync(nextBundleDir(cacheDir))).toBe(false)
  }, 120_000)

  it('build --quiet 의 표준 오류에는 경로 · 발췌 없이 규칙별 수만 나온다', () => {
    const repo = makeRepo({ 'docs/wiki/feature/home.md': '# 집\n\n## 경로\n\n작업 폴더는 /Users/someone/secret-project 이다.\n' })
    const dir = tmp('wiki-quiet-')
    const cfg = path.join(dir, 'cfg.json')
    fs.writeFileSync(cfg, JSON.stringify(CONFIG))
    const r = spawnSync(process.execPath, [CLI, 'build', '--config', cfg, '--root', repo, '--out', path.join(dir, 'out'), '--profile', 'local', '--allow-dirty', '--quiet'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('경고 1건(personal-path-users 1)')
    expect(r.stderr).not.toContain('home.md')
    expect(r.stderr).not.toContain('/Users/someone')
  }, 120_000)
})

describe('캐시 폴더', () => {
  it('다른 경로의 같은 이름 워크트리는 다른 캐시 폴더를 쓰고, worktree.txt 에 경로를 적는다', () => {
    const env = { WIKI_INDEX_CACHE_DIR: tmp('wiki-cache-') }
    const a = cacheDirFor('/repo-a/wt-x', '/cfg.json', env)
    const b = cacheDirFor('/repo-b/wt-x', '/cfg.json', env)
    expect(a).not.toBe(b)
    prepareCacheDir(a, '/repo-a/wt-x')
    expect(fs.readFileSync(path.join(a, 'worktree.txt'), 'utf8').trim()).toBe('/repo-a/wt-x')
  })
})
