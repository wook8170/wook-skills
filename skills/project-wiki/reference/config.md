# project-wiki 설정 항목

위키 설정은 `.wiki/config.json` 한 파일이다. `init` 이 초안을 만들고, 사람이 고친다. 이 파일은 커밋한다. 색인 폴더 `.wiki/index/` 는 생성물이라 커밋하지 않는다.

## 설정 파일 예

```json
{
  "schema": 1,
  "bundle": { "name": "my-repo", "title": "my-repo 위키" },
  "pack": "core",
  "sources": [
    { "adapter": "markdown", "root": "docs", "include": ["docs/**/*.md"], "exclude": ["docs/adr/**"], "level": "internal", "idNamespace": "docs" },
    { "adapter": "markdown", "root": "docs/adr", "include": ["docs/adr/**/*.md"], "level": "internal", "idNamespace": "docs-adr", "area": "decision" },
    { "adapter": "markdown", "include": ["*.md"], "level": "internal", "idNamespace": "root" }
  ],
  "security": { "maxLevel": "confidential", "excludePaths": ["**/.env*"], "onSecret": "quarantine" }
}
```

## 맨 위 항목

| 항목 | 뜻 |
|---|---|
| `schema` | 설정 형식 버전. 지금은 `1` 만 받는다 |
| `bundle.name` | 묶음 이름. 영문 소문자 · 숫자 · `-` 로 40자 이하 |
| `bundle.title` | 사람이 읽는 위키 이름 |
| `pack` | 어댑터 묶음. 지금은 `core`(일반 Markdown)만 있다 |
| `sources` | 원천 목록(아래). 비어 있으면 설정 오류다 |
| `chunk` | 나누기 규칙. `maxChars`(조각 글자 상한, 기본 1800) · `overlapChars`(글자 수로 자를 때 겹침, 기본 150) · `tableRowsPerChunk`(표를 묶는 행 수, 기본 30) |
| `security` | 보안 검사(아래) |
| `noStatusBaseline` | 「상태를 읽지 못한 결정 · 정책 문서」 기준 목록 파일(설정 파일 기준 상대 경로). 적으면 `stale` 이 목록에 없는 문서를 막는다 |

## 원천(`sources[]`)

| 항목 | 뜻 |
|---|---|
| `adapter` | `markdown` |
| `root` | 원천 폴더. 조각 ID 의 페이지 키는 이 폴더를 뺀 경로다. 작업 트리 모드는 이 폴더의 git 상태로 바뀜을 판정한다 |
| `include` | 넣을 파일 글롭. 없으면 `<root>/**/*.md` |
| `exclude` | 뺄 파일 글롭 |
| `level` | 이 원천의 기본 등급. `public` · `internal` · `confidential`(공개 · 사내 · 대외비) |
| `area` | 이 원천의 영역. 문서 머리말의 `area` 가 먼저다 |
| `idNamespace` | 조각 ID 앞부분. 원천마다 달라야 같은 ID 가 두 번 나오지 않는다. 없으면 `wiki` |
| `part` | 부분 이름(`wiki` · `dev` · `dd`). 없으면 `wiki` |
| `titlePrefix` | 제목 경로 앞에 붙일 이름 목록 |

조각 ID 는 `<이름공간>:<페이지 키>#<절 슬러그>` 다. 예: `docs-adr:0001-cache#결정`. 같은 제목이 한 페이지에 두 번 나오면 `~2`, 길이로 자른 뒷조각은 `@2` 를 붙인다. 페이지 ID 는 `#` 앞부분이다.

## 보안(`security`)

| 항목 | 뜻 |
|---|---|
| `maxLevel` | 묶음 등급 상한. 원천 · 문서 · 절 등급이 이보다 높으면 설정 오류다. 기본 `confidential` |
| `excludePaths` | 어느 원천에서도 넣지 않을 경로 글롭 |
| `onSecret` | 비밀값이 든 문서를 만났을 때. `fail`(기본, 빌드 실패) · `quarantine`(그 문서만 빼고 경로를 `.wiki/index/quarantine.txt` 에 남긴다. 권한 600) |
| `allow` | 예외 목록. 칸은 `rule` · `path`(글롭) · `match`(문자열) · `reason`. 이 목록으로만 예외를 둔다 |
| `ownerDb` | 이 저장소에서만 아는 내부 DB 주소 패턴(정규식 문자열) |
| `customer` | 고객 데이터로 볼 추가 패턴(정규식 문자열) |
| `emailDomains` | 예시로 쓰는 메일 도메인. 이 도메인은 고객 데이터로 보지 않는다 |

검사 규칙은 다음과 같다. 검사 대상은 묶음에 들어가는 원문 전체(HTML 주석 · 머리말 포함)다. 결과에는 비밀값 원문을 싣지 않는다.

| 대상 | `--profile server` | `--profile local`(기본) |
|---|---|---|
| 비밀값(개인 키 · GitHub · Slack · AWS · LLM API 키 · JWT · 주소 안 비밀번호 · 값이 무작위인 `*_PASSWORD=` 등) | 실패(또는 격리) | 실패(또는 격리) |
| 개인 경로(`/Users/<이름>/…` · `/home/<이름>/…` · `/Volumes/<이름>/…`) | 실패 | 경고 |
| 고객 데이터(메일 주소 · 휴대전화 · 사업자번호 · `customer` 패턴), 내부 DB 주소(`ownerDb` 패턴) | 실패 | 경고 |

## 문서 머리말

일반 Markdown 어댑터는 머리말에서 다음 칸을 읽는다.

| 칸 | 뜻 |
|---|---|
| `id` · `title` | 페이지 키 · 제목. 없으면 경로 · 첫 `#` 제목 · 첫 문단 · 파일 이름 순서로 정한다 |
| `level` | 등급. 원천 등급보다 올릴 수만 있다 |
| `area`(옛 이름 `category`) · `status` | 영역 · 상태. `area: decision` 또는 `policy` 이고 `status: current` 면 출하 차단 대상이다 |
| `sources` | 근거 파일 목록. 기준 커밋 뒤 이 파일이 바뀌면 낡음 표시가 붙는다 |
| `base_commit` | 근거를 마지막으로 확인한 커밋. `mark-synced` 가 HEAD 로 쓴다 |
| `aliases` · `supersedes` · `implements` | 옛 ID · 대체한 문서 · 구현한 대상 |
| `since` · `verified_at` · `summary` | 처음 적용된 버전 · 따로 확인한 날 · 첫 조각 요약 |

절 하나만 등급을 올리려면 절 제목 바로 아래 줄에 `<!-- level: confidential -->` 를 둔다. 본문의 `[텍스트](다른.md#절)` · `[[페이지 ID]]` · 백틱 안 코드 경로(`src/a.ts:12`)는 링크가 되고, `backlinks` 로 거꾸로 찾을 수 있다.

## 색인 폴더와 환경 변수

색인 폴더는 설정 파일 옆 `index/` 다(`.wiki/index/`).

| 파일 | 내용 |
|---|---|
| `bundle/` | 지금 쓰는 묶음(manifest.json · chunks.jsonl · links.json · lexical/ · pages/ 등) |
| `chunks-cache.json` | 나누기 결과 캐시. 내용이 같은 문서는 다시 나누지 않는다 |
| `state.json` · `worktree.txt` | 마지막 빌드 시각과 신호, 작업 트리 경로 |
| `quarantine.txt` | 격리한 문서 경로(권한 600) |

| 환경 변수 | 뜻 |
|---|---|
| `WIKI_INDEX_CACHE_DIR` | 주면 색인 폴더를 `<값>/<작업 트리 경로 해시 12자>/` 에 두고, 빌드 잠금도 그 아래에 둔다. 없으면 잠금은 `~/.cache/project-wiki/` 에 둔다 |
| `WIKI_INDEX_ENTRY` | MCP 서버가 뒤에서 띄우는 자식 빌드의 진입 파일. 없으면 지금 실행 중인 파일이다 |

## 명령과 종료 코드

| 명령 | 하는 일 |
|---|---|
| `init [--root <저장소>] [--wiki-dir <폴더>] [--json]` | 문서 폴더를 찾아 설정을 만든다. `--wiki-dir` 이 저장소 밖이면 저장소 파일(.gitignore · 설정 문서)을 건드리지 않는다 |
| `build [--if-changed] [--quiet]` | 프로젝트 색인을 만든다. `--if-changed` 면 원천이 그대로일 때 건너뛴다 |
| `build --config <설정> --out <폴더> [--tar <파일>] [--profile server] [--reproducible] [--version <버전>]` | 다른 곳에 옮길 묶음을 만든다. 미커밋 변경이 있으면 멈추고, `--allow-dirty` 로 허용한다 |
| `search <질의>` · `read <ID>` · `backlinks <ID>` | 찾기 · 읽기 · 역참조. 첫 위치 인자에 묶음 폴더나 tar.gz 를 주면 그 묶음으로 답한다 |
| `stale [--json]` | 낡음 판정. 출하 차단이 있으면 종료 1 |
| `mark-synced <문서 경로…>` | 기준 커밋 칸을 HEAD 로 쓴다 |
| `serve-mcp [--root <저장소>] [--bundle <묶음>]` | 표준 입출력 MCP 서버 |
| `check <묶음>` · `diff <옛 묶음> <새 묶음>` · `eval <묶음> --questions <파일>` | 묶음 검증 · 비교 · 검색 평가 |

옵션 없이 부르면 지금 폴더에서 위로 올라가며 `.wiki/config.json` 을 찾는다. `--wiki-dir <폴더>` 나 `--config <파일> --root <저장소>` 로 바꿀 수 있다.

종료 코드는 0 통과 · 1 검사 실패 · 2 설정 · 입력 오류 · 3 색인 준비 안 됨(다른 빌드가 잠금을 잡고 있어 60초 안에 만들지 못함)이다. 네트워크를 쓰지 않는다.

## 색인기 개발

- 원본: `src/`(TypeScript, Node 22 의 타입 지우기로 바로 실행된다: `node src/cli/main.ts help`)
- 묶기: `node scripts/build-wiki-index.mjs` → `bin/wiki-index.mjs`. esbuild 고정 버전을 쓴다. 환경 변수 `ESBUILD` 로 실행 파일을 주거나, 없으면 `npx --yes esbuild@<고정 버전>` 을 부른다.
- 묶은 파일 확인: `node scripts/build-wiki-index.mjs --check` (다시 묶은 결과가 지금 bin 과 바이트까지 같으면 종료 0)
- 시험: `node --test test/*.test.ts`(원본), `WIKI_INDEX_BIN=bin/wiki-index.mjs node --test test/*.test.ts`(묶은 파일)
