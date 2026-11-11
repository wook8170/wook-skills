# wook-skills

[English](README.md) | 한국어

개발 업무에 쓰는 Claude Code 스킬 10개를 플러그인 하나로 묶었다.

- 버전: **0.1.0**
- 사용권: MIT · 저자: 장욱 (Wook Jang)

## 스킬 목록

요청이 스킬 설명과 맞으면 Claude 가 스킬을 알아서 불러온다. 직접 부르려면 `/wook-skills:<이름>` 을 입력한다.

| 스킬 | 하는 일 | 부르는 방법 |
|---|---|---|
| `handoff` | 작업 중 변경을 커밋하고, 끝난 이력을 `docs/progress-archive/` 로 옮긴다. 그다음 `progress.md` 를 현재 상태와 재개 명령만 담은 짧은 파일로 다시 쓰고 멈춘다 | 「핸드오프」「멈춰」, `/wook-skills:handoff` |
| `pickup` | 최신 `progress.md` 핸드오프를 읽고 git · 워크트리 · 서버 상태를 확인한다. 낡은 항목을 표시하고, 요약한 뒤에 작업을 시작한다 | 「이어받아」, `/wook-skills:pickup` |
| `work-status` | 현재 상태를 읽기 전용으로 보여 준다(main · 태그 · 게이트 표식 · 워크트리 · 병합 안 된 브랜치 · 열린 PR · 떠 있는 서버 · 무거운 작업) | 「현황」「지금 상태」, `/wook-skills:work-status` |
| `code-structure-guard` | 새 코드의 크기 · 복잡도 상한과 계층 방향을 지키게 한다. 순환 의존과 빈 `catch` 를 막고, 래칫 검사를 세우는 방법도 담았다 | 코드 작성 · 리팩토링 요청, `/wook-skills:code-structure-guard` |
| `readable-korean` | 한국어 글을 읽기 어렵게 만드는 네 가지 형태를 찾아 고친다 | 「문장 다듬어」「교정」, `/wook-skills:readable-korean` |
| `design-deliverables` | 설계 산출물 세트를 세우고 현행화한다(생성 장 · 요구사항 ID · 추적 · 화면 설계서) | 「설계 산출물」「현행화」, `/wook-skills:design-deliverables` |
| `pdf-typeset` | Markdown · HTML 원고를 A4 PDF 로 조판한다(차례 · 링크 · 책갈피 · 그림 배율 · 가로 쪽 · 다이어그램) | 「PDF 만들기」「조판」, `/wook-skills:pdf-typeset` |
| `glossary` | 화면 문구 · 매뉴얼 · 문서에 쓸 용어 사전을 두고, 용어 검사와 래칫을 게이트에 넣는다 | 「용어 사전」「금지어 검사」, `/wook-skills:glossary` |
| `retina-capture` | 화면을 2x 로 캡처한다(오프스크린 AppKit 방법, 헤드리스 Chrome · CDP 옵션) | 「캡처」「스크린샷」, `/wook-skills:retina-capture` |
| `ui-stability-harness` | 브라우저로 전 화면을 돌며 배치 · 겹 순서 · 초점 · 대비 · 옛 코드 서빙을 판정하는 하네스와 템플릿 | 「UI 안정성」, `/wook-skills:ui-stability-harness` |

## 설치

```bash
claude plugin marketplace add wook8170/claude-plugins
claude plugin install wook-skills@wook8170-plugins
```

같은 이름의 스킬이 `~/.claude/skills/` 에 있으면 개인 사본을 먼저 지우거나 이름을 바꾼다. 그대로 두면 두 벌이 함께 불려 온다.

## 프로젝트 설정 파일

게이트 표식 이름, 구조 검사 명령, 산출물 세트의 번호 체계, PDF 빌더 지도처럼 프로젝트마다 다른 값은 스킬 이름으로 된 파일에 적는다.

```
<프로젝트>/.claude/skills-config/<스킬 이름>.md
```

모든 `SKILL.md` 의 첫 줄은 이 파일을 먼저 읽으라고 지시한다. 파일이 없으면 스킬은 안에 적힌 기본값과 범용 절차를 쓴다.

| 스킬 | 설정 파일에 주로 적는 값 |
|---|---|
| `work-status` | `gate-stamp`(git 공용 디렉터리 안의 표식 파일 이름, 기본 `gate-pass`)와 `ports`(확인할 서버 포트, 기본 `3000 4173 5173 5174 8000 8080`). 스크립트는 ``- `gate-stamp`: `이름` `` 형식의 줄을 읽는다 |
| `code-structure-guard` | 래칫 명령 · 검사 범위 · 예외 폴더 · 기준선 수치 · 로거 위치 |
| `design-deliverables` | 산출물 폴더 위치 · 권 번호 체계 · 생성 명령 · 알려진 함정 |
| `pdf-typeset` | 빌더 지도(빌더 · 입력 · 출력 · 굽는 방법) · 명령 · 검사 · 보관 규칙 · 표 가로 쪽 지원 여부 |
| `ui-stability-harness` | 어댑터 값(선택자 · 저장소 키 · ID 접두)과 그 프로젝트의 적용 사례 |

나머지 스킬도 파일이 있으면 읽는다. 설정 파일은 Markdown 이라서 코드와 함께 버전 관리할 수 있다.

## 구성

```
.claude-plugin/plugin.json
skills/<스킬 이름>/SKILL.md      # 필요한 스킬은 reference/ · references/ · templates/ · scripts/ 를 함께 둔다
```

스크립트 경로는 스킬 폴더 기준이다. Claude Code 는 스킬을 불러올 때 이 폴더를 기본 디렉터리(Base directory)로 보여 준다.
