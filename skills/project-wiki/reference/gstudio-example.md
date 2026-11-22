# 프로젝트 설정 예: 자기 색인기를 가진 저장소(gstudio)

gstudio 는 저장소 안에 자기 색인기(`packages/wiki-indexer`)와 위키 명령을 따로 둔다. 이런 저장소는 이 스킬의 `init` · `build` 를 돌리지 않고, 설정 문서에 적은 명령을 그대로 쓴다. 쓰는 순서(검색 → 읽기 → 역참조 → 낡음 확인)와 서브에이전트 문구는 같다.

아래 내용을 저장소의 `.claude/skills-config/project-wiki.md` 로 둔다.

```markdown
# project-wiki 설정

이 저장소는 자기 색인기를 쓴다. `wiki-index init` · `build` 를 돌리지 않는다.

## 명령

| 할 일 | 명령 |
|---|---|
| 찾기 | `pnpm -s wiki:search "<질의>" [--limit n] [--level <등급>] [--area <영역>]` |
| 읽기 | `pnpm -s wiki:read <ID>` |
| 가리키는 곳 | `pnpm -s wiki:backlinks <ID>` |

명령은 작업 트리 모드로 돈다. 색인이 HEAD 보다 오래되면 경고 한 줄을 내고, MCP 서버가 뒤에서 다시 만든다.

## MCP

- 서버 이름: `wiki`(`.mcp.json` → `scripts/dev-wiki/mcp.sh`)
- 이 서버의 도구(`wiki_search` · `wiki_read` · `wiki_backlinks`)가 세션에 떠 있으면 CLI 보다 먼저 쓴다.

## 원천

- 개발 문서(`docs/manual/`), 설계 산출물, 운영 문서, 결정 기록
- 개발 세션에서는 운영 영역(`ops`)을 빼고 찾는다(설정의 `devSession.excludeAreas`).

## 낡음 표시

- `[stale]` · `[stale-candidate]` 가 붙은 결과는 원문 파일을 `rg -a` 로 열어 보고, 문서가 말하는 코드와 `git log` 로 다시 확인한다.

## 색인기가 없는 폴더

- 색인기는 저장소 작업 트리 안에만 있다. 다른 폴더에서는 저장소 작업 트리로 이동해 명령을 돌린다.
```

## 이 스킬의 색인기와 다른 점

| 항목 | 이 스킬(`bin/wiki-index.mjs`) | gstudio 색인기 |
|---|---|---|
| 원천 | 일반 Markdown(`markdown` 어댑터) | 일반 Markdown + 저장소 전용 어댑터(설계 산출물 · 개발 문서 머리 형식 등) |
| 설정 위치 | `.wiki/config.json` | 저장소 안 색인기 패키지의 설정 파일 |
| 색인 위치 | `.wiki/index/` | 사용자 캐시 폴더 |
| 명령 | `node <wiki-index> search …` | `pnpm -s wiki:search …` |
| 묶음 형식 | `formatVersion` 1 | `formatVersion` 1(같은 형식이라 `search <묶음 폴더>` 로 서로 읽을 수 있다) |
