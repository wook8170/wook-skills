// 머리말 경계: 닫히지 않은 머리말, 코드 블록 안의 `---`, BOM 으로 시작하는 문서.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from './support/vitest-shim.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import { MarkSyncedError, setFrontmatterField } from '../src/core/mark-synced.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { BLOCK_REASON, judgeStale } from '../src/core/stale.ts'
import { parseFrontmatter } from '../src/core/util.ts'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const F = '```'
const BOM = '﻿'

/** 두 번 쓴다. 두 번째 실행에서 줄이 늘지 않아야 한다. */
function twice(md: string, write: (md: string, sha: string) => string): { one: string; two: string } {
  const one = write(md, SHA)
  return { one, two: write(one, SHA2) }
}
const lineCount = (s: string) => s.split('\n').length
const field = (md: string, sha: string) => setFrontmatterField(md, 'base_commit', sha)

describe('위키 페이지 머리말 쓰기', () => {
  test('F1: 닫히지 않은 머리말은 새 머리말을 앞에 붙이지 않고 오류로 알린다', () => {
    expect(() => field('---\ntitle: 열림\nsources:\n  - src/a.ts\n\n# 제목\n', SHA)).toThrow(MarkSyncedError)
  })

  test('닫히지 않은 머리말 뒤 코드 블록 안의 --- 를 닫는 줄로 보지 않는다', () => {
    expect(() => field(`---\ntitle: 열림\n\n# 제목\n\n${F}\n---\n${F}\n`, SHA)).toThrow(MarkSyncedError)
  })

  test('F2: BOM 으로 시작하는 문서는 BOM 을 지키고 있는 머리말에 칸을 더한다', () => {
    const { one, two } = twice(`${BOM}---\ntitle: 봄\n---\n# 제목\n`, field)
    expect(one).toBe(`${BOM}---\ntitle: 봄\nbase_commit: "${SHA}"\n---\n# 제목\n`)
    expect(two).toBe(`${BOM}---\ntitle: 봄\nbase_commit: "${SHA2}"\n---\n# 제목\n`)
  })

  test('BOM 과 CRLF 를 함께 쓴 문서도 둘 다 지킨다', () => {
    expect(field(`${BOM}---\r\ntitle: 봄\r\n---\r\n# 제목\r\n`, SHA)).toBe(`${BOM}---\r\ntitle: 봄\r\nbase_commit: "${SHA}"\r\n---\r\n# 제목\r\n`)
  })

  test('F3: 정상 머리말의 값은 바꾸기만 한다', () => {
    const { one, two } = twice('---\ntitle: t\nbase_commit: old\n---\n# 제목\n', field)
    expect(one).toBe(`---\ntitle: t\nbase_commit: "${SHA}"\n---\n# 제목\n`)
    expect(lineCount(two)).toBe(lineCount(one))
  })

  test('F4: 들여쓴 base_commit 은 다른 칸으로 보고, 맨 앞 칸을 한 번만 더한다', () => {
    const { one, two } = twice('---\ntitle: t\n  base_commit: old\n---\n# 제목\n', field)
    expect(one).toBe(`---\ntitle: t\n  base_commit: old\nbase_commit: "${SHA}"\n---\n# 제목\n`)
    expect(lineCount(two)).toBe(lineCount(one))
  })
})

describe('BOM 으로 시작하는 위키 페이지 읽기', () => {
  const page = `${BOM}---\ntitle: 결정\narea: decision\nstatus: current\n---\n# 결정\n\n본문이다.\n`

  test('parseFrontmatter 는 BOM 을 떼고 머리말을 읽는다', () => {
    expect(parseFrontmatter(page).data).toMatchObject({ area: 'decision', status: 'current' })
  })

  test('parseFrontmatter 는 코드 블록 안의 --- 를 닫는 줄로 보지 않는다', () => {
    expect(parseFrontmatter(`---\ntitle: 열림\n\n${F}\nx: 1\n---\n${F}\n`).data).toEqual({})
  })

  test('BOM 으로 시작하는 결정 페이지도 출하 차단 대상이 된다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-bom-test-'))
    try {
      fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'docs/wiki/d.md'), page)
      const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal' } as SourceSpec & Record<string, unknown>
      const [u] = markdownAdapter.read({ repoRoot: dir, spec }).units
      expect(u).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true, title: '결정' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('머리말 안의 코드 블록 표시 줄과 닫히지 않은 머리말', () => {
  const head = (mark: string) => ['---', 'title: 결정', 'area: decision', 'status: current', 'summary: |', '  예시 줄', `  ${mark}`, 'sources: [src/a.ts]', '---', '# 결정', '', '본문이다.', ''].join('\n')

  /** 임시 폴더에 위키 페이지 하나를 두고 일반 Markdown 어댑터로 읽는다. 폴더는 읽은 뒤 지운다. */
  function readPage(md: string, area?: string): SourceUnit {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-head-test-'))
    try {
      fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'docs/wiki/d.md'), md)
      const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal', ...(area ? { area } : {}) } as SourceSpec & Record<string, unknown>
      return markdownAdapter.read({ repoRoot: dir, spec }).units[0]
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('H1: 여러 줄 값 안의 들여쓴 ``` 한 줄을 코드 블록 표시로 보지 않고 머리말을 읽는다', () => {
    expect(parseFrontmatter(head(F)).data).toMatchObject({ area: 'decision', status: 'current' })
    expect(readPage(head(F))).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true })
  })

  test('H1c: 들여쓴 ~~~ 한 줄도 머리말을 닫는 --- 를 가리지 않는다', () => {
    expect(readPage(head('~~~'))).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true })
  })

  test('H2: 첫 줄이 --- 인데 닫는 줄이 없는 문서는 머리말 없는 문서로 넘기지 않고 출하를 막는다', () => {
    const u = readPage('---\ntitle: 결정\narea: decision\nstatus: current\n\n# 결정\n')
    expect(u.headUnclosed).toBe(true)
    const { report } = judgeStale([u], () => ({ code: 0, out: '' }))
    expect(report.block).toEqual([{ id: u.page, title: u.title, reason: BLOCK_REASON.headUnclosed }])
  })

  test('G: 결정 · 정책 출처의 문서인데 status 를 읽지 못하면 수를 세고 경고한다(여는 줄 끝 공백 · 앞 빈 줄)', () => {
    const units = [readPage('--- \ntitle: 결정\nstatus: current\n---\n# 결정\n', 'decision'), readPage('\n---\nstatus: current\n---\n# 정책\n', 'policy')]
    const { report } = judgeStale(units, () => ({ code: 0, out: '' }))
    expect(report.block).toEqual([])
    expect(report.noStatusDocs).toBe(2)
    expect(report.warnings.filter((w) => w.includes('status 를 읽지 못함'))).toHaveLength(2)
  })

  test('G: status 를 적은 결정 문서와 결정 · 정책이 아닌 문서는 세지 않는다', () => {
    const units = [readPage('---\nstatus: superseded\n---\n# 옛 결정\n', 'decision'), readPage('# 안내\n', 'guide')]
    expect(judgeStale(units, () => ({ code: 0, out: '' })).report.noStatusDocs).toBe(0)
  })
})
