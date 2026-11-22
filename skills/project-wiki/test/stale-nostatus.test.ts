// 상태를 읽지 못한 결정 · 정책 문서.
// P2: 위키 원천에서 머리말 모양이 어긋난 문서도 센다. P3: 기준 목록으로 잠그고 새 문서가 생기면 관문을 막는다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { CLI } from './helpers.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { judgeStale } from '../src/core/stale.ts'
import { commitFiles, gitRepo } from './helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = CLI
const noGit = () => ({ code: 0, out: '' })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 임시 폴더에 문서 하나를 두고 일반 Markdown 어댑터로 읽는다. */
function readPage(md: string, area: string): SourceUnit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-nostatus-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs/wiki/d.md'), md)
  const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal', area } as SourceSpec & Record<string, unknown>
  return markdownAdapter.read({ repoRoot: dir, spec }).units[0]
}

const HEAD = 'category: decision\nstatus: current\nsources: [src/a.ts]\n---\n# 결정\n'

describe('위키 원천의 결정 문서가 머리말 모양이 어긋남', () => {
  const shapes: Array<[string, string]> = [
    ['Hw4 여는 줄 끝 공백', `--- \n${HEAD}`],
    ['Hw7 첫 줄 앞 빈 줄', `\n---\n${HEAD}`],
    ['Hw5 들여쓴 --- 첫 줄', `  ---\n${HEAD}`],
    ['Hw9 들여쓴 여는 줄', ` ---\n${HEAD}`],
    ['Hw10 HTML 주석이 첫 줄', `<!-- 메모 -->\n---\n${HEAD}`],
    ['여러 줄 HTML 주석이 먼저', `<!--\n메모\n-->\n---\n${HEAD}`],
  ]
  for (const [name, md] of shapes) {
    test(`${name}: 상태를 읽지 못한 문서로 세고 경고한다`, () => {
      const { report } = judgeStale([readPage(md, 'wiki')], noGit)
      expect(report.noStatusDocs).toBe(1)
      expect(report.warnings.filter((w) => w.includes('docs/wiki/d.md'))).toHaveLength(1)
    })
  }

  test('머리말이 없는 보통 문서와 본문 중간의 가로줄은 세지 않는다', () => {
    const units = [readPage('# 안내\n\n본문.\n', 'wiki'), readPage('# 안내\n\n---\n\n아래.\n', 'wiki')]
    expect(judgeStale(units, noGit).report.noStatusDocs).toBe(0)
  })

  test('정상 모양이면 차단 대상으로 읽힌다(대조)', () => {
    expect(readPage(`---\n${HEAD}`, 'wiki')).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true })
  })
})

describe('status 표기 알림 — 판정은 바꾸지 않는다', () => {
  test('status: Current(대문자)는 차단 대상으로 읽지 않고, 표기가 어긋난 문서로 센다', () => {
    const u = readPage('---\nstatus: Current\n---\n# 정책\n', 'policy')
    expect(u.blockOnStale).toBeUndefined()
    const { report } = judgeStale([u], noGit)
    expect(report).toMatchObject({ block: [], noStatusDocs: 1 })
    expect(report.noStatusList.map((d) => d.kind)).toEqual(['misshapen'])
  })

  test('status: Draft(대문자, 정한 낱말)는 지금처럼 알림 한 줄만 낸다', () => {
    const { report } = judgeStale([readPage('---\nstatus: Draft\n---\n# 정책\n', 'policy')], noGit)
    expect(report).toMatchObject({ block: [], noStatusDocs: 0 })
    expect(report.warnings.filter((w) => w.includes('대소문자'))).toHaveLength(1)
  })

  test('status 를 두 번 적으면 머리말 모양이 어긋난 문서로 센다', () => {
    const u = readPage('---\nstatus: current\nstatus: draft\n---\n# 정책\n', 'policy')
    expect(u.status).toBe('draft')
    const { report } = judgeStale([u], noGit)
    expect(report).toMatchObject({ block: [], noStatusDocs: 1 })
    expect(report.noStatusList.map((d) => d.kind)).toEqual(['misshapen'])
  })

  test('status: current 를 한 번 적은 정상 문서는 알림이 없다', () => {
    const u = readPage('---\nstatus: superseded\n---\n# 정책\n', 'policy')
    expect(judgeStale([u], noGit).report.warnings).toEqual([])
  })
})

// ── 기준 목록 잠금 ───────────────────────────────────────────────────

const POLICY_A = '# 정책 A\n\n머리말이 없는 정책 문서다.\n'
/** 값 안에서 들여쓴 `---` 가 머리말을 닫아 status 를 읽지 못하는 정책 문서. */
const POLICY_H5 = '---\ntitle: 정책 H5\nsummary: |\n  설명 줄\n  ---\nstatus: current\nsources: [src/a.ts]\n---\n# 정책 H5\n'

/** 정책 원천과 위키 원천을 가진 저장소와 설정. `baseline` 을 주면 기준 목록 파일(사유 「머리말 없음」)을 둔다. */
function lockRepo(files: Record<string, string>, baseline?: string[]): { dir: string; cfg: string; base: string } {
  const { dir } = gitRepo({ 'src/a.ts': 'export const a = 1\n', ...files })
  dirs.push(dir)
  const cfg = path.join(dir, 'wiki.json')
  const base = path.join(dir, 'no-status-baseline.json')
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      schema: 1,
      bundle: { name: 't', title: 't' },
      pack: 'core',
      noStatusBaseline: 'no-status-baseline.json',
      sources: [
        { adapter: 'markdown', root: 'docs', include: ['docs/legal/*.md'], level: 'internal', area: 'policy', idNamespace: 'doc' },
        { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal', area: 'wiki' },
      ],
    }),
  )
  if (baseline) fs.writeFileSync(base, JSON.stringify({ schema: 2, entries: baseline.map((p) => ({ path: p, reason: 'no-frontmatter' })) }))
  return { dir, cfg, base }
}

const stale = (cfg: string, dir: string, extra: string[] = []) => spawnSync(process.execPath, [BIN, 'stale', '--config', cfg, '--root', dir, '--json', ...extra], { cwd: dir, encoding: 'utf8' })

describe('상태를 읽지 못한 문서의 기준 목록 잠금', () => {
  test('기준 목록과 같으면 통과한다', () => {
    const { dir, cfg } = lockRepo({ 'docs/legal/a.md': POLICY_A }, ['docs/legal/a.md'])
    const r = stale(cfg, dir)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ block: [], noStatusDocs: 1, noStatusGone: 0 })
  })

  test('기준에 없는 머리말 없는 문서가 생기면 종료 1 로 막는다', () => {
    const { dir, cfg } = lockRepo({ 'docs/legal/a.md': POLICY_A, 'docs/legal/b.md': POLICY_A }, ['docs/legal/a.md'])
    const r = stale(cfg, dir)
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).block).toEqual([{ id: 'doc:legal/b', title: '정책 A', reason: '출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록에 없음)' }])
  })

  test('값 안의 들여쓴 --- 는 머리말을 닫지 않는다. 차단 사유에 머리말 모양을 확인하라는 말을 붙인다', () => {
    const { dir, cfg } = lockRepo({ 'docs/legal/a.md': POLICY_A, 'docs/legal/h5.md': POLICY_H5 }, ['docs/legal/a.md'])
    const r = stale(cfg, dir)
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).block).toEqual([{ id: 'doc:legal/h5', title: '정책 H5', reason: '출하 차단 — 기준 커밋 없음 · 머리말 모양이 어긋나 상태를 읽지 못함, 머리말 모양(첫 줄 `---`)을 확인하세요' }])
  })

  test('위키 원천에서 머리말 모양이 어긋난 결정 문서도 기준에 없으면 막는다', () => {
    const { dir, cfg } = lockRepo({ 'docs/wiki/d.md': `--- \n${HEAD}` }, [])
    const r = stale(cfg, dir)
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).block.map((b: { reason: string }) => b.reason)).toEqual(['출하 차단 — 머리말 모양이 어긋나 상태를 읽지 못함, 머리말 모양(첫 줄 `---`)을 확인하세요'])
  })

  test('기준에 있던 문서가 빠지면 통과하고 다시 잠그라는 알림 한 줄을 낸다', () => {
    const { dir, cfg } = lockRepo({ 'docs/legal/a.md': POLICY_A }, ['docs/legal/a.md', 'docs/legal/gone.md'])
    const r = stale(cfg, dir)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ noStatusDocs: 1, noStatusGone: 1 })
    expect(r.stderr.split('\n').filter((l) => l.includes('기준을 다시 잠그세요'))).toHaveLength(1)
  })

  test('--update-baseline 은 새 문서 · 모양이 어긋난 문서를 목록에 넣지 않는다', () => {
    const { dir, cfg, base } = lockRepo({ 'docs/legal/z.md': POLICY_A, 'docs/legal/a.md': POLICY_A, 'docs/legal/h5.md': POLICY_H5 }, ['docs/legal/a.md'])
    const r = stale(cfg, dir, ['--update-baseline'])
    expect(r.status).toBe(1)
    expect(JSON.parse(fs.readFileSync(base, 'utf8')).entries).toEqual([{ path: 'docs/legal/a.md', reason: 'no-frontmatter' }])
    expect(stale(cfg, dir, ['--accept-new', 'docs/legal/z.md']).status).toBe(1)
    expect(stale(cfg, dir, ['--accept-new', 'docs/legal/h5.md']).status).toBe(2)
    commitFiles(dir, { 'docs/legal/h5.md': null })
    expect(stale(cfg, dir).status).toBe(0)
  })

  test('설정에 적은 기준 목록 파일이 없으면 종료 2', () => {
    const { dir, cfg } = lockRepo({ 'docs/legal/a.md': POLICY_A })
    const r = stale(cfg, dir)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('기준 목록')
  })
})
