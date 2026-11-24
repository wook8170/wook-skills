---
name: pdf-typeset
description: Markdown · 책 명세 · 쪽 HTML 원고를 A4 PDF 로 조판할 때 쓴다. typeset-kit 명령(init · build · check · check-writing · doctor)으로 굽고 검사한다. 차례 · 차례 링크 · 책갈피(장 > 절) · 열 때 책갈피 창을 반드시 붙이고, 넓은 표는 그 쪽만 가로로 싣고, 긴 목록은 엑셀로 빼고, 한글 글꼴을 내장하고, 결과 PDF 의 책갈피 · 링크 수를 센다. 다이어그램(Mermaid · C4 · D2 · ArchiMate)을 PDF 용으로 그리는 방법도 담는다. 「PDF 만들기」「PDF 로 뽑아」「조판」「재조판」「산출물 PDF」「매뉴얼 PDF」「백서 PDF」「책갈피」「차례」「목차 링크」「가로 쪽」「그림 배율」「그림이 작다」「표가 넘침」「쪽이 넘침」「다이어그램」「Mermaid」「D2」「C4」「ArchiMate」 요청이나, PDF 를 만드는 빌더를 새로 짜거나 고칠 때 사용.
---

> 프로젝트 설정: 프로젝트 루트의 `.claude/skills-config/pdf-typeset.md` 가 있으면 먼저 읽는다. 거기에 「이 저장소는 `typeset.config.mjs` 를 쓴다」가 적혀 있으면 1절의 명령을 그대로 쓴다. 없으면 0절부터 따른다.

# PDF 조판 — typeset-kit 으로 굽고 검사한다

이 스킬이 하는 일은 세 가지다. 원고를 도구가 읽는 꼴로 쓰고, 설정을 고르고, 검사 결과를 읽어 고친다. 굽기 · 쪽 나누기 · 책갈피 · 글꼴 내장은 도구가 한다.

도구는 버전을 고정해 부른다. 아래 명령의 `typeset-kit` 은 모두 `npx --yes github:wook8170/typeset-kit#v0.1.0` 을 줄인 것이다. 프로젝트의 `package.json` 에 `typeset-kit` 이 개발 의존으로 있으면 그 버전을 쓴다(`npx typeset-kit`).

## 0. 먼저 — 이 프로젝트가 무엇으로 굽는지 찾는다

```bash
ls typeset.config.mjs typeset.config.json 2>/dev/null
rg -a -l 'printToPDF|page\.pdf\(|pdf-lib|generateDocumentOutline|pdfunite' -g '!node_modules' .
```

- `typeset.config.*` 가 있으면 1절로 간다.
- 설정은 없고 자체 조판기(위 검색 결과)가 있으면 그것을 쓰고 고칠 곳만 고친다. 프로젝트 설정 파일의 빌더 지도 · 명령을 따른다. 그 조판기를 typeset-kit 으로 바꾸는 일은 사용자가 요청할 때만 한다.
- 둘 다 없으면 `typeset-kit init`(영어 문서는 `--locale en`)으로 시작한다. 설정 파일과 예제 원고(`docs/`)가 생긴다.
- 다이어그램을 그리거나 고치면 **`reference/diagrams.md` 를 읽는다**. 도구는 다이어그램을 그리지 않는다. 그린 결과(SVG · PNG)를 원고에 그림으로 넣는다.
- 설계 산출물 · 개발 문서 세트의 구성 · 추적 · 현행화는 **`design-deliverables` 스킬**이 맡는다. 이 스킬은 굽는 일만 다룬다.

## 1. 명령

| 명령 | 하는 일 | 실패(종료 코드 1)일 때 |
|---|---|---|
| `typeset-kit doctor` | Node · 브라우저 · 책갈피 지원 · 글꼴 · 설정을 점검한다 | 안내대로 브라우저를 설치하거나 `CHROME_BIN` 을 준다 |
| `typeset-kit build [id…] [--pdf] [--web] [--html-only]` | 설정의 문서를 굽는다. 결과와 `typeset-report.json` 이 `outDir` 에 생긴다 | 3절의 문제 코드 표를 본다 |
| `typeset-kit check <pdf…> [--require-toc] [--json]` | 차례 줄 수 = 책갈피 수, 링크 목적지, 책갈피 단계, 쪽 번호 표기, 책갈피 창, Type 3 글꼴, 크기 | 3절의 검사 코드 표를 본다 |
| `typeset-kit check-writing [--check \| --update-baseline]` | 원고의 금지 표현을 찾는다. `--check` 는 기준선보다 늘어난 것만 실패로 본다 | 문장을 고친다. 기준선을 올려 통과시키지 않는다 |

작업 순서는 `doctor` → `build --pdf --web` → `check --require-toc <pdf>` → `check-writing --check` 다. 종료 코드 2 는 인자 · 설정 오류다. 그때는 오류에 적힌 설정 키를 고친다.

브라우저는 도구가 헤드리스로만 띄우고, 끝나면 프로세스와 임시 프로필을 지운다. `pkill -f Chrome` 같은 패턴 종료는 쓰지 않는다.

## 2. 원고와 설정

**입력은 세 가지다.** 문서의 `mode` 로 고른다.

| mode | 원고 | 쓰는 곳 |
|---|---|---|
| `book` | Markdown | 안내서 · 보고서 · 매뉴얼. 대부분 이것이다 |
| `spec` | 책 명세(`.json` · `.mjs`) | 스크립트가 원고를 만들 때. 블록 13종은 도구의 `docs/contract.md` 「책 명세」에 있다 |
| `pages` | 판형대로 짠 HTML | 브로셔 · 소책자. 넘친 쪽 판정이 없으므로 쪽 이미지를 눈으로 본다 |

**Markdown 원고 규칙(`book`).**
- 첫 `#` 은 문서 제목, `##` 은 장, `###` 은 절, `####` 은 소제목이다. 차례와 책갈피에는 장 · 절 두 단계만 들어간다. 장 · 절 · 그림 번호는 도구가 붙이므로 원고에 쓰지 않는다.
- 첫 `##` 앞에는 문단만 둔다(표지 요약). `##` 바로 아래 첫 문단은 장 표지의 요약이 된다.
- 문단에 그림 하나만 두면 그림 블록이 된다: `![캡션](figures/a.svg)`. 그림 파일은 프로젝트 폴더(설정 파일이 있는 폴더) 안에 둔다. 폴더 밖 파일과 바깥 주소는 굽지 않는다.
- 인용문의 첫 낱말을 굵게 쓰면 콜아웃이다: `> **주의** …`. 종류는 참고 · 주의 · 경고와 설정 `theme.callouts` 에 더한 것이다.
- 원고에 쓴 HTML 은 글자로 보인다. 링크는 `http` · `https` · `mailto` · `#` 만 눌린다.
- 개정 이력은 `revisions` 가 가리키는 JSON(`[[버전, 날짜, 변경 내용, 작성], …]`)에 쓴다. 표지의 발행 연월과 문서 정보 쪽이 여기서 나온다.

**설정에서 자주 고르는 키(`typeset.config.mjs`).**

| 하려는 일 | 키 |
|---|---|
| 표지 메타(문서번호 · 적용 버전 · 배포 등급) | `cover.meta: [['문서번호', 'DOC-01'], …]` |
| 결재 칸 | `cover.approvalBox: ['작성', '검토', '승인']` |
| 발행처 · 문의처 · 표지 마크 | `brand.{name, publisher, contact, logo}` |
| 열이 많은 표를 그 쪽만 가로로 | `typeset.landTables: 'auto'`(기준 열 수는 `landTableMinCols`, 기본 8) |
| 표 열 폭을 내용 길이로 | `typeset.tableColWidths: 'content'` |
| 쪽 끝에서 표를 쪼개 채우기 | `typeset.tableFillSplit: 3`(남은 자리에 들어갈 최소 행 수) |
| 절이 아주 많은 장의 표지 | `typeset.sectionListMax` · `typeset.splitSectionList` |
| 머리글 · 바닥글 | `header` · `footer` 의 `{title} {brand} {edition} {chapter} {section} {page}` |
| 글꼴 바꾸기 | `theme.fonts.sans` · `theme.fonts.mono`(기본은 내장 Noto Sans KR · JetBrains Mono) |
| 큰 PNG 줄이기 · PDF 크기 상한 | `limits.imageMaxPx`(기본 2000) · `limits.pdfMaxMb`(기본 90) |
| 문서 하나만 다르게 | `documents[]` 의 `theme` · `cover` · `header` · `footer` · `typeset` |

**모든 PDF 의 필수 요소**는 그대로다: 차례 + 차례 링크 + 책갈피(장 > 절) + 열 때 책갈피 창, 표지(문서번호 · 제목 · 적용 버전 · 발행처 · 배포 등급), 문서 정보(개정 이력 · 대상 독자 · 관련 문서), 머리글 · 바닥글 · 쪽 번호(앞붙임은 로마 숫자). `book` · `spec` 모드는 도구가 이것을 끌 수 없게 만든다. 표지에 넣을 값(`cover.meta`)과 개정 이력은 사람이 채운다.

**그림 · 표 · 목록.**
- 그림마다 가장 작은 글자가 9px 밑으로 내려가지 않게 한다. 본문 폭에 넣었을 때 작으면 그림을 의미 단위로 나눈다(그림 3-6a · 3-6b). 그림별 자리 고르기(`fit`)는 `spec` 원고에서만 줄 수 있다.
- SVG 는 허용 목록(도형 · 글자 · 표식 · data 주소 그림)만 받는다. `script` · `foreignObject` · `style` 요소 · 바깥 주소가 있으면 `svg-guard` 로 실패한다. 다이어그램 도구가 낸 SVG 가 걸리면 PNG(2배)로 내보내 넣는다.
- 수백 행을 넘는 목록은 본문에 요약과 대표 행만 두고 전체는 같은 이름의 `.xlsx` 로 뺀다. 본문에서 「엑셀 `<파일>` 의 「<시트>」 시트」로 가리킨다.
- 화면 캡처는 2배로 찍는다(`retina-capture` 스킬). 해상도 정보가 들어 있거나 파일 이름이 `@2x.png` 로 끝나는 2배 PNG 는 도구가 CSS 크기를 절반으로 잡는다.

## 3. 결과를 읽고 고친다

`build` 가 실패하면 `typeset-report.json` 의 문서별 `problems` 를 본다.

| 문제 코드 | 뜻 | 고치는 법 |
|---|---|---|
| `overflow: pages N` | N 쪽에서 블록이 쪽 높이를 넘었다 | 그 쪽의 블록을 찾는다. 한 쪽보다 긴 코드 블록 · 그림 · 쪼갤 수 없는 표가 원인이다. 코드는 나누고, 그림은 줄이거나 나누고, 표는 `tableFillSplit` 을 켜거나 행을 줄인다. `--allow-overflow` 는 원인을 보려고 구울 때만 쓴다 |
| `missing-file` | 원고 · 개정 이력 · 그림 파일이 없다 | 경로를 고친다. 그림 경로는 원고 파일 기준이다 |
| `outside-root` | 그림 · 스타일시트가 프로젝트 폴더 밖을 가리킨다 | 파일을 프로젝트 폴더 안으로 옮기거나 설정 파일을 윗폴더에 둔다 |
| `bad-image` | 그림 주소가 파일도 그림 data 주소도 아니다 | 그림 파일로 저장해 경로로 넣는다 |
| `svg-guard` | SVG 에 허용 목록 밖의 요소 · 속성이 있다 | 문구에 적힌 요소 · 속성을 빼거나 PNG 로 넣는다 |
| `missing-var` | `pages` 원고의 `{{이름}}` 이 `vars` 에 없다 | `documents[].vars` 에 값을 준다 |
| `pdf-size` | 크기 상한을 넘었다 | 큰 그림을 줄이거나 JPEG 로 바꾼다. 꼭 필요하면 `limits.pdfMaxMb` 를 올린다 |

`check` 가 실패하면 코드별로 본다.

| 검사 코드 | 뜻 | 고치는 법 |
|---|---|---|
| `toc-count` · `toc-target` · `toc-order` | 차례 줄과 책갈피가 맞지 않는다 | 도구로 구운 PDF 에서 나오면 도구 결함이다. PDF 를 다른 도구로 합치거나 고친 뒤라면 다시 굽는다 |
| `toc-missing` | 차례가 없다(`--require-toc`) | `book` · `spec` 로 다시 굽는다. `pages` 문서는 `toc: true` 를 준다 |
| `no-bookmarks` · `bookmark-depth` · `page-mode` · `page-labels` | 책갈피 · 책갈피 창 · 쪽 번호 표기가 없다 | 도구로 다시 굽는다. 후처리를 건너뛴 PDF 다 |
| `type3-fonts` | 시스템 글꼴이 그림 글리프로 들어갔다 | 글꼴 파일을 `theme.fonts` 로 지정한다. 글자에 `stroke` 테두리를 두른 SVG 도 원인이다 |
| `dead-links` | 문서 안 링크의 목적지가 없다 | 원고의 `#앵커` 링크를 고친다 |

검사가 통과한 뒤에도 눈으로 본다.
- `pdftoppm -r 144 -png -f N -l N <pdf> <이름>` 으로 표지 · 차례 · 가로 쪽 · 그림이 많은 쪽을 2배로 뽑아 그림 글자 크기와 표 잘림을 본다. 도구의 넘친 쪽 판정은 본문 쪽의 세로 넘침만 본다. 표지의 긴 제목과 폭을 넘는 표 · 그림은 눈으로 확인한다.
- 차례에 찍힌 쪽 번호가 본문과 맞는지 `pdftotext -layout <pdf> - | less` 로 본다. `check` 는 링크 목적지를 보고 찍힌 숫자는 읽지 않는다.
- `typeset-report.json` 의 쪽 수 · 가로 쪽 수 · 책갈피 수가 의도와 같은지 본다.

## 4. 문장 · 표기 지침

`check-writing` 이 잡는 것은 과장 표현 · 비유 · 번역투 같은 금지 표현과 명사 사슬이다. 아래는 기계로 잡히지 않으므로 사람이 지킨다. 마감 전에 `readable-korean` 스킬로 점검한다.

- 문체: 산출물 · 개발 문서는 「~한다」 평서체다. 매뉴얼 · 안내서는 그 문서가 이미 쓰는 문체를 따른다.
- 개발 과정의 흔적을 남기지 않는다: 작업자 · 작업 묶음 · 대화 이름, 에이전트 지침 파일을 근거로 드는 문장, 과정 설명, TODO.
- 「미확인」을 쓰지 않는다. 소스 · 설정 · 실측으로 확인해 채운다. 정할 수 없는 값은 `> **예정**: <언제 · 어디서 채우는지>` 로 쓴다.
- 버전을 뜻하는 말은 「버전」이다. 숫자 · 목록은 세어서 쓴다.
- 연결어를 빼지 않는다 · 사물을 사람처럼 쓰지 않는다 · 명사를 셋 이상 조사 없이 잇지 않는다 · 주어와 서술어를 멀리 띄우지 않는다.

기준선(`typeset.writing-baseline.json`)은 이미 있는 건수를 잠가 두는 파일이다. 새 글에서 걸린 표현은 고친다. `--update-baseline` 은 건수가 줄었을 때만 돌린다.

## 5. 운영 주의

- 큰 문서 세트 전체를 다시 굽는 일은 무겁다. `uptime` 의 1분 부하가 20 아래일 때 한 번에 하나만 돌리고, 테스트 · 다른 빌드와 겹치지 않게 한다.
- 완성 PDF 는 버전마다 다시 구워 커밋한다. `outDir` 의 인쇄판 HTML 과 `typeset-report.json` 은 `.gitignore` 로 뺀다. 100MB 를 넘는 PDF 는 커밋 전에 크기를 확인한다.
- 생성물(`*.gen.md` 등)은 손으로 고치지 않고 생성기를 고쳐 다시 만든다.
- 산출물을 `~/Downloads` 에 두지 않는다.

## 6. 도구를 쓸 수 없을 때

Node 22 나 Chrome 을 쓸 수 없는 환경, 또는 프로젝트의 자체 조판기를 고칠 때는 같은 원리를 손으로 지킨다.

- HTML 한 파일에 글꼴 · 그림 · CSS 를 모두 넣는다(바깥 요청 0). 한글 글꼴은 base64 `@font-face` 로 넣고 사용권 고지를 올린다.
- 헤드리스 Chrome 의 `Page.printToPDF` 를 `printBackground · preferCSSPageSize · 여백 0 · generateDocumentOutline · transferMode: 'ReturnAsStream'` 로 부른다. 책갈피는 제목 요소(또는 `role=heading` + `aria-level` 1 · 2)에서 생긴다.
- pdf-lib 로 `/PageMode /UseOutlines` 와 `/PageLabels` 를 붙인다. PDF 를 합치면 책갈피와 링크를 다시 단다.
- 띄운 Chrome 은 PID 로 끄고 임시 프로필을 지운다. 시간 상한은 문서 크기에 비례해 잡는다.
- `scripts/` 의 세 도우미(`print-pdf.mjs` · `pdf-nav.mjs` · `check-pdf.py`)는 typeset-kit 으로 대체됐다. 이 버전까지만 남기고 다음 버전에서 지운다.

## 7. 끝내기 전 점검표

- [ ] `doctor` 가 통과했는가
- [ ] `build` 의 문제가 0 이고 넘친 쪽이 0 인가(`--allow-overflow` 없이)
- [ ] `check --require-toc` 가 통과했는가(책갈피 수 = 차례 줄 수, Type 3 글꼴 0)
- [ ] `check-writing --check` 가 통과했고, 기준선을 올려 통과시키지 않았는가
- [ ] 표지 메타 · 개정 이력 · 배포 등급을 채웠는가
- [ ] 쪽 이미지를 2배로 몇 장 뽑아 표지 · 가로 쪽 · 그림 글자 크기를 눈으로 봤는가
- [ ] 긴 목록을 엑셀로 뺐는가
- [ ] 문장이 4절 지침을 지키는가(`readable-korean` 점검)
