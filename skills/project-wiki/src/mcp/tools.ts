// 위키 도구 3종(wiki_search · wiki_read · wiki_backlinks)의 정의와 실행. 부르는 곳: mcp/server.ts.
// 범위(등급 상한 · 영역)는 부르는 쪽이 정하고, 도구 인자로는 넓힐 수 없다. 알 수 없는 인자(예: level)가 오면 실행하지 않고 오류로 돌려준다.
// 먼저 읽을 파일: core/search.ts.
import type { ChunkKind, Level, LinkKind } from '../core/model.ts'
import { isReadError, type WikiIndex } from '../core/search.ts'

export interface ToolScope {
  /** 등급 상한. */
  cap: Level
  /** 영역 제한. 없으면 전부. 도구 인자의 areas 는 이 안에서만 좁힐 수 있다. */
  areas?: string[]
  /** 빼는 영역. 도구 인자로 되살릴 수 없다. */
  excludeAreas?: string[]
}

type JsonSchema = Record<string, unknown>

export interface ToolDef {
  name: 'wiki_search' | 'wiki_read' | 'wiki_backlinks'
  description: string
  inputSchema: JsonSchema
}

const STALE_NOTE = '결과에 낡음(stale) 표시가 있으면 답에 그 사실을 적는다.'

export const WIKI_TOOLS: ToolDef[] = [
  {
    name: 'wiki_search',
    description: `프로젝트 문서(설계 · 결정 · 운영 · 산출물)를 절 단위로 찾는다. 결과 한 줄 = 조각 하나(ID · 부분 · 경로 · 일치 문장 · 낡음 · 근거 위치 · 등급). ${STALE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 200 },
        kinds: { type: 'array', items: { type: 'string', enum: ['section', 'figure'] } },
        areas: { type: 'array', items: { type: 'string' } },
        exclude_stale: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki_read',
    description: `조각 · 페이지 ID 로 본문을 읽는다. 제목 경로 · 근거 · 낡음 · 이 조각을 가리키는 곳(종류별 상위 5)을 함께 돌려준다. context=1 이면 앞뒤 조각도 준다. ${STALE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 300 }, context: { type: 'integer', enum: [0, 1] } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki_backlinks',
    description: '대상(조각 · 페이지 · 요구사항 등 ID 또는 code:경로[#심볼])을 가리키는 조각을 종류별로 돌려준다. 볼 수 없는 등급은 건수만 센다.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 300 },
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
]

export class ToolInputError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type PropSchema = Record<string, unknown>
type Args = Record<string, unknown>

/** 인자를 도구 스키마로 확인한다(외부 스키마 라이브러리 없이 이 3종에 필요한 만큼만). */
export function validateArgs(def: ToolDef, args: unknown): Args {
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('invalid_arguments', '인자는 객체여야 한다')
  const a = args as Args
  const props = def.inputSchema.properties as Record<string, PropSchema>
  rejectUnknownArgs(a, props)
  for (const k of (def.inputSchema.required as string[] | undefined) ?? []) {
    if (a[k] === undefined || a[k] === '') throw new ToolInputError('invalid_arguments', `${k} 가 필요하다`)
  }
  for (const [k, v] of Object.entries(a)) checkArg(k, v, props[k])
  return a
}

/** 스키마에 없는 인자가 하나라도 있으면 거절한다. 범위(묶음 · 등급 · 영역)를 인자로 넓히지 못하게 하려는 것이다. */
function rejectUnknownArgs(a: Args, props: Record<string, PropSchema>): void {
  for (const k of Object.keys(a)) {
    if (!(k in props)) {
      throw new ToolInputError('scope_override_rejected', `알 수 없는 인자 ${k}: 범위(묶음 · 등급 · 영역)는 도구 인자로 바꿀 수 없다`)
    }
  }
}

function badArg(k: string, msg: string): ToolInputError {
  return new ToolInputError('invalid_arguments', `${k}: ${msg}`)
}

/** 인자 하나를 스키마 종류에 맞춰 확인한다. */
function checkArg(k: string, v: unknown, s: PropSchema): void {
  if (s.type === 'string') checkStringArg(k, v, s)
  else if (s.type === 'integer') checkIntegerArg(k, v, s)
  else if (s.type === 'boolean') {
    if (typeof v !== 'boolean') throw badArg(k, '참 · 거짓이어야 한다')
  } else if (s.type === 'array') checkArrayArg(k, v, s)
}

function checkStringArg(k: string, v: unknown, s: PropSchema): void {
  if (typeof v !== 'string') throw badArg(k, '문자열이어야 한다')
  if (typeof s.maxLength === 'number' && v.length > s.maxLength) throw badArg(k, `${s.maxLength}자 이하여야 한다`)
  if (typeof s.minLength === 'number' && v.length < s.minLength) throw badArg(k, '비어 있다')
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) throw badArg(k, '형식이 맞지 않는다')
  if (Array.isArray(s.enum) && !s.enum.includes(v)) throw badArg(k, `허용 값: ${s.enum.join(', ')}`)
  if (/[\u0000-\u001f]/.test(v)) throw badArg(k, '제어 문자는 쓸 수 없다')
}

function checkIntegerArg(k: string, v: unknown, s: PropSchema): void {
  if (!Number.isInteger(v)) throw badArg(k, '정수여야 한다')
  if (typeof s.minimum === 'number' && (v as number) < s.minimum) throw badArg(k, `${s.minimum} 이상이어야 한다`)
  if (typeof s.maximum === 'number' && (v as number) > s.maximum) throw badArg(k, `${s.maximum} 이하여야 한다`)
  if (Array.isArray(s.enum) && !s.enum.includes(v)) throw badArg(k, `허용 값: ${s.enum.join(', ')}`)
}

function checkArrayArg(k: string, v: unknown, s: PropSchema): void {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badArg(k, '문자열 목록이어야 한다')
  const en = (s.items as Record<string, unknown>).enum
  if (Array.isArray(en) && v.some((x) => !en.includes(x))) throw badArg(k, `허용 값: ${en.join(', ')}`)
}

/** 도구 인자의 영역을 범위 안으로 좁힌다. 범위 밖 영역만 남으면 빈 목록이 되어 결과도 비게 된다. */
function narrowAreas(scope: ToolScope, req: string[] | undefined): string[] | undefined {
  if (!scope.areas) return req
  if (!req?.length) return scope.areas
  const ok = req.filter((r) => scope.areas!.includes(r))
  return ok.length ? ok : ['\u0000none']
}

function runSearch(index: WikiIndex, a: Args, scope: ToolScope): unknown {
  const r = index.search({
    q: a.q as string,
    cap: scope.cap,
    kinds: a.kinds as ChunkKind[] | undefined,
    areas: narrowAreas(scope, a.areas as string[] | undefined),
    excludeAreas: scope.excludeAreas,
    excludeStale: a.exclude_stale as boolean | undefined,
    limit: (a.limit as number | undefined) ?? 10,
  })
  return {
    results: r.hits.map((h) => ({
      id: h.id,
      part: h.part,
      path: h.titlePath.join(' › '),
      match: h.snippet,
      stale: h.stale,
      source: `${h.source.path}:${h.source.lines[0]}-${h.source.lines[1]}`,
      level: h.level,
    })),
    total: r.total,
    filtered_count: r.filteredCount,
  }
}

function runRead(index: WikiIndex, a: Args, scope: ToolScope): unknown {
  // 영역 범위 밖 조각 · 페이지는 WikiIndex.read 가 not_found 로 돌려준다(찾지 못한 것과 같음).
  const r = index.read(a.id as string, { cap: scope.cap, context: a.context === 1, areas: scope.areas, excludeAreas: scope.excludeAreas })
  if (isReadError(r)) throw new ToolInputError(r.error, r.error === 'not_found' ? `찾지 못했다: ${r.id}` : `이 조각을 볼 등급이 아니다: ${r.id}`)
  return r
}

/** 도구 실행. 결과는 JSON 으로 그대로 직렬화할 수 있는 객체다. */
export function callWikiTool(index: WikiIndex, name: string, rawArgs: unknown, scope: ToolScope): unknown {
  const def = WIKI_TOOLS.find((t) => t.name === name)
  if (!def) throw new ToolInputError('unknown_tool', `알 수 없는 도구: ${name}`)
  const a = validateArgs(def, rawArgs)
  switch (def.name) {
    case 'wiki_search':
      return runSearch(index, a, scope)
    case 'wiki_read':
      return runRead(index, a, scope)
    case 'wiki_backlinks':
      return index.backlinks(a.target as string, { cap: scope.cap, kinds: a.kinds as LinkKind[] | undefined, limit: (a.limit as number | undefined) ?? 20, areas: scope.areas, excludeAreas: scope.excludeAreas })
  }
}
