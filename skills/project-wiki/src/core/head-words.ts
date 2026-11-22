// 머리말의 영역(area · category) 값과 상태(status) 값으로 받는 낱말. 이 파일 한 곳에서만 정한다.
// 부르는 곳: core/head-shape.ts. 먼저 읽을 파일: core/head-shape.ts.
// 낱말 밖의 값은 오타일 수 있다. 그래서 머리말 점검(`head-shape.ts`)이 「표기가 어긋난 문서」로 센다.

/** 출하 차단 대상이 될 수 있는 영역. */
export const BLOCK_AREAS: ReadonlySet<string> = new Set(['decision', 'policy'])

/**
 * 영역 값으로 받는 낱말(소문자). 흔히 쓰는 문서 분류 이름을 든다.
 * 원천 설정에 적은 그 원천의 영역 이름도 받는다(`head-shape.ts` `offWord`).
 */
export const AREA_WORDS: ReadonlySet<string> = new Set([
  ...BLOCK_AREAS,
  'wiki', 'guide', 'feature', 'design', 'design-system', 'testing', 'roadmap', 'history', 'ops', 'dev-doc', 'deliverable',
  'architecture', 'pattern', 'debugging', 'environment', 'session-log', 'reference', 'convention',
])

/** 결정 · 정책 문서의 상태 값으로 받는 낱말(소문자). 차단 대상은 이 가운데 소문자 `current` 뿐이다. */
export const STATUS_WORDS: ReadonlySet<string> = new Set(['current', 'draft', 'proposed', 'accepted', 'rejected', 'superseded', 'deprecated', 'archived'])
