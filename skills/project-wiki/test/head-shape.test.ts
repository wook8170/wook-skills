// 위키 원천의 머리말 모양. 영역을 머리말에서 읽는 원천은 모양 · 표기가 어긋나면
// 결정 문서인지 알 수 없으므로, 경고만 남기지 않고 「상태를 읽지 못한 문서」로 센다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { judgeStale } from '../src/core/stale.ts'
import { frontmatterClose } from '../src/core/util.ts'

const noGit = () => ({ code: 0, out: '' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function readPage(md: string, area: string): SourceUnit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-headshape-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs/wiki/d.md'), md)
  const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal', area } as SourceSpec & Record<string, unknown>
  return markdownAdapter.read({ repoRoot: dir, spec }).units[0]
}

const HEAD = 'category: decision\nstatus: current\nsources: [src/a.ts]\n---\n# 결정\n'
const head = (body: string) => `---\n${body}status: current\nsources: [src/a.ts]\n---\n# 결정\n`

function noStatusOf(md: string, area = 'wiki') {
  const { report } = judgeStale([readPage(md, area)], noGit)
  return { count: report.noStatusDocs, kinds: report.noStatusList.map((d) => d.kind), warnings: report.warnings }
}

describe('어긋난 모양은 headMisshapen 으로 세고 사유 종류는 misshapen', () => {
  const shapes: Array<[string, string]> = [
    ['P2-e 값 안의 들여쓴 ---', `---\ntitle: 결정\nsummary: |\n  설명 줄\n  ---\n${HEAD}`],
    ['P2-e2 목록 항목 안의 ---', `---\ntitle: 결정\naliases:\n  - a\n  ---\n${HEAD}`],
    ['P2-h 여는 줄 앞 폭 없는 글자', `​---\n${HEAD}`],
    ['P2-i 줄 끝이 CR 뿐', `---\n${HEAD}`.replace(/\n/g, '\r')],
    ['P2-j --- # 머리말', `--- # 머리말\n${HEAD}`],
    ['P2-k ----', `----\n${HEAD}`],
    ['P2-l BOM 두 개', `﻿﻿---\n${HEAD}`],
    ['P2-m 머리말 앞에 글자', `결정 문서\n\n---\n${HEAD}`],
  ]
  for (const [name, md] of shapes) {
    test(name, () => {
      expect(readPage(md, 'wiki').headMisshapen).toBe(true)
      expect(noStatusOf(md)).toMatchObject({ count: 1, kinds: ['misshapen'] })
    })
  }
})

describe('area · category · status 표기가 어긋나면 경고가 아니라 상태를 읽지 못한 문서로 센다', () => {
  const shapes: Array<[string, string]> = [
    ['P2-f Category:', head('Category: decision\n')],
    ['P2-g category: Decision', head('category: Decision\n')],
    ['P2-p area: wiki 와 category: decision', head('area: wiki\ncategory: decision\n')],
    ['P2-q 따옴표 안 공백', head('category: "decision "\n')],
    ['Status: current(열쇠 대문자)', '---\ncategory: decision\nStatus: current\n---\n# 결정\n'],
    ['status: "current "(따옴표 안 공백)', '---\ncategory: decision\nstatus: "current "\n---\n# 결정\n'],
    ['위키 원천의 status: Current', '---\ncategory: decision\nstatus: Current\n---\n# 결정\n'],
  ]
  for (const [name, md] of shapes) {
    test(name, () => {
      expect(noStatusOf(md)).toMatchObject({ count: 1, kinds: ['misshapen'] })
    })
  }
})

describe('사유 종류와 대조', () => {
  test('머리말이 없는 정책 문서는 no-frontmatter', () => {
    expect(noStatusOf('<!-- 메모 -->\n# 정책\n\n본문\n\n---\n\n아래\n', 'policy')).toMatchObject({ count: 1, kinds: ['no-frontmatter'] })
  })

  test('머리말은 있는데 status 가 없으면 no-status', () => {
    expect(noStatusOf('---\ncategory: decision\n---\n# 결정\n')).toMatchObject({ count: 1, kinds: ['no-status'] })
  })

  test('다른 영역 문서의 Status 열쇠는 세지 않는다. 제목 뒤에 둔 category 줄은 센다', () => {
    expect(noStatusOf('# 안내\n\n---\nStatus: done\ncategory: decision\n---\n본문\n')).toMatchObject({ count: 1, kinds: ['misshapen'] })
    expect(noStatusOf('---\nStatus: draft\n---\n# 안내\n', 'guide').count).toBe(0)
    expect(noStatusOf(`---\n${HEAD}`).count).toBe(0)
  })

  test('정책 원천의 status: Current 도 표기가 어긋난 문서로 센다', () => {
    expect(noStatusOf('---\nstatus: Current\n---\n# 정책\n', 'policy')).toMatchObject({ count: 1, kinds: ['misshapen'] })
  })
})

describe('머리말을 닫는 줄', () => {
  test('들여쓰지 않은 --- 만 닫는 줄로 본다', () => {
    expect(frontmatterClose(['---', 'summary: |', '  ---', 'status: current', '---', '# 제목'])).toBe(4)
    expect(frontmatterClose(['---', 'a: 1', '--- ', 'b'])).toBe(2)
    expect(frontmatterClose(['---', 'a: 1', '  ---'])).toBe(-1)
  })
})
