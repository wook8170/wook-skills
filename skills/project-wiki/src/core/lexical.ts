// BM25 낱말 색인. 파일 3개(lexical/terms.tsv · postings.bin · docs.json)로 쓰고 읽는다.
// 부르는 곳: core/build.ts · core/search.ts · index.ts. 먼저 읽을 파일: core/tokenize.ts.
// terms.tsv 한 줄 = 낱말 · 문서 빈도 · 위치 · 길이 · 종류(bigram · word · ident · piece · id · path · version).
// 가중: 절 제목 ×3, 제목 경로의 나머지 ×1, 본문 ×1, 식별자 · ID · 경로 낱말 ×2(본문에서).
import type { Chunk } from './model.ts'
import { TOKENIZER, TYPE_PRIORITY, tokenize, type TokenType } from './tokenize.ts'
import { cmp } from './util.ts'

export const BM25 = { k1: 1.2, b: 0.75 }
export const FIELD_WEIGHTS = { heading: 3, path: 1, body: 1, ident: 2 }

export interface LexicalDocs {
  tokenizer: string
  k1: number
  b: number
  fieldWeights: typeof FIELD_WEIGHTS
  n: number
  dl: number[]
}

export interface LexicalFiles {
  'lexical/terms.tsv': Buffer
  'lexical/postings.bin': Buffer
  'lexical/docs.json': Buffer
}

/** 낱말 종류 중 우선순위가 높은 쪽. */
function strongerType(a: TokenType | undefined, b: TokenType): TokenType {
  return a === undefined || TYPE_PRIORITY.indexOf(b) < TYPE_PRIORITY.indexOf(a) ? b : a
}

function chunkTermWeights(c: Chunk, types: Map<string, TokenType>): Map<string, number> {
  const m = new Map<string, number>()
  const add = (term: string, w: number, type: TokenType) => {
    m.set(term, (m.get(term) ?? 0) + w)
    types.set(term, strongerType(types.get(term), type))
  }
  for (const t of tokenize(c.heading)) add(t.term, FIELD_WEIGHTS.heading, t.type)
  const pathTokens = new Map(c.titlePath.slice(0, -1).flatMap((p) => tokenize(p).map((t) => [t.term, t.type] as const)))
  for (const [term, type] of pathTokens) add(term, FIELD_WEIGHTS.path, type)
  for (const t of tokenize(c.text)) add(t.term, t.ident ? FIELD_WEIGHTS.ident : FIELD_WEIGHTS.body, t.type)
  return m
}

function writeVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

/** 조각 목록 → 색인 파일 3개. 같은 입력이면 같은 바이트다. */
export function buildLexical(chunks: Chunk[]): LexicalFiles {
  const postings = new Map<string, Array<[number, number]>>()
  const types = new Map<string, TokenType>()
  const dl: number[] = []
  chunks.forEach((c, doc) => {
    let len = 0
    for (const [term, w] of chunkTermWeights(c, types)) {
      let p = postings.get(term)
      if (!p) postings.set(term, (p = []))
      p.push([doc, w])
      len += w
    }
    dl.push(len)
  })
  const terms = [...postings.keys()].sort(cmp)
  const bytes: number[] = []
  const rows: string[] = []
  for (const term of terms) {
    const list = postings.get(term)!
    const off = bytes.length
    let prev = 0
    for (const [doc, w] of list) {
      writeVarint(bytes, doc - prev)
      writeVarint(bytes, w)
      prev = doc
    }
    rows.push(`${term}\t${list.length}\t${off}\t${bytes.length - off}\t${types.get(term)}`)
  }
  const docs: LexicalDocs = { tokenizer: TOKENIZER, k1: BM25.k1, b: BM25.b, fieldWeights: FIELD_WEIGHTS, n: chunks.length, dl }
  return {
    'lexical/terms.tsv': Buffer.from(rows.join('\n') + '\n'),
    'lexical/postings.bin': Buffer.from(bytes),
    'lexical/docs.json': Buffer.from(JSON.stringify(docs)),
  }
}

export class LexicalIndex {
  readonly docs: LexicalDocs
  private readonly terms = new Map<string, { off: number; len: number; type: TokenType }>()
  private readonly postings: Buffer

  constructor(files: LexicalFiles) {
    this.docs = JSON.parse(files['lexical/docs.json'].toString('utf8')) as LexicalDocs
    this.postings = files['lexical/postings.bin']
    for (const line of files['lexical/terms.tsv'].toString('utf8').split('\n')) {
      if (!line) continue
      const [term, , off, len, type] = line.split('\t')
      this.terms.set(term, { off: Number(off), len: Number(len), type: (type as TokenType | undefined) ?? 'word' })
    }
  }

  get termCount(): number {
    return this.terms.size
  }

  /** 낱말 사전의 종류. 사전에 없으면 undefined. */
  termType(term: string): TokenType | undefined {
    return this.terms.get(term)?.type
  }

  /** 낱말의 (조각 번호, 가중 빈도) 목록. */
  postingsOf(term: string): Array<[number, number]> {
    const t = this.terms.get(term)
    if (!t) return []
    const out: Array<[number, number]> = []
    const end = t.off + t.len
    let i = t.off
    let doc = 0
    const read = () => {
      let v = 0
      let shift = 0
      for (;;) {
        const b = this.postings[i++]
        v += (b & 0x7f) * 2 ** shift
        if (b < 0x80) return v
        shift += 7
      }
    }
    while (i < end) {
      doc += read()
      out.push([doc, read()])
    }
    return out
  }

  /**
   * BM25 점수. allowed 가 주어지면 그 조각만 문서 수 · 문서 빈도 · 평균 길이 계산에 넣는다.
   * 그래서 볼 수 없는 조각은 점수 계산에 아무 영향도 주지 않는다. excluded 는 거른 조각 가운데 낱말이 맞은 수다.
   */
  score(terms: string[], allowed: Uint8Array | null): { scores: Map<number, number>; excluded: number } {
    const { k1, b, dl } = this.docs
    let n = 0
    let total = 0
    for (let d = 0; d < dl.length; d++) {
      if (allowed && !allowed[d]) continue
      n++
      total += dl[d]
    }
    const avgdl = n ? total / n : 1
    const scores = new Map<number, number>()
    const excludedDocs = new Set<number>()
    for (const term of terms) {
      const all = this.postingsOf(term)
      const list = allowed ? all.filter(([d]) => allowed[d] || (excludedDocs.add(d), false)) : all
      if (!list.length) continue
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5))
      for (const [d, tf] of list) {
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl[d]) / avgdl))
        scores.set(d, (scores.get(d) ?? 0) + s)
      }
    }
    return { scores, excluded: excludedDocs.size }
  }
}

/** 자동 연결에 쓰는 낱말 종류. 바이그램 · 일반 낱말 · 식별자 조각은 쓰지 않는다. */
export const LINK_TERM_TYPES: readonly TokenType[] = ['ident', 'id', 'version']

/**
 * 고객 보고 제목 · 본문에서 자동 연결 낱말을 뽑는다. 식별자 · ID · 버전 꼴이면서 묶음 낱말 사전에도
 * 같은 종류로 있는 낱말만 남긴다. 그래서 사람 이름 · 호스트 이름 같은 낱말은 남지 않는다.
 */
export function extractLinkTerms(text: string, index: LexicalIndex): string[] {
  const out = new Set<string>()
  for (const t of tokenize(text)) {
    if (!LINK_TERM_TYPES.includes(t.type)) continue
    const known = index.termType(t.term)
    if (known && LINK_TERM_TYPES.includes(known)) out.add(t.term)
  }
  return [...out].sort()
}
