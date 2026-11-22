// 검색 평가. LLM 없이 결정적으로 돈다.
// 부르는 곳: cli/eval.ts · index.ts. 먼저 읽을 파일: core/search.ts.
// 정답은 조각 ID 가 아니라 안정 키(원천 경로 글롭 + 절 제목 정규식)로 적는다. 평가 때 지금 묶음에서 조각 ID 로 푼다.
// 그래서 제목 경로 · 본문이 바뀌어도 원천과 제목이 같으면 정답이 유지된다.
import type { Level } from '../core/model.ts'
import type { WikiIndex } from '../core/search.ts'
import { globToRegExp } from '../core/util.ts'

/**
 * 정답 안정 키. source 는 저장소 상대 경로 글롭이다(예: `docs/adr/0001-*.md`). heading 은 절 제목 정규식이다.
 * book 을 주면 권 · 장 구조를 내는 원천의 그 권 조각으로 더 좁힌다.
 */
export interface GoldKey {
  source: string
  heading?: string
  book?: string
}

export interface Question {
  id: string
  q: string
  answer?: string
  gold: GoldKey[]
  /** 이 묶음의 원천 범위 밖 질문(예: 3단계 어댑터가 필요한 질문). 집계에서 뺀다. */
  scope?: string
  note?: string
}

export interface QuestionFile {
  schema: 1
  k?: number
  threshold?: { recallAt10?: number; staleTop5Max?: number; regression?: number }
  questions: Question[]
}

export interface QuestionResult {
  id: string
  q: string
  inScope: boolean
  goldIds: string[]
  rank: number | null
  top: Array<{ id: string; stale: string | null }>
}

export interface EvalSummary {
  questions: number
  inScope: number
  recallAt5: number
  recallAt10: number
  mrr: number
  staleTop5: number
  staleCandidateTop5: number
}

export class GoldUnresolvedError extends Error {
  readonly ids: string[]
  constructor(ids: string[]) {
    super(`정답 안정 키가 조각으로 풀리지 않는다(gold_unresolved): ${ids.join(', ')}`)
    this.ids = ids
  }
}

/** 안정 키 → 지금 묶음의 조각 ID 목록. heading 이 없으면 그 원천의 모든 조각. */
export function resolveGold(index: WikiIndex, gold: GoldKey[]): string[] {
  const out = new Set<string>()
  for (const g of gold) {
    const src = globToRegExp(g.source)
    const head = g.heading ? new RegExp(g.heading) : null
    for (const c of index.chunks) {
      if (!src.test(c.source.path)) continue
      if (g.book && c.book !== g.book) continue
      if (head && !head.test(c.heading)) continue
      out.add(c.id)
    }
  }
  return [...out]
}

export function evaluate(index: WikiIndex, file: QuestionFile, cap: Level = 'confidential'): { results: QuestionResult[]; summary: EvalSummary } {
  const k = file.k ?? 10
  const results: QuestionResult[] = []
  const unresolved: string[] = []
  for (const q of file.questions) {
    const inScope = !q.scope
    const goldIds = inScope ? resolveGold(index, q.gold) : []
    if (inScope && !goldIds.length) unresolved.push(q.id)
    const r = index.search({ q: q.q, cap, limit: k })
    const gold = new Set(goldIds)
    const pos = r.hits.findIndex((h) => gold.has(h.id))
    results.push({ id: q.id, q: q.q, inScope, goldIds, rank: pos >= 0 ? pos + 1 : null, top: r.hits.map((h) => ({ id: h.id, stale: h.stale?.state ?? null })) })
  }
  if (unresolved.length) throw new GoldUnresolvedError(unresolved)
  const scoped = results.filter((r) => r.inScope)
  const n = scoped.length || 1
  const top5 = scoped.flatMap((r) => r.top.slice(0, 5))
  const summary: EvalSummary = {
    questions: results.length,
    inScope: scoped.length,
    recallAt5: scoped.filter((r) => r.rank !== null && r.rank <= 5).length / n,
    recallAt10: scoped.filter((r) => r.rank !== null && r.rank <= 10).length / n,
    mrr: scoped.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
    staleTop5: top5.length ? top5.filter((t) => t.stale === 'stale').length / top5.length : 0,
    staleCandidateTop5: top5.length ? top5.filter((t) => t.stale === 'stale-candidate').length / top5.length : 0,
  }
  return { results, summary }
}

/** 기준(고정)과 회귀선(직전 기록) 판정. 기준 재현율@10 은 측정 전에 고정한 값이고, 회귀는 직전 기록 대비 하락 폭으로 본다. */
export function judge(summary: EvalSummary, file: QuestionFile, baseline?: EvalSummary | null): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  const t = { recallAt10: 0.8, staleTop5Max: 0.1, regression: 0.1, ...file.threshold }
  if (summary.recallAt10 < t.recallAt10) reasons.push(`재현율@10 ${summary.recallAt10.toFixed(2)} < 기준 ${t.recallAt10}`)
  if (summary.staleTop5 > t.staleTop5Max) reasons.push(`상위 5 안 낡은 조각 비율 ${summary.staleTop5.toFixed(2)} > ${t.staleTop5Max}`)
  if (baseline && baseline.recallAt10 - summary.recallAt10 >= t.regression - 1e-9) {
    reasons.push(`직전 기록 대비 재현율@10 하락 ${(baseline.recallAt10 - summary.recallAt10).toFixed(2)} ≥ ${t.regression}`)
  }
  return { pass: reasons.length === 0, reasons }
}
