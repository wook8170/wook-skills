---
name: handoff
description: Commit all WIP, move finished history to docs/progress-archive/, and rewrite progress.md as a short current-state file (status, open branches/PRs, running jobs, exact resume commands), commit it, then stop. Use when the user says 「핸드오프」「멈춰」「정리하고 넘겨」「handoff」, or before limits/context run out.
---

> 프로젝트 설정: 프로젝트 루트의 `.claude/skills-config/handoff.md` 가 있으면 먼저 읽는다. 없으면 이 문서의 기본값과 범용 절차를 쓴다.

# handoff — 재개 가능한 핸드오프 남기기

1. 작업 중 변경을 보존한다. 활성 워크트리마다 `git status --short` 를 보고, 미커밋 변경이 있으면 `wip: <무엇>` 접두사로 커밋한다(push 는 하지 않는다). 다른 세션·에이전트가 쓰는 워크트리는 건드리지 않고 목록에만 적는다. `git stash` 는 쓰지 않는다.
2. 돌고 있는 것을 기록한다: 실행 중인 서브에이전트·백그라운드 작업(무엇을, 어느 워크트리에서), 떠 있는 서버(포트·워크트리·PID), 진행 중 게이트·빌드(결과 파일 경로).
3. `progress.md` 는 **현재 상태만 담는 파일**이다(목표 300줄 이하 — 새 세션이 처음부터 끝까지 읽을 수 있어야 한다). 누적하지 않는다.
   - 먼저 지금 내용 중 **끝난 것**(완료된 웨이브·병합 기록, 해소된 확인 대기, 더는 맞지 않는 상태)을 `docs/progress-archive/progress-<YYYY-MM>.md` 끝에 `## <YYYY-MM-DD HH:MM> — <요지>` 절로 덧붙인다(폴더·파일이 없으면 만든다). 이력은 버리지 않는다.
   - 그다음 `progress.md` 를 통째로 다시 쓴다. 맨 위에 아카이브 위치와 검색 방법(`grep -n '<키워드>' docs/progress-archive/*.md`) 한 줄, 이어서 아래 절:
     - 목표와 오너 결정(아직 유효한 것만)
     - 브랜치와 서버(통합 HEAD, 떠 있는 서버 포트·워크트리·기동 방법)
     - 진행 중(브랜치·워크트리·담당 작업·상태·보고서 경로)
     - 다음 할 일(순서)과 main 머지 조건
     - 확인 대기(오너 결정 사항)
     - 시스템 지식(지금 유효한 함정·환경)
     - **정확한 재개 명령**(복붙 가능한 명령과 다음에 시킬 일)
   - 이미 누적형으로 커진 `progress.md`(300줄 초과)를 만나면 통째로 `docs/progress-archive/progress-until-<YYYY-MM-DD>.md` 로 `git mv` 한 뒤 위 형식으로 새로 쓴다. 저장소에 문서 목록 점검(예: `docs/INDEX.md`)이 있으면 새 폴더를 등재한다.
   - 자동 블록(예: waves checkpoint 가 맨 위에 넣는 블록)이 있으면 그대로 둔다.
4. `progress.md` 와 아카이브 파일을 함께 커밋한다(저장소 규약의 트레일러 포함). 다른 작업이 같은 체크아웃에서 병합·게이트를 돌리는 중이면 그 작업에 넘겨 함께 커밋하게 하고, 그 사실을 보고한다.
5. 사용자에게 한 번만 보고한다(커밋 해시, 재개 방법, `/clear` 가능 여부 — 백그라운드 작업이 남아 있으면 그 결과를 받기 전 `/clear` 하지 말라고 알린다). **그리고 멈춘다.** 같은 상태 메시지를 반복하지 않는다.
