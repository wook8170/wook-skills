# 래칫 검사를 저장소에 세우는 방법

래칫은 「지금 수치를 기준선으로 잠그고, 늘면 실패, 같거나 줄면 통과」하는 검사다. 기존 위반을 한꺼번에 고치지 않아도 게이트를 바로 켤 수 있다. 그리고 위반이 줄 때마다 기준선이 따라 내려간다.

## 1. 순서

1. **측정**: 대상 소스(시험 · 생성물 · 선언 파일 제외)를 읽어 항목별 수치를 낸다. 파일별 값(줄 수 · 빈 catch 수 · console 수 · DB 직접 호출 수)과 함수별 값(줄 수 · 복잡도 · 중첩 · 훅 수), 목록 값(서버 최상위 파일 · 순환 묶음)으로 나눈다.
2. **기준선 json**: 상한을 넘은 것만 담는다(파일 경로 → 값, 파일 → 함수 키 → 값). 커밋해서 변경 이력에 남긴다.
3. **판정**:
   - 기준선에 없는 파일 · 함수는 상한을 지켜야 한다.
   - 기준선에 있는 것은 기준선 값 + 허용 폭을 넘으면 실패한다. 허용 폭은 줄 수에만 작게 둔다(예: 파일 +20 · 함수 +10, 복잡도 · 훅 수 등은 0). 작은 버그 수정마다 재잠금하는 마찰을 줄이기 위해서다.
   - 순환은 「새 파일이 순환 묶음에 들어오거나, 기존 묶음끼리 합쳐지면」 실패한다.
4. **명령 세 개**: 보고(항상 exit 0) · 게이트(`--ci`, 늘면 exit 1) · 재잠금(`--update-baseline`). 게이트는 저장소의 묶음 게이트(`gate` · CI)에 넣는다. 측정기의 단위 시험을 게이트 앞에 붙인다.
5. **재잠금 규칙**: 줄었을 때만 재잠금한다. 늘어난 값을 재잠금으로 덮으면, 그 변경 설명에 이유를 적고 검토를 받는다.

## 2. 함수 키 정하기

- 키 = `파일 경로 + 바깥 함수 이름 > 함수 이름 + 같은 이름이 또 나오면 #2 · #3`.
- **줄 번호를 키에 넣지 않는다.** 위쪽에 한 줄만 더해도 모든 키가 바뀌기 때문이다.
- 이름 없는 콜백은 부른 곳으로 이름을 붙인다(예: `app.get(/users)=>`, `items.map=>`).
- 이름이 바뀐 함수는 같은 파일에서 짝이 없는 기준선 함수 가운데 수치가 넘지 않는 것과 맞춰 본다. 맞으면 통과로 처리하고 「이름 바뀜」으로 보고한다.

## 3. 도구 고르기 — 저장소에 이미 있는 것을 먼저

| 언어 | 크기 · 복잡도 | 경계 · 계층 | 순환 |
|---|---|---|---|
| TypeScript · JavaScript | ESLint `max-lines` · `max-lines-per-function` · `complexity` · `max-depth` (규칙 자체는 래칫이 없으므로 위반 목록을 json 으로 뽑아 기준선과 비교) 또는 TypeScript 컴파일러 API 로 직접 측정 | ESLint `no-restricted-imports` · `import/no-restricted-paths`, 또는 `dependency-cruiser` 규칙 | `dependency-cruiser` · `madge --circular`, 또는 import 그래프 + Tarjan 강연결 요소 |
| Python | `radon cc` · `radon raw`, `ruff` 의 `C901` · `PLR0915` | `import-linter`(계층 계약) | `pydeps --show-cycles`, `import-linter` |
| Go | `gocyclo` · `gocognit`, `golangci-lint` 의 `funlen` | `depguard` | 컴파일러가 순환 import 를 막는다 |
| Java · Kotlin | Checkstyle `MethodLength` · `CyclomaticComplexity`, detekt | ArchUnit 계층 규칙 | ArchUnit `slices().should().beFreeOfCycles()` |
| Rust | `clippy::too_many_lines` · `cognitive_complexity` | 크레이트 · 모듈 공개 범위 | 크레이트 사이 순환은 빌드가 막는다 |

- 새 의존은 최소로 들인다. 저장소에 TypeScript 가 있으면 컴파일러 API 만으로 줄 수 · 함수 · 복잡도 · import 그래프를 모두 잴 수 있다.
- ESLint 규칙을 「경고」로만 켜면 게이트가 아니다. 위반이 0 인 규칙은 바로 「오류」로 올리고, 0 이 아닌 규칙은 래칫으로 관리한다.

## 4. 기준선 파일 모양(예)

```json
{
  "$schema": "structure-lint baseline v1",
  "updated": "2026-11-11",
  "limits": { "fileLines": 500, "fn": { "warn": 60, "fail": 100 } },
  "totals": { "filesOverLimit": 490 },
  "files": { "src/big.ts": 2100 },
  "functions": { "src/big.ts": { "handle>step": { "kind": "fn", "lines": 240, "cx": 31, "depth": 5, "hooks": 0 } } },
  "emptyCatch": { "src/a.ts": 3 },
  "serverTop": ["src/app.ts"],
  "cycles": [["src/a.ts", "src/b.ts"]]
}
```

## 5. 시험으로 확인할 것

줄 수 계산 · 함수 길이 · 위에 줄이 늘어도 키가 같은지 · 늘면 실패 · 줄면 통과(재잠금 안내) · 새 함수 상한 · 이름 바뀜 처리 · 새 순환 · 재잠금 뒤 새 값이 기준이 되는지.
