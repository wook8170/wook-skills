---
name: pickup
description: Resume work from the progress.md handoff — read the latest handoff, check git/worktree/server state, flag stale items, and summarize done / in-progress / blocked / next before doing anything. Use at session start or when the user says 「이어받아」「핸드오프 이어서」「pickup」.
---

> 프로젝트 설정: 프로젝트 루트의 `.claude/skills-config/pickup.md` 가 있으면 먼저 읽는다. 없으면 이 문서의 기본값과 범용 절차를 쓴다.

# pickup — 핸드오프 이어받기

1. 프로젝트 루트의 `progress.md` 를 읽는다. 맨 위(가장 최근) 핸드오프 절을 정독하고, 그 절이 가리키는 문서·브랜치·워크트리를 확인 목록으로 뽑는다.
2. 저장소 상태를 확인한다.
   - `git status` · `git worktree list` · `git log --oneline -10 main` (그리고 `git fetch -q` 후 `origin/main` 과의 차이)
   - 핸드오프에 적힌 작업 브랜치마다 `git log --oneline -3 <branch>` 와 미커밋 변경 여부
   - 메인 체크아웃(워크트리 밖의 원래 체크아웃)에 미커밋 핸드오프가 남아 있는지(`git -C <메인 체크아웃> status`)
3. 핸드오프에 적힌 서버·포트·백그라운드 작업이 실제로 떠 있는지 확인한다(`lsof -nP -iTCP:<port> -sTCP:LISTEN`, `curl -s -o /dev/null -w '%{http_code}' <health>`, `ps`). 어느 워크트리에서 떠 있는지도 본다(다른 워크트리의 낡은 코드를 서빙하는 경우가 잦다).
4. 오래된(stale) 것을 표시한다: main 보다 뒤처진 워크트리, 이미 머지됐는데 남은 브랜치·워크트리, 꺼졌거나 다른 코드를 서빙하는 서버, 핸드오프와 실제 상태가 다른 항목.
5. 사용자에게 한국어로 요약한다 — **완료 / 진행 중 / 막힘·확인 대기 / 다음 즉시 할 일**, 그리고 stale 목록. **여기서 멈추고 진행 승인을 기다린다.** 요약 전에 코드를 고치거나 서브에이전트를 띄우지 않는다.
