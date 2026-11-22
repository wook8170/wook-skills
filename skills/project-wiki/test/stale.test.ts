// 낡음 판정(core/stale.ts) · mark-synced · 출하 차단 규칙 · stale 명령 · 위키 페이지 낡음.
// 모두 임시 git 저장소에서 판정한다. 저장소 고정물에 기대지 않는다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from './support/vitest-shim.ts'
import { CLI } from './helpers.ts'
import { corePack } from '../src/index.ts'
import { fileAnchor, isBlockingPage, markdownAdapter } from '../src/core/adapter.ts'
import { buildBundle, normalizeConfig, type WikiConfig } from '../src/core/build.ts'
import { MarkSyncedError, markSynced, setFrontmatterField } from '../src/core/mark-synced.ts'
import type { Chunk, SourceUnit } from '../src/core/model.ts'
import { BLOCK_REASON, SAME_COMMIT_FOR_BLOCKING, applyStale, gitRunner, judgeStale, type GitRun } from '../src/core/stale.ts'
import { CONFIG, FILES, commitFiles, git, gitRepo } from './helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = CLI

const BASE: Record<string, string> = {
  'docs/w/block.md': '# 차단\n',
  'docs/w/plain.md': '# 보통\n',
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
  'src/dir/x.ts': 'export const x = 1\n',
}

function unit(o: Partial<SourceUnit> & { path: string }): SourceUnit {
  return { adapter: 'markdown', page: `wiki:${o.path}`, part: 'wiki', title: o.path, titlePrefix: [], level: 'internal', generated: false, markdown: '', anchors: [], ...o }
}

/** 같은 근거 · 기준 커밋을 가진 차단 대상 페이지와 보통 페이지. */
function pair(dir: string, baseCommit: string | undefined, anchors: string[]): SourceUnit[] {
  const common = { reviewInSameCommit: true, anchors: anchors.map((a) => fileAnchor(dir, a)), ...(baseCommit ? { baseCommit } : {}) }
  return [unit({ path: 'docs/w/block.md', blockOnStale: true, ...common }), unit({ path: 'docs/w/plain.md', ...common })]
}

const blockOf = (reason: string) => [{ id: 'wiki:docs/w/block.md', title: 'docs/w/block.md', reason }]

describe('판정할 수 없을 때(A3) — 차단 대상 · 그 밖', () => {
  test('기준 커밋 칸이 없음: 차단 대상은 stale, 그 밖은 판정 불가 +1', () => {
    const { dir } = gitRepo(BASE)
    const { report } = judgeStale(pair(dir, undefined, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.noCommit))
    expect(report).toMatchObject({ unverifiable: 1, noAnchorDocs: 0, warn: 0 })
  })

  test('기준 커밋이 없는 값: 차단 대상은 stale, 그 밖은 판정 불가 +1 · 경고 줄 1개', () => {
    const { dir } = gitRepo(BASE)
    const { report } = judgeStale(pair(dir, 'deadbeefdeadbeef', ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.badCommit))
    expect(report.unverifiable).toBe(1)
    expect(report.warnings).toHaveLength(1)
  })

  test('HEAD 의 조상이 아닌 커밋도 찾을 수 없음으로 본다', () => {
    const { dir, first } = gitRepo(BASE)
    git(dir, ['checkout', '-q', '-b', 'side'])
    const side = commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    git(dir, ['checkout', '-q', 'main'])
    expect(side).not.toBe(first)
    const { report } = judgeStale(pair(dir, side, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.badCommit))
    expect(report.unverifiable).toBe(1)
  })

  test('판정할 근거가 0개(폴더만): 차단 대상은 stale, 그 밖은 noAnchorDocs +1', () => {
    const { dir, first } = gitRepo(BASE)
    const { report } = judgeStale(pair(dir, first, ['src/dir']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.noAnchor))
    expect(report).toMatchObject({ noAnchorDocs: 1, unverifiable: 0, unverifiableAnchors: 2 })
  })

  test('git 실행 실패(저장소가 아님): 차단 대상은 stale, 그 밖은 판정 불가 +1 · 경고 줄 1개', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-stale-nogit-'))
    for (const [rel, body] of Object.entries(BASE)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), body)
    }
    const { report } = judgeStale(pair(dir, 'abcdef1234', ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
    expect(report.unverifiable).toBe(1)
    expect(report.warnings).toHaveLength(1)
  })

  test('이력 읽기(git log)만 실패해도 같은 사유로 센다', () => {
    const { dir, first } = gitRepo(BASE)
    const real = gitRunner(dir)
    const run: GitRun = (args) => (args[0] === 'log' ? { code: 128, out: '' } : real(args))
    const { report } = judgeStale(pair(dir, first, ['src/a.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
    expect(report.unverifiable).toBe(1)
  })

  test('근거가 바뀜: 차단 대상은 「근거 파일 N개 바뀜」, 그 밖은 낡음 후보(지금 형식)', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 2\n' })
    const units = pair(dir, first, ['src/a.ts', 'src/b.ts'])
    const { verdicts, report } = judgeStale(units, gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(2)))
    expect(report.warn).toBe(1)
    const chunks = units.map((u) => ({ source: { path: u.path }, anchors: u.anchors, stale: null }) as unknown as Chunk)
    applyStale(chunks, verdicts)
    expect(chunks[0].stale).toEqual({ state: 'stale', reason: '출하 차단 — 근거 파일 2개 바뀜' })
    expect(chunks[1].stale).toEqual({ state: 'stale-candidate', reason: `근거 파일이 기준 커밋 ${first} 뒤 바뀜: src/a.ts, src/b.ts` })
  })

  test('얕은 복제에서는 사유에 전체 이력으로 받으라는 말을 넣는다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    commitFiles(dir, { 'src/b.ts': 'export const b = 2\n' })
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-stale-shallow-'))
    git(os.tmpdir(), ['clone', '-q', '--depth', '1', `file://${dir}`, shallow])
    const { report } = judgeStale(pair(shallow, first, ['src/a.ts']), gitRunner(shallow))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.shallow))
    expect(report.warnings[0]).toContain('얕은 복제')
  })
})

describe('같은 커밋 규칙', () => {
  const plain = (dir: string, base: string, anchors: string[]) => pair(dir, base, anchors)[1]

  test('근거와 문서가 같은 커밋에서 함께 바뀌면 확인한 것으로 본다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/w/plain.md': '# 보통 고침\n' })
    const { verdicts, report } = judgeStale([plain(dir, first, ['src/a.ts'])], gitRunner(dir))
    expect(verdicts.size).toBe(0)
    expect(report.warn).toBe(0)
  })

  test('다른 커밋의 근거 변경은 낡음으로 센다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    commitFiles(dir, { 'docs/w/plain.md': '# 보통 고침\n' })
    const { verdicts } = judgeStale([plain(dir, first, ['src/a.ts'])], gitRunner(dir))
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('합친 커밋 하나가 근거 둘과 문서를 함께 바꾸면 확인한 것으로 보고, 그 뒤 따로 바뀐 근거만 센다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 2\n', 'docs/w/plain.md': '# 합침\n' }, 'squash')
    const one = judgeStale([plain(dir, first, ['src/a.ts', 'src/b.ts'])], gitRunner(dir))
    expect(one.verdicts.size).toBe(0)
    commitFiles(dir, { 'src/b.ts': 'export const b = 3\n' })
    const two = judgeStale([plain(dir, first, ['src/a.ts', 'src/b.ts'])], gitRunner(dir))
    expect(two.verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/b.ts']) })
  })

  test('진짜 병합 커밋(--no-ff)이 끼어도 곁가지 커밋마다 판정한다', () => {
    const { dir, first } = gitRepo(BASE)
    const mergeIn = (branch: string, branchFiles: Record<string, string>, mainFiles: Record<string, string>) => {
      git(dir, ['checkout', '-q', '-b', branch])
      commitFiles(dir, branchFiles)
      git(dir, ['checkout', '-q', 'main'])
      commitFiles(dir, mainFiles)
      git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `merge ${branch}`, branch])
    }
    mergeIn('feat', { 'src/a.ts': 'export const a = 2\n', 'docs/w/plain.md': '# 보통 고침\n' }, { 'src/dir/x.ts': 'export const x = 2\n' })
    expect(git(dir, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1')
    expect(judgeStale([plain(dir, first, ['src/a.ts'])], gitRunner(dir)).verdicts.size).toBe(0)
    mergeIn('feat2', { 'src/a.ts': 'export const a = 3\n' }, { 'docs/w/plain.md': '# 보통 또 고침\n' })
    expect(git(dir, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('2')
    const { verdicts } = judgeStale([plain(dir, first, ['src/a.ts'])], gitRunner(dir))
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('차단 대상 페이지에는 적용하지 않는다', () => {
    expect(SAME_COMMIT_FOR_BLOCKING).toBe(false)
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/w/block.md': '# 차단 고침\n', 'docs/w/plain.md': '# 보통 고침\n' })
    const { report } = judgeStale(pair(dir, first, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(0)
  })
})

const WIKI_CFG: WikiConfig = normalizeConfig({
  schema: 1,
  bundle: { name: 'stale-test', title: '낡음 시험' },
  pack: 'core',
  sources: [
    { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal' as never, area: 'wiki' },
    { adapter: 'markdown', root: 'docs/guide', idNamespace: 'dev', part: 'dev', level: 'internal' as never },
  ],
})

function page(fm: Record<string, string>): string {
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n# 페이지\n\n## 절\n\n본문이다.\n`
}

function readUnits(dir: string, cfg: WikiConfig = WIKI_CFG): SourceUnit[] {
  return cfg.sources.flatMap((spec) => corePack.adapters.find((a) => a.name === spec.adapter)!.read({ repoRoot: dir, spec }).units)
}

function build(dir: string, cfg: WikiConfig = WIKI_CFG) {
  return buildBundle(cfg, { repoRoot: dir, pack: corePack, profile: 'local', identity: { reproducible: true, version: '1.0.0' } })
}

const chunksOf = (r: ReturnType<typeof build>, rel: string): Chunk[] =>
  r.files
    .get('chunks.jsonl')!
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Chunk)
    .filter((c) => c.source.path === rel)

describe('출하 차단 규칙', () => {
  test.each([
    ['decision', 'current', true],
    ['policy', 'current', true],
    ['decision', 'draft', false],
    ['feature', 'current', false],
    [undefined, 'current', false],
  ])('영역 %s · status %s → 차단 대상 %s', (area, status, want) => {
    expect(isBlockingPage(area, status)).toBe(want)
  })

  test.each([
    ['policy', 'current', true, 'stale'],
    ['decision', 'current', true, 'stale'],
    ['policy', 'draft', true, 'stale-candidate'],
    ['feature', 'current', true, 'stale-candidate'],
    ['policy', 'current', false, null],
  ])('영역 %s · status %s · 근거 변경 %s → 조각 %s', (area, status, changed, want) => {
    const { dir, first } = gitRepo({ ...BASE, 'docs/wiki/p.md': '# 임시\n' })
    const base = commitFiles(dir, { 'docs/wiki/p.md': page({ title: '피', area, status, sources: '[src/a.ts]', base_commit: `"${first}"` }) })
    if (changed) commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    expect(base).not.toBe(first)
    const cs = chunksOf(build(dir), 'docs/wiki/p.md')
    expect(cs.length).toBeGreaterThan(0)
    for (const c of cs) expect(c.stale?.state ?? null).toBe(want)
  })

  test('머리말 category 는 area 의 옛 이름이다', () => {
    const { dir } = gitRepo({ 'docs/wiki/p.md': page({ title: '피', category: 'decision', status: 'current' }) })
    const u = readUnits(dir).find((x) => x.path === 'docs/wiki/p.md')!
    expect(u).toMatchObject({ area: 'decision', blockOnStale: true, reviewInSameCommit: true })
  })

  test('area 와 category 가 함께 있으면 area 를 쓴다', () => {
    const { dir } = gitRepo({ 'docs/wiki/p.md': page({ title: '피', area: 'feature', category: 'decision', status: 'current' }) })
    const u = readUnits(dir).find((x) => x.path === 'docs/wiki/p.md')!
    expect(u.area).toBe('feature')
    expect(u.blockOnStale).toBeUndefined()
  })
})

describe('stale 명령 종료 코드', () => {
  const runCli = (args: string[], cwd: string) => spawnSync(process.execPath, [BIN, 'stale', ...args], { cwd, encoding: 'utf8' })
  const writeCfg = (dir: string) => {
    const p = path.join(dir, 'wiki.json')
    fs.writeFileSync(p, JSON.stringify({ schema: 1, bundle: { name: 't', title: 't' }, pack: 'core', sources: [{ adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal' }] }))
    return p
  }

  test('차단 0건이면 0, --json 형식을 지킨다', () => {
    const { dir, first } = gitRepo({ ...BASE, 'docs/wiki/p.md': '# 임시\n' })
    commitFiles(dir, { 'docs/wiki/p.md': page({ title: '피', sources: '[src/a.ts]', base_commit: `"${first}"` }) })
    const r = runCli(['--config', writeCfg(dir), '--root', dir, '--json'], dir)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ block: [], warn: 0, unverifiable: 0, noAnchorDocs: 0, unverifiableAnchors: 0, noStatusDocs: 0 })
  })

  test('차단 1건 이상이면 1, 미커밋 변경이 있어도 판정한다', () => {
    const { dir } = gitRepo({ 'docs/wiki/p.md': page({ title: '정책 피', area: 'policy', status: 'current' }) })
    fs.writeFileSync(path.join(dir, 'docs/wiki/q.md'), '# 미커밋\n')
    const r = runCli(['--config', writeCfg(dir), '--root', dir, '--json'], dir)
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).block).toEqual([{ id: 'wiki:p', title: '정책 피', reason: BLOCK_REASON.noCommit }])
  })

  test('mark-synced 명령: HEAD 를 쓰고 0, git 저장소가 아니면 2', () => {
    const { dir } = gitRepo({ ...BASE, 'docs/wiki/p.md': page({ title: '피' }) })
    const head = git(dir, ['rev-parse', 'HEAD'])
    const ok = spawnSync(process.execPath, [BIN, 'mark-synced', '--config', writeCfg(dir), '--root', dir, 'docs/wiki/p.md'], { cwd: dir, encoding: 'utf8' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(`기준 커밋 ${head.slice(0, 10)} → docs/wiki/p.md`)
    expect(fs.readFileSync(path.join(dir, 'docs/wiki/p.md'), 'utf8')).toContain(`base_commit: "${head}"`)
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mark-nogit-'))
    fs.mkdirSync(path.join(plainDir, 'docs/wiki'), { recursive: true })
    fs.writeFileSync(path.join(plainDir, 'docs/wiki/p.md'), page({ title: '피' }))
    const bad = spawnSync(process.execPath, [BIN, 'mark-synced', '--config', writeCfg(plainDir), '--root', plainDir, 'docs/wiki/p.md'], { cwd: plainDir, encoding: 'utf8' })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('HEAD 커밋을 읽지 못했다')
  })

  test('설정 · 사용 오류는 2', () => {
    const { dir } = gitRepo(BASE)
    expect(runCli(['--root', dir], dir).status).toBe(2)
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ schema: 2 }))
    expect(runCli(['--config', path.join(dir, 'bad.json'), '--root', dir], dir).status).toBe(2)
  })
})

describe('위키 페이지 낡음(머리말 base_commit)', () => {
  function repoWithPage(fm: Record<string, string>) {
    const { dir, first } = gitRepo({ ...BASE, 'docs/wiki/p.md': '# 임시\n' })
    commitFiles(dir, { 'docs/wiki/p.md': page({ title: '피', base_commit: `"${first}"`, ...fm }) })
    return { dir, first }
  }

  test('기준 커밋 뒤 근거가 바뀌면 낡음 후보', () => {
    const { dir, first } = repoWithPage({ sources: '[src/a.ts]' })
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    const r = build(dir)
    for (const c of chunksOf(r, 'docs/wiki/p.md')) expect(c.stale).toEqual({ state: 'stale-candidate', reason: `근거 파일이 기준 커밋 ${first} 뒤 바뀜: src/a.ts` })
    expect(r.manifest.counts.staleCandidates).toBeGreaterThan(0)
  })

  test('근거가 바뀌지 않으면 표시 없음', () => {
    const { dir } = repoWithPage({ sources: '[src/a.ts]' })
    commitFiles(dir, { 'src/b.ts': 'export const b = 2\n' })
    for (const c of chunksOf(build(dir), 'docs/wiki/p.md')) expect(c.stale).toBeNull()
  })

  test('저장소 밖 · 없는 근거는 판정하지 않고 근거 확인 불가로 센다', () => {
    const { dir } = repoWithPage({ sources: '[../outside/x.md, other-repo/src/y.ts]' })
    const r = build(dir)
    expect(r.stale).toMatchObject({ noAnchorDocs: 1, unverifiableAnchors: 2, unverifiable: 0 })
    for (const c of chunksOf(r, 'docs/wiki/p.md')) expect(c.stale).toBeNull()
  })

  test('근거와 페이지가 같은 커밋에서 바뀌면 표시 없음', () => {
    const { dir, first } = repoWithPage({ sources: '[src/a.ts]' })
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/wiki/p.md': page({ title: '피 고침', base_commit: `"${first}"`, sources: '[src/a.ts]' }) })
    for (const c of chunksOf(build(dir), 'docs/wiki/p.md')) expect(c.stale).toBeNull()
  })

  test('잘못된 커밋 값: 보통 페이지는 판정 불가 수, 차단 대상 페이지는 stale', () => {
    const { dir } = gitRepo({ ...BASE, 'docs/wiki/p.md': page({ title: '피', sources: '[src/a.ts]', base_commit: '"zzz"' }), 'docs/wiki/q.md': page({ title: '규', area: 'policy', status: 'current', sources: '[src/a.ts]', base_commit: '"zzz"' }) })
    const r = build(dir)
    expect(r.stale).toMatchObject({ unverifiable: 1, block: [{ id: 'wiki:q', title: '규', reason: BLOCK_REASON.badCommit }] })
    for (const c of chunksOf(r, 'docs/wiki/p.md')) expect(c.stale).toBeNull()
    for (const c of chunksOf(r, 'docs/wiki/q.md')) expect(c.stale).toEqual({ state: 'stale', reason: BLOCK_REASON.badCommit })
  })
})

describe('마크다운 어댑터의 근거 값 처리', () => {
  test('중괄호는 한 단계만 풀고, 글롭 · 경로가 아닌 값은 앵커로 넣지 않는다', () => {
    const { dir } = gitRepo({ ...BASE, 'docs/wiki/p.md': page({ title: '피', sources: '["src/{a,b}.ts", "src/*.ts", "pivot"]' }) })
    const u = markdownAdapter.read({ repoRoot: dir, spec: { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal' } }).units[0]
    expect(u.anchors.map((a) => a.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(u.skippedAnchors).toBe(2)
  })
})
