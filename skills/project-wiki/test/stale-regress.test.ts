// 머리말 · 링크 판정의 회귀 표.
// 앞서 막은 모양이 계속 막히는지, 정상 문서는 막히지 않는지 한 파일에서 본다.
// - 본문 `---` 덩어리(제목 뒤 머리말 · 둘째 덩어리) 안의 area · category 줄은 값과 관계없이 센다.
// - 근거(`sources`) 경로가 심볼릭 링크면 차단 대상은 막고, 다른 문서는 근거 확인 불가로 센다.
// - 와일드카드 뒤에 고정 조각이 오는 글롭 앞의 폴더 링크도 링크 문서로 센다.
// - 블록 값 뒤 1칸 · 탭 들여쓴 열쇠 줄, 목록 항목 뒤 4칸 줄, 이어 쓴 YAML 값.
// 덩어리 판정:
// - 덩어리를 `---` 줄의 짝으로 세지 않는다. 코드 밖의 첫 `---` 줄과 마지막 닫는 줄 사이를 덩어리 안으로 본다.
// - 덩어리의 닫는 줄로 `...` 도 받는다.
// - 폴더 링크 아래 보기 경로를 여럿 만든다. 제외 글롭이 링크 아래 모든 경로를 덮을 때만 링크를 세지 않는다.
// - 흩어진 줄의 닮은 글자는 영문과 섞인 비영문 글자(한글 · 한자 · 가나 제외)로 본다.
// - 값이 빈 열쇠 다음의 들여쓴 줄(중첩 사상 · 다음 줄 값)은 그 열쇠의 값으로 받는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { markdownAdapter } from '../src/core/adapter.ts'
import type { SourceSpec, SourceUnit } from '../src/core/model.ts'
import { lockNoStatus, type ListedReason } from '../src/core/stale-baseline.ts'
import { BLOCK_REASON, gitRunner, judgeStale } from '../src/core/stale.ts'
import { globFiles } from '../src/core/util.ts'
import { commitFiles, gitRepo } from './helpers.ts'

const noGit = () => ({ code: 0, out: '' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const DOC = 'docs/wiki/d.md'
const MISSHAPEN = '머리말 모양이 어긋나 상태를 읽지 못함'
const S = 'sources: [src/a.ts]'

function readPage(md: string, area: string): SourceUnit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-regress-'))
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

const wh = (cat = 'category: decision', st = 'status: current') => `${cat}\n${st}\n${S}`
const good = (h: string) => `---\n${h}\n---\n# 문서\n\n본문이다.\n`
/** 제목 뒤에 둔 머리말 덩어리. */
const after = (h: string) => `# 결정\n\n---\n${h}\n${S}\n---\n\n본문.\n`
/** 덩어리 값: 영문 낱말 하나가 아니라서 흩어진 줄로는 세지 않는 값. */
const V = 'category: decision (결정)\nstatus: current'
/** 머리말 없는 결정 문서의 흩어진 줄. */
const loose = (cat: string) => `# 결정\n\ncategory: ${cat}\nstatus: current\n${S}\n`

// ── 막혀야 하는 모양(회귀 표) ─────────────────────────────────────────────

/** [이름, 문서, 원천 영역, 기준 목록 사유] */
const BLOCKED: Array<[string, string, string, ListedReason?]> = [
  // 머리말 안 값 오타 · 닮은 글자 열쇠 · 닮은 쌍점 · YAML 꼴
  ['W1 키릴 с 열쇠', good(wh('сategory: decision')), 'wiki'],
  ['W2 !!str 열쇠', good(wh('!!str category: decision')), 'wiki'],
  ['W3 &a 열쇠', good(wh('&a category: decision')), 'wiki'],
  ['W4 값 오타 decisions', good(wh('category: decisions')), 'wiki'],
  ['W5 값 오타 curent', good(wh(undefined, 'status: curent')), 'wiki'],
  ['W6 쌍점 U+A789', good(wh('category꞉ decision')), 'wiki'],
  ['W7 쌍점 U+2236', good(wh('category∶ decision')), 'wiki'],
  ['W8 ? category / : decision', good(wh('? category\n: decision')), 'wiki'],
  ['W9 값 decision-record', good(wh('category: decision-record')), 'wiki'],
  ['W10 status: active', good(wh(undefined, 'status: active')), 'wiki'],
  ['W11 CR 만 쓴 줄 끝', good(wh()).replace(/\n/g, '\r'), 'wiki'],
  ['W13 열쇠 앞 백틱', good(wh('`category`: decision')), 'wiki'],
  ['W14 키릴 а 열쇠', good(wh('cаtegory: decision')), 'wiki'],
  // 목록에 든 status 없는 위키 결정 문서
  ['L2 키릴 ѕtatus', good(wh(undefined, 'ѕtatus: current')), 'wiki', 'no-status'],
  ['L3 status꞉', good(wh(undefined, 'status꞉ current')), 'wiki', 'no-status'],
  ['L4 !!str status', good(wh(undefined, '!!str status: current')), 'wiki', 'no-status'],
  // (제목 뒤 머리말의 영역 값) · 둘째 덩어리
  ['C0 제목 뒤 category: decision', after('category: decision\nstatus: current'), 'wiki'],
  ['T1 제목 뒤 닮은 글자 dеcision', after('category: dеcision\nstatus: current'), 'wiki'],
  ['T2 제목 뒤 decision (결정)', after('category: decision (결정)\nstatus: current'), 'wiki'],
  ['T3 제목 뒤 decision record', after('category: decision record\nstatus: current'), 'wiki'],
  ['T4 제목 뒤 decision, policy', after('category: decision, policy\nstatus: current'), 'wiki'],
  ['T5 제목 뒤 결정', after('category: 결정\nstatus: current'), 'wiki'],
  ['T6 제목 뒤 Category: Decision 문서', after('Category: Decision 문서\nStatus: Current'), 'wiki'],
  ['T7 제목 뒤 decision/policy', after('category: decision/policy\nstatus: current'), 'wiki'],
  ['T8 정책 제목 뒤 status: сurrent', `# 정책\n\n---\ntitle: 정책\nstatus: сurrent\n${S}\n---\n`, 'policy'],
  ['T9 머리말 없는 본문 category: dеcision', `# 결정\n\ncategory: dеcision\nstatus: current\n${S}\n`, 'wiki'],
  ['S1 첫 머리말 status: draft + 둘째 덩어리 decision', `---\ntitle: x\nstatus: draft\n---\n# 결정\n\n---\ncategory: decision\nstatus: current\n${S}\n---\n`, 'wiki'],
  ['S4 첫 머리말 status + 둘째 덩어리 dеcision', `---\nstatus: current\n${S}\n---\n# 결정\n\n---\ncategory: dеcision\n---\n`, 'wiki'],
  ['S5 첫 머리말 status + 둘째 덩어리 decision', `---\nstatus: current\n${S}\n---\n# 결정\n\n---\ncategory: decision\n---\n`, 'wiki'],
  // 머리말 안
  ['H1 title: | 다음 1칸 들여쓴 category', `---\ntitle: |\n category: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['H2 title: | 다음 탭 들여쓴 category', `---\ntitle: |\n\tcategory: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['H6 값 안 U+2028 뒤 category', `---\ntitle: x category: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['H7 status 값 뒤 폭 없는 글자', good(wh(undefined, 'status: current​')), 'wiki'],
  ['H8 status: "current "', good(wh(undefined, 'status: "current "')), 'wiki'],
  ['H9 전각 값', good(wh('category: ｄｅｃｉｓｉｏｎ')), 'wiki'],
  ['H10 따옴표 열쇠', good(wh('"category": decision')), 'wiki'],
  ['H11 status: | 블록 값', good(wh(undefined, 'status: |\n  current')), 'wiki'],
  ['H15 목록 뒤 들여쓴 category', `---\ntags:\n  - a\n  category: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['H17 값에 붙은 #x', good(wh('category: decision#x')), 'wiki'],
  // 
  ['I2 목록 항목 + 빈 줄 + 4칸 줄', `# 결정\n\n- 메타\n\n    category: decision\n    status: current\n`, 'wiki'],
  ['I4 문단 바로 아래 4칸 줄', `# 결정\n메타:\n    category: decision\n    status: current\n`, 'wiki'],
  ['이어 쓴 값 뒤 들여쓴 category', `---\ndescription: 첫 줄\n  category: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['이어 쓴 값 뒤 탭 줄', `---\ndescription: 첫 줄\n\t둘째 줄\ncategory: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  // 머리말 닫는 줄 변형
  ['H14 들여쓴 \' ---\' 뒤 진짜 ---', `---\ntitle: x\n ---\ncategory: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  // 본문 덩어리의 짝 어긋남 · 닫는 줄 ...
  ['N1 제목 뒤 덩어리, 닫는 줄 ...', `# 결정\n\n---\n${V}\n${S}\n...\n\n본문.\n`, 'wiki'],
  ['N5a 앞에 구분선 하나 뒤 닫힌 덩어리', `# 결정\n\n---\n\n요약 글.\n\n---\n${V}\n${S}\n---\n\n본문.\n`, 'wiki'],
  ['N5b setext 제목 뒤 덩어리', `결정 제목\n---\n\n---\n${V}\n${S}\n---\n\n본문.\n`, 'wiki'],
  ['N5c setext 제목 바로 뒤 덩어리', `결정 제목\n---\n---\n${V}\n${S}\n---\n`, 'wiki'],
  ['N6a 앞 구분선의 짝이 울타리 안 ---', `# 결정\n\n---\n\n예시:\n\n\`\`\`yaml\n---\nx: 1\n\`\`\`\n\n---\n${V}\n${S}\n---\n\n본문.\n`, 'wiki'],
  ['N6b 앞 구분선의 짝이 4칸 코드 안 ---', `# 결정\n\n---\n\n예시:\n\n    ---\n    x: 1\n\n---\n${V}\n${S}\n---\n\n본문.\n`, 'wiki'],
  ['N6c 구분선 둘 뒤 덩어리(대조)', `# 결정\n\n---\n\n예시.\n\n---\n\n---\n${V}\n${S}\n---\n`, 'wiki'],
  // 흩어진 줄의 닮은 글자
  ['N7 흩어진 줄 decısion(점 없는 ı)', loose('decısion'), 'wiki'],
  ['N8 흩어진 줄 decisiⲟn(콥트)', loose('decisiⲟn'), 'wiki'],
  ['N9 흩어진 줄 ᴅecision(작은 대문자)', loose('ᴅecision'), 'wiki'],
  ['N10 흩어진 줄 결합 문자 de\u0301cision', loose('de\u0301cision'), 'wiki'],
  ['N18 흩어진 줄 ꓓecision(리수)', loose('ꓓecision'), 'wiki'],
  ['흩어진 줄 dеcision (결정)(키릴)', loose('dеcision (결정)'), 'wiki'],
  ['흩어진 줄 전각 ｄｅｃｉｓｉｏｎ', loose('ｄｅｃｉｓｉｏｎ'), 'wiki'],
  ['낮음 3 흩어진 줄 값 앞 한글 채움 문자', loose('\u3164decision'), 'wiki'],
  ['낮음 3 흩어진 줄 값 안 한글 채움 문자', loose('dec\u3164ision'), 'wiki'],
  // 낮음 2 수리 뒤에도 값이 빈 열쇠 아래의 열쇠 꼴 줄은 센다
  ['값이 빈 열쇠 아래 들여쓴 category', `---\nmeta:\n  category: decision\nstatus: current\n${S}\n---\n# 결정\n`, 'wiki'],
  // 목록 값 상태에서 열쇠 꼴 목록 줄은 값으로 받지 않는다
  ['E2 meta: 다음 들여쓴 - category: decision', `---\ntitle: x\nmeta:\n  - category: decision\n  - status: current\n${S}\n---\n# 결정\n`, 'wiki'],
  ['E3 들여쓰지 않은 tags: 다음 - category: decision', `---\ntitle: x\ntags:\n- category: decision\n- status: current\n${S}\n---\n# 결정\n`, 'wiki'],
  // 막는 쪽을 택한 모양: 닫힌 `---` 덩어리 안의 영역 줄은 구분선 사이 글이어도 센다
  ['구분선 사이 - Category: 대시보드', '# 안내\n\n---\n\n- Category: 대시보드\n\n---\n', 'guide'],
  // 이 든 모양
  ['정책 status: Current', '---\nstatus: Current\n---\n# 정책\n', 'policy'],
  ['머리말 없는 목록 정책 문서 본문 Status: current', '# 정책\n\nStatus: current\n', 'policy', 'no-frontmatter'],
  ['목록 항목 아래 4칸 status', '# 정책\n\n- 상태\n    status: current\n', 'policy', 'no-frontmatter'],
]

describe('앞서 막은 모양은 계속 막힌다(회귀 표)', () => {
  for (const [name, md, area, listed] of BLOCKED) {
    test(name, () => expect(blockReasons(md, area, listed)).toEqual([expect.stringContaining(MISSHAPEN)]))
  }
})

describe('머리말 닫는 줄 변형 H12 · H13', () => {
  test('H12 닫는 줄 ... 은 닫히지 않은 머리말로 막는다', () => {
    expect(blockReasons(`---\ncategory: decision\nstatus: current\n${S}\n...\n# 결정\n`, 'wiki')).toEqual([BLOCK_REASON.headUnclosed])
  })
  test('H13 닫는 줄 ---\\t 은 머리말로 읽어 결정 문서로 판정한다', () => {
    const u = readPage(`---\ncategory: decision\nstatus: current\n${S}\n---\t\n# 결정\n`, 'wiki')
    expect(u).toMatchObject({ area: 'decision', status: 'current' })
    expect(blockReasons(`---\ncategory: decision\nstatus: current\n${S}\n---\t\n# 결정\n`, 'wiki')).toEqual([BLOCK_REASON.noCommit])
  })
})

// ── 정상 문서(막히면 안 된다) ─────────────────────────────────────────────

const OK: Array<[string, string, string, ListedReason?]> = [
  ['F1 가이드 4칸 코드 블록의 category', '---\ncategory: guide\n---\n# 안내\n\n예시:\n\n    category: decision\n', 'wiki'],
  ['F2 가이드 본문 Area: 서울 전역', '# 안내\n\nArea: 서울 전역\n', 'guide'],
  ['F3 가이드 표 | category: |', '# 안내\n\n| 칸 | 뜻 |\n|---|---|\n| category: | 분류 |\n', 'guide'],
  ['F4 가이드 - Category: 대시보드', '# 안내\n\n- Category: 대시보드\n', 'guide'],
  ['F5 결정 + 본문 - status: 진행 중', `${good(wh())}\n- status: 진행 중\n`, 'wiki'],
  ['F6 결정 + 본문 Status: 승인', `${good(wh())}\nStatus: 승인\n`, 'wiki'],
  ['F7 목록 정책 문서 본문 status=200', '# 정책\n\n응답 status=200 이면 성공이다.\n', 'policy', 'no-frontmatter'],
  ['F8 가이드 title: | 안 category: 예시', '---\ntitle: |\n  category: 예시\n---\n# 안내\n', 'guide'],
  ['F9 가이드 > **Area**: 화면 영역', '# 안내\n\n> **Area**: 화면 영역\n', 'guide'],
  ['F11 머리말 area: guide + 본문 Category: UI', '---\narea: guide\n---\n# 안내\n\nCategory: UI\n', 'guide'],
  ['F12 category: architecture + status: active', good('category: architecture\nstatus: active'), 'wiki'],
  ['F13 title: "a: b"', '---\ntitle: "a: b"\n---\n# 안내\n', 'wiki'],
  ['F14 이어 쓴 YAML 값', '---\ndescription: 첫 줄\n  둘째 줄\n  셋째 줄\n---\n# 안내\n', 'wiki'],
  ['가이드 구분선 하나 뒤 Category: 대시보드', '# 안내\n\n---\n\nCategory: 대시보드 화면\n', 'guide'],
  ['목록 항목 + 빈 줄 + 8칸 코드 블록', '# 안내\n\n- 예시\n\n        category: decision\n', 'guide'],
  ['머리말 블록 값 + 2칸 내용', '---\ntitle: >-\n  status: current 뜻\nsummary: x\n---\n# 안내\n', 'guide'],
  // 정상 YAML 의 중첩 사상 · 다음 줄 값
  ['G4 목록 안 사상', '---\nitems:\n  - name: a\n    desc: b\ntitle: x\n---\n# 안내\n', 'guide'],
  ['G5 중첩 사상', '---\nauthor:\n  name: x\n  team: y\ntitle: x\n---\n# 안내\n', 'guide'],
  ['G6 다음 줄에 쓴 값', '---\nsummary:\n  긴 글이다\ntitle: x\n---\n# 안내\n', 'guide'],
  // 낮음 1 을 넓혀도 한글과 섞인 영문 · 구분선 하나 · 울타리 안 대시 줄은 세지 않는다
  ['가이드 흩어진 줄 Category: UI화면', '# 안내\n\nCategory: UI화면\n', 'guide'],
  ['울타리 안 --- 사이 Category: 대시보드', '# 안내\n\n```yaml\n---\nCategory: 대시보드 화면\n---\n```\n', 'guide'],
  ['구분선 뒤 4칸 코드 안 --- 앞 Category', '# 안내\n\n---\n\nCategory: 대시보드 화면\n\n    ---\n', 'guide'],
]

describe('정상 문서는 막지 않는다', () => {
  // 바른 결정 문서 예시(F5 · F6)는 기준 커밋이 없어서 나오는 차단만 남는다. 그 사유는 빼고 본다.
  for (const [name, md, area, listed] of OK) test(name, () => expect(blockReasons(md, area, listed).filter((r) => r !== BLOCK_REASON.noCommit)).toEqual([]))
})

// ── 근거 경로가 심볼릭 링크 ──────────────────────────────────

const decision = (src: string, base: string, cat = 'decision') => `---\ncategory: ${cat}\nstatus: current\nsources: [${src}]\nbase_commit: ${base}\n---\n# 결정\n`

/** 근거 링크가 있는 저장소. 문서를 기준 커밋 뒤에 쓰고, `touch` 를 주면 그 파일을 고쳐 한 번 더 커밋한다. */
function anchorRepo(src: string, cat: string, touch?: string) {
  const { dir, first } = gitRepo({ 'src/real.ts': '1\n', 'lib/x.ts': '1\n', 'other.txt': '1\n' })
  dirs.push(dir)
  fs.symlinkSync('real.ts', path.join(dir, 'src/link.ts'))
  fs.symlinkSync('../lib', path.join(dir, 'src/lk'))
  commitFiles(dir, { [DOC]: decision(src, first, cat) }, 'doc')
  if (touch) commitFiles(dir, { [touch]: '2\n' }, 'touch')
  const spec = { adapter: 'markdown', root: 'docs/wiki', level: 'internal', area: 'wiki' } as SourceSpec & Record<string, unknown>
  const u = markdownAdapter.read({ repoRoot: dir, spec }).units[0]
  return judgeStale([u], gitRunner(dir)).report
}

describe('근거 경로가 심볼릭 링크면 차단 대상은 막고 다른 문서는 근거 확인 불가로 센다', () => {
  test('A1 파일 링크 근거의 대상이 바뀌면 막는다', () => {
    expect(anchorRepo('src/link.ts', 'decision', 'src/real.ts').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
  })
  test('파일 링크 근거는 대상이 바뀌지 않아도 막는다', () => {
    expect(anchorRepo('src/link.ts', 'decision').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
  })
  test('A4 정책 문서의 파일 링크 근거', () => {
    expect(anchorRepo('src/link.ts', 'policy', 'src/real.ts').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
  })
  test('A3 폴더 링크 근거는 「바뀜」이 아니라 링크 사유로 막는다', () => {
    expect(anchorRepo('src/lk', 'decision').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
    expect(anchorRepo('src/lk', 'decision', 'other.txt').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
  })
  test('폴더 링크 아래 파일을 근거로 적어도 막는다', () => {
    expect(anchorRepo('src/lk/x.ts', 'decision', 'lib/x.ts').block.map((b) => b.reason)).toEqual([BLOCK_REASON.anchorLink])
  })
  test('차단 대상이 아닌 문서는 근거 확인 불가로 센다', () => {
    for (const src of ['src/link.ts', 'src/lk', 'src/lk/x.ts']) {
      const r = anchorRepo(src, 'guide', 'src/real.ts')
      expect(r).toMatchObject({ block: [], warn: 0, unverifiableAnchors: 1 })
    }
  })
  test('A1b 실제 경로 근거는 지금처럼 「바뀜」으로 막는다(대조)', () => {
    expect(anchorRepo('src/real.ts', 'decision', 'src/real.ts').block.map((b) => b.reason)).toEqual([BLOCK_REASON.changed(1)])
    expect(anchorRepo('src/real.ts', 'decision', 'other.txt').block).toEqual([])
  })
})

// ── 와일드카드 뒤 고정 조각이 있는 글롭 앞의 폴더 링크 ─────────────────

describe('글롭 앞의 폴더 링크를 링크 경로 아래에 글롭이 맞을 수 있는지로 센다', () => {
  function tree(): string {
    const g = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-glob-'))
    dirs.push(g)
    const w = (p: string) => {
      fs.mkdirSync(path.dirname(path.join(g, p)), { recursive: true })
      fs.writeFileSync(path.join(g, p), 'x\n')
    }
    const ln = (target: string, p: string) => {
      fs.mkdirSync(path.dirname(path.join(g, p)), { recursive: true })
      fs.symlinkSync(target, path.join(g, p))
    }
    w('real/decisions/a.md')
    w('real/sub/a.md')
    w('docs/x/ok/decisions/b.md')
    ln('../../real', 'docs/x/team')
    ln('../../real', 'docs/wiki/dec')
    ln('../../../real', 'docs/wiki/a/b')
    ln('../../real', 'docs/wiki/archive')
    ln('../../real', 'docs/legal/sub')
    ln('../../real', 'docs/p/team')
    return g
  }
  const links = (g: string, inc: string[], exc: string[] = []) => {
    const out: string[] = []
    globFiles(g, inc, exc, out)
    return out
  }

  test('docs/x/**/decisions/*.md 앞의 링크', () => expect(links(tree(), ['docs/x/**/decisions/*.md'])).toEqual(['docs/x/team']))
  test('docs/x/*/decisions/*.md 앞의 링크', () => expect(links(tree(), ['docs/x/*/decisions/*.md'])).toEqual(['docs/x/team']))
  test('docs/p/**/sub/*.md 앞의 링크', () => expect(links(tree(), ['docs/p/**/sub/*.md'])).toEqual(['docs/p/team']))
  test('docs/p/**/a.md 앞의 링크', () => expect(links(tree(), ['docs/p/**/a.md'])).toEqual(['docs/p/team']))
  test('docs/wiki/**/*.md 의 하위 · 두 단계 아래 링크', () => {
    expect(links(tree(), ['docs/wiki/**/*.md'])).toEqual(['docs/wiki/a/b', 'docs/wiki/archive', 'docs/wiki/dec'])
  })
  test('제외 글롭이 링크 아래 모든 경로를 덮을 때만 세지 않는다(대조)', () => {
    expect(links(tree(), ['docs/wiki/**/*.md'], ['docs/wiki/archive/**'])).toEqual(['docs/wiki/a/b', 'docs/wiki/dec'])
  })
  test('GL3 제외 글롭이 링크 바로 아래만 덮으면 링크를 센다', () => {
    expect(links(tree(), ['docs/wiki/**/*.md'], ['docs/wiki/archive/*.md'])).toEqual(['docs/wiki/a/b', 'docs/wiki/archive', 'docs/wiki/dec'])
  })
  test('GL1 제외 docs/wiki/*/*.md 는 링크 아래 깊은 경로를 덮지 않는다', () => {
    expect(links(tree(), ['docs/wiki/**/*.md'], ['docs/wiki/*/*.md'])).toEqual(['docs/wiki/a/b', 'docs/wiki/archive', 'docs/wiki/dec'])
  })
  test('GL2 제외 글롭이 파일 이름 하나만 덮으면 링크를 센다', () => {
    expect(links(tree(), ['docs/wiki/**/*.md'], ['docs/wiki/**/x.md'])).toEqual(['docs/wiki/a/b', 'docs/wiki/archive', 'docs/wiki/dec'])
  })
  test('GL4 조각 안의 ** 글롭(docs/**.md) 앞의 링크', () => {
    expect(links(tree(), ['docs/p/**.md'])).toEqual(['docs/p/team'])
  })
  test('R2 글롭 고정 접두가 폴더 링크면 따라가 그 안의 파일을 읽는다', () => {
    const g = tree()
    fs.symlinkSync('../real', path.join(g, 'docs/pol'))
    const out: string[] = []
    expect(globFiles(g, ['docs/pol/*/*.md'], [], out)).toEqual(['docs/pol/decisions/a.md', 'docs/pol/sub/a.md'])
    expect(out).toEqual([])
  })
  test('하위 폴더를 보지 않는 글롭의 링크는 세지 않는다(대조)', () => {
    expect(links(tree(), ['docs/legal/*.md'])).toEqual([])
    expect(links(tree(), ['docs/x/ok/decisions/*.md'])).toEqual([])
  })
  test('실제 폴더 안 파일은 지금처럼 찾는다(대조)', () => {
    const g = tree()
    expect(globFiles(g, ['docs/x/**/decisions/*.md'])).toEqual(['docs/x/ok/decisions/b.md'])
  })
})
