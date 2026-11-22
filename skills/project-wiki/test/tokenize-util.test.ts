import { describe, expect, it } from './support/vitest-shim.ts'
import { tokenize } from '../src/core/tokenize.ts'
import { decodeId, encodeId, globToRegExp, parseFrontmatter, slugify } from '../src/core/util.ts'

const terms = (s: string) => tokenize(s).map((t) => t.term)

describe('낱말 나누기', () => {
  it('한글은 2글자 겹침, 한 글자 구간은 그대로', () => {
    expect(terms('압축피벗 와')).toEqual(['압축', '축피', '피벗', '와'])
  })
  it('ID 는 통째 + 접두어 + 조각, 종류는 id', () => {
    const t = tokenize('REQ-F-041')
    expect(t.map((x) => x.term)).toEqual(expect.arrayContaining(['req-f-041', 'req-f', 'req']))
    expect(t[0]).toMatchObject({ term: 'req-f-041', type: 'id' })
  })
  it('경로는 통째 + 마지막 이름 + 확장자 뺀 이름', () => {
    expect(terms('apps/server/src/db/dialect.ts')).toEqual(['apps/server/src/db/dialect.ts', 'dialect.ts', 'dialect'])
  })
  it('낙타 · 뱀 표기 식별자는 통째(ident) + 조각(piece)', () => {
    const t = tokenize('effectivePivotLayoutOf E_LIC_42')
    expect(t.filter((x) => x.type === 'ident').map((x) => x.term)).toEqual(['effectivepivotlayoutof', 'e_lic_42'])
    expect(t.filter((x) => x.type === 'piece').map((x) => x.term)).toContain('pivot')
  })
  it('버전 번호는 통째(version) + 앞 두 자리', () => {
    expect(tokenize('1.12.0').map((x) => [x.term, x.type])).toEqual([
      ['1.12.0', 'version'],
      ['1.12', 'piece'],
    ])
  })
})

describe('ID 인코딩 · 슬러그 · 머리말 · 글롭', () => {
  it('encodeURIComponent 1회 왕복: / # 한글 ~2 @1', () => {
    for (const id of ['design:05-data/06-테이블-정의서#엑셀-구성', 'wiki:a#절~2', 'dev:05#긴-절@2', 'x#y/z']) {
      const e = encodeId(id)
      expect(e).not.toMatch(/[/#]/)
      expect(decodeId(e)).toBe(id)
      // 세그먼트를 나눈 뒤 디코드하므로 %2F 는 경로 구분자가 되지 않는다
      expect(`#/wiki/p/${e}`.split('/')).toHaveLength(4)
    }
  })
  it('슬러그는 구분자(# / ~ @)를 지우고 80자에서 자른다', () => {
    expect(slugify('엑셀 구성 (요약)')).toBe('엑셀-구성-요약')
    expect(slugify('a/b#c~d@e')).toBe('a-b-c-d-e')
    expect([...slugify('가'.repeat(200))]).toHaveLength(80)
  })
  it('머리말: 값 · 목록 · 줄 목록', () => {
    const { data } = parseFrontmatter('---\nid: x\nn: 3\ntags: [a, "b c"]\nsources:\n  - p.ts\n  - q.ts\n---\n본문')
    expect(data).toEqual({ id: 'x', n: 3, tags: ['a', 'b c'], sources: ['p.ts', 'q.ts'] })
  })
  it('글롭 ** · *', () => {
    expect(globToRegExp('docs/**/*.md').test('docs/a/b/c.md')).toBe(true)
    expect(globToRegExp('docs/**/*.md').test('docs/c.md')).toBe(true)
    expect(globToRegExp('docs/*.md').test('docs/a/c.md')).toBe(false)
  })
})
