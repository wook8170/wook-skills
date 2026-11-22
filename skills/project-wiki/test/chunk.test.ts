import { describe, expect, it } from './support/vitest-shim.ts'
import { chunkUnit, leadSentence } from '../src/core/chunk.ts'
import type { SourceUnit } from '../src/core/model.ts'

function unit(markdown: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  return { adapter: 'markdown', path: 'docs/wiki/a.md', page: 'wiki:a', part: 'wiki', title: '문서', titlePrefix: [], level: 'internal', generated: false, markdown, anchors: [], ...extra }
}

describe('절 단위 나누기', () => {
  it('## · ### 에서 나누고 #### 는 부모 절에 둔다', () => {
    const cs = chunkUnit(unit('# 문서\n\n머리 문단.\n\n## 하나\n\n본문 하나.\n\n### 둘\n\n본문 둘.\n\n#### 넷\n\n본문 넷.\n'))
    expect(cs.map((c) => c.id)).toEqual(['wiki:a#문서', 'wiki:a#하나', 'wiki:a#둘'])
    expect(cs[2].text).toContain('#### 넷')
    expect(cs[2].titlePath).toEqual(['문서', '하나', '둘'])
  })

  it('본문 없는 ## 바로 아래에 ### 가 오면 제목만 있는 조각을 남긴다(차례 · 경로에서 큰 절이 사라지지 않는다)', () => {
    const cs = chunkUnit(unit('# 문서\n\n머리.\n\n## 2. 확인\n\n확인 본문.\n\n## 3. 갱신\n\n### 3-1. 기간 연장\n\n연장 본문.\n\n## 4. 비어 있음\n\n## 5. 끝\n\n끝 본문.\n'))
    expect(cs.map((c) => c.heading)).toEqual(['문서', '2. 확인', '3. 갱신', '3-1. 기간 연장', '5. 끝'])
    const up = cs[2]
    expect(up.text).toBe('')
    expect(up.titlePath).toEqual(['문서', '3. 갱신'])
    expect(cs[3].titlePath).toEqual(['문서', '3. 갱신', '3-1. 기간 연장'])
  })

  it('페이지 제목과 같은 본문 없는 ## 는 제목 조각을 만들지 않는다(설계 산출물 장 제목)', () => {
    const cs = chunkUnit(unit('## 문서\n\n### 하나\n\n본문.\n'))
    expect(cs.map((c) => c.heading)).toEqual(['하나'])
  })

  it('같은 제목은 ~2 를 붙인다', () => {
    const cs = chunkUnit(unit('## 항목\n\n가.\n\n## 항목\n\n나.\n'))
    expect(cs.map((c) => c.id)).toEqual(['wiki:a#항목', 'wiki:a#항목~2'])
  })

  it('코드 울타리 안의 ## 줄은 제목이 아니다', () => {
    const cs = chunkUnit(unit('## 진짜\n\n```\n## 가짜\n```\n'))
    expect(cs).toHaveLength(1)
    expect(cs[0].text).toContain('## 가짜')
  })

  it('머리말 · HTML 주석은 본문에서 빠지고 줄 번호는 유지된다', () => {
    const cs = chunkUnit(unit('---\ntitle: x\n---\n<!-- sources: a.ts -->\n## 절\n\n본문.\n'))
    expect(cs[0].text).toBe('본문.')
    expect(cs[0].source.lines[0]).toBe(5)
  })

  it('긴 절은 상한 안에서 자르고, 글자 수로 자를 때만 겹친다', () => {
    const long = '가'.repeat(5000)
    const cs = chunkUnit(unit(`## 긴 절\n\n${long}\n`), { maxChars: 1800, overlapChars: 150, tableRowsPerChunk: 30 })
    expect(cs.map((c) => c.id)).toEqual(['wiki:a#긴-절', 'wiki:a#긴-절@2', 'wiki:a#긴-절@3'])
    for (const c of cs) expect(c.text.length).toBeLessThanOrEqual(1800)
    expect(cs[0].text.slice(-150)).toBe(cs[1].text.slice(0, 150))
    // 문단 경계로 나눈 조각은 겹치지 않는다
    const paras = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(700)).join('\n\n')
    const ps = chunkUnit(unit(`## 문단\n\n${paras}\n`))
    expect(ps.length).toBe(2)
    expect(ps[1].text.startsWith('2')).toBe(true)
  })

  it('큰 표는 머리 행을 되풀이해 정해진 행 수씩 묶는다', () => {
    const rows = Array.from({ length: 65 }, (_, i) => `| r${i} | v |`).join('\n')
    const cs = chunkUnit(unit(`## 표\n\n| 이름 | 값 |\n|---|---|\n${rows}\n`))
    expect(cs).toHaveLength(3)
    for (const c of cs) expect(c.text.startsWith('| 이름 | 값 |\n|---|---|')).toBe(true)
    expect(cs[0].text.split('\n')).toHaveLength(32)
  })

  it('다른 절을 끼워 넣어도 나머지 조각 ID 는 그대로다(ID 안정성)', () => {
    const a = chunkUnit(unit('## 하나\n\n가.\n\n## 셋\n\n다.\n')).map((c) => c.id)
    const b = chunkUnit(unit('## 하나\n\n가.\n\n## 둘\n\n나.\n\n## 셋\n\n다.\n')).map((c) => c.id)
    expect(b).toEqual(expect.arrayContaining(a))
  })

  it('목록 항목 줄 보존 — 이어지는 줄의 들여쓰기 · 문장 중간 줄바꿈 · 중첩 표식을 그대로 둔다(위키 렌더 회귀 11-17)', () => {
    const item = [
      '- **정본(게이트)**: [README](../scripts/design-lint/README.md)',
      '  + **보고 전용 5종**(`check-skin-parity`)',
      '  한 단계 유지되면 절대-0 가드로 전환,',
      '  근거 §8).',
      '- **정본(개인화 시각 축)**: D6',
    ].join('\n')
    const cs = chunkUnit(unit(`## 디자인\n\n${item}\n`))
    expect(cs).toHaveLength(1)
    expect(cs[0].text).toBe(item)
  })

  it('첫 문장을 요약으로 쓰고, 단위 요약이 있으면 첫 조각에 쓴다', () => {
    expect(leadSentence('| 표 |\n본문 첫 문장이다. 둘째 문장.')).toBe('본문 첫 문장이다.')
    const cs = chunkUnit(unit('## 절\n\n본문이다.\n', { summary: '장 요약' }))
    expect(cs[0].summary).toBe('장 요약')
  })
})
