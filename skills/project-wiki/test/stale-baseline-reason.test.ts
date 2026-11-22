// 기준 목록에 사유 종류를 적는다.
// 목록에 든 경로라도 지금 사유가 목록의 사유와 다르거나 머리말 모양이 어긋났으면 막는다.
// `--update-baseline` 은 빠진 경로만 지우고, 새 경로는 `--accept-new` 로만 더한다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { CLI } from './helpers.ts'
import { commitFiles, git, gitRepo } from './helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = CLI
const MISSHAPEN_HINT = '머리말 모양(첫 줄 `---`)을 확인하세요'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Entry = { path: string; reason: string }
type Baseline = Entry[] | string | undefined

const NOHEAD = '# 정책\n\n머리말이 없는 정책 문서다.\n'
const policy = (c: string, extra = '') => `---\n${extra}status: current\nsources: [src/a.ts]\nbase_commit: ${c}\n---\n# 정책\n`

/** 정책 원천(docs/legal)과 위키 원천(docs/wiki)을 가진 저장소. 기준 목록은 배열이면 새 형식으로, 문자열이면 그대로 쓴다. */
function repo(files: Record<string, string>, baseline: Baseline, cfgExtra: Record<string, unknown> = {}) {
  const { dir, first } = gitRepo({ 'src/a.ts': 'export const a = 1\n', ...files })
  dirs.push(dir)
  const cfg = path.join(dir, 'wiki.json')
  const base = path.join(dir, 'no-status-baseline.json')
  const config = {
    schema: 1,
    bundle: { name: 't', title: 't' },
    pack: 'core',
    noStatusBaseline: 'no-status-baseline.json',
    sources: [
      { adapter: 'markdown', root: 'docs', include: ['docs/legal/*.md'], level: 'internal', area: 'policy', idNamespace: 'doc' },
      { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], level: 'internal', area: 'wiki' },
    ],
    ...cfgExtra,
  }
  fs.writeFileSync(cfg, JSON.stringify(config))
  if (Array.isArray(baseline)) fs.writeFileSync(base, JSON.stringify({ schema: 2, entries: baseline }))
  else if (typeof baseline === 'string') fs.writeFileSync(base, baseline)
  return { dir, cfg, base, first }
}

const stale = (cfg: string, root: string, extra: string[] = []) => spawnSync(process.execPath, [BIN, 'stale', '--config', cfg, '--root', root, '--json', ...extra], { cwd: root, encoding: 'utf8' })
const reasons = (stdout: string) => (JSON.parse(stdout) as { block: Array<{ reason: string }> }).block.map((b) => b.reason)
const entries = (base: string) => (JSON.parse(fs.readFileSync(base, 'utf8')) as { entries: Entry[] }).entries

const LISTED_P: Entry[] = [{ path: 'docs/legal/p.md', reason: 'no-frontmatter' }]

/** 목록에 든 머리말 없는 정책 문서를 `shape` 로 덮어쓰고 근거를 바꾼다. */
function overwriteListed(shape: (c: string) => string) {
  const r = repo({ 'docs/legal/p.md': NOHEAD }, LISTED_P)
  commitFiles(r.dir, { 'docs/legal/p.md': shape(r.first) }, 'overwrite')
  commitFiles(r.dir, { 'src/a.ts': 'export const a = 2\n' }, 'mod')
  return r
}

describe('목록에 든 경로를 덮어쓰면', () => {
  test('사유가 같으면 통과한다(대조)', () => {
    const r = repo({ 'docs/legal/p.md': NOHEAD }, LISTED_P)
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({ block: [], noStatusDocs: 1, noStatusGone: 0 })
  })

  const misshapen: Array<[string, (c: string) => string]> = [
    ['HTML 주석 뒤에 붙인 머리말', (c) => `<!-- 메모 -->\n${policy(c)}`],
    ['값 안의 들여쓴 ---', (c) => policy(c, 'title: P\nsummary: |\n  줄\n  ---\n')],
    ['첫 줄 앞 빈 줄', (c) => `\n${policy(c)}`],
    ['여는 줄 끝 공백', (c) => policy(c).replace(/^---\n/, '--- \n')],
  ]
  for (const [name, shape] of misshapen) {
    test(`${name}: 목록에 있어도 머리말 모양 사유로 막는다`, () => {
      const r = overwriteListed(shape)
      const out = stale(r.cfg, r.dir)
      expect(out.status).toBe(1)
      const [reason] = reasons(out.stdout)
      expect(reason).toContain(MISSHAPEN_HINT)
    })
  }

  test('바른 머리말을 붙였는데 status 가 없으면 사유가 달라 막는다', () => {
    const r = overwriteListed(() => '---\ntitle: P\n---\n# 정책\n')
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)).toEqual(['출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록의 사유 「머리말 없음」과 지금 사유 「status 없음」이 다름)'])
  })

  test('바른 머리말에 status: current 면 근거 변경으로 막는다(대조)', () => {
    const r = overwriteListed((c) => policy(c))
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)).toEqual(['출하 차단 — 근거 파일 1개 바뀜'])
    expect(JSON.parse(out.stdout).noStatusGone).toBe(1)
  })

  test('status 가 없던 위키 결정 문서(목록 사유 status 없음)에 어긋난 머리말로 status: current 를 붙이면 막는다', () => {
    const wiki = (c: string) => `---\ncategory: decision\nsources: [src/a.ts]\nbase_commit: ${c}\n---\n# 결정\n`
    const r = repo({ 'docs/wiki/d.md': '---\ncategory: decision\n---\n# 결정\n' }, [{ path: 'docs/wiki/d.md', reason: 'no-status' }])
    commitFiles(r.dir, { 'docs/wiki/d.md': wiki(r.first).replace(/^---\n/, '--- \n').replace('category: decision\n', 'category: decision\nstatus: current\n') })
    commitFiles(r.dir, { 'src/a.ts': 'export const a = 2\n' })
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)[0]).toContain(MISSHAPEN_HINT)
  })

  test('목록 철자가 다르면(앞에 ./) 새 문서로 막고 빠진 문서로 센다', () => {
    const r = repo({ 'docs/legal/p.md': NOHEAD }, [{ path: './docs/legal/p.md', reason: 'no-frontmatter' }])
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)).toEqual(['출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록에 없음)'])
    expect(JSON.parse(out.stdout).noStatusGone).toBe(1)
  })

  test('가로줄로 시작하는 보통 위키 문서는 머리말 모양을 확인하라는 사유로 막는다', () => {
    const r = repo({ 'docs/wiki/guide.md': '\n---\n\n# 안내\n\n보통 문서다.\n' }, [])
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)).toEqual([`출하 차단 — 머리말 모양이 어긋나 상태를 읽지 못함, ${MISSHAPEN_HINT}`])
  })
})

describe('--update-baseline 과 --accept-new', () => {
  test('--update-baseline 은 빠진 경로만 지우고 새 경로는 더하지 않는다', () => {
    const r = repo({ 'docs/legal/a.md': NOHEAD, 'docs/legal/z.md': NOHEAD }, [
      { path: 'docs/legal/a.md', reason: 'no-frontmatter' },
      { path: 'docs/legal/gone.md', reason: 'no-frontmatter' },
    ])
    const out = stale(r.cfg, r.dir, ['--update-baseline'])
    expect(out.status).toBe(1)
    expect(entries(r.base)).toEqual([{ path: 'docs/legal/a.md', reason: 'no-frontmatter' }])
    expect(out.stderr).toContain('기준 목록에서 지움: docs/legal/gone.md')
    expect(reasons(out.stdout)).toEqual(['출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록에 없음)'])
  })

  test('--accept-new 는 여러 번 줄 수 있고, 더한 경로와 사유를 출력한다', () => {
    const r = repo({ 'docs/legal/a.md': NOHEAD, 'docs/legal/y.md': NOHEAD, 'docs/wiki/d.md': '---\ncategory: decision\n---\n# 결정\n' }, [{ path: 'docs/legal/a.md', reason: 'no-frontmatter' }])
    const out = stale(r.cfg, r.dir, ['--accept-new', 'docs/legal/y.md', '--accept-new', 'docs/wiki/d.md'])
    expect(out.status).toBe(0)
    expect(entries(r.base)).toEqual([
      { path: 'docs/legal/a.md', reason: 'no-frontmatter' },
      { path: 'docs/legal/y.md', reason: 'no-frontmatter' },
      { path: 'docs/wiki/d.md', reason: 'no-status' },
    ])
    expect(out.stderr).toContain('기준 목록에 더함: docs/legal/y.md (머리말 없음)')
    expect(out.stderr).toContain('기준 목록에 더함: docs/wiki/d.md (status 없음)')
  })

  test('머리말 모양이 어긋난 문서는 --accept-new 로도 더하지 않는다(종료 2, 목록 그대로)', () => {
    const r = repo({ 'docs/legal/h.md': '\n---\nstatus: current\n---\n# 정책\n' }, [])
    const before = fs.readFileSync(r.base, 'utf8')
    const out = stale(r.cfg, r.dir, ['--accept-new', 'docs/legal/h.md'])
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('머리말 모양이 어긋난 문서는 목록에 더하지 않는다')
    expect(fs.readFileSync(r.base, 'utf8')).toBe(before)
  })

  test('상태를 읽지 못한 문서가 아니면 --accept-new 는 종료 2', () => {
    const r = repo({ 'docs/legal/ok.md': '---\nstatus: draft\n---\n# 정책\n' }, [])
    const out = stale(r.cfg, r.dir, ['--accept-new', 'docs/legal/ok.md'])
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('상태를 읽지 못한 결정 · 정책 문서가 아니다')
  })
})

describe('한글 경로는 NFC 로 맞춘다', () => {
  const NFC = 'docs/legal/정책.md'
  test('목록에 NFD 로 적혀 있어도 같은 문서로 본다', () => {
    const r = repo({ [NFC]: NOHEAD }, [{ path: NFC.normalize('NFD'), reason: 'no-frontmatter' }])
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(0)
    expect(JSON.parse(out.stdout).noStatusGone).toBe(0)
  })

  test('--accept-new 는 NFC 로 적는다', () => {
    const r = repo({ [NFC]: NOHEAD }, [])
    expect(stale(r.cfg, r.dir, ['--accept-new', NFC.normalize('NFD')]).status).toBe(0)
    expect(entries(r.base).map((e) => e.path)).toEqual([NFC])
  })
})

describe('목록 파일 · 설정 칸의 꼴', () => {
  const cases: Array<[string, string, string]> = [
    ['옛 형식(경로만)', JSON.stringify({ paths: ['docs/legal/p.md'] }), '옛 형식'],
    ['내용이 null', 'null', '기준 목록 파일'],
    ['깨진 JSON', '{ "entries": [', '기준 목록 파일'],
    ['entries 가 목록이 아님', JSON.stringify({ schema: 2, entries: 'docs/legal/p.md' }), '기준 목록 파일'],
    ['사유 종류가 틀림', JSON.stringify({ schema: 2, entries: [{ path: 'docs/legal/p.md', reason: 'misshapen' }] }), '기준 목록 파일'],
  ]
  for (const [name, body, msg] of cases) {
    test(`${name}: 종료 2, 다듬은 오류 문구`, () => {
      const r = repo({ 'docs/legal/p.md': NOHEAD }, body)
      const out = stale(r.cfg, r.dir)
      expect(out.status).toBe(2)
      expect(out.stderr.split('\n')[0]).toContain(msg)
      expect(out.stderr).not.toMatch(/TypeError|SyntaxError|Unexpected token/)
    })
  }

  const badValues: Array<[string, unknown]> = [
    ['빈 문자열', ''],
    ['null', null],
    ['false', false],
    ['숫자', 123],
  ]
  for (const [name, v] of badValues) {
    test(`설정 칸 값이 ${name}이면 종료 2`, () => {
      const r = repo({ 'docs/legal/p.md': NOHEAD }, LISTED_P, { noStatusBaseline: v })
      const out = stale(r.cfg, r.dir)
      expect(out.status).toBe(2)
      expect(out.stderr.split('\n')[0]).toContain('noStatusBaseline')
    })
  }

  test('--require-baseline 인데 설정 칸이 없거나 이름이 틀리면 종료 2', () => {
    for (const extra of [{ noStatusBaseline: undefined }, { noStatusBaseline: undefined, nostatusBaseline: 'no-status-baseline.json' }]) {
      const r = repo({ 'docs/legal/p.md': NOHEAD }, LISTED_P, extra)
      const out = stale(r.cfg, r.dir, ['--require-baseline'])
      expect(out.status).toBe(2)
      expect(out.stderr.split('\n')[0]).toContain('noStatusBaseline')
    }
  })

  test('--require-baseline 이 없으면 설정 칸이 없어도 판정만 한다(묶음 만들기 등, 대조)', () => {
    const r = repo({ 'docs/legal/p.md': NOHEAD }, undefined, { noStatusBaseline: undefined })
    const out = stale(r.cfg, r.dir)
    expect(out.status).toBe(0)
    expect(JSON.parse(out.stdout).noStatusGone).toBeUndefined()
  })
})

describe('얕은 복제', () => {
  test('기준 커밋이 복제본에 있어도 전체 이력으로 받으라고 막는다', () => {
    const r = repo({ 'docs/legal/p.md': NOHEAD }, LISTED_P)
    // 기준 커밋(첫 커밋)은 깊이 2 복제본에 들어 있다. 근거 src/a.ts 는 그 뒤 바뀌지 않았다.
    commitFiles(r.dir, { 'docs/legal/q.md': policy(r.first) })
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-shallow-'))
    dirs.push(clone)
    git(clone, ['clone', '-q', '--depth', '2', `file://${r.dir}`, 'c'])
    expect(git(path.join(clone, 'c'), ['cat-file', '-t', r.first])).toBe('commit')
    const out = stale(r.cfg, path.join(clone, 'c'))
    expect(out.status).toBe(1)
    expect(reasons(out.stdout)).toEqual(['출하 차단 — 얕은 복제라 기준 커밋을 찾지 못함, 전체 이력으로 받으세요'])
  })
})
