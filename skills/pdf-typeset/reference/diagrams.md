# PDF 용 다이어그램 — 도구 고르기 · 공통 테마 · 렌더 · 배치 · 점검

그림 원본은 텍스트로 두고(비교 · 검토가 원고처럼 된다), 조판 전에 SVG 로 그려 문서에 인라인으로 넣는다.
이 방법을 처음 적용한 BI 제품 저장소의 구현은 `scripts/deliverables/render-figures.mjs`(변환기) · `scripts/deliverables/diagram-theme.json`(테마 정본) ·
`scripts/deliverables/gen/archimate.mjs` · `docs/deliverables/design/README.md` 「다이어그램」 절이다. 다른 프로젝트는 아래 방법을 그대로 옮긴다.

## 1. 어떤 내용에 어떤 그림

| 보여 줄 내용 | 그림 | 원본 → 출력 |
|---|---|---|
| 시스템과 바깥(사람 · 외부 시스템)의 관계 | C4 컨텍스트 | D2 `.d2` → `.d2.svg` |
| 시스템 안의 실행 단위(웹 · API · DB · 작업자) | C4 컨테이너 | D2 |
| 한 컨테이너 안의 모듈 | C4 컴포넌트 | D2 |
| 서버 · 호스트 · 네트워크 배치(단일 · 이중화) | 배포도 | D2 |
| 업무 · 애플리케이션 · 기술 계층을 한 장에 | ArchiMate 계층 뷰(손 배치 좌표) | `.am.json` → `.am.svg` |
| 처리 순서 · 분기 · 판단 | 흐름도(flowchart) | Mermaid `.mmd` → `.mmd.svg` |
| 요청 · 응답이 오가는 순서(누가 누구를 부르나) | 시퀀스(sequenceDiagram) | Mermaid |
| 타입 · 클래스 관계 | 클래스(classDiagram) | Mermaid(코드에서 생성) |
| 상태와 전이(작업 상태 · 승인 단계) | 상태(stateDiagram-v2) | Mermaid |
| 테이블 · 외래키 | ER(erDiagram) | Mermaid(마이그레이션에서 생성) |
| 일정 · 원형 비율 등 | gantt · pie 등 | Mermaid 기본 배치(ELK 를 쓰지 않는다) |

- 코드에서 뽑을 수 있는 그림(ERD · 클래스 · 흐름 시퀀스)은 손으로 그리지 않고 생성기로 만든다.
- 그 저장소의 실제 수(2026-11-11): `.mmd` 1,432개(시퀀스 989 · 흐름도 164 · 클래스 160 · ER 116 · 상태 3), `.d2` 11개, `.am.json` 1개(아키텍처 설계서 그림 1-1 「계층 뷰」).

## 2. 공통 테마 — JSON 하나에서 모든 도구의 설정을 만든다

색 · 글꼴 · 선 · 여백은 테마 JSON 한 곳에 두고, 변환기가 도구마다 설정으로 바꾼다. 원본에는 **역할 이름만** 적는다(`class A,B ext`, D2 는 `class: container`). 색을 원본에 직접 적지 않는다.

다른 프로젝트가 그대로 쓸 수 있는 최소 테마(그 저장소의 테마에서 추린 값, 밝은 문서용):

```json
{
  "font": { "family": "'Noto Sans KR', sans-serif", "woff2": "fonts/NotoSansKR-Variable.woff2",
            "ttfRegular": "fonts/NotoSansKR-Regular.ttf", "ttfBold": "fonts/NotoSansKR-Bold.ttf",
            "size": { "title": 15, "body": 13, "small": 11 } },
  "palette": { "paper": "#ffffff", "surface2": "#f8f9fb", "ink": "#1b1f27", "ink2": "#4b5361", "ink3": "#7a8290",
               "line": "#d9dce3", "primary": "#1f3f8a", "primaryStrong": "#142c66", "primaryWeak": "#edf1fa", "primaryWeak2": "#d9e2f4" },
  "line": { "color": "#4b5361", "width": { "normal": 1, "strong": 2 }, "dash": { "dashed": "6 4", "dotted": "2 3" },
            "labelSize": 11, "labelColor": "#4b5361", "labelBackground": "#ffffff" },
  "shape": { "radius": 6, "strokeWidth": 1, "shadow": false, "padding": 12 },
  "roles": {
    "person":    { "fill": "#142c66", "stroke": "#142c66", "text": "#ffffff" },
    "system":    { "fill": "#1f3f8a", "stroke": "#142c66", "text": "#ffffff" },
    "container": { "fill": "#d9e2f4", "stroke": "#1f3f8a", "text": "#1b1f27" },
    "component": { "fill": "#edf1fa", "stroke": "#1f3f8a", "text": "#1b1f27" },
    "db":        { "fill": "#d9e2f4", "stroke": "#1f3f8a", "text": "#1b1f27" },
    "ext":       { "fill": "#eceef2", "stroke": "#7a8290", "text": "#1b1f27" },
    "boundary":  { "fill": "none",    "stroke": "#7a8290", "text": "#4b5361", "dash": "6 4" },
    "node":      { "fill": "#f8f9fb", "stroke": "#7a8290", "text": "#1b1f27" }
  },
  "layout": { "nodeNodeBetweenLayers": 48, "edgeNodeBetweenLayers": 24, "padding": "[top=44,left=24,bottom=24,right=24]", "pad": 20 }
}
```

색은 제품 디자인 토큰의 **라이트 값**에서 옮긴다. 토큰이 바뀌면 테마도 같이 고치고, 두 값을 대조하는 시험을 둔다(예: `render-figures.test.mjs`).

### Mermaid 로 넘기기

- `mermaid.initialize` 에 `fontFamily` · **최상위 `fontSize`**(themeVariables.fontSize 만 주면 시퀀스 글자가 16px 로 찍힌다) · `themeVariables`(primaryColor ← container.fill, lineColor ← line.color, actorBkg ← 참여자 역할색, noteBkgColor ← ext 등) · `themeCSS`(모서리 반경 · 선 굵기 · 묶음 점선 · 선 라벨 크기)를 넣는다.
- 흐름도는 `flowchart.htmlLabels: false`(SVG 글자 — PDF 에 글꼴로 들어간다). 다만 최상위 `htmlLabels: false` 는 두지 않는다(`<br/>` 이 든 긴 라벨이 실패한다).
- 역할 `classDef`(person · system · container · component · db · ext …)는 변환기가 흐름도 첫 줄 뒤에 넣는다.
- 배치는 ELK(`@mermaid-js/layout-elk`): 흐름도 · 상태 · 클래스 · ER 은 `layout: 'elk'`, 직각 선 + 모서리 둥글게, 채운 삼각형 화살촉. 시퀀스는 Mermaid 기본 배치를 쓴다.
- 렌더는 헤드리스 Chrome 한 개 안에서 `mermaid.render` 로 하고, 페이지에 조판과 같은 woff2 글꼴을 넣어 글자 폭을 잰다.

### D2 로 넘기기(C4 · 배포도)

- 테마에서 공통 클래스 파일(`_theme.d2`)을 생성하고, 원본은 첫 줄 `...@_theme` 로 불러 역할 클래스만 적는다. `_theme.d2` 는 손으로 쓰지 않는다.
- CLI 인자: `--layout elk --pad 20 --elk-nodeNodeBetweenLayers 48 --elk-edgeNodeBetweenLayers 24 --elk-padding … --font-regular <TTF> --font-bold <TTF> --font-italic <Regular TTF>`. D2 는 글자 폭을 TTF 로 잰다.
- 렌더 뒤 D2 가 넣은 내장 글꼴(@font-face)을 빼고 테마 글꼴 이름만 남긴다. 그러면 문서에 내장한 같은 글꼴로 찍힌다. 기울임으로 찍히는 선 라벨은 바로 세운다.
- C4 요소 라벨 형식: 「이름 \n [종류: 기술] \n\n 설명」, 모든 줄 보통 굵기(묶음 경계 · 노드 제목만 굵게).

### ArchiMate 계층 뷰

- 요소 종류 · 관계 이름은 ArchiMate 3.2 를 따르고, 색 · 선 · 모서리는 C4 와 같은 역할 색을 쓴다. 표준 계층 색(노랑 · 하늘 · 연두)은 쓰지 않고, 층을 옅은 남색 바탕 3단계로 나눈다.
- 한 장뿐이면 자동 배치 없이 좌표를 원본에 손으로 적는다(`{ groups, elements, relations, legend }`). 생성기는 도형 · 관계 · 범례만 그린다.

## 3. 렌더 경로 · 버전 고정 · 캐시

1. 원본: 권 폴더 `figures/<이름>.mmd | .d2 | .am.json`. 생성기가 쓰는 그림은 `.gen.mmd` · `.gen.svg`.
2. 변환: `<이름>.mmd.svg` · `.d2.svg` · `.am.svg`(원본 확장자를 이름에 남겨 생성 그림과 겹치지 않게). **생성물이므로 커밋하지 않는다.**
3. 증분: SVG 첫 줄 주석에 입력 해시(원본 + 도구 버전 + 테마 설정 + 후처리 코드)를 적고, 같으면 다시 그리지 않는다. 테마나 후처리를 고치면 해당 종류를 모두 다시 그린다.
4. 버전 고정: mermaid · layout-elk 는 정확한 버전을 `npm pack` 으로 받아 캐시 폴더에 둔다(예: mermaid 11.12.0 · layout-elk 0.2.0 · `node_modules/.cache/deliverables-mermaid`). d2 는 CLI 버전을 확인하고 다르면 경고한다(예: 0.9.0). 버전이 바뀌면 배치가 달라진다.
5. 조판: 원고의 그림 줄 `[[그림 <장>-<순번> | <원본 파일> | 설명]]` 을 SVG 인라인 블록으로 바꾼다. 원본이 없으면 검사기가 오류, 변환 전이면 「그림 예정」 자리 표시를 넣는다.

## 4. 배치 규칙

- **그림마다 배율 맞춤**: 변환기가 그림에 찍힌 가장 작은 글자 크기를 재서 SVG 에 `data-minfont` 로 적는다. 조판은 기본 배율(0.8)로 싣고, 가장 작은 글자 × 배율이 하한(9px) 밑이면 그 그림만 키운다. 자리 차례는 본문 → 한 쪽 전체 → 그 쪽만 A4 가로(`data-land="1"`).
- 줄어드는 그림은 변환기가 방향(LR ↔ TB)을 바꾸거나 떨어진 표를 다른 종횡비로 묶어 다시 그려, 글자가 더 크게 실리는 쪽을 고른다.
- **큰 그림은 나눈다**: 시퀀스는 단계 구간으로(자르는 자리에서 열린 alt · loop 틀은 앞 조각에서 닫고 뒤 조각에서 「(계속)」 으로 다시 연다), 흐름도 · 클래스는 묶음 단위로. 번호는 「그림 3-6a · 3-6b」, 캡션 끝 「(1/2)」.
- **PDF 크기를 키우는 효과 금지**: 글자에 `stroke` 테두리(halo)를 주면 Chrome 이 글자를 곡선(Type 3 글꼴)으로 넣어 쪽마다 글꼴이 수십 개 생긴다. 선과 겹친 글자를 읽히게 하려면 바탕색으로 채운 글자 사본 8개를 2.5px 씩 어긋나게 깐다(일반 글자라 TrueType 으로 들어간다). 그림자 · 3D · 필터도 쓰지 않는다(`shape.shadow: false`).
- **캡션 · 번호 · 참조**: 그림 번호는 「장-순번」, 캡션은 그림 아래 한 줄. 본문에서 「그림 4-1 은 …」 처럼 번호로 가리키고, 그림만 덩그러니 두지 않는다.
- PDF 는 밝은 바탕(흰 종이)용 테마로 굽는다. 어두운 테마 그림을 PDF 에 넣지 않는다.

## 5. 그림 품질 점검표

- [ ] 실린 뒤 가장 작은 글자 9px 이상(변환기 「경고 실린 글자」 0)
- [ ] 글자끼리 · 글자와 선이 겹치지 않는다(시퀀스 메시지가 옆 생명선에 걸리지 않는다)
- [ ] 잘림 없음: 상자 안 글자, viewBox 아래 생명선, 사람 도형 머리
- [ ] 선 교차가 적다(ELK 배치 · 방향 바꾸기를 써 봤다)
- [ ] 역할 색이 테마와 같고, 범례가 필요한 그림(ArchiMate · 색 구분이 뜻을 갖는 그림)에 범례가 있다
- [ ] 글꼴이 문서 내장 글꼴로 찍힌다(`check-pdf.py` 의 Type 3 경고 없음)
- [ ] 밝은 바탕에서 대비가 충분하다(색만으로 뜻을 구분하지 않는다)
- [ ] 2x 쪽 이미지(`pdftoppm -r 144`)로 열어 눈으로 확인했다
