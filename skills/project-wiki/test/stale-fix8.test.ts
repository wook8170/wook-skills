// 머리말 표기 · 링크 문서 판정.
// 원천 루트 아래의 폴더 링크를 링크 문서로 세고 막는다.
// 머리말 안을 허용 목록으로 판정한다. 읽지 못한 줄이 있거나 영역 · 상태 값이 정한 낱말 밖이면 막는다.
// 정책 원천의 `status: Current` 도 막는다. 본문 `status:` 줄은 머리말에서 status 를 읽지 못한 문서일 때만 센다.
// 가이드 본문의 `Area:` 줄 · 4칸 들여쓴 코드 · 머리말 블록 값 안의 줄은 막지 않는다. 목록 경로의 `./` 를 정규화한다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { CLI } from './helpers.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { lockNoStatus, type ListedReason } from '../src/core/stale-baseline.ts'
import { judgeStale } from '../src/core/stale.ts'
import { commitFiles, git, gitRepo } from './helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = CLI
const noGit = () => ({ code: 0, out: '' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const DOC = 'docs/wiki/d.md'
const BODY = '# 문서\n\n본문이다.\n'
const MISSHAPEN = '머리말 모양이 어긋나 상태를 읽지 못함'
const LINK_REASON = '출하 차단 — 문서가 심볼릭 링크라 상태를 읽지 못함, 링크를 실제 파일로 바꾸세요'

function readPage(md: string, area: string): SourceUnit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fix8-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true })
  fs.writeFileSync(path.join(dir, DOC), md)
  const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal', area } as SourceSpec & Record<string, unknown>
  return markdownAdapter.read({ repoRoot: dir, spec }).units[0]
}

/** 판정한 뒤 기준 목록(`listed` 를 주면 이 문서 하나)과 견준 차단 사유. */
function blockReasons(md: string, area: string, listed?: ListedReason): string[] {
  const { report } = judgeStale([readPage(md, area)], noGit)
  lockNoStatus(report, listed ? [{ path: DOC, reason: listed }] : [])
  return report.block.map((b) => b.reason)
}

const noStatusCount = (md: string, area: string) => judgeStale([readPage(md, area)], noGit).report.noStatusDocs

/** 위키 결정 머리말. 열쇠 줄을 바꿔 끼운다. */
const wh = (cat = 'category: decision', st = 'status: current') => `${cat}\n${st}\nsources: [src/a.ts]`
const good = (h: string) => `---\n${h}\n---\n${BODY}`

describe('머리말 안은 허용 목록으로 판정한다', () => {
  const shapes: Array<[string, string]> = [
    ['값 오타 category: decisions', good(wh('category: decisions'))],
    ['값 오타 category: decision-record', good(wh('category: decision-record'))],
    ['값 오타 status: curent', good(wh(undefined, 'status: curent'))],
    ['정한 낱말 밖 status: active', good(wh(undefined, 'status: active'))],
    ['키릴 с(U+0441) 열쇠', good(wh('сategory: decision'))],
    ['키릴 а(U+0430) 열쇠', good(wh('cаtegory: decision'))],
    ['닮은 쌍점 U+A789', good(wh('category꞉ decision'))],
    ['닮은 쌍점 U+2236', good(wh('category∶ decision'))],
    ['YAML 꼴 !!str', good(wh('!!str category: decision'))],
    ['YAML 꼴 &a', good(wh('&a category: decision'))],
    ['YAML 꼴 ? key', good(wh('? category\n: decision'))],
  ]
  for (const [name, md] of shapes) {
    test(`목록 밖 위키 문서: ${name}`, () => expect(blockReasons(md, 'wiki')).toEqual([expect.stringContaining(MISSHAPEN)]))
  }

  const listed: Array<[string, string]> = [
    ['키릴 ѕ(U+0455)tatus', good(wh(undefined, 'ѕtatus: current'))],
    ['status꞉ current', good(wh(undefined, 'status꞉ current'))],
    ['!!str status: current', good(wh(undefined, '!!str status: current'))],
  ]
  for (const [name, md] of listed) {
    test(`목록에 든 위키 결정 문서(status 없음): ${name}`, () => expect(blockReasons(md, 'wiki', 'no-status')).toEqual([expect.stringContaining(MISSHAPEN)]))
  }

  test('목록에 든 정책 문서(status 없음)의 머리말에 키릴 ѕtatus', () => {
    expect(blockReasons('---\ntitle: 정책\nѕtatus: current\n---\n# 정책\n', 'policy', 'no-status')).toEqual([expect.stringContaining(MISSHAPEN)])
  })

  test('읽을 수 있는 머리말은 막지 않는다(대조): 블록 값 · 목록 · 주석 · 정한 낱말', () => {
    const md = '---\ntitle: |\n  여러 줄 제목\n  category: 예시\nsummary: >-\n  접는 값\n\n  둘째 문단\ntags:\n  - a\n  - b\n# 주석\ncategory: architecture\nstatus: draft\n---\n# 안내\n'
    expect(noStatusCount(md, 'wiki')).toBe(0)
    expect(noStatusCount(good(wh(undefined, 'status: superseded')), 'wiki')).toBe(0)
    expect(readPage(good(wh()), 'wiki')).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true })
  })
})

describe('정책 원천의 status: Current 도 막는다', () => {
  test('목록 밖 정책 문서', () => {
    expect(blockReasons('---\nstatus: Current\n---\n# 정책\n', 'policy')).toEqual([expect.stringContaining(MISSHAPEN)])
  })
})

describe('본문 status 줄은 머리말에서 status 를 읽지 못한 문서일 때만 센다', () => {
  const bodies = ['- status: 진행 중', 'Status: 승인', '- Status: DONE / 검수 대기', '> **Status: 승인 대기 (담당자)**', '## Status: fixed']
  for (const b of bodies) {
    test(`바른 머리말 결정 문서 + 본문 「${b}」는 막지 않는다`, () => expect(noStatusCount(`${good(wh())}\n${b}\n`, 'wiki')).toBe(0))
  }

  test('바른 머리말 정책 문서 + 본문 Status 줄은 막지 않는다', () => {
    expect(noStatusCount('---\ntitle: 정책\nstatus: current\n---\n# 정책\n\n- Status: 승인\n', 'policy')).toBe(0)
  })

  test('머리말 없는 목록 정책 문서의 본문 status 줄은 지금처럼 막는다', () => {
    expect(blockReasons('# 정책\n\nStatus: current\n', 'policy', 'no-frontmatter')).toEqual([expect.stringContaining(MISSHAPEN)])
  })

  test('제목 뒤 머리말(status 만 적음)은 지금처럼 막는다', () => {
    expect(blockReasons('# 정책\n\n---\ntitle: 정책\nstatus: current\n---\n\n본문.\n', 'policy', 'no-frontmatter')).toEqual([expect.stringContaining(MISSHAPEN)])
  })
})

describe('정상 문서를 막지 않는다', () => {
  const ok: Array<[string, string, string]> = [
    ['가이드 머리말 + 4칸 들여쓴 코드 블록의 category', '---\ncategory: guide\n---\n# 안내\n\n예시:\n\n    category: decision\n', 'wiki'],
    ['머리말 없는 가이드 + 4칸 들여쓴 코드 블록의 category', '# 안내\n\n예시:\n\n    category: decision\n    status: current\n', 'guide'],
    ['가이드 본문 Area: 서울 전역', '# 안내\n\nArea: 서울 전역\n', 'guide'],
    ['가이드 본문 표 | category: | 분류 |', '# 안내\n\n| 칸 | 뜻 |\n|---|---|\n| category: | 분류 |\n', 'guide'],
    ['가이드 본문 - Category: 대시보드', '# 안내\n\n- Category: 대시보드\n', 'guide'],
    ['가이드 본문 > **Area**: 화면 영역', '# 안내\n\n> **Area**: 화면 영역\n', 'guide'],
    ['머리말 title: | 값 안의 category: 줄', '---\ntitle: |\n  category: 예시\n---\n# 안내\n', 'guide'],
  ]
  for (const [name, md, area] of ok) test(name, () => expect(noStatusCount(md, area)).toBe(0))

  test('제목 뒤 머리말의 값 오타는 계속 막는다', () => {
    expect(blockReasons('# 결정\n\n---\ncategory: decisions\nstatus: current\n---\n\n본문.\n', 'wiki')).toEqual([expect.stringContaining(MISSHAPEN)])
  })

  test('목록 항목 아래 4칸 들여쓴 status 줄은 코드가 아니라서 계속 막는다', () => {
    expect(blockReasons('# 정책\n\n- 상태\n    status: current\n', 'policy', 'no-frontmatter')).toEqual([expect.stringContaining(MISSHAPEN)])
  })
})

// ── 폴더 링크 ───────────────────────────────────────────────────

const HEAD = 'category: decision\nstatus: current\nsources: [src/a.ts]\n---\n# 결정\n\n본문이다.\n'

function repo(files: Record<string, string>): { dir: string; cfg: string } {
  const { dir } = gitRepo({ 'src/a.ts': 'export const a = 1\n', ...files })
  dirs.push(dir)
  const cfg = path.join(dir, 'wiki.json')
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
  fs.writeFileSync(path.join(dir, 'no-status-baseline.json'), JSON.stringify({ schema: 2, entries: [] }))
  return { dir, cfg }
}

function link(dir: string, target: string, at: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true })
  fs.symlinkSync(target, path.join(dir, at))
}

function staleOf(dir: string, cfg: string) {
  const r = spawnSync(process.execPath, [BIN, 'stale', '--config', cfg, '--root', dir, '--json', '--require-baseline'], { cwd: dir, encoding: 'utf8' })
  return { status: r.status, out: JSON.parse(r.stdout) as { block: Array<{ id: string; reason: string }>; noStatusDocs: number } }
}

describe('원천 루트 아래의 폴더 링크는 링크 문서로 세고 막는다', () => {
  test('하위 폴더 링크 안의 결정 문서', () => {
    const { dir, cfg } = repo({ 'other/dec/x.md': `---\n${HEAD}` })
    link(dir, '../../other/dec', 'docs/wiki/dec')
    const { status, out } = staleOf(dir, cfg)
    expect(status).toBe(1)
    expect(out.block).toEqual([{ id: 'docs/wiki/dec', title: 'docs/wiki/dec', reason: LINK_REASON }])
  })

  test('하위 폴더의 하위 폴더 링크', () => {
    const { dir, cfg } = repo({ 'docs/wiki/a/ok.md': '# 안내\n', 'other/dec/x.md': `---\n${HEAD}` })
    link(dir, '../../../other/dec', 'docs/wiki/a/b')
    expect(staleOf(dir, cfg).out.block.map((b) => [b.id, b.reason])).toEqual([['docs/wiki/a/b', LINK_REASON]])
  })

  test('글롭이 하위 폴더를 보지 않는 원천의 폴더 링크는 세지 않는다(대조)', () => {
    const { dir, cfg } = repo({ 'other/dec/x.md': `---\n${HEAD}` })
    link(dir, '../../other/dec', 'docs/legal/sub')
    expect(staleOf(dir, cfg)).toMatchObject({ status: 0, out: { block: [], noStatusDocs: 0 } })
  })

  test('원천 루트 자체가 폴더 링크면 지금처럼 따라 읽는다(대조)', () => {
    const { dir, cfg } = repo({ 'wikisrc/ok.md': '# 안내\n' })
    link(dir, '../wikisrc', 'docs/wiki')
    expect(staleOf(dir, cfg)).toMatchObject({ status: 0, out: { block: [], noStatusDocs: 0 } })
  })
})

// ── 목록 경로의 앞붙이 ─────────────────────────────────────────────
