// 머리말 모양 · 표기 점검. 일반 Markdown 어댑터가 문서마다 부른다.
// 부르는 곳: core/adapter.ts. 먼저 읽을 파일: core/head-words.ts.
// 영역(area)을 머리말에서 읽는 원천은 머리말이 읽히지 않으면 결정 · 정책 문서인지 알 수 없다.
// 그래서 모양이 어긋난 머리말과 표기가 어긋난 열쇠 · 값을 찾아 「상태를 읽지 못한 문서」로 세게 한다(`stale-status.ts`).
// - 머리말로 읽히지 않은 글에 area · category · status 열쇠처럼 보이는 줄이 있으면 어긋난 문서로 본다(`unreadStateLine`).
// - 머리말 안은 허용 목록으로 본다. 머리말이 열쇠로 읽지 못한 줄이 있거나, 영역 · 상태 값이 정한 낱말(`head-words.ts`) 밖이면 막는다.
// - 본문의 닫힌 `---` 덩어리(제목 뒤 머리말 · 둘째 덩어리) 안의 영역 줄은 값과 관계없이 센다. 덩어리는 `---` 줄의 짝으로 세지 않고,
//   코드 밖의 첫 `---` 줄과 마지막 닫는 줄(`---` · `...`) 사이를 덩어리 안으로 본다.
import { AREA_WORDS, BLOCK_AREAS, STATUS_WORDS } from './head-words.ts'
import { frontmatterClose } from './util.ts'

/** 폭 없는 글자(서식 문자 · BOM)와 공백. 줄 모양을 견줄 때 지운다. */
const INVISIBLE = /[\p{Cf}\s]/gu

const visible = (line: string) => line.replace(INVISIBLE, '')

/** 문서 앞의 빈 줄 · HTML 주석(여러 줄 포함)을 건너뛴 첫 줄 번호. 없으면 -1. */
function firstMeaningfulLine(lines: string[]): number {
  let comment = false
  for (let i = 0; i < lines.length; i++) {
    const t = visible(lines[i])
    if (comment || t.startsWith('<!--')) comment = !t.endsWith('-->')
    else if (t) return i
  }
  return -1
}

/** 머리말 안에 들여쓴 `---` 줄이 있는가. YAML 값의 한 줄이지만 사람 눈에는 머리말을 닫는 줄로 보인다. */
function hasIndentedRule(head: string[]): boolean {
  return head.some((l) => /^\s+---\s*$/.test(l))
}

/**
 * 머리말로 읽히지 않았거나 읽혔어도 모양이 어긋났는가. 문서 앞 BOM 하나는 떼고 본다.
 * - 첫 줄이 정확한 `---` 이고 닫혔으면: 머리말 안에 들여쓴 `---` 가 있을 때만 어긋남이다.
 * - 첫 줄이 정확한 `---` 인데 닫히지 않았으면 여기서 다루지 않는다(`headUnclosed`).
 * - 그 밖: 빈 줄 · HTML 주석을 건너뛴 첫 줄에서 폭 없는 글자 · 공백을 지우면 `---` 로 시작하는 경우다
 *   (여는 줄 끝 공백 · 들여쓰기 · 앞 빈 줄 · 폭 없는 글자 · `--- # …` · `----` · 줄 끝이 CR 뿐).
 * 글자 뒤 · 제목 뒤에 둔 머리말 덩어리는 `unreadStateLine` 이 본다.
 */
export function misshapenHead(src: string): boolean {
  const lines = src.replace(/^﻿/, '').split('\n')
  const close = frontmatterClose(lines)
  if (close !== null) return close > 0 && hasIndentedRule(lines.slice(1, close))
  const i = firstMeaningfulLine(lines)
  if (i < 0) return false
  return visible(lines[i]).startsWith('---')
}

// ── 머리말로 읽히지 않은 열쇠 줄 · 머리말 허용 목록 ───────────────────────────

/** 열쇠를 견줄 때 지우는 글자: 서식 문자 · 결합 표시 · 공백 · 한글 채움 문자(U+115F · U+1160 · U+3164 · U+FFA0) · 점자 빈칸(U+2800). */
const HIDDEN = /[\p{Cf}\p{Mn}\p{Z}\sᅟᅠㅤﾠ⠀]/gu
/**
 * 열쇠처럼 보이는 줄: 보이지 않는 글자를 지우고 NFKC 로 맞춘 뒤, 줄 앞의 기호(목록 · 인용 · 따옴표 · 강조 등)를 건너뛰고
 * area · category · status 가 오고, 따옴표 · 강조 기호 두 글자까지 뒤에 `:` 나 `=` 가 오는 줄이다. 대소문자는 가리지 않는다.
 * 줄 앞 기호에 백틱이 있으면 인라인 코드로 적은 예시라서 세지 않는다.
 */
const KEY_LIKE = /^[^\p{L}\p{N}`]*(area|category|status)[^\p{L}\p{N}`]{0,2}?[:=]/iu
/** 머리말이 그대로 읽는 열쇠 줄: 들여쓰지 않은 소문자 열쇠 · ASCII 쌍점. */
const EXACT_KEY = /^(area|category|status)[ \t]*:(.*)$/
/** `parseFrontmatter` 가 열쇠로 읽는 줄(`util.ts` 와 같은 꼴). */
const READ_KEY = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/
/** `parseFrontmatter` 가 목록 값으로 읽는 줄. */
const LIST_ITEM = /^\s*-\s+/
/** YAML 블록 값을 여는 값(`|` · `>` 와 그 꾸밈). 다음의 들여쓴 줄은 값의 내용이다. */
const BLOCK_VALUE = /^[|>][+-]?\d*[+-]?(\s+#.*)?$/
/** 간단한 값: 영문자로 시작하는 낱말 하나(값 뒤 ` # 주석` 과 짝이 맞는 따옴표는 떼고 본다). */
const PLAIN_VALUE = /^[A-Za-z][\w-]*$/
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/
/** 목록 항목을 여는 줄. 맞은 길이가 항목 내용의 들여쓰기다. */
const LIST_OPEN = /^ *(?:[-*+]|\d{1,9}[.)])(?: +|$)/
/** 영문과 한 낱말에 섞여도 닮은 글자로 보지 않는 문자(한글 · 한자 · 가나). 예: `UI화면`. */
const MIXABLE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/** 찾은 것: area · category 줄(영역과 관계없이 센다), status 줄(결정 · 정책일 때만 센다), 머리말이 읽지 못한 줄. */
type Mark = 'area' | 'status' | 'line'
type Found = Set<Mark | null>

/** 줄이 열쇠처럼 보이면 그 갈래(area · category 는 area), 아니면 null. */
function keyLike(line: string): 'area' | 'status' | null {
  const m = KEY_LIKE.exec(line.normalize('NFKC').replace(HIDDEN, ''))
  if (!m) return null
  return m[1].toLowerCase() === 'status' ? 'status' : 'area'
}

/** 머리말 줄의 값을 간단한 값으로 읽을 수 있는가. */
function plainValue(rest: string): boolean {
  const t = rest.trim().replace(/\s+#.*$/, '')
  const q = /^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t)
  return PLAIN_VALUE.test(q ? q[1] : t)
}

/**
 * 값이 머리말에 쓴 낱말처럼 보이는가: 영문 낱말 하나이거나, 첫 낱말이 영문과 비영문 글자(`MIXABLE` 제외)를 섞어 쓴 낱말이다.
 * 정규화와 문자 계열 판정을 여기서 함께 한다. NFKD 로 풀고 결합 표시 · 서식 문자를 지운 뒤 앞뒤 기호를 떼고 본다.
 * 그래서 전각 · 수학 글자 · 결합 문자는 영문이 되고, 키릴 · 콥트 · 리수 · 점 없는 ı · 작은 대문자는 비영문 글자로 남는다.
 */
function headLikeWord(value: string): boolean {
  const v = value.normalize('NFKD').replace(/[\p{Cf}\p{M}ᅟᅠㅤﾠ⠀]/gu, '').trim()
  const core = v.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  const first = [...core.split(/\s/)[0]]
  const foreign = first.some((c) => /\p{L}/u.test(c) && !/[A-Za-z]/.test(c) && !MIXABLE.test(c))
  return PLAIN_VALUE.test(core) || (foreign && first.some((c) => /[A-Za-z]/.test(c)))
}

/** 본문 열쇠 줄의 값(첫 `:` · `=` 뒤, ` # 주석` 뗌)을 `headLikeWord` 로 본다. 흩어진 본문 줄 가운데 머리말로 쓴 줄을 가려낸다. */
function plainBodyValue(line: string): boolean {
  const t = line.normalize('NFKC')
  return headLikeWord(t.slice(t.search(/[:=]/) + 1).replace(/\s+#.*$/, ''))
}

/** 앞 줄이 연 값의 상태: 블록 값(`|` · `>`) 안인가, 목록 값(`키:` 다음 `- 값`)을 받는 중인가, 값을 다음 줄에 이어 쓸 수 있는가. */
interface HeadState {
  block: boolean
  list: boolean
  cont: boolean
}

/**
 * 블록 값의 내용 줄인가: 공백으로 들여쓴 줄. 다만 탭으로 시작하는 줄과 1칸만 들여쓴 열쇠 줄은 내용으로 보지 않는다.
 * 사람 눈에는 블록 값이 끝난 뒤의 열쇠 줄로 보이기 때문이다.
 */
const blockContent = (line: string) => line.startsWith(' ') && !(/^ \S/.test(line) && keyLike(line))

/** 앞 줄 값을 이어 쓴 줄인가: 공백으로 들여썼고 열쇠처럼 보이지 않는 줄. 탭으로 시작하면 이어 쓴 값으로 보지 않는다. */
const continued = (line: string) => /^ +\S/.test(line) && !keyLike(line)

/**
 * 열쇠 줄로 보지 않는 머리말 줄인가: 빈 줄, 블록 값의 내용, 이어 쓴 값, `#` 주석, 목록 값.
 * 값이 빈 열쇠 다음의 들여쓴 줄(중첩 사상 · 다음 줄에 쓴 값)도 그 열쇠의 값으로 받는다. 다만 열쇠처럼 보이는 줄은 받지 않는다.
 * 빈 줄은 앞 줄이 연 상태를 그대로 둔다.
 */
function skipHeadLine(line: string, st: HeadState): boolean {
  if (!line.trim()) return true
  if ((st.block && blockContent(line)) || ((st.cont || st.list) && continued(line))) return true
  st.block = false
  st.cont = false
  return line.trim().startsWith('#') || (st.list && LIST_ITEM.test(line) && !keyLike(line))
}

/** 열쇠처럼 보이는데 그대로 읽히지 않는 줄 · 간단한 값이 아닌 줄 · 같은 열쇠를 두 번 적은 줄을 센다. */
function markKeyLine(line: string, seen: Set<string>, out: Found): void {
  const k = keyLike(line)
  if (!k) return
  const m = EXACT_KEY.exec(line)
  if (!m || !plainValue(m[2]) || seen.has(m[1])) out.add(k)
  if (m) seen.add(m[1])
}

/**
 * 머리말 안(허용 목록): 블록 값의 내용 · 빈 줄 · `#` 주석 · 목록 값이 아니면서 `parseFrontmatter` 가 열쇠로 읽지 못한 줄은 `line` 이다.
 * 열쇠 줄은 `markKeyLine` 이 본문 열쇠 줄과 같은 방식으로 센다.
 */
function scanHead(head: string[], out: Found): void {
  const seen = new Set<string>()
  const st: HeadState = { block: false, list: false, cont: false }
  for (const raw of head) {
    const line = raw.replace(/\r$/, '')
    if (skipHeadLine(line, st)) continue
    const kv = READ_KEY.exec(line)
    if (!kv) out.add('line')
    st.list = kv?.[2] === ''
    st.block = !!kv && BLOCK_VALUE.test(kv[2].trim())
    st.cont = !!kv && kv[2] !== '' && !st.block
    markKeyLine(line, seen, out)
  }
}

/** 머리말에서 이미 읽은 것. 읽은 갈래의 본문 줄은 머리말을 정본으로 보고 세지 않는다. */
export interface HeadRead {
  area: boolean
  status: boolean
}

/**
 * 본문의 열쇠 줄 하나를 센다. area 줄은 닫힌 `---` 덩어리 안이면 값과 관계없이 세고,
 * 흩어진 줄이면 값이 영문 낱말 하나이거나 닮은 글자를 섞은 낱말일 때만 센다(가이드 본문의 `Area: 서울 전역` 은 세지 않는다).
 */
function bodyMark(line: string, read: HeadRead, inBlock: boolean): Mark | null {
  const k = keyLike(line)
  if (k === 'area') return !read.area && (inBlock || plainBodyValue(line)) ? 'area' : null
  return k === 'status' && !read.status ? 'status' : null
}

/** 본문을 훑는 동안의 상태. */
interface BodyState {
  /** 열린 코드 울타리의 여는 글자. 울타리 밖이면 null. */
  fence: string | null
  /** 머리말 자리의 울타리라서 안도 보는가. */
  checkFence: boolean
  /** 4칸 들여쓴 코드 블록 안인가. */
  code: boolean
  /** 열린 목록 항목의 내용 들여쓰기. 목록 밖이면 null. */
  list: number | null
}

/** 줄 앞 들여쓰기 칸 수(탭은 다음 4칸 자리까지). */
function indentOf(line: string): number {
  let n = 0
  for (const c of line) {
    if (c === ' ') n++
    else if (c === '\t') n += 4 - (n % 4)
    else break
  }
  return n
}

/** 코드 울타리를 여닫는 줄이면 상태를 바꾸고 true. 여는 줄과 같은 글자로 같거나 긴 줄이 닫는다. */
function fenceStep(line: string, atHeadSlot: boolean, st: BodyState): boolean {
  const f = FENCE_OPEN.exec(line)?.[1]
  if (!f) return false
  if (!st.fence) {
    st.fence = f
    st.checkFence = atHeadSlot
    return true
  }
  if (f[0] !== st.fence[0] || f.length < st.fence.length || line.trim().slice(f.length)) return false
  st.fence = null
  return true
}

/**
 * 4칸 들여쓴 코드 블록과 목록 항목을 CommonMark 처럼 따라간다.
 * 코드 블록은 빈 줄 다음(또는 글 처음)에서 시작하고 들여쓴 줄이 이어지는 동안 계속된다. 목록 항목 안에서는 항목 내용의
 * 들여쓰기에 4칸을 더해야 코드다. 그래서 `- 메타`, 빈 줄, 4칸 줄은 항목에 이어진 문단이다.
 * 빈 줄 다음에 항목 내용보다 덜 들여쓴 줄이 오면 목록이 끝난다.
 */
function codeStep(lines: string[], i: number, from: number, st: BodyState): void {
  const line = lines[i]
  const prevBlank = i === from || !lines[i - 1].trim()
  st.code = !!line.trim() && indentOf(line) >= (st.list ?? 0) + 4 && (st.code || prevBlank)
  if (st.code || !line.trim()) return
  const m = LIST_OPEN.exec(line)
  if (m) st.list = m[0].length
  else if (prevBlank && st.list !== null && indentOf(line) < st.list) st.list = null
}

/** 덩어리를 여는 줄(`---`)이면 'open', 닫기만 하는 줄(`...`, YAML 끝 표시)이면 'close'. 폭 없는 글자 · 공백은 지우고 본다. */
function dashKind(line: string): 'open' | 'close' | null {
  const t = visible(line)
  return /^-{3,}$/.test(t) ? 'open' : t === '...' ? 'close' : null
}

/**
 * 머리말 밖의 글: 코드 울타리(``` · ~~~)와 4칸 들여쓴 코드 블록 밖에서 열쇠처럼 보이는 줄.
 * 머리말이 없는 문서는 첫 줄(빈 줄 · HTML 주석 다음)이 울타리면 머리말 자리라서 그 안도 본다.
 * 덩어리는 `---` 줄을 짝으로 세지 않는다. 코드 밖의 첫 `---` 줄보다 뒤이고 마지막 닫는 줄(`---` · `...`)보다 앞인 줄을 덩어리 안으로 본다.
 * 그래서 앞에 구분선 · setext 제목 밑줄이 하나 더 있거나, 울타리 · 4칸 코드 안에 `---` 가 있어도 닫힌 덩어리를 놓치지 않는다.
 */
function scanBody(lines: string[], from: number, headSlot: number, read: HeadRead, out: Found): void {
  const st: BodyState = { fence: null, checkFence: false, code: false, list: null }
  const keys: number[] = []
  let open = Infinity
  let close = -1
  for (let i = from; i < lines.length; i++) {
    if (fenceStep(lines[i], i === headSlot, st) || (st.fence && !st.checkFence)) continue
    codeStep(lines, i, from, st)
    if (st.code) continue
    const kind = dashKind(lines[i])
    if (kind === 'open') open = Math.min(open, i)
    if (kind) close = i
    else keys.push(i)
  }
  for (const i of keys) out.add(bodyMark(lines[i], read, open < i && i < close))
}

/**
 * 머리말로 읽히지 않은 area · category · status 열쇠 줄이나 머리말이 읽지 못한 줄이 있는가.
 * 있으면 「머리말 모양이 어긋난 문서」로 센다.
 * - 머리말 안: 읽지 못한 줄과 area · category 줄은 영역과 관계없이 센다. status 줄은 읽힌 영역(`area`)이 결정 · 정책일 때만 센다.
 * - 머리말 밖: area · category 줄은 머리말에서 영역을 읽지 못했을 때, status 줄은 머리말에서 status 를 읽지 못했을 때만 센다(`read`).
 * 머리말이 닫혔으면 머리말 안과 닫는 줄 뒤의 글을 본다. 머리말이 없거나 닫히지 않았으면 글 전체를 본다.
 */
export function unreadStateLine(src: string, area: string | undefined, read: HeadRead = { area: false, status: false }): boolean {
  const lines = src.replace(/^﻿/, '').split('\n')
  const close = frontmatterClose(lines)
  const out: Found = new Set()
  if (close !== null && close > 0) {
    scanHead(lines.slice(1, close), out)
    scanBody(lines, close + 1, -1, read, out)
  } else scanBody(lines, 0, firstMeaningfulLine(lines), read, out)
  return out.has('area') || out.has('line') || (out.has('status') && BLOCK_AREAS.has(area ?? ''))
}

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** 문자열 값이 정한 낱말 밖인가. 원천 설정의 영역(`extra`)도 받는다. */
const offWord = (v: unknown, words: ReadonlySet<string>, extra?: string) => typeof v === 'string' && !words.has(norm(v)) && norm(v) !== norm(extra)

/**
 * 머리말의 area · category · status 표기가 어긋났는가.
 * - 영역 값이 정한 낱말(`AREA_WORDS`) 밖이다(예: `decisions` · `decision-record`).
 * - 열쇠 · 값의 대소문자만 다르거나, 따옴표 안에 공백이 있거나, area 와 category 가 서로 다른 영역을 가리켜서 결정 · 정책 문서가 차단 대상으로 읽히지 않는다.
 * - 결정 · 정책 문서의 상태 값이 정한 낱말(`STATUS_WORDS`) 밖이다(예: `curent`).
 * `specArea` 는 원천 설정의 영역이다. 정책 원천의 `status: Current` 도 표기가 어긋난 것으로 센다.
 */
export function misspelledHead(data: Record<string, unknown>, specArea: string | undefined): boolean {
  const keys = Object.keys(data)
  const areaKeys = keys.filter((k) => /^(area|category)$/i.test(k))
  if (areaKeys.some((k) => offWord(data[k], AREA_WORDS, specArea))) return true
  const intendsBlock = areaKeys.some((k) => BLOCK_AREAS.has(norm(data[k])))
  const area = typeof data.area === 'string' ? data.area : typeof data.category === 'string' ? data.category : specArea
  if (!BLOCK_AREAS.has(area ?? '')) return intendsBlock
  if (keys.some((k) => /^status$/i.test(k) && k !== 'status')) return true
  const s = data.status
  if (typeof s !== 'string' || s === 'current') return false
  return norm(s) === 'current' || offWord(s, STATUS_WORDS)
}

/** 어댑터가 문서마다 붙이는 머리말 점검 표시. 어댑터 `read` 를 키우지 않으려고 여기서 묶는다. */
export function headFlags(markdown: string, data: Record<string, unknown>, specArea: string | undefined, area: string | undefined, status: string | undefined) {
  const read: HeadRead = { area: typeof data.area === 'string' || typeof data.category === 'string', status: status !== undefined }
  return {
    ...(misshapenHead(markdown) || unreadStateLine(markdown, area, read) ? { headMisshapen: true as const } : {}),
    ...(misspelledHead(data, specArea) ? { headMisspelled: true as const } : {}),
  }
}
