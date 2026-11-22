import { describe, expect, it } from './support/vitest-shim.ts'
import { LexicalIndex, buildLexical, extractLinkTerms } from '../src/core/lexical.ts'
import type { Chunk, Level } from '../src/core/model.ts'

function chunk(id: string, heading: string, text: string, level: Level = 'internal'): Chunk {
  return {
    id,
    page: id.split('#')[0],
    contentHash: id,
    kind: 'section',
    part: 'wiki',
    titlePath: ['문서', heading],
    heading,
    text,
    summary: '',
    source: { adapter: 'markdown', path: 'a.md', lines: [1, 1] },
    anchors: [],
    level,
    generated: false,
    stale: null,
    seq: 0,
  }
}

describe('BM25 낱말 색인', () => {
  const docs = [
    chunk('w:a#1', '롤링 업그레이드', '노드를 하나씩 바꾼다.'),
    chunk('w:a#2', '백업', '롤링 업그레이드 전에 백업한다. 백업 파일을 확인한다.'),
    chunk('w:a#3', '세션', '세션 쿠키를 쓴다.'),
  ]
  const ix = new LexicalIndex(buildLexical(docs))

  it('제목에 맞은 조각이 본문에만 맞은 조각보다 위다', () => {
    const { scores } = ix.score(['롤링', '업그', '그레', '레이', '이드'], null)
    const ranked = [...scores].sort((a, b) => b[1] - a[1]).map(([d]) => d)
    expect(ranked).toEqual([0, 1])
  })

  it('같은 입력이면 같은 바이트(재현)', () => {
    const a = buildLexical(docs)
    const b = buildLexical(docs)
    for (const k of Object.keys(a) as Array<keyof typeof a>) expect(a[k].equals(b[k])).toBe(true)
  })

  it('등급 거르기는 순위 계산 전이다: 거른 조각은 문서 빈도 · 평균 길이에 들어가지 않는다', () => {
    const secret = chunk('w:s#1', '롤링', '롤링 롤링 롤링', 'confidential')
    const withSecret = new LexicalIndex(buildLexical([...docs, secret]))
    const mask = Uint8Array.from([1, 1, 1, 0])
    const filtered = withSecret.score(['롤링'], mask)
    const plain = ix.score(['롤링'], null)
    expect([...filtered.scores]).toEqual([...plain.scores])
    expect(filtered.excluded).toBe(1)
  })

  it('terms.tsv 에 낱말 종류 열이 있다', () => {
    const files = buildLexical([chunk('w:x#1', 'x', 'REQ-F-001 김철수 apps/a/b.ts 1.12.0 parseLevel')])
    const rows = files['lexical/terms.tsv'].toString('utf8').trim().split('\n').map((l) => l.split('\t'))
    const typeOf = Object.fromEntries(rows.map((r) => [r[0], r[4]]))
    expect(typeOf['req-f-001']).toBe('id')
    expect(typeOf['김철']).toBe('bigram')
    expect(typeOf['apps/a/b.ts']).toBe('path')
    expect(typeOf['1.12.0']).toBe('version')
    expect(typeOf['parselevel']).toBe('ident')
  })

  it('자동 연결 낱말: 사람 이름 조각(바이그램)은 남지 않고 식별자 · ID · 버전만 남는다', () => {
    const lex = new LexicalIndex(buildLexical([chunk('w:x#1', '오류', '김철수 담당. 오류 E_LIC_42 와 REQ-F-001, 1.12.0 에서 고쳤다. host-01 서버')]))
    const got = extractLinkTerms('김철수 담당 서버 오류 E_LIC_42 · 1.12.0 · 묶음에 없는 E_NOPE_1', lex)
    expect(got).toEqual(['1.12.0', 'e_lic_42'])
    expect(got.some((t) => /[가-힣]/.test(t))).toBe(false)
  })
})
