// 프로젝트 모드 끝까지: 작은 예제 저장소에서 init → build → search → read → backlinks → stale, 바뀐 문서만 다시 색인, 격리, MCP.
// CLI 를 하위 프로세스로 띄운다. WIKI_INDEX_BIN=bin/wiki-index.mjs 로 돌리면 묶은 파일을 시험한다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { CLI, commitFiles, gitRepo } from './helpers.ts'

const DECISION = `---
title: 캐시 결정
area: decision
status: current
sources: [src/cache.ts]
---
# 캐시 결정

## 결정

조회가 느려서 캐시를 둔다. 근거는 \`src/cache.ts\` 다.
`

const REPO_FILES: Record<string, string> = {
  'README.md': '# 예제\n\n소개 글.\n',
  'docs/ops.md': '# 운영\n\n## 재기동\n\n서버를 다시 띄운다. [캐시 결정](adr/0001-cache.md)\n',
  'docs/adr/0001-cache.md': DECISION,
  'src/cache.ts': 'export const cache = 1\n',
}

/** 머신 전체 잠금 폴더(~/.cache/project-wiki)는 시험 전용 HOME 아래에 두고, 색인 폴더는 기본값(.wiki/index/)을 쓴다. */
const ENV: NodeJS.ProcessEnv = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'project-wiki-home-')) }
delete ENV.WIKI_INDEX_CACHE_DIR

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV })
}

describe('프로젝트 모드 끝까지', () => {
  const { dir } = gitRepo(REPO_FILES)

  it('init: 문서 폴더를 원천으로 잡고 설정 · 프로젝트 설정 문서 · .gitignore 줄을 만든다', () => {
    const r = cli(dir, ['init'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('원천 docs-adr')
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.wiki/config.json'), 'utf8'))
    expect(cfg.sources.map((s: { idNamespace: string }) => s.idNamespace)).toEqual(['docs', 'docs-adr', 'root'])
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.wiki/index/')
    expect(fs.readFileSync(path.join(dir, '.claude/skills-config/project-wiki.md'), 'utf8')).toContain('node <wiki-index> search')
  })

  it('init 을 다시 하면 이미 있는 파일을 덮어쓰지 않는다', () => {
    const cfgPath = path.join(dir, '.wiki/config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, bundle: { ...cfg.bundle, title: '고친 제목' } }, null, 2))
    const before = fs.readFileSync(path.join(dir, '.wiki/config.json'), 'utf8')
    const r = cli(dir, ['init'])
    expect(r.stdout).toContain('그대로 둠')
    expect(fs.readFileSync(path.join(dir, '.wiki/config.json'), 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').match(/\.wiki\/index\//g)).toHaveLength(1)
  })

  it('build → search → read → backlinks', () => {
    const b = cli(dir, ['build'])
    expect(b.status).toBe(0)
    expect(b.stdout).toContain('다시 나눈 문서 3 · 그대로 쓴 문서 0')
    const s = cli(path.join(dir, 'docs'), ['search', '캐시', '--json'])
    expect(s.status).toBe(0)
    const hits = JSON.parse(s.stdout).hits as Array<{ id: string }>
    expect(hits[0].id).toBe('docs-adr:0001-cache#결정')
    const r = cli(dir, ['read', 'docs:ops#재기동'])
    expect(JSON.parse(r.stdout)).toMatchObject({ id: 'docs:ops#재기동', titlePath: ['운영', '재기동'] })
    const bl = JSON.parse(cli(dir, ['backlinks', 'docs-adr:0001-cache']).stdout)
    expect(bl.backlinks.ref.top.map((t: { id: string }) => t.id)).toEqual(['docs:ops#재기동'])
  })

  it('문서를 고치면 다음 검색 전에 바뀐 문서만 다시 나눈다', () => {
    fs.appendFileSync(path.join(dir, 'docs/ops.md'), '\n## 점검\n\n점검 절차를 적는다.\n')
    const s = cli(dir, ['search', '점검 절차'])
    expect(s.stderr).toContain('다시 나눈 문서 1 · 그대로 쓴 문서 2')
    expect(s.stdout).toContain('docs:ops#점검')
    const again = cli(dir, ['search', '점검 절차'])
    expect(again.stderr).not.toContain('색인 새로 고침')
    expect(cli(dir, ['build', '--if-changed']).stdout).toContain('색인이 최신이다')
  })

  it('stale: 기준 커밋이 없는 현행 결정 문서는 출하 차단(종료 1), mark-synced 뒤 통과(종료 0)', () => {
    const r = cli(dir, ['stale'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('차단 docs-adr:0001-cache')
    expect(cli(dir, ['mark-synced', 'docs/adr/0001-cache.md']).status).toBe(0)
    expect(cli(dir, ['stale']).status).toBe(0)
  })

  it('근거 파일이 기준 커밋 뒤 바뀌면 다시 차단하고 검색 결과에 낡음 표시가 붙는다', () => {
    commitFiles(dir, { 'docs/adr/0001-cache.md': fs.readFileSync(path.join(dir, 'docs/adr/0001-cache.md'), 'utf8') }, 'sync')
    commitFiles(dir, { 'src/cache.ts': 'export const cache = 2\n' }, 'change evidence')
    expect(cli(dir, ['stale']).status).toBe(1)
    const hits = JSON.parse(cli(dir, ['search', '캐시', '--json']).stdout).hits as Array<{ id: string; stale: { state: string } | null }>
    expect(hits.find((h) => h.id === 'docs-adr:0001-cache#결정')?.stale?.state).toBe('stale')
  })

  it('비밀값이 든 문서는 격리하고 경로는 quarantine.txt(600)에만 남긴다', () => {
    const key = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')
    fs.writeFileSync(path.join(dir, 'docs/secret.md'), `# 비밀\n\n토큰 ${key}\n`)
    const b = cli(dir, ['build'])
    expect(b.status).toBe(0)
    expect(b.stdout).toContain('격리 1편')
    expect(b.stdout + b.stderr).not.toContain(key)
    const q = path.join(dir, '.wiki/index/quarantine.txt')
    expect(fs.readFileSync(q, 'utf8')).toBe('격리 docs/secret.md\n')
    expect(fs.statSync(q).mode & 0o777).toBe(0o600)
    expect(JSON.parse(cli(dir, ['search', '토큰', '--json']).stdout).hits).toEqual([])
  })

  it('serve-mcp: 표준 입출력으로 도구 3종을 알리고 검색에 답한다', () => {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki_search', arguments: { q: '재기동' } } },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n'
    const r = spawnSync(process.execPath, [CLI, 'serve-mcp'], { cwd: dir, input, encoding: 'utf8', env: ENV, timeout: 60_000 })
    const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(replies.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['wiki_search', 'wiki_read', 'wiki_backlinks'])
    expect(replies.find((m) => m.id === 3).result.content[0].text).toContain('docs:ops#재기동')
  }, 90_000)
})

describe('위키 폴더를 저장소 밖에 둘 때', () => {
  it('init --wiki-dir 는 저장소 파일을 건드리지 않고, 같은 --wiki-dir 로 build · search 를 한다', () => {
    const { dir } = gitRepo(REPO_FILES)
    const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-wiki-out-'))
    expect(cli(dir, ['init', '--wiki-dir', wikiDir]).status).toBe(0)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false)
    expect(cli(dir, ['build', '--wiki-dir', wikiDir]).status).toBe(0)
    expect(fs.existsSync(path.join(wikiDir, 'index/bundle/manifest.json'))).toBe(true)
    const s = cli(dir, ['search', '재기동', '--wiki-dir', wikiDir])
    expect(s.stdout).toContain('docs:ops#재기동')
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout
    expect(status).toBe('')
  })

  it('설정이 없는 곳에서 search 하면 init 을 먼저 하라는 설정 오류(종료 2)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'project-wiki-none-'))
    const r = cli(empty, ['search', '아무거나'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('wiki-index init')
  })
})
