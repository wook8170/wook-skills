// 기준 줄(dev/basis.ts)과 작업 트리 모드 CLI 의 HEAD 불일치 경고(dev/serve-root.ts openRoot).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { corePack } from '../src/index.ts'
import { buildBundle } from '../src/core/build.ts'
import { writeBundleDir } from '../src/core/bundle.ts'
import { basisLine, headMismatchWarning } from '../src/dev/basis.ts'
import { bundleDir, cacheDirFor } from '../src/dev/cache.ts'
import { openRoot } from '../src/dev/serve-root.ts'
import { CONFIG, FILES, commitFiles, gitRepo } from './helpers.ts'

describe('기준 줄', () => {
  it('커밋 · 미커밋 수 · 상태를 한 줄로 쓴다', () => {
    expect(basisLine({ commit: 'fb3a9b531c7f00', dirtyFiles: 3, state: 'building' })).toBe('기준 fb3a9b531c · 미커밋 3편 · 다시 만드는 중')
    expect(basisLine({ commit: 'fb3a9b531c', dirtyFiles: 0, state: 'deferred', deferredMin: 12 })).toBe('기준 fb3a9b531c · 부하로 12분 미룸')
    expect(basisLine({ commit: 'fb3a9b531c', dirtyFiles: 0, state: 'failed' })).toBe('기준 fb3a9b531c · 다시 만들기 실패')
    expect(basisLine({ commit: 'fb3a9b531c', dirtyFiles: 0, state: 'ready' })).toBe('기준 fb3a9b531c')
    expect(basisLine({ commit: null, dirtyFiles: 1, state: 'ready' })).toBe('기준 커밋 없음 · 미커밋 1편')
  })

  it('HEAD 와 같거나 HEAD 를 모르면 경고하지 않는다', () => {
    expect(headMismatchWarning('abc', 'abc')).toBeNull()
    expect(headMismatchWarning('fb3a9b531c', 'fb3a9b531c7f00aa')).toBeNull()
    expect(headMismatchWarning('abc', null)).toBeNull()
  })
})

describe('작업 트리 모드 CLI', () => {
  it('캐시 묶음의 기준 커밋이 HEAD 와 다르면 표준 오류 경고 한 줄', async () => {
    const { dir } = gitRepo(FILES)
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cfg-')), 'cfg.json')
    fs.writeFileSync(cfg, JSON.stringify(CONFIG))
    const env = { WIKI_INDEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cache-')) }
    const prev = process.env.WIKI_INDEX_CACHE_DIR
    process.env.WIKI_INDEX_CACHE_DIR = env.WIKI_INDEX_CACHE_DIR
    try {
      const b = buildBundle(CONFIG, { repoRoot: dir, pack: corePack, profile: 'local', identity: { allowDirty: true } })
      writeBundleDir(bundleDir(cacheDirFor(dir, cfg, env)), b.files, b.manifest)
      const same: string[] = []
      await openRoot(dir, cfg, (l) => same.push(l))
      expect(same).toEqual([])
      const head = commitFiles(dir, { 'docs/guide/00-overview.md': `${FILES['docs/guide/00-overview.md']}\n## 추가\n\n더한 절.\n` })
      const warned: string[] = []
      const { index } = await openRoot(dir, cfg, (l) => warned.push(l))
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain(`지금 HEAD ${head.slice(0, 10)}`)
      expect(warned[0]).toContain(`색인 기준 ${b.manifest.commit!.slice(0, 10)}`)
      expect(index.chunks.length).toBe(b.manifest.counts.chunks)
    } finally {
      if (prev === undefined) delete process.env.WIKI_INDEX_CACHE_DIR
      else process.env.WIKI_INDEX_CACHE_DIR = prev
    }
  })
})
