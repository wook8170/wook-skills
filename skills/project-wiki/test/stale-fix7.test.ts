// 머리말 표기 · 링크 문서 · 기준 목록 사유 판정.
// 머리말 모양이 어긋난 문서에 mark-synced 를 부르면 거절하고 문서를 그대로 둔다.
// 심볼릭 링크로 바뀐 문서는 「상태를 읽지 못한 문서」로 세고 막는다.
// --accept-new 가 목록에 든 문서의 사유를 바꾸면 그 사실을 출력한다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { CLI } from './helpers.ts'
import { git, gitRepo } from './helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = CLI
const HEAD = 'category: decision\nstatus: current\nsources: [src/a.ts]\n---\n# 결정\n\n본문이다.\n'
const POLICY = '# 정책\n\n머리말이 없는 정책 문서다.\n'
const LINK_REASON = '출하 차단 — 문서가 심볼릭 링크라 상태를 읽지 못함, 링크를 실제 파일로 바꾸세요'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 위키 원천 · 정책 원천(글롭과 정확한 경로)을 가진 저장소와 설정. `listed` 를 주면 그 경로들을 사유와 함께 기준 목록에 둔다. */
function repo(files: Record<string, string>, listed: Array<[string, string]> = []): { dir: string; cfg: string; base: string } {
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
        { adapter: 'markdown', root: 'docs', include: ['docs/LICENSING.md'], level: 'internal', area: 'policy', idNamespace: 'doc' },
        { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal', area: 'wiki' },
      ],
    }),
  )
  fs.writeFileSync(base, JSON.stringify({ schema: 2, entries: listed.map(([p, reason]) => ({ path: p, reason })) }))
  return { dir, cfg, base }
}

/** `at` 자리에 `target` 을 가리키는 심볼릭 링크를 만든다(폴더가 없으면 만든다). */
function link(dir: string, target: string, at: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true })
  fs.symlinkSync(target, path.join(dir, at))
}

const cli = (dir: string, args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' })
const stale = (dir: string, cfg: string, extra: string[] = []) => cli(dir, ['stale', '--config', cfg, '--root', dir, '--json', '--require-baseline', ...extra])

describe('머리말 모양이 어긋난 문서에는 mark-synced 를 거절한다', () => {
  const shapes: Array<[string, string]> = [
    ['앞 빈 줄', `\n---\n${HEAD}`],
    ['여는 줄 끝 공백', `--- \n${HEAD}`],
    ['앞 HTML 주석', `<!-- 메모 -->\n---\n${HEAD}`],
  ]
  for (const [name, md] of shapes) {
    test(`${name}: 종료 2, 문서를 바꾸지 않고, 막힌 채로 남는다`, () => {
      const { dir, cfg } = repo({ 'docs/wiki/d.md': md })
      const r = cli(dir, ['mark-synced', '--config', cfg, '--root', dir, 'docs/wiki/d.md'])
      expect(r.status).toBe(2)
      expect(r.stderr.split('\n')[0]).toBe('오류: 머리말 모양이 어긋난 문서: docs/wiki/d.md — 머리말 모양(첫 줄 `---`)을 먼저 고친다')
      expect(fs.readFileSync(path.join(dir, 'docs/wiki/d.md'), 'utf8')).toBe(md)
      expect(git(dir, ['status', '--short', '--', 'docs'])).toBe('')
      expect(stale(dir, cfg).status).toBe(1)
    })
  }

  test('바른 머리말 문서에는 지금처럼 쓴다(대조)', () => {
    const { dir, cfg } = repo({ 'docs/wiki/d.md': `---\n${HEAD}` })
    expect(cli(dir, ['mark-synced', '--config', cfg, '--root', dir, 'docs/wiki/d.md']).status).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'docs/wiki/d.md'), 'utf8')).toContain('base_commit: "')
  })
})

describe('심볼릭 링크로 바뀐 문서는 상태를 읽지 못한 문서로 세고 막는다', () => {
  const blockOf = (dir: string, cfg: string) => {
    const r = stale(dir, cfg)
    return { status: r.status, out: JSON.parse(r.stdout) as { block: Array<{ id: string; reason: string }>; noStatusDocs: number } }
  }

  test('위키 원천에 새로 생긴 링크', () => {
    const { dir, cfg } = repo({ 'docs/other.md': `---\n${HEAD}` })
    link(dir, '../other.md', 'docs/wiki/d.md')
    const { status, out } = blockOf(dir, cfg)
    expect(status).toBe(1)
    expect(out.block).toEqual([{ id: 'docs/wiki/d.md', title: 'docs/wiki/d.md', reason: LINK_REASON }])
    expect(out.noStatusDocs).toBe(1)
  })

  test('목록에 든 정책 문서를 링크로 바꾸면 빠진 문서가 아니라 막힌 문서다', () => {
    const { dir, cfg } = repo({ 'docs/legal/a.md': POLICY, 'docs/other.md': POLICY }, [['docs/legal/a.md', 'no-frontmatter']])
    expect(stale(dir, cfg).status).toBe(0)
    fs.rmSync(path.join(dir, 'docs/legal/a.md'))
    link(dir, '../other.md', 'docs/legal/a.md')
    const { status, out } = blockOf(dir, cfg)
    expect(status).toBe(1)
    expect(out.block.map((b) => b.reason)).toEqual([LINK_REASON])
  })

  test('경로를 정확히 적은 원천의 문서를 링크로 바꿔도 막는다', () => {
    const { dir, cfg } = repo({ 'docs/other.md': POLICY })
    link(dir, 'other.md', 'docs/LICENSING.md')
    expect(blockOf(dir, cfg).out.block.map((b) => b.reason)).toEqual([LINK_REASON])
  })

  test('링크는 --accept-new 로 목록에 넣지 않는다', () => {
    const { dir, cfg, base } = repo({ 'docs/other.md': POLICY })
    link(dir, '../other.md', 'docs/legal/b.md')
    const before = fs.readFileSync(base, 'utf8')
    const r = stale(dir, cfg, ['--accept-new', 'docs/legal/b.md'])
    expect(r.status).toBe(2)
    expect(r.stderr.split('\n')[0]).toBe('오류: --accept-new docs/legal/b.md: 심볼릭 링크 문서는 목록에 더하지 않는다 — 링크를 실제 파일로 바꾼다')
    expect(fs.readFileSync(base, 'utf8')).toBe(before)
  })
})

describe('--accept-new 가 목록에 든 문서의 사유를 바꾸면 출력한다', () => {
  test('사유가 바뀐 경로는 「사유를 바꿈」 줄을 낸다', () => {
    const { dir, cfg, base } = repo({ 'docs/legal/a.md': '---\ntitle: 정책\n---\n# 정책\n' }, [['docs/legal/a.md', 'no-frontmatter']])
    expect(stale(dir, cfg).status).toBe(1)
    const r = stale(dir, cfg, ['--accept-new', 'docs/legal/a.md'])
    expect(r.status).toBe(0)
    expect(r.stderr.split('\n').filter((l) => l.startsWith('기준 목록'))).toEqual(['기준 목록의 사유를 바꿈: docs/legal/a.md (머리말 없음 → status 없음)'])
    expect(JSON.parse(fs.readFileSync(base, 'utf8')).entries).toEqual([{ path: 'docs/legal/a.md', reason: 'no-status' }])
  })

  test('새 경로는 지금처럼 「더함」 줄을 낸다(대조)', () => {
    const { dir, cfg } = repo({ 'docs/legal/a.md': POLICY })
    const r = stale(dir, cfg, ['--accept-new', 'docs/legal/a.md'])
    expect(r.stderr.split('\n').filter((l) => l.startsWith('기준 목록'))).toEqual(['기준 목록에 더함: docs/legal/a.md (머리말 없음)'])
  })
})
