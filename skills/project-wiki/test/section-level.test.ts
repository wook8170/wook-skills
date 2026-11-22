// 절 단위 등급(`<!-- level: … -->`) — 상속 · 혼합 문서 · 잘못된 표기 거부 · 읽기 · 찾기 거르기.
import { describe, expect, it } from './support/vitest-shim.ts'
import { chunkUnit } from '../src/core/chunk.ts'
import { ConfigError } from '../src/core/build.ts'
import { isReadError } from '../src/core/search.ts'
import type { Level, SourceUnit } from '../src/core/model.ts'
import { buildIndex } from './helpers.ts'

function unit(markdown: string, level: Level = 'internal'): SourceUnit {
  return { adapter: 'markdown', path: 'docs/guide/99-x.md', page: 'dev:99-x', part: 'dev', title: '문서', titlePrefix: [], level, generated: false, markdown, anchors: [] }
}

const levelsOf = (md: string, level: Level = 'internal') => Object.fromEntries(chunkUnit(unit(md, level)).map((c) => [c.heading, c.level]))

const MIXED = `# 문서

머리 문단.

## 공개 절

누구나 읽는다.

## 키 관리
<!-- level: confidential -->

서명 키 위치를 적는다.

### 키 교체

교체 순서를 적는다.

## 다시 사내

사내 본문.

### 하위 절

하위 본문.
`

describe('절 단위 등급 — 나누기', () => {
  it('표시한 절과 하위 절은 그 등급, 다음 같은 깊이 절부터는 원천 등급으로 돌아간다', () => {
    expect(levelsOf(MIXED)).toEqual({ 문서: 'internal', '공개 절': 'internal', '키 관리': 'confidential', '키 교체': 'confidential', '다시 사내': 'internal', '하위 절': 'internal' })
  })

  it('표시 줄은 조각 본문에 남지 않고 줄 번호는 그대로다', () => {
    const c = chunkUnit(unit(MIXED)).find((x) => x.heading === '키 관리')!
    expect(c.text).toBe('서명 키 위치를 적는다.')
    expect(c.text).not.toContain('level')
    expect(c.source.lines[0]).toBe(9)
  })

  it('### 하나만 표시하면 그 절만 오른다', () => {
    const md = '## 위\n\n본문.\n\n### 비밀\n<!-- level: confidential -->\n\n가.\n\n### 보통\n\n나.\n'
    expect(levelsOf(md)).toEqual({ 위: 'internal', 비밀: 'confidential', 보통: 'internal' })
  })

  it('한글 키 · 값(`등급: 대외비`)도 읽고, 원천과 같은 등급 표시는 그대로 둔다', () => {
    expect(levelsOf('## 가\n<!-- 등급: 대외비 -->\n\n본문.\n')).toEqual({ 가: 'confidential' })
    expect(levelsOf('## 가\n<!-- level: internal -->\n\n본문.\n')).toEqual({ 가: 'internal' })
  })

  it('본문 없이 표시만 있는 절도 하위 절에 등급을 물려준다', () => {
    expect(levelsOf('## 묶음\n<!-- level: confidential -->\n\n### 안쪽\n\n본문.\n')).toEqual({ 묶음: 'confidential', 안쪽: 'confidential' }) // 본문 없는 큰 절도 제목 조각으로 남고 같은 등급이다(1.14 위키 수리)
  })

  it('코드 울타리 안 · 백틱 안의 표시는 등급 표시가 아니다', () => {
    expect(levelsOf('## 예시\n\n```md\n<!-- level: confidential -->\n```\n')).toEqual({ 예시: 'internal' })
    expect(levelsOf('## 규칙\n\n절 제목 아래 `<!-- level: confidential -->` 를 둔다.\n')).toEqual({ 규칙: 'internal' })
  })

  it('표시가 없는 문서는 모든 조각이 원천 등급이다(기존 묶음과 같다)', () => {
    expect(new Set(Object.values(levelsOf('## 가\n\n나.\n\n### 다\n\n라.\n', 'confidential')))).toEqual(new Set(['confidential']))
  })
})

describe('절 단위 등급 — 잘못된 표기 거부', () => {
  const bad: Array<[string, string, RegExp, Level?]> = [
    ['모르는 등급', '## 가\n<!-- level: secret -->\n\n본문.\n', /알 수 없는 등급: secret/],
    ['콜론 없는 꼴', '## 가\n<!-- level confidential -->\n\n본문.\n', /형식이 틀렸다/],
    ['제목 줄에 붙인 꼴', '## 가 <!-- level: confidential -->\n\n본문.\n', /형식이 틀렸다/],
    ['제목 앞(머리 문단)', '<!-- level: confidential -->\n\n머리.\n\n## 가\n\n본문.\n', /절 제목 아래에 둔다/],
    ['본문 뒤', '## 가\n\n본문.\n\n<!-- level: confidential -->\n', /본문 앞/],
    ['한 절에 둘', '## 가\n<!-- level: confidential -->\n<!-- level: confidential -->\n\n본문.\n', /표시가 둘/],
    ['원천보다 낮춤', '## 가\n<!-- level: internal -->\n\n본문.\n', /낮출 수 없다/, 'confidential'],
    ['바깥 절보다 낮춤', '## 가\n<!-- level: confidential -->\n\n본문.\n\n### 나\n<!-- level: internal -->\n\n본문.\n', /낮출 수 없다/],
  ]
  for (const [name, md, re, level] of bad) {
    it(name, () => {
      expect(() => chunkUnit(unit(md, level))).toThrow(re)
    })
  }

  it('묶음 만들기는 설정 오류(ConfigError)로 멈추고 파일 · 줄을 알려 준다', () => {
    expect(() => buildIndex({ 'docs/wiki/feature/bad.md': '# 나쁨\n\n## 가\n<!-- level: top -->\n\n본문.\n' })).toThrow(ConfigError)
    expect(() => buildIndex({ 'docs/wiki/feature/bad.md': '# 나쁨\n\n## 가\n<!-- level: top -->\n\n본문.\n' })).toThrow(/docs\/wiki\/feature\/bad\.md:4/)
  })
})

describe('절 단위 등급 — 색인 거르기', () => {
  const page = `---
id: feature/mixed
title: 혼합 문서
---
# 혼합 문서

## 개요

사내 직원이 읽는 개요다.

## 서명 키 보관
<!-- level: confidential -->

비밀낱말쿼츠 는 키 보관 위치를 가리킨다.
`
  const { index, result } = buildIndex({ 'docs/wiki/feature/mixed.md': page })

  it('매니페스트 등급별 수에 절 단위 대외비 조각이 잡힌다', () => {
    const cs = index.chunks.filter((c) => c.page === 'wiki:feature/mixed')
    expect(cs.map((c) => [c.heading, c.level])).toEqual([
      
      ['개요', 'internal'],
      ['서명 키 보관', 'confidential'],
    ])
    expect(result.manifest.counts.byLevel.confidential).toBeGreaterThan(0)
    expect(index.pageLevel('wiki:feature/mixed')).toBe('internal')
  })

  it('사내 상한으로 페이지를 읽으면 대외비 절만 빠지고 거른 건수가 잡힌다', () => {
    const r = index.read('wiki:feature/mixed', { cap: 'internal' })
    if (isReadError(r)) throw new Error(r.error)
    expect(r.level).toBe('internal')
    expect(r.chunks?.map((c) => c.heading)).toEqual(['개요'])
    expect(r.text).not.toContain('비밀낱말쿼츠')
    expect(r.filteredCount).toBeGreaterThanOrEqual(1)
  })

  it('대외비 상한이면 모든 절이 보이고 절 때문에 거른 것은 없다', () => {
    const r = index.read('wiki:feature/mixed', { cap: 'confidential' })
    if (isReadError(r)) throw new Error(r.error)
    expect(r.chunks?.map((c) => c.heading)).toEqual(['개요', '서명 키 보관'])
    expect(r.text).toContain('비밀낱말쿼츠')
  })

  it('대외비 절 조각을 사내 상한으로 직접 읽으면 거부한다', () => {
    const r = index.read('wiki:feature/mixed#서명-키-보관', { cap: 'internal' })
    expect(isReadError(r) && r.error).toBe('wiki_level_required')
  })

  it('찾기는 사내 상한에서 대외비 절을 내놓지 않고 거른 건수만 센다', () => {
    const low = index.search({ q: '비밀낱말쿼츠', cap: 'internal' })
    expect(low.hits).toHaveLength(0)
    expect(low.filteredCount).toBeGreaterThan(0)
    const high = index.search({ q: '비밀낱말쿼츠', cap: 'confidential' })
    expect(high.hits.map((h) => h.id)).toContain('wiki:feature/mixed#서명-키-보관')
  })
})
