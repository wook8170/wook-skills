// 묶음 형식의 자료 구조. 핵심(core)은 저장소의 다른 패키지를 import 하지 않는다.
// 부르는 곳: cli/build.ts · cli/eval.ts · cli/query.ts · cli/stale.ts 등. 먼저 읽을 파일: core/build.ts.

/** 묶음 형식 버전. 읽는 쪽은 자기가 아는 범위(FORMAT_MIN ~ FORMAT_MAX)를 벗어난 묶음을 거절한다. */
export const FORMAT_VERSION = 1
export const FORMAT_MIN = 1
export const FORMAT_MAX = 1

/** 보안 등급. 뒤로 갈수록 높다. */
export type Level = 'public' | 'internal' | 'confidential'
export const LEVELS: readonly Level[] = ['public', 'internal', 'confidential']

const LEVEL_ALIASES: Record<string, Level> = {
  public: 'public',
  공개: 'public',
  internal: 'internal',
  사내: 'internal',
  confidential: 'confidential',
  대외비: 'confidential',
}

/** 설정 · 인자의 등급 표기(영문 · 한글)를 정규화한다. 모르는 값이면 오류. */
export function parseLevel(v: unknown): Level {
  const l = typeof v === 'string' ? LEVEL_ALIASES[v.trim()] : undefined
  if (!l) throw new Error(`알 수 없는 보안 등급: ${String(v)}`)
  return l
}

export function levelRank(l: Level): number {
  return LEVELS.indexOf(l)
}

/** 등급 l 인 항목을 상한 cap 인 사용자가 볼 수 있는가. */
export function levelAllowed(l: Level, cap: Level): boolean {
  return levelRank(l) <= levelRank(cap)
}

export function maxLevel(a: Level, b: Level): Level {
  return levelRank(a) >= levelRank(b) ? a : b
}

/** 조각이 속한 부분. 화면의 세그먼트(위키 · 개발 문서 · 설계 산출물)와 같다. */
export type Part = 'wiki' | 'dev' | 'dd'

export type ChunkKind = 'section' | 'figure'

export interface Anchor {
  kind: 'file' | 'snippet'
  path: string
  /** snippet: 문장(정규식이 아니라 그대로 찾는 문자열). */
  match?: string
  /** 대상 내용 sha256 앞 16자리. 파일이 저장소에 없으면 null. */
  hash: string | null
  /**
   * 경로나 그 위 폴더 가운데 심볼릭 링크가 있다. git 은 링크를 가리키는 경로 문자열로만 추적한다.
   * 그래서 대상 파일이 바뀌어도 근거의 이력에 나오지 않는다. 낡음 판정은 이 근거를 판정하지 않고, 차단 대상 문서는 막는다.
   */
  link?: true
}

export interface StaleMark {
  state: 'stale' | 'stale-candidate'
  reason: string
}

export interface Chunk {
  id: string
  /** 같은 원천 파일(페이지)의 ID. 조각 ID 에서 `#` 앞부분. */
  page: string
  contentHash: string
  kind: ChunkKind
  part: Part
  titlePath: string[]
  /** 이 조각의 절 제목(정답 안정 키가 맞춰 보는 값). 머리글 앞 조각은 페이지 제목. */
  heading: string
  text: string
  summary: string
  source: { adapter: string; path: string; lines: [number, number] }
  anchors: Anchor[]
  level: Level
  area?: string
  status?: string
  /** 쪽 머리말 `since`(이 내용이 처음 적용된 제품 버전). 머리말에 값이 없으면 칸이 없다(옛 묶음도 같다). */
  since?: string
  /** 쪽 머리말 `verified_at`(내용을 실제 동작과 마지막으로 맞춰 본 날). 머리말에 값이 없으면 칸이 없다. */
  verifiedAt?: string
  /**
   * 원천 파일을 마지막으로 고친 날(묶음 커밋 기준 git 커밋 날짜, `YYYY-MM-DD`, `core/modified.ts`).
   * git 이 없거나 · 생성 장 · 미커밋 변경 파일이면 칸이 없다. 화면 「확인」은 `verifiedAt` 이 있으면 그 값을 먼저 쓴다.
   */
  modifiedAt?: string
  generated: boolean
  stale: StaleMark | null
  /** 같은 페이지 안 순서. */
  seq: number
  /** 설계 산출물 조각의 권 · 장. */
  book?: string
  chapter?: string
}

export type LinkKind =
  | 'ref'
  | 'evidence'
  | 'contains'
  | 'implements'
  | 'reverts'
  | 'trace_feature'
  | 'trace_screen'
  | 'trace_api'
  | 'trace_usecase'
  | 'trace_test'

export type Edge = [from: string, to: string, kind: LinkKind]

export interface LinkNode {
  type: string
  title?: string
  /** 이 ID 를 정의한 조각. */
  defined?: string
  /** 조각이 아닌 노드(추적 데이터의 기능 · 화면 등)의 등급. 그 노드를 만든 원천의 등급이다. */
  level: Level
}

export interface LinksFile {
  nodes: Record<string, LinkNode>
  edges: Edge[]
  backlinks: Record<string, Partial<Record<LinkKind, string[]>>>
  counts: Record<string, { in: number; out: number }>
  broken: Edge[]
}

export interface SourceSpec {
  adapter: string
  part?: Part
  titlePrefix?: string[]
  root?: string
  include?: string[]
  exclude?: string[]
  level: Level
  area?: string
  idNamespace?: string
  /**
   * 원천 폴더가 아직 저장소에 없는 「예정」 원천. 읽을 파일이 없으면 0건으로 지나간다(지금도 같다).
   * 매니페스트 `sources` 에 그대로 실려, 화면이 0 대신 「예정」으로 보이게 한다.
   */
  planned?: boolean
}

export interface Manifest {
  formatVersion: number
  name: string
  title: string
  version: string
  createdAt: string
  commit: string | null
  dirty: boolean
  profile: 'server' | 'local'
  rules: { chunker: string; tokenizer: string; anchors: string; security: string }
  maxLevel: Level
  levels: Level[]
  counts: {
    chunks: number
    pages: number
    edges: number
    broken: number
    stale: number
    staleCandidates: number
    byLevel: Partial<Record<Level, number>>
    byPart: Partial<Record<Part, number>>
  }
  sources: SourceSpec[]
  /** 권(book) 단위 원천을 내는 어댑터가 싣는 권별 원천 해시. 일반 Markdown 원천만 쓰면 빈 객체다. */
  manuscripts: Record<string, { manuscriptSha256: string; figuresSha256: string }>
  securityWarnings: number
  /** 빌드 때 쓴 보안 검사 예외 · 추가 규칙. check 가 같은 기준으로 다시 검사한다. */
  security: { allow?: Array<{ rule: string; path?: string; match?: string; reason: string }>; ownerDb?: string[]; customer?: string[]; emailDomains?: string[] }
  vectors: null
  /** 비밀값이 있어 묶음에서 뺀(격리한) 문서 수. 격리를 켠 원천이 있을 때만 싣는다. 경로는 싣지 않는다. */
  quarantined?: number
  /** 묶음 안 모든 파일(manifest.json · SIGNATURE 제외)의 `sha256:<hex>`. */
  files: Record<string, string>
}

/** 어댑터가 내는 중간 형식. 원천 파일 하나 = SourceUnit 하나. */
export interface SourceUnit {
  adapter: string
  /** 저장소 기준 상대 경로. */
  path: string
  /** 페이지 ID(조각 ID 의 `#` 앞부분). */
  page: string
  part: Part
  title: string
  /** 제목 경로의 앞부분(예: 권 이름). 페이지 제목은 포함하지 않는다. */
  titlePrefix: string[]
  level: Level
  area?: string
  status?: string
  /** 쪽 머리말 `since`(이 내용이 처음 적용된 제품 버전). 머리말에 값이 없으면 칸이 없다(옛 묶음도 같다). */
  since?: string
  /** 쪽 머리말 `verified_at`(내용을 실제 동작과 마지막으로 맞춰 본 날). 머리말에 값이 없으면 칸이 없다. */
  verifiedAt?: string
  generated: boolean
  /** 원문 Markdown(머리말 · HTML 주석 포함). 나누기는 엔진이 한다. */
  markdown: string
  /** 첫 조각의 요약(예: book.json 의 장 요약). */
  summary?: string
  anchors: Anchor[]
  /** 머리말 aliases(옛 ID). */
  aliases?: string[]
  book?: string
  chapter?: string
  /** 근거 파일 앵커를 비교할 기준 커밋(예: 머리말 base_commit). */
  baseCommit?: string
  /** 출하 차단 대상. 근거가 바뀌었거나 판정할 수 없으면 낡음(`stale`)이 된다. 어댑터가 채운다. */
  blockOnStale?: boolean
  /**
   * 위키 페이지 · 개발 문서 방식으로 판정한다. 저장소 안의 파일 근거만 보고,
   * 근거와 이 문서가 같은 커밋에서 함께 바뀌었으면 그 변경은 확인한 것으로 본다(`core/stale.ts`).
   */
  reviewInSameCommit?: boolean
  /**
   * 첫 줄이 `---` 인데 머리말을 닫는 줄이 없다. 영역 · 상태를 읽지 못해 차단 대상인지 알 수 없으므로
   * 낡음 판정은 출하를 막는다(`core/stale.ts`).
   */
  headUnclosed?: boolean
  /**
   * 머리말로 읽히지 않았는데 앞쪽(빈 줄 · HTML 주석 뒤)에 `---` 줄이 있거나, 머리말 안에 들여쓴 `---` 가 있다.
   * 여는 줄 끝 공백 · 들여쓰기 · 앞 빈 줄 · 폭 없는 글자처럼 모양이 어긋난 머리말이다(`core/head-shape.ts`).
   * 머리말로 읽히지 않은 area · category · status 열쇠 줄(중복 열쇠 포함)이 있는 문서도 든다.
   * 머리말 안에 머리말이 열쇠로 읽지 못한 줄이 있는 문서도 든다.
   * 영역 · 상태를 읽지 못하므로 「상태를 읽지 못한 문서」로 센다(`core/stale-status.ts`).
   */
  headMisshapen?: boolean
  /**
   * 머리말의 area · category · status 표기가 어긋났다(열쇠 · 값의 대소문자, 따옴표 안 공백, area 와 category 가 서로 다름,
   * 값이 정한 낱말 밖 — `core/head-words.ts`).
   * 결정 · 정책 문서가 차단 대상으로 읽히지 않으므로 「상태를 읽지 못한 문서」로 센다(`core/head-shape.ts`).
   */
  headMisspelled?: boolean
  /** 글롭 · 저장소 밖 · 경로가 아닌 값이라 앵커로 넣지 않은 근거 값 수(「근거 확인 불가」로 센다). */
  skippedAnchors?: number
  /** 원천이 정의하는 노드 · 간선(추적 데이터 등). */
  extraNodes?: Record<string, LinkNode>
  extraEdges?: Edge[]
}

export interface SecurityFinding {
  rule: string
  category: 'secret' | 'personal-path' | 'owner-db' | 'customer-data'
  severity: 'fail' | 'warn'
  path: string
  line: number
  /** 걸린 값을 가린 앞뒤 문맥. 비밀값 원문은 싣지 않는다. */
  excerpt: string
}
