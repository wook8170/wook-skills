// 진입점 레지스트리(범용 템플릿) — 「여는 동작」 하나가 한 항목. 런타임 import 가 없는 순수 데이터로 둔다(정적 가드가 Node 로 직접 읽는다).
// 실제 입력(드라이버)은 drivers.ts 에 같은 id 로. 새 표면 · 여는 호출을 새 파일에 두면 여기에 항목을 추가하고 sources 에 그 파일을 적는다.

export type Invariant = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I9' | 'I10' | 'I11' | 'I12' | 'I13' | 'I14' | 'I15' | 'I16' | 'I17' | 'I18' | 'I20' | 'I22'
export type ConditionId = 'core' | 'narrow' | 'dark' | 'wide' | 'w390' | 'slow'
export type AppId = string

export type Condition = {
  id: ConditionId
  label: string
  viewport: { width: number; height: number }
  theme: 'light' | 'dark'
  /** 프로젝트 고유 축(사이드바 폭 · 패널 고정 · 도킹 배치 …)은 여기에 필드를 더하고 순회 사양에서 localStorage 등으로 맞춘다. */
  extra?: Record<string, string>
  /** 느린 환경 — I20 전환 깜빡임 측정용 응답 지연 · CPU 배수. */
  slow?: { delayMs: number; cpu: number }
}

/** 축마다 모든 값이 한 번 이상 나오게 줄인 조건. core 만 병합 관문(@p0), 나머지는 야간. 결함이 났던 특정 조합은 반드시 넣는다. */
export const CONDITIONS: Record<ConditionId, Condition> = {
  core: { id: 'core', label: '1440 · 라이트', viewport: { width: 1440, height: 900 }, theme: 'light' },
  narrow: { id: 'narrow', label: '1024 · 라이트', viewport: { width: 1024, height: 768 }, theme: 'light' },
  dark: { id: 'dark', label: '1440 · 다크', viewport: { width: 1440, height: 900 }, theme: 'dark' },
  wide: { id: 'wide', label: '2560 · 라이트', viewport: { width: 2560, height: 1440 }, theme: 'light' },
  w390: { id: 'w390', label: '390 · 라이트', viewport: { width: 390, height: 844 }, theme: 'light' },
  slow: { id: 'slow', label: '1440 · 응답 600ms · CPU 4배', viewport: { width: 1440, height: 900 }, theme: 'light', slow: { delayMs: 600, cpu: 4 } },
}

export type Fixme = { defect: string; reason: string; conditions?: ConditionId[]; apps?: AppId[] }

export type SurfaceEntry = {
  id: string
  title: string
  /** 진입 경로 — 사람이 따라 할 수 있게. */
  entry: string
  /** 기대 표면(testid 또는 선택자)과 그 뜻. */
  surface: string
  invariants: Invariant[]
  conditions: ConditionId[]
  /** 원장 케이스 ID(조건별). */
  cases: Partial<Record<ConditionId, string>>
  /** 이 표면을 그리거나 여는 소스 파일 — 누락 가드가 표지를 세는 파일과 대조한다. */
  sources: string[]
  /** 이 항목이 잡는 결함 번호. */
  catches?: string[]
  /** 아직 못 고친 결함 — 기준을 낮추지 않고 그 조합만 보류한다(결함 ID 필수). */
  fixme?: Fixme[]
}

export const REGISTRY: SurfaceEntry[] = [
  {
    id: 'example.rowMenu', title: '목록 행 ⋯ 메뉴',
    entry: '목록 화면 › 행에 포인터 › ⋯ 누르기', surface: 'row-menu (role=menu)',
    invariants: ['I1', 'I9', 'I10', 'I22'], conditions: ['core', 'narrow', 'dark'],
    cases: { core: 'E2E-uistab-001', narrow: 'E2E-uistab-002', dark: 'E2E-uistab-003' }, sources: ['apps/web/src/components/RowMenu.tsx'],
  },
]

export function fixmeFor(e: SurfaceEntry, cond: ConditionId, app: AppId): Fixme | null {
  for (const f of e.fixme ?? []) {
    if (f.conditions && !f.conditions.includes(cond)) continue
    if (f.apps && !f.apps.includes(app)) continue
    return f
  }
  return null
}
