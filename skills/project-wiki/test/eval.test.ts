// 검색 평가: 정답을 조각 ID 가 아니라 안정 키(원천 경로 글롭 · 절 제목)로 적고 재현율을 잰다.
import { describe, expect, it } from './support/vitest-shim.ts'
import { GoldUnresolvedError, evaluate, judge, resolveGold, type QuestionFile } from '../src/eval/retrieval.ts'
import { FILES, buildIndex } from './helpers.ts'

const qf: QuestionFile = {
  schema: 1,
  k: 10,
  questions: [
    { id: 'R-01', q: '공용 DB 함정', gold: [{ source: 'docs/wiki/ops/*.md', heading: '^기본 주소$' }] },
    { id: 'R-02', q: '압축 레이아웃 결정', gold: [{ source: 'docs/decisions/D-*.md', heading: '^결정$' }] },
    { id: 'Q-x', q: '범위 밖 질문', gold: [{ source: 'CHANGELOG.md' }], scope: 'stage3' },
  ],
}

describe('검색 평가(안정 키)', () => {
  it('경로 글롭 · 절 제목으로 정답이 풀리고 재현율을 잰다', () => {
    const { index } = buildIndex()
    const { results, summary } = evaluate(index, qf)
    expect(results.find((r) => r.id === 'R-01')?.rank).toBe(1)
    expect(summary.inScope).toBe(2)
    expect(summary.recallAt10).toBe(1)
    expect(judge(summary, qf).pass).toBe(true)
  })

  it('지금 원고에 없는 경로를 적은 정답은 풀리지 않아 gold_unresolved 로 끝난다', () => {
    const { index } = buildIndex()
    const bad: QuestionFile = { schema: 1, questions: [{ id: 'B-1', q: '개요', gold: [{ source: 'docs/없는-폴더/*.md', heading: '^구성$' }] }] }
    expect(() => evaluate(index, bad)).toThrow(GoldUnresolvedError)
  })

  it('본문이 바뀌어도 원천과 절 제목이 같으면 정답이 유지된다', () => {
    const changed = FILES['docs/guide/00-overview.md'].replace('서버는', '이제 서버는')
    const { index } = buildIndex({ 'docs/guide/00-overview.md': changed })
    expect(resolveGold(index, [{ source: 'docs/guide/00-*.md', heading: '^구성$' }])).toEqual(['dev:00-overview#구성'])
  })

  it('판정: 기준 0.8 미만 · 직전 기록 대비 0.1 이상 하락이면 실패', () => {
    const s = { questions: 10, inScope: 10, recallAt5: 0.7, recallAt10: 0.85, mrr: 0.5, staleTop5: 0, staleCandidateTop5: 0 }
    expect(judge(s, qf, { ...s, recallAt10: 0.9 }).pass).toBe(true)
    expect(judge(s, qf, { ...s, recallAt10: 0.95 }).pass).toBe(false)
    expect(judge({ ...s, recallAt10: 0.75 }, qf).pass).toBe(false)
  })
})
