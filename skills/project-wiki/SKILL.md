---
name: project-wiki
description: 저장소의 개발 문서 · 설계 문서 · 결정 기록 · 운영 절차 · 산출물을 절 단위 위키 색인으로 만들고, 문서 질문에서 파일을 훑기 전에 그 색인을 먼저 검색하게 한다. init 으로 문서 폴더를 찾아 설정을 만들고, build 로 색인을 만들고, search · read · backlinks 로 근거를 모은다. 낡음 표시가 붙은 결과는 코드와 git 로그로 다시 확인한다. 「위키 만들어」「문서 색인」「문서 찾아」「설계 문서에 뭐라고 돼 있어」「왜 이렇게 했지」「결정 이력」「운영 절차」「정책」「용어」「산출물」 같은 요청이나, 서브에이전트에 문서 조사를 맡길 때 사용.
---

> 프로젝트 설정: 프로젝트 루트의 `.claude/skills-config/project-wiki.md` 가 있으면 먼저 읽는다. 위키 위치, 명령, MCP 서버 이름, 원천, 등급 · 영역 옵션, 낡음 표시를 다루는 법이 거기에 있다. 없으면 아래 「만들기」부터 한다.

# project-wiki — 문서 질문은 위키부터

문서 · 설계 · 결정 이력은 여러 폴더에 흩어져 있다. 폴더를 `Read` 로 훑으면 호출이 많이 들고 놓치는 문서도 생긴다. 그래서 문서를 절(`##` · `###`) 단위로 나눈 색인을 만들어 두고, 문서 질문은 이 색인을 먼저 검색한다.

색인기는 이 스킬 폴더의 `bin/wiki-index.mjs` 한 파일이다. Node 22 이상만 있으면 되고 설치할 의존성이 없다. 아래 명령의 `<wiki-index>` 는 `node <이 스킬의 Base directory>/bin/wiki-index.mjs` 를 뜻한다.

## (a) 프로젝트 설정을 먼저 읽는다

1. `.claude/skills-config/project-wiki.md` 를 읽는다. 위키 폴더(기본 `.wiki/`)와 명령이 적혀 있다.
2. 설정 문서가 프로젝트 고유 색인기 명령을 적어 두었으면 그 명령을 쓴다(아래 (g)).
3. 설정 문서도 `.wiki/config.json` 도 없으면 (b) 로 위키를 만든다. 사용자가 저장소 파일을 바꾸지 말라고 했으면 `--wiki-dir` 로 저장소 밖에 만든다.

## (b) 만들기: init → build

```bash
node <wiki-index> init            # 저장소 루트에서. 문서 폴더를 찾아 설정을 만든다
node <wiki-index> build           # 색인을 .wiki/index/ 에 만든다
```

`init` 이 하는 일은 다음과 같다. 이미 있는 파일은 덮어쓰지 않는다.

- 문서 폴더(`docs/` · `design/` · `adr/` · `decisions/` · `rfcs/` · `wiki/` · `guides/` · `runbooks/` 등)를 원천으로 잡는다. 결정 · 운영 · 설계 하위 폴더(`docs/adr/` 등)는 영역(`decision` · `ops` · `design`)을 단 원천으로 따로 뗀다.
- 맨 위 Markdown(`README.md` 등)은 `root`, 그 밖 폴더의 Markdown 은 `other` 원천이 된다. 의존성 · 빌드 산출물 · 숨김 폴더는 뺀다.
- `.wiki/config.json`(설정, 커밋한다), `.claude/skills-config/project-wiki.md`(프로젝트 설정 문서), `.gitignore` 의 `.wiki/index/` 줄을 만든다.
- 기본값: 등급 `internal`, 묶음 상한 `confidential`, 비밀값이 든 문서는 격리(`security.onSecret: "quarantine"`).

`init` 결과의 원천 목록을 사용자에게 보이고, 빠진 폴더나 넣지 말아야 할 폴더가 있으면 `.wiki/config.json` 을 고친다. 설정 항목은 `reference/config.md` 에 있다.

색인 폴더(`.wiki/index/`)는 언제든 다시 만들 수 있는 생성물이다. 커밋하지 않는다.

## (c) 쓰기: search → read → backlinks

코드의 위치 · 흐름 · 호출 관계 · 변경 영향은 이 스킬이 아니다. 그것은 codegraph 가 먼저다. 정확한 줄 번호 · 문자열은 `rg -a` 로 확인한다. 문서와 코드를 함께 물으면 문서는 위키로, 코드는 codegraph 로 따로 찾는다.

1. **도구를 고른다.** 설정 문서에 적힌 MCP 서버의 도구(`wiki_search` · `wiki_read` · `wiki_backlinks`)가 이 세션에 떠 있으면 그것을 쓴다. 없으면 CLI 를 쓴다.
2. **검색한다.** `node <wiki-index> search "질의"`. 결과가 너무 많거나 엉뚱하면 `--area` · `--exclude-area` · `--level` 로 좁히고, 핵심어를 바꿔 한 번 더 찾는다. `--json` 이면 기계가 읽기 좋은 결과가 나온다.
3. **읽는다.** 상위 결과 몇 건을 `node <wiki-index> read <조각 ID>` 로 읽는다. 제목과 첫 문장만 보고 답하지 않는다. 앞뒤 절이 필요하면 `--context`, 문서 전체는 페이지 ID(`#` 앞부분)로 읽는다.
4. **역참조한다.** 결정의 이유나 영향이 더 필요하면 `node <wiki-index> backlinks <ID>` 로 그 문서를 가리키는 문서를 찾아 읽는다. 코드 파일을 가리키는 문서는 `backlinks code:<경로>` 로 찾는다.
5. **원문으로 확인한다.** 줄 번호나 최신 여부가 필요하면 원문 파일을 `rg -a` 로 연다.
6. **근거를 붙인다.** 답마다 조각 ID 나 `파일 경로 + 절 제목`을 붙인다. 위키에서 찾지 못한 내용은 「문서에서 확인하지 못했다」고 쓰고 추측으로 채우지 않는다.

검색 · 읽기 · 역참조는 원천 폴더가 지난 빌드 뒤 바뀌었으면, 바뀐 문서만 다시 나눠 색인을 새로 만든 뒤 답한다(표준 오류에 `색인 새로 고침 · 다시 나눈 문서 N` 한 줄). 지금 색인 그대로 답하게 하려면 `--no-refresh` 를 붙인다.

## (d) 낡음 표시 다루기

- 결과에 `[stale]` · `[stale-candidate]` 가 붙으면, 문서 머리말의 근거 파일(`sources`)이 문서의 기준 커밋(`base_commit`) 뒤에 바뀌었다는 뜻이다.
- 이 표시가 있으면 문서를 그대로 믿지 않는다. 문서가 말하는 코드와 `git log` 로 다시 확인하고, 어긋나면 그 사실을 답에 적는다.
- `node <wiki-index> stale` 은 결정 · 정책 문서(`area: decision|policy`, `status: current`)의 근거가 바뀌었는지 판정한다. 출하를 막을 문서가 있으면 종료 코드 1 이다.
- 문서를 코드와 다시 맞췄으면 `node <wiki-index> mark-synced <문서 경로>` 로 기준 커밋 칸을 HEAD 로 쓴다. 커밋은 하지 않는다.
- 문서와 코드가 다르면 코드가 기준이다. 문서 고치기는 사용자에게 제안한다.

## (e) MCP 로 쓰기

저장소 `.mcp.json` 에 다음을 더하면 세션에서 도구 3종(`wiki_search` · `wiki_read` · `wiki_backlinks`)을 쓸 수 있다. 서버는 질의 때 바뀜을 확인하고, 부하가 낮을 때 뒤에서 색인을 다시 만든다. 그동안은 이전 색인으로 답하고 결과 첫 줄에 기준 줄(`기준 <커밋> · 미커밋 N편`)을 붙인다.

```json
{
  "mcpServers": {
    "wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["<이 스킬 폴더>/bin/wiki-index.mjs", "serve-mcp", "--root", "${CLAUDE_PROJECT_DIR:-.}"]
    }
  }
}
```

고정된 묶음을 띄우려면 `serve-mcp --bundle <묶음 폴더>` 를 쓴다. 등급 상한은 `--level`, 영역 제한은 `--area` · `--exclude-area` 로 띄울 때 정한다. 도구 인자로는 범위를 넓힐 수 없다.

## (f) 서브에이전트 지시문

서브에이전트는 이 스킬을 자동으로 읽지 않는다. 문서 조사를 맡길 때 지시문에 아래 문구를 넣는다.

> 문서 · 설계 · 운영 규칙 · 결정 이력은 파일을 훑기 전에 `.claude/skills-config/project-wiki.md` 를 읽고, 거기 적힌 위키(MCP 도구 `wiki_search` 또는 `node <wiki-index> search "질의"`)로 먼저 검색한다. 상위 결과를 read 로 읽고, 필요하면 backlinks 로 역참조한다. 낡음 표시(`[stale]` · `[stale-candidate]`)가 붙은 결과는 코드와 git 로그로 다시 확인한다. 답에는 조각 ID 나 파일 절을 붙인다. 코드 탐색은 codegraph 를 먼저 쓰고, 정확한 줄은 `rg -a` 로 확인한다.

`<wiki-index>` 자리에는 이 스킬의 `bin/wiki-index.mjs` 절대 경로를 넣어 준다.

## (g) 프로젝트가 자기 색인기를 가진 경우

프로젝트가 자체 색인기를 두고 있으면(예: gstudio 의 `pnpm wiki:search` · `pnpm wiki:read` · `pnpm wiki:backlinks`, MCP 서버 `wiki`), 설정 문서에 적힌 그 명령을 그대로 쓴다. 이 스킬의 `init` · `build` 를 돌리지 않는다. 쓰는 순서((c) · (d))와 서브에이전트 문구((f))는 같다. 예시는 `reference/gstudio-example.md` 에 있다.

## 설정이 없을 때

- 사용자가 위키를 만들지 말라고 했거나 만들 수 없는 상황이면, 문서 폴더(`docs/` 등)를 `rg -a` 로 찾는다. 그리고 「이 저장소에는 문서 위키가 없어 파일을 직접 찾았다」고 한 줄 알린다.

## 하지 않는 것

- 위키 결과만 믿고 코드 동작을 단정하지 않는다.
- 색인 폴더(`.wiki/index/`)를 커밋하지 않는다.
- 사용자 확인 없이 `.wiki/config.json` 의 등급 · 상한을 낮추지 않는다.

## 색인기 다시 묶기 · 시험

원본은 `src/`(TypeScript)다. 고친 뒤 `node scripts/build-wiki-index.mjs` 로 `bin/wiki-index.mjs` 를 다시 묶고, `--check` 로 묶은 파일이 원본과 맞는지 본다. 시험은 `node --test test/*.test.ts` 이고, `WIKI_INDEX_BIN=bin/wiki-index.mjs` 를 주면 묶은 파일로 같은 시험을 돌린다. 자세한 내용은 `reference/config.md` 「색인기 개발」에 있다.
