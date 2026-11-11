// I6 성능 예산 · 자동 탐색 한도 — 예산은 이 파일 하나에서만 관리한다. 바꾸면 설계 문서의 예산 표도 함께 고친다.
// 측정 기준: 헤드리스 크로미움 · 하네스 스택(시험 DB). 콜드 · 웜 캐시 값이 갈리면 둘 다 기록한다.
export const BUDGETS_MS = {
  /** 예: 미리보기 창 — 누르기부터 첫 썸네일까지 */
  'preview.firstThumb': 1500,
  /** 예: 같은 창 — 누르기부터 첫 자리표시(스켈레톤)까지 */
  'preview.firstPaint': 400,
} as const
export type BudgetKey = keyof typeof BUDGETS_MS

/**
 * 자동 탐색 한도 — P0 관문은 핵심 화면만 얕게, 야간은 전 화면 · 전 요소를 깊게.
 * dupRequestMax: 화면 열기 · 누르기 한 번 사이 같은 요청(방법 + 경로 + 쿼리)이 이 수를 넘으면 I15 위반.
 */
export const AUTO = {
  dupRequestMax: 3,
  p0: { clicks: 6, hoverMax: 4, maxElements: 400, screenMs: 30_000 },
  nightly: { clicks: 40, hoverMax: 15, maxElements: 800, screenMs: 150_000 },
} as const
