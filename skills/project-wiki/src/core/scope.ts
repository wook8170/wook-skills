// 영역 판정 하나. 검색 · 읽기 · 역링크 · artifact_search 가 모두 이 함수를 쓴다.
// 부르는 곳: core/search.ts. 먼저 읽을 파일: core/search.ts.
// 그래서 호출 경로마다 영역 범위가 갈리지 않는다.

export interface AreaScope {
  /** 이 영역만 보인다. 없거나 비었으면 제한 없음. */
  areas?: string[]
  /** 이 영역은 보이지 않는다. area 가 없는 조각은 걸리지 않는다(빠뜨려도 더 보이는 쪽). */
  excludeAreas?: string[]
}

/** 영역 `area` 를 범위 안에서 볼 수 있으면 true. */
export function areaAllowed(area: string | undefined, s: AreaScope): boolean {
  if (s.areas?.length && !s.areas.includes(area ?? '')) return false
  return !(area && s.excludeAreas?.includes(area))
}

/** 범위가 영역을 전혀 제한하지 않으면 true(이때는 판정 비용을 쓰지 않는다). */
export function areaUnscoped(s: AreaScope): boolean {
  return !s.areas?.length && !s.excludeAreas?.length
}
