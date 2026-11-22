// 머리말로 읽히지 않은 열쇠 줄. 어긋난 모양을 하나씩 나열하지 않고,
// 머리말로 읽히지 않은 글에 area · category · status 열쇠처럼 보이는 줄이 있으면 「머리말 모양이 어긋난 문서」로 막는다.
// 목록에 든 문서와 영역을 머리말에서 읽는 원천을 함께 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { lockNoStatus, type ListedReason } from '../src/core/stale-baseline.ts'
import { judgeStale } from '../src/core/stale.ts'

const noGit = () => ({ code: 0, out: '' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const DOC = 'docs/wiki/d.md'
const BODY = '# 문서\n\n본문이다.\n'
const MISSHAPEN = '머리말 모양이 어긋나 상태를 읽지 못함'

function readPage(md: string, area: string): SourceUnit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-unread-'))
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

/** 정책 원천 머리말(영역은 설정에서 받는다). */
const ph = (st = 'status: current') => `title: 정책\n${st}\nsources: [src/a.ts]`
/** 위키 결정 머리말. */
const wh = (o: { cat?: string; st?: string } = {}) => `${o.cat ?? 'category: decision'}\n${o.st ?? 'status: current'}\nsources: [src/a.ts]`
const good = (h: string) => `---\n${h}\n---\n${BODY}`

type Case = [name: string, md: string]

const POLICY_OPEN: Array<[string, string]> = [
  ['U+2014', '—'], ['U+2014 -', '—-'], ['U+2212 세 개', '−−−'], ['U+2013 세 개', '–––'],
  ['U+2010 세 개', '‐‐‐'], ['U+2011 세 개', '‑‑‑'], ['U+FF0D 세 개', '－－－'],
  ['U+3164 ---', 'ㅤ---'], ['U+115F ---', 'ᅟ---'], ['U+034F ---', '͏---'], ['U+FE0F ---', '️---'], ['U+2800 ---', '⠀---'],
  ['~~~', '~~~'], ['+++', '+++'], ['___', '___'], ['***', '***'], ['--', '--'],
]

/** 목록에 든 정책 문서(사유 「머리말 없음」)에 머리말을 어긋나게 붙인 25가지. */
const POLICY_SHAPES: Case[] = [
  ...POLICY_OPEN.map(([k, o]): Case => [`여는 줄 ${k}`, `${o}\n${ph()}\n---\n${BODY}`]),
  ['제목 뒤 머리말', `# 정책\n\n---\n${ph()}\n---\n\n본문이다.\n`],
  ['글자 뒤 --- 다음 빈 줄', `정책 문서\n---\n\n${ph()}\n---\n${BODY}`],
  ['글자 뒤 sources 목록이 status 앞', `정책 문서\n---\ntitle: 정책\nsources:\n  - src/a.ts\nstatus: current\n---\n${BODY}`],
  ['글자 뒤 --- 다음 줄이 # 주석', `정책 문서\n---\n# 머리말\n${ph()}\n---\n${BODY}`],
  ['글자 뒤 들여쓴 ---', `정책 문서\n ---\n${ph()}\n ---\n${BODY}`],
  ['글자 뒤 --- 와 U+200B', `정책 문서\n---​\n${ph()}\n---\n${BODY}`],
  ['글자 뒤 ----', `정책 문서\n----\n${ph()}\n----\n${BODY}`],
  ['SPDX 주석과 글자 뒤 머리말', `<!-- SPDX --> 정책\n---\n\n${ph()}\n---\n${BODY}`],
]

/** 목록에 든 위키 결정 문서(사유 「status 없음」)에 status 를 읽히지 않게 적은 12가지. */
const WIKI_STATUS_SHAPES: Case[] = [
  ['status: [current]', 'status: [current]'], ['값을 다음 줄에', 'status:\n  current'], ['값을 다음 줄 목록으로', 'status:\n  - current'],
  ['공백으로 들여씀', ' status: current'], ['탭으로 들여씀', '\tstatus: current'], ['큰따옴표 열쇠', '"status": current'],
  ["작은따옴표 열쇠", "'status': current"], ['전각 쌍점', 'status：current'], ['전각 글자', 'ｓtatus: current'],
  ['열쇠 앞 U+200B', '​status: current'], ['열쇠 뒤 U+200B', 'status​: current'], ['status = current', 'status = current'],
].map(([k, st]): Case => [k, good(wh({ st }))])

/** 경고 없이 통과하던 값 6가지와 알림만 내던 중복 열쇠 3가지. [이름, 문서, 영역, 목록 사유]. */
const VALUE_SHAPES: Array<[string, string, string, ListedReason | undefined]> = [
  ['정책 값 뒤 U+200B', good(ph('status: current​')), 'policy', 'no-frontmatter'],
  ['정책 둥근 따옴표', good(ph('status: “current”')), 'policy', 'no-frontmatter'],
  ['위키 값 뒤 U+200B', good(wh({ st: 'status: current​' })), 'wiki', 'no-status'],
  ['위키 둥근 따옴표', good(wh({ st: 'status: “current”' })), 'wiki', 'no-status'],
  ['위키 짝이 안 맞는 따옴표', good(wh({ st: "status: 'current" })), 'wiki', 'no-status'],
  ['위키 >- 접기', good(wh({ st: 'status: >-\n  current' })), 'wiki', 'no-status'],
  ['목록에 든 위키 문서의 status 두 번', good(wh({ st: 'status: current\nstatus: draft' })), 'wiki', 'no-status'],
  ['목록에 없는 위키 문서의 status 두 번', good(wh({ st: 'status: current\nstatus: draft' })), 'wiki', undefined],
  ['닫는 줄 --- + NBSP 뒤 본문의 status', `---\n${wh()}\n--- \n${BODY}\nstatus: draft\n\n---\n\n끝.\n`, 'wiki', undefined],
]

/** 목록에 없는 위키 원천 문서(영역을 머리말에서 읽는다) 27가지와 가이드 원천 2가지. */
const AREA_SHAPES: Array<[string, string, string]> = [
  ...([
    ['머리말 두 덩어리(빈 덩어리)', `---\n---\n${wh()}\n---\n${BODY}`],
    ['머리말 두 덩어리(title 뒤 빈 줄)', `---\ntitle: 결정\n---\n\n---\n${wh()}\n---\n${BODY}`],
    ['머리말 두 덩어리(빈 줄 없음)', `---\ntitle: 결정\n---\n---\n${wh()}\n---\n${BODY}`],
    ['머리말 전체를 들여씀', `---\n${wh().split('\n').map((l) => `  ${l}`).join('\n')}\n---\n${BODY}`],
    ['category 줄을 공백으로 들여씀', good(wh({ cat: ' category: decision' }))],
    ['category 줄을 탭으로 들여씀', good(wh({ cat: '\tcategory: decision' }))],
    ['category: [decision]', good(wh({ cat: 'category: [decision]' }))],
    ['category 다음 줄 목록', good(wh({ cat: 'category:\n  - decision' }))],
    ['category 둥근 따옴표', good(wh({ cat: 'category: “decision”' }))],
    ['category 전각 값', good(wh({ cat: 'category: ｄecision' }))],
    ['category &a decision', good(wh({ cat: 'category: &a decision' }))],
    ['category > 접기', good(wh({ cat: 'category: >\n  decision' }))],
    ['category 값 뒤 U+200B', good(wh({ cat: 'category: decision​' }))],
    ['category 열쇠 앞 U+200B', good(wh({ cat: '​category: decision' }))],
    ['category 큰따옴표 열쇠', good(wh({ cat: '"category": decision' }))],
    ['category 전각 쌍점', good(wh({ cat: 'category：decision' }))],
    ['category 짝이 안 맞는 따옴표', good(wh({ cat: 'category: "decision' }))],
    ['category 를 두 번(뒤가 wiki)', good(`${wh()}\ncategory: wiki`)],
    ['area 를 두 번(뒤가 wiki)', good(`${wh({ cat: 'area: decision' })}\narea: wiki`)],
    ['status 값 뒤 U+200B', good(wh({ st: 'status: current​' }))],
    ['status 둥근 따옴표', good(wh({ st: 'status: “current”' }))],
    ['status 짝이 안 맞는 따옴표', good(wh({ st: "status: 'current" }))],
    ['status >- 접기', good(wh({ st: 'status: >-\n  current' }))],
    ['여는 줄 앞 U+3164', `ㅤ---\n${wh()}\n---\n${BODY}`],
    ['여는 줄 U+2014', `—\n${wh()}\n—\n${BODY}`],
    ['제목 뒤 머리말', `# 결정\n\n---\n${wh()}\n---\n\n본문이다.\n`],
    ['글자 뒤 --- 다음 빈 줄', `결정 문서\n---\n\n${wh()}\n---\n${BODY}`],
  ] as Array<[string, string]>).map(([k, md]): [string, string, string] => [k, md, 'wiki']),
  ['가이드 원천의 category 들여씀', good(wh({ cat: ' category: decision' })), 'guide'],
  ['가이드 원천의 머리말 두 덩어리', `---\ntitle: 결정\n---\n\n---\n${wh()}\n---\n${BODY}`, 'guide'],
]

describe('목록에 든 정책 문서: 머리말로 읽히지 않은 status 줄이 있으면 막는다', () => {
  test('표의 모양 수', () => expect(POLICY_SHAPES).toHaveLength(25))
  for (const [name, md] of POLICY_SHAPES) {
    test(name, () => expect(blockReasons(md, 'policy', 'no-frontmatter')).toEqual([expect.stringContaining(MISSHAPEN)]))
  }
})

describe('목록에 든 위키 결정 문서: 읽히지 않은 status 열쇠가 있으면 막는다', () => {
  test('표의 모양 수', () => expect(WIKI_STATUS_SHAPES).toHaveLength(12))
  for (const [name, md] of WIKI_STATUS_SHAPES) {
    test(name, () => expect(blockReasons(md, 'wiki', 'no-status')).toEqual([expect.stringContaining(MISSHAPEN)]))
  }
})

describe('간단한 값으로 읽히지 않는 값 · 중복 열쇠도 막는다', () => {
  for (const [name, md, area, listed] of VALUE_SHAPES) {
    test(name, () => expect(blockReasons(md, area, listed)).toEqual([expect.stringContaining(MISSHAPEN)]))
  }
})

describe('영역을 머리말에서 읽는 원천: 읽히지 않은 area · category 줄이 있으면 막는다', () => {
  test('표의 모양 수', () => expect(AREA_SHAPES).toHaveLength(29))
  for (const [name, md, area] of AREA_SHAPES) {
    test(name, () => expect(blockReasons(md, area)).toEqual([expect.stringContaining(MISSHAPEN)]))
  }
})

describe('정상 문서는 막지 않는다(대조)', () => {
  const count = (md: string, area = 'wiki') => judgeStale([readPage(md, area)], noGit).report.noStatusDocs

  test('바른 머리말 · 값 뒤 주석 · 따옴표 값', () => {
    expect(readPage(good(wh()), 'wiki')).toMatchObject({ area: 'decision', status: 'current', blockOnStale: true })
    expect(count(good(wh({ cat: 'category: decision # 결정 문서' })))).toBe(0)
    expect(count(good(wh({ st: 'status: "current"' })))).toBe(0)
  })

  test('머리말이 없는 보통 문서와 본문의 가로줄', () => {
    expect(count('# 안내\n\n본문.\n')).toBe(0)
    expect(count('# 안내\n\n---\n\n아래.\n')).toBe(0)
  })

  test('코드 울타리 안의 머리말 예시는 세지 않는다', () => {
    expect(count('# 안내\n\n```yaml\n---\ncategory: decision\nstatus: current\n---\n```\n')).toBe(0)
    expect(count('# 안내\n\n~~~\narea: decision\n~~~\n')).toBe(0)
    expect(count('# 안내\n\n````md\n```\nstatus: current\n```\ncategory: decision\n````\n')).toBe(0)
  })

  test('글 속 인라인 코드로 적은 열쇠 예시는 세지 않는다', () => {
    expect(count('# 안내\n\n- `category: decision` 과 `status: current` 를 적는다.\n')).toBe(0)
  })

  test('영역이 결정 · 정책이 아닌 문서의 본문 Status 줄은 세지 않는다', () => {
    expect(count('# 출시 기록\n\nStatus: done\n', 'history')).toBe(0)
    expect(count('---\nStatus: draft\n---\n# 안내\n', 'guide')).toBe(0)
  })

  test('목록에 든 정책 문서가 열쇠 줄 없이 그대로면 막지 않는다', () => {
    expect(blockReasons('<!-- 메모 -->\n# 정책\n\n본문\n\n---\n\n아래\n', 'policy', 'no-frontmatter')).toEqual([])
  })
})
