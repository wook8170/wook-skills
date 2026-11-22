// 낱말 나누기(ko-bigram-ident/1). 형태소 분석기 없이 한글은 2글자 겹침, 식별자 · ID · 경로는 통째와 조각을 함께 낸다.
// 부르는 곳: core/build.ts · core/lexical.ts · core/search.ts · index.ts. 먼저 읽을 파일: core/lexical.ts.
export const TOKENIZER = 'ko-bigram-ident/1'

/**
 * 낱말 종류. 자동 연결 낱말(extractLinkTerms)은 ident · id · version 만 쓴다.
 * 바이그램은 사람 이름의 조각(「김철수」 → 「김철」 · 「철수」)도 담으므로 연결에 쓰지 않는다.
 */
export type TokenType = 'bigram' | 'word' | 'ident' | 'piece' | 'id' | 'path' | 'version'

export interface Token {
  term: string
  /** 식별자 · ID · 경로에서 나온 낱말. 색인에서 가중 2배. */
  ident: boolean
  type: TokenType
}

/** 같은 낱말이 여러 종류로 나오면 앞의 종류를 그 낱말의 종류로 본다. */
export const TYPE_PRIORITY: TokenType[] = ['id', 'version', 'path', 'ident', 'piece', 'word', 'bigram']

const HANGUL = /[가-힣ㄱ-ㆎ]/
const PATH_RE = /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/g
const ID_RE = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g
const VERSION_RE = /\b\d+\.\d+(?:\.\d+)+\b/g
const WORD_RE = /[A-Za-z0-9_$]+|[가-힣ㄱ-ㆎ]+/g

function pushIdent(out: Token[], whole: string, pieces: string[], type: TokenType): void {
  out.push({ term: whole, ident: true, type })
  for (const p of pieces) if (p && p !== whole) out.push({ term: p, ident: true, type: 'piece' })
}

/** 낙타 · 뱀 표기 식별자를 조각낸다. 조각이 하나면 빈 목록. */
function identPieces(w: string): string[] {
  const parts = w
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase())
  return parts.length > 1 ? parts : []
}

function hangulBigrams(run: string, out: Token[]): void {
  if (run.length === 1) {
    out.push({ term: run, ident: false, type: 'bigram' })
    return
  }
  for (let i = 0; i + 1 < run.length; i++) out.push({ term: run.slice(i, i + 2), ident: false, type: 'bigram' })
}

export function tokenize(input: string): Token[] {
  const out: Token[] = []
  let text = input.normalize('NFC')
  // 1) 경로: 통째 + 마지막 이름 + 확장자 뺀 이름
  text = text.replace(PATH_RE, (p) => {
    const whole = p.toLowerCase().replace(/^\.\/+/, '')
    const last = whole.split('/').pop() ?? whole
    const stem = last.replace(/\.[a-z0-9]+$/, '')
    pushIdent(out, whole, [last, stem], 'path')
    return ' '
  })
  // 2) 버전 번호: 통째 + 앞 두 자리
  text = text.replace(VERSION_RE, (v) => {
    out.push({ term: v, ident: true, type: 'version' })
    out.push({ term: v.split('.').slice(0, 2).join('.'), ident: true, type: 'piece' })
    return ' '
  })
  // 3) ID · 케밥 식별자: 통째 + 접두어 + 조각
  text = text.replace(ID_RE, (id) => {
    const lower = id.toLowerCase()
    const segs = lower.split('-')
    const prefixes = segs.slice(1, -1).map((_, i) => segs.slice(0, i + 2).join('-'))
    pushIdent(out, lower, [...prefixes, ...segs], /\d/.test(lower) ? 'id' : 'ident')
    return ' '
  })
  // 4) 남은 낱말: 영숫자는 소문자 + 식별자 조각, 한글은 바이그램
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0]
    if (HANGUL.test(w)) {
      hangulBigrams(w, out)
      continue
    }
    const pieces = identPieces(w)
    if (pieces.length) pushIdent(out, w.toLowerCase(), pieces, 'ident')
    else out.push({ term: w.toLowerCase(), ident: false, type: 'word' })
  }
  return out
}

/** 질의 낱말(중복 제거). */
export function queryTerms(q: string): string[] {
  return [...new Set(tokenize(q).map((t) => t.term))]
}

/** 근접 가중에 쓰는 질의 구절: 3글자 이상 한글 연속 구간과 공백으로 나눈 2글자 이상 낱말. */
export function queryPhrases(q: string): string[] {
  const set = new Set<string>()
  for (const w of q.normalize('NFC').toLowerCase().split(/\s+/)) {
    const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (t.length >= 2) set.add(t)
  }
  for (const m of q.normalize('NFC').matchAll(/[가-힣]{3,}/g)) set.add(m[0])
  return [...set]
}
