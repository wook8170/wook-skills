// 해시 · 슬러그 · ID 인코딩 · 머리말 · 글롭. 외부 의존성 없이 node 표준만 쓴다.
// 부르는 곳: cli/stale.ts · core/adapter.ts · core/build.ts · core/bundle.ts 등. 먼저 읽을 파일: core/model.ts.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** 내용 해시 · 앵커 해시: 공백을 정규화한 뒤 sha256 앞 16자리. 줄이 밀려도 내용이 같으면 같다. */
export function shortHash(text: string): string {
  return sha256Hex(text.replace(/\s+/g, ' ').trim()).slice(0, 16)
}

/**
 * 절 제목 → ID 조각. 공백 · 구두점은 `-` 로 바꾸고 한글 · 영숫자는 그대로 둔다.
 * `#` · `/` · `~` · `@` 는 ID 구분자라서 제목 안에서는 지운다.
 */
export function slugify(heading: string): string {
  const s = heading
    .normalize('NFC')
    .replace(/`/g, '')
    .replace(/[#/~@]/g, ' ')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  // 조각 ID 는 300자 이하여야 한다(서버 매개변수 규칙). 슬러그는 80자에서 자른다.
  return ([...s].length > 80 ? [...s].slice(0, 80).join('').replace(/-$/, '') : s) || '절'
}

/**
 * 주소 세그먼트 · 쿼리 값 · API 경로에 ID 를 실을 때 쓴다. `encodeURIComponent` 를 정확히 1회 적용한다.
 * 그래서 ID 안의 `/` 는 `%2F` 가 되어 경로 구분자로 읽히지 않는다.
 */
export function encodeId(id: string): string {
  return encodeURIComponent(id)
}

/** encodeId 의 역. 세그먼트를 나눈 뒤 각 세그먼트에 1회만 적용한다. */
export function decodeId(segment: string): string {
  return decodeURIComponent(segment)
}

/**
 * 코드 블록 여닫는 줄. 들여쓰기가 없는 줄만 센다. 머리말의 YAML 여러 줄 값은 늘 들여쓰므로,
 * 값 안의 「```」 · `~~~` 한 줄이 닫는 `---` 를 가리지 않는다.
 */
const FENCE = /^(```|~~~)/

/** 머리말을 닫는 줄. 들여쓰지 않은 `---` 만 인정한다. 줄 끝 공백 · `\r` 은 무시한다. */
const CLOSE = /^---[ \t]*\r?$/

/**
 * 머리말을 닫는 `---` 줄 번호. 첫 줄이 `---` 가 아니면(머리말 없음) null, 닫는 줄이 없으면 -1.
 * 코드 블록(``` · ~~~) 안의 `---` 는 닫는 줄로 보지 않는다. 줄 끝 `\r` 은 무시한다.
 * 들여쓴 `---` 는 YAML 여러 줄 값의 한 줄이라 닫는 줄로 보지 않는다(모양 점검은 `head-shape.ts`).
 */
export function frontmatterClose(lines: string[]): number | null {
  if (lines[0]?.replace(/\r$/, '') !== '---') return null
  let fence = false
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fence = !fence
    else if (!fence && CLOSE.test(lines[i])) return i
  }
  return -1
}

/**
 * Markdown 머리말(`---` 로 감싼 YAML)의 간단한 부분집합을 읽는다. 문서 앞 BOM 은 떼고 읽는다.
 * 첫 줄이 `---` 인데 닫는 줄이 없으면 `unclosed` 를 붙인다(머리말 없는 문서와 구분한다).
 * 지원: `키: 값`, `키: [a, b]`, 다음 줄의 `- 값` 목록, 따옴표 문자열, true · false · 숫자.
 * 중첩 객체는 지원하지 않는다(문자열 그대로 둔다).
 */
export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string; bodyStartLine: number; unclosed?: true } {
  const md = src.replace(/^\ufeff/, '')
  const lines = md.split('\n')
  const end = frontmatterClose(lines)
  if (end === null) return { data: {}, body: md, bodyStartLine: 1 }
  if (end < 0) return { data: {}, body: md, bodyStartLine: 1, unclosed: true }
  const data = frontmatterData(lines.slice(1, end))
  return { data, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 }
}

/** 머리말 안쪽 줄들을 키 · 값으로 읽는다. */
function frontmatterData(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && listKey) {
      ;(data[listKey] as unknown[]).push(scalar(item[1]))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rest] = kv
    if (rest === '') {
      data[key] = []
      listKey = key
      continue
    }
    listKey = null
    const arr = /^\[(.*)\]$/.exec(rest.trim())
    data[key] = arr ? (arr[1].trim() ? splitInline(arr[1]).map(scalar) : []) : scalar(rest)
  }
  return data
}

function splitInline(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null
      cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function scalar(v: string): unknown {
  const t = v.trim().replace(/\s+#.*$/, '')
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1)
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

/** 글롭(`**` · `*` · `?`) → 정규식. 경로 구분자는 `/`. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(rel: string, globs: string[] | undefined): boolean {
  return !!globs?.some((g) => globToRegExp(g).test(rel))
}

/**
 * root 아래 파일을 저장소 상대 경로(정렬)로 돌려준다. 숨김 폴더 · node_modules · 링크는 건너뛴다.
 * root 아래의 링크는 파일 링크든 폴더 링크든(하위 폴더 포함) 따라가지 않고, `links` 를 주면 그 경로를 담는다.
 * root 자체가 파일 링크면 건너뛰고 담는다. root 자체가 폴더 링크면 따라가 그 안을 훑는다.
 */
export function walkFiles(repoRoot: string, rel: string, links?: string[]): string[] {
  const out: string[] = []
  const abs = path.join(repoRoot, rel)
  const self = fs.lstatSync(abs, { throwIfNoEntry: false })
  if (!self) return out
  const rec = (dirRel: string) => {
    const entries = fs.readdirSync(path.join(repoRoot, dirRel), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = dirRel ? `${dirRel}/${e.name}` : e.name
      if (e.isDirectory()) rec(r)
      else if (e.isFile()) out.push(r)
      else if (e.isSymbolicLink()) links?.push(r)
    }
  }
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) rec(rel.replace(/\/$/, ''))
  else if (self.isSymbolicLink()) links?.push(rel)
  else out.push(rel)
  return out
}

/** 보기 경로의 와일드카드 자리에 넣는 글자. 제외 글롭이 한 이름(예: `**\/x.md`)만 덮을 때를 비키려고 둘을 쓴다. `?` 자리에도 맞게 한 글자다. */
const FILLERS = ['x', 'q']

/**
 * 글롭 조각을 보기 글자(f)로 채운 경로들. 조각 `**` 는 조각 0 · 1 · 2개로, 조각 안의 `**`(예: `**.md`)는 `f` · `f/f` 로,
 * `*` · `?` 는 `f` 로 바꾼다.
 */
function fillSegs(segs: string[], f: string): string[] {
  let outs = ['']
  for (const s of segs) {
    const opts = s === '**' ? ['', f, `${f}/${f}`] : (s.includes('**') ? [f, `${f}/${f}`] : [f]).map((r) => s.replace(/\*\*/g, r).replace(/[*?]/g, f))
    outs = outs.flatMap((o) => opts.map((p) => (!p ? o : o ? `${o}/${p}` : p)))
  }
  return outs
}

/**
 * 폴더 링크 경로 아래의 보기 경로들. 글롭의 각 조각부터 끝까지를 보기 글자로 채워 링크 경로 뒤에 붙인다.
 * 보기 경로가 글롭에 맞고 제외 글롭에 걸리지 않는 것이 하나라도 있으면, 링크 안에 원천 파일이 있을 수 있다(`globFiles`).
 * 그래서 제외 글롭이 링크 아래 모든 보기 경로를 덮을 때만 링크를 세지 않는다. 예: `docs/x/**\/decisions/*.md` 의 `docs/x/team` → `docs/x/team/decisions/x.md`.
 */
function samplesUnder(link: string, glob: string): string[] {
  const gs = glob.split('/')
  const out = new Set<string>()
  for (let gi = 0; gi <= gs.length; gi++) {
    for (const f of FILLERS) for (const rest of fillSegs(gs.slice(gi), f)) out.add(`${link}/${rest || f}`)
  }
  return [...out]
}

/**
 * 글롭 목록에 맞는 파일. 글롭의 고정 접두 폴더부터 훑는다. 링크 경로는 `links` 를 주면 거기에 담는다(정렬).
 * 담는 링크: 글롭에 맞는 링크, 그리고 그 안에 글롭에 맞는 파일이 있을 수 있는 폴더 링크.
 * 폴더 링크는 링크 경로 아래의 보기 경로(`samplesUnder`) 가운데 하나라도 글롭에 맞고 제외 글롭에 걸리지 않으면 담는다.
 */
export function globFiles(repoRoot: string, include: string[], exclude: string[] = [], links?: string[]): string[] {
  const set = new Set<string>()
  const linkSet = new Set<string>()
  const hit = (re: RegExp, f: string) => re.test(f) && !matchesAny(f, exclude)
  const dirLink = (f: string) => fs.statSync(path.join(repoRoot, f), { throwIfNoEntry: false })?.isDirectory() === true
  for (const g of include) {
    const fixed = g.split('/').filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?]/.test(s)))
    const base = fixed.join('/')
    const re = globToRegExp(g)
    const found: string[] = []
    for (const f of walkFiles(repoRoot, base, found)) if (hit(re, f)) set.add(f)
    for (const f of found) if (hit(re, f) || (dirLink(f) && samplesUnder(f, g).some((s) => hit(re, s)))) linkSet.add(f)
  }
  links?.push(...[...linkSet].sort(cmp))
  return [...set].sort(cmp)
}

/**
 * 줄 단위로 문서를 고치되 원문의 줄바꿈과 BOM 을 지킨다. CRLF 문서는 LF 로 바꿔 고친 뒤 다시 CRLF 로 돌려준다.
 * 그래서 고친 줄과 새로 넣은 줄도 원문과 같은 줄바꿈을 쓴다. 앞의 BOM 은 떼고 고친 뒤 다시 붙인다.
 */
export function editKeepingEol(src: string, edit: (lf: string) => string): string {
  const bom = src.startsWith('\ufeff') ? '\ufeff' : ''
  const text = src.slice(bom.length)
  if (!text.includes('\r\n')) return bom + edit(text)
  return bom + edit(text.replace(/\r\n/g, '\n')).replace(/\n/g, '\r\n')
}

/** 문자열 비교(코드 단위). 지역 설정에 따라 바뀌지 않게 localeCompare 를 쓰지 않는다. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
