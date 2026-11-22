# 사람이 읽기 쉬운 코드 — 작성 기준 전문

크기 상한(파일 500줄 · 함수 100줄 · 복잡도 15)은 「얼마나 큰가」만 막는다. 상한을 지켜도 따라가기 어려운 코드가 생긴다. 예를 들어 함수를 문장 순서대로 잘라 작은 조각만 많아진 코드가 그렇다. 아래 기준은 **처음 보는 사람이 기능 하나를 쉽게 찾아 고칠 수 있는가**를 지킨다. 코드를 새로 쓰거나 고칠 때 크기 상한과 함께 지킨다. 지키지 않은 코드는 미완료다.

## 1. 판정과 실행을 나눈다

- 「해도 되나 · 무엇을 할까」를 정하는 규칙과 「실제로 바꾸는」 처리를 한 함수에 섞지 않는다.
- 규칙은 입력을 받아 결과(허용 · 거절 · 확인 필요 · 적용할 변경)를 돌려주는 **순수 함수**로 둔다. 규칙 하나에 함수 하나를 둔다.
- 화면 · 라우트의 처리 함수는 「읽기 → 판정 받기 → 결과대로 하기」만 남긴다.
- 정리 동작(상태 초기화 · 잠금 해제)은 한 곳에서 한 번만 한다. 같은 정리를 `return` 앞마다 되풀이하지 않는다.

예) 드래그한 항목을 목록에 놓는 처리 140줄(복잡도 58)을 두 부분으로 나눈다. 판정은 `judgeDrop()` 하나로 묶고, 그 안에서 규칙 함수 5개(`rejectNestedItem` · `rejectLockedList` · `rejectWrongKind` · `checkScale` · `planApply`)를 차례로 부른다. 화면에 남는 처리 함수는 15줄이다.

## 2. 기능 단위로 나눈다 — 위치 순서로 자르지 않는다

- 파일 · 훅 · 컴포넌트는 **사용자가 보는 기능**이나 **도메인 개념** 단위로 나눈다. 예: 표 보기 · 상세 펼치기 · 범례 · 권한 칸 · 데이터 불러오기.
- 원래 함수를 문장 순서대로 잘라 `createX` · `partN` · `helpers2` 같은 조각을 만들지 않는다.
- 조각들이 값 수십 개를 담은 공용 묶음(`ctx` · `deps` · `c`)을 주고받게 하지 않는다.
- 나눈 단위는 필요한 입력만 받고 자기 결과만 돌려준다.
  - 매개변수 · 입력 객체의 칸은 **7개 이하**로 둔다. 화면 컴포넌트의 props 는 **12개 이하**로 둔다. 화면 컴포넌트는 표시 옵션 · 이벤트 props 가 함께 붙기 때문이다.
  - 넘으면 경계를 잘못 잡은 것이다. 묶음을 다시 나눈다.
- 이름은 하는 일을 말한다. 예: `useTableView` · `planExport`. 코드가 있던 위치를 따른 이름(`surfaceState` · `part2`)은 쓰지 않는다.

## 3. 같은 규칙은 한 곳에 둔다

- 두 화면 앱(React · Vue), 서버 · 화면처럼 같은 규칙이 여러 곳에 필요하면 공용 패키지의 순수 함수 한 벌로 둔다. 두 곳에 같은 코드를 복사하지 않는다. 「React 와 같게 맞춤」 같은 주석으로 동기화하는 방식도 쓰지 않는다.
- 두 벌을 유지해야 하는 화면 코드는 **같은 이름 · 같은 경계**로 나눈다. 한쪽에만 있는 부품은 그 까닭을 파일 머리 주석에 적는다.

## 4. 이름

- 한 글자 · 약어 이름(`d` · `f` · `src` · `tmp` · `cfg2`)을 쓰지 않는다.
  - 예외: 짧은 반복문의 `i` · `j`, 짧은 화살표 함수의 인자, 관례 이름(`e` · `err` · `ctx` 는 그 프레임워크의 관례일 때만)
- 불리언은 `is` · `has` · `can` · `should` 로 시작한다.
- 함수 이름은 동사로 시작한다.
- 같은 개념은 저장소 전체에서 한 이름으로 부른다. 용어집이 있으면 그 이름을 쓴다.

## 5. 주석

- 주석에는 **무엇 · 왜**를 쓴다. 코드를 그대로 옮긴 설명(「i 를 1 늘린다」)은 쓰지 않는다.
- 이력은 주석에 두지 않는다. 버전 번호 · 티켓 · 작업 번호 · 「누가 언제 왜 넣었나」 · 설계 문서 줄 번호(`1.8.7 —` · `B5:` · `F-22 AC1` · `Design L2390`)는 git 기록과 설계 문서에 둔다.
  - 규칙의 근거 문서를 가리켜야 하면 절 이름 하나만 적는다. 예: `(설계 09-07 §4)`
- 한 저장소 안에서 주석 언어는 하나로 맞춘다. 코드 이름만 원문으로 둔다.
- **파일 머리 주석 3줄**: 이 파일이 맡는 일 · 부르는 곳 · 먼저 읽을 파일. 새 파일은 반드시 둔다. 고치는 기존 파일에 없으면 더한다.

## 6. 읽는 길

- 도메인 폴더(서버 도메인 · 화면 영역)마다 `README.md` 한 쪽을 둔다. 내용은 「여기서 무엇을 하나 · 들어오는 곳 · 요청이 거치는 순서 · 먼저 읽을 파일」이다.
- 폴더를 새로 만들거나 흐름을 바꾸면 같은 변경에서 고친다.
- 다시 내보내기(re-export)로 옛 경로를 살려 두지 않는다. 가져다 쓰는 곳을 고친다. 패키지 공개 진입점만 예외다.

## 7. 완료 점검 — 처음 보는 사람 기준

기능을 추가 · 수정하거나 나누는 변경을 마치면, 그 영역을 처음 보는 사람이 받을 법한 과제 1 ~ 3개를 정한다. 예: 「잠긴 목록에 놓을 때 나오는 문구를 바꿔라」. 그 과제로 아래를 확인한다.

| 기준 | 통과 조건 |
|---|---|
| 고칠 곳을 찾기까지 열어 본 파일 수 | 3개 이하 |
| 고칠 곳을 찾기까지 읽은 줄 수 | 300줄 이하 |
| 같은 규칙을 두 곳 이상 고쳐야 하나 | 아니오 |
| 고친 뒤 바꿀 테스트 | 그 규칙의 테스트 몇 줄 |

통과하지 못하면 그 변경 안에서 경계를 다시 잡는다. 큰 변경 · 리팩토링은 이 점검을 다른 맥락(서브에이전트)에서 적대적으로 한다.

점검 절차:

1. 변경한 영역과 상관없는 맥락(새 서브에이전트 등)에서 시작한다. 변경 설명은 주지 않고 과제만 준다.
2. 과제를 푸는 동안 열어 본 파일 수와 읽은 줄 수를 센다.
3. 과제를 푼 뒤, 바꿔야 했던 규칙이 몇 곳에 있었는지, 그 규칙의 테스트를 몇 줄 고쳤는지 센다.
4. 위 표의 통과 조건과 견준다. 하나라도 넘으면 파일 경계 · 규칙 위치를 다시 잡고 같은 과제로 다시 점검한다.

## 고치기 전 · 후 예시

### 예 1. 긴 판정 함수를 규칙 함수로 나누기

고치기 전 — 판정과 실행이 섞여 있고, 정리 동작이 `return` 마다 되풀이된다.

```ts
function onDrop(event: DropEvent, state: ListState) {
  if (event.item.parentId) {
    state.dragging = false;
    showMessage("중첩된 항목은 놓을 수 없습니다");
    return;
  }
  if (state.list.locked) {
    state.dragging = false;
    showMessage("잠긴 목록입니다");
    return;
  }
  if (state.list.kind !== event.item.kind) {
    state.dragging = false;
    showMessage("종류가 다릅니다");
    return;
  }
  // ... 규칙이 더 이어지고, 중간에 실제 저장도 섞여 있다
  state.list.items.push(event.item);
  save(state.list);
  state.dragging = false;
}
```

고친 후 — 규칙은 순수 함수로, 처리 함수는 「읽기 → 판정 → 결과대로 하기」만 한다.

```ts
type DropVerdict =
  | { kind: "reject"; message: string }
  | { kind: "apply"; nextItems: Item[] };

const rejectNestedItem = (item: Item): DropVerdict | null =>
  item.parentId ? { kind: "reject", message: "중첩된 항목은 놓을 수 없습니다" } : null;

const rejectLockedList = (list: List): DropVerdict | null =>
  list.locked ? { kind: "reject", message: "잠긴 목록입니다" } : null;

const rejectWrongKind = (list: List, item: Item): DropVerdict | null =>
  list.kind !== item.kind ? { kind: "reject", message: "종류가 다릅니다" } : null;

export function judgeDrop(list: List, item: Item): DropVerdict {
  return (
    rejectNestedItem(item) ??
    rejectLockedList(list) ??
    rejectWrongKind(list, item) ?? { kind: "apply", nextItems: [...list.items, item] }
  );
}

function onDrop(event: DropEvent, state: ListState) {
  try {
    const verdict = judgeDrop(state.list, event.item);
    if (verdict.kind === "reject") return showMessage(verdict.message);
    state.list.items = verdict.nextItems;
    save(state.list);
  } finally {
    state.dragging = false; // 정리는 한 곳에서 한 번만
  }
}
```

규칙을 고칠 때는 해당 규칙 함수와 그 테스트 몇 줄만 바꾼다.

### 예 2. 순서대로 자른 조각을 기능 단위로 다시 묶기

고치기 전 — 120줄 훅을 문장 순서대로 세 조각으로 잘랐다. 조각들이 값 수십 개가 든 `ctx` 를 주고받아서, 기능 하나를 고치려면 세 파일을 모두 열어야 한다.

```ts
// useReportPart1.ts
export function createReportPart1(ctx: ReportCtx) { /* 불러오기 + 필터 + 정렬의 앞부분 */ }
// useReportPart2.ts
export function createReportPart2(ctx: ReportCtx) { /* 정렬의 뒷부분 + 내보내기 앞부분 */ }
// useReportPart3.ts
export function createReportPart3(ctx: ReportCtx) { /* 내보내기 뒷부분 + 범례 */ }
```

고친 후 — 사용자가 보는 기능마다 훅 하나를 두고, 각 훅은 필요한 입력만 받는다.

```ts
// useReportData.ts    — 데이터 불러오기. 입력: reportId, filters
// useReportSort.ts    — 정렬 상태와 정렬 결과. 입력: rows
// useReportExport.ts  — 내보내기 계획과 실행. 입력: rows, format
// useReportLegend.ts  — 범례 표시. 입력: series
```

「정렬 기준을 바꿔라」라는 과제는 `useReportSort.ts` 한 파일에서 끝난다.

### 예 3. 이름 · 주석

| 고치기 전 | 고친 후 | 이유 |
|---|---|---|
| `const d = getData();` | `const orderRows = fetchOrderRows();` | 한 글자 이름과 동사 없는 함수 이름 |
| `const cfg2 = merge(cfg, o);` | `const mergedSettings = mergeSettings(baseSettings, overrides);` | 약어 · 번호 붙은 이름 |
| `const locked = list.locked;` | `const isLocked = list.locked;` | 불리언은 `is` · `has` · `can` · `should` 로 시작 |
| `function surfaceState() {}` | `function useTableView() {}` | 코드 위치가 아니라 하는 일을 이름으로 |
| `// i 를 1 늘린다` | (삭제) | 코드를 그대로 옮긴 주석 |
| `// 1.8.7 — 합계 줄 추가 (B5)` | `// 합계 줄은 숨긴 열을 뺀 값을 쓴다. 보이는 값과 합이 맞아야 하기 때문이다.` | 이력 표식은 git 기록에 두고, 주석에는 무엇 · 왜를 쓴다 |
| `// Design L2390 참고` | `// 기준 문서: 설계 09-07 §4` | 줄 번호 대신 절 이름 하나 |
| (머리 주석 없음) | `// 맡는 일: 주문 목록 내보내기 계획 / 부르는 곳: ExportDialog / 먼저 읽을 파일: exportTypes.ts` | 새 파일은 머리 주석 3줄 |

## 자동 검사로 막을 수 있는 것과 막기 어려운 것

원칙은 「기존 위반은 늘지 않게, 새 코드는 0」이다. 규칙을 경고로만 켜면 게이트가 아니다. 위반이 0 인 규칙은 오류로 올리고, 0 이 아닌 규칙은 래칫(`ratchet.md` 의 「가독성 검사를 래칫에 붙이기」)으로 관리한다.

### 막을 수 있는 것

| 막을 대상 | 대표 도구 설정 예 |
|---|---|
| 매개변수가 7개를 넘는 함수 | ESLint `max-params: ["error", 7]`. 위반이 있으면 목록을 json 으로 뽑아 기준선과 견준다 |
| 칸이 7개를 넘는 입력 객체 하나를 받는 함수 | 기본 규칙이 없으므로 직접 만든 지표를 쓴다. TypeScript 컴파일러 API 로 객체 구조분해 매개변수 · 매개변수 타입의 프로퍼티 수를 센다 |
| props 가 12개를 넘는 화면 컴포넌트 | 위와 같은 직접 만든 지표로 React 함수 컴포넌트의 props 타입 · Vue `defineProps` 의 칸을 센다. 기준은 일반 함수(7)와 따로 둔다 |
| 한 글자 · 금지 약어 식별자 | ESLint `id-length: ["error", { min: 2, exceptions: ["i", "j"] }]` 와 `id-denylist: ["error", "tmp", "cfg2", "src"]` |
| 주석 안의 이력 표식(버전 번호 · 티켓 · 작업 번호 · 설계 문서 줄 번호) | ESLint `no-warning-comments` 로 `TODO` 류를 막고, 이력 표식은 주석 본문에 정규식(`\b\d+\.\d+\.\d+\b —` · `\b[A-Z]{1,3}-?\d+\b:` · `L\d{2,}`)을 거는 직접 만든 검사 |
| 새 파일의 머리 주석 누락 | 직접 만든 검사. `git diff --diff-filter=A` 로 새 파일을 모아 첫 줄이 주석인지 확인한다. 또는 `eslint-plugin-header` 의 `header/header` |
| 옛 경로 다시 내보내기 | ESLint `no-restricted-syntax` 로 `export * from` · `export { x } from` 를 막고 패키지 공개 진입점만 예외 처리, 또는 `dependency-cruiser` 규칙 |

### 막기 어려운 것

- 판정과 실행이 섞였는지
- 기능 단위로 나눴는지, 위치 순서로 잘랐는지
- 이름이 하는 일을 말하는지
- 주석이 무엇 · 왜를 말하는지

이 기준은 자동으로 재기 어렵다. 코드 검수와 위의 7번 점검(처음 보는 사람 기준)에서 본다.
