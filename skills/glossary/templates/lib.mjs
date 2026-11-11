// scripts/glossary/lib.mjs — 용어 사전 공용 유틸(범용판). 읽기 · 문구 추출 · 금지어 판정 · 미등록 후보 추출.
//
// 정본: docs/glossary/terms.yaml(사전) · docs/glossary/config.json(검사 범위 · 무시 목록).
// 이 파일은 판정에 쓰는 순수 함수만 담는다. 파일을 쓰는 일은 gen.mjs, 게이트 판정은 check.mjs 가 한다.
// 신규 npm 의존 0 — YAML 은 사전이 쓰는 부분 집합만 읽는 작은 파서로 읽는다(아래 parseYaml).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
export const TERMS_FILE = 'docs/glossary/terms.yaml'
export const CONFIG_FILE = 'docs/glossary/config.json'

export const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')

// ─────────────────────────────────────────────────────────────────────────────
// YAML 부분 집합 파서
//   지원: 들여쓰기 맵 · 블록 리스트(`- `) · 리스트 안의 맵 · 스칼라(맨글 · "큰따옴표" JSON 규칙 · '작은따옴표')
//         · 빈 리스트 `[]` · 줄 전체 주석(`#` 로 시작하는 줄).
//   미지원: 줄 끝 주석(값 안의 `#` 은 글자로 둔다) · 흐름 맵 · 앵커 · 여러 줄 스칼라.
//   사전이 이 범위를 벗어나면 조용히 틀리게 읽지 않고 예외를 던진다.
// ─────────────────────────────────────────────────────────────────────────────
export function parseYaml(src) {
  const lines = src.split('\n').map((raw, i) => ({ raw, no: i + 1 }))
    .filter(({ raw }) => raw.trim() !== '' && !/^\s*#/.test(raw))
    .map(({ raw, no }) => {
      if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`terms.yaml ${no}행: 들여쓰기에 탭을 쓸 수 없어요`)
      return { indent: raw.match(/^ */)[0].length, text: raw.trim(), no }
    })
  let i = 0
  function scalar(s, no) {
    if (s === '[]') return []
    if (s === '{}') return {}
    if (s.startsWith('"')) {
      try { return JSON.parse(s) } catch { throw new Error(`terms.yaml ${no}행: 큰따옴표 문자열을 읽지 못했어요 — ${s}`) }
    }
    if (s.startsWith("'")) {
      if (!s.endsWith("'") || s.length < 2) throw new Error(`terms.yaml ${no}행: 작은따옴표가 닫히지 않았어요`)
      return s.slice(1, -1).replace(/''/g, "'")
    }
    if (s.startsWith('[') || s.startsWith('{')) throw new Error(`terms.yaml ${no}행: 흐름 표기([a, b] · {a: b})는 쓰지 않아요 — 블록 리스트로 적어 주세요`)
    if (/^-?\d+$/.test(s)) return Number(s)
    if (s === 'true' || s === 'false') return s === 'true'
    if (s === 'null' || s === '~') return null
    return s
  }
  function splitKey(text, no) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(text)
    if (!m) throw new Error(`terms.yaml ${no}행: 「키: 값」 형식이 아니에요 — ${text}`)
    return [m[1], m[2]]
  }
  function block(indent) {
    if (i >= lines.length) return null
    return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(indent) : map(indent)
  }
  function list(indent) {
    const out = []
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const { text, no } = lines[i]
      const rest = text === '-' ? '' : text.slice(2).trim()
      if (rest === '') { i++; out.push(block(lines[i]?.indent ?? indent + 2)); continue }
      if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
        // 리스트 항목이 맵 — 첫 키는 같은 줄, 나머지 키는 `- ` 다음 열에 맞춘다.
        const childIndent = indent + 2
        lines[i] = { indent: childIndent, text: rest, no }
        out.push(map(childIndent))
        continue
      }
      out.push(scalar(rest, no)); i++
    }
    return out
  }
  function map(indent) {
    const out = {}
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const { text, no } = lines[i]
      const [key, val] = splitKey(text, no)
      if (key in out) throw new Error(`terms.yaml ${no}행: 키 「${key}」가 두 번 나왔어요`)
      i++
      if (val === undefined || val === '') {
        const next = lines[i]
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) out[key] = block(next.indent)
        else out[key] = null
      } else out[key] = scalar(val, no)
    }
    return out
  }
  const doc = block(lines[0]?.indent ?? 0)
  if (i < lines.length) throw new Error(`terms.yaml ${lines[i].no}행: 들여쓰기가 맞지 않아요 — ${lines[i].text}`)
  return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// 사전 읽기 · 검증
// ─────────────────────────────────────────────────────────────────────────────
export const SCOPES = ['ui', 'manual', 'docs', 'all']
export const STATUSES = ['확정', '검토']
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

/** 사전 항목을 정규화하고 형식 오류를 모은다. */
export function normalizeTerms(doc) {
  const problems = []
  const raw = Array.isArray(doc) ? doc : doc?.terms
  if (!Array.isArray(raw)) return { terms: [], problems: ['terms.yaml: 최상위에 terms: 리스트가 없어요'] }
  const ids = new Set()
  const terms = raw.map((t, n) => {
    const where = `terms[${n}]${t?.id ? ` (${t.id})` : ''}`
    if (!t || typeof t !== 'object') { problems.push(`${where}: 항목이 맵이 아니에요`); return null }
    for (const k of ['id', 'use', 'meaning', 'decided', 'status']) if (!t[k] || typeof t[k] !== 'string') problems.push(`${where}: 「${k}」가 비어 있어요`)
    if (t.id && !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) problems.push(`${where}: id 는 영문 소문자 · 숫자 · 하이픈만 써요`)
    if (t.id && ids.has(t.id)) problems.push(`${where}: id 「${t.id}」가 겹쳐요`)
    ids.add(t.id)
    const scope = String(t.scope ?? 'all').split(/[,\s]+/).filter(Boolean)
    for (const s of scope) if (!SCOPES.includes(s)) problems.push(`${where}: scope 「${s}」는 ${SCOPES.join('/')} 중 하나여야 해요`)
    if (t.status && !STATUSES.includes(t.status)) problems.push(`${where}: status 는 확정 또는 검토예요`)
    const level = t.level ?? (t.status === '검토' ? 'warn' : 'fail')
    if (!['fail', 'warn'].includes(level)) problems.push(`${where}: level 은 fail 또는 warn 이에요`)
    const avoid = asList(t.avoid).map(String)
    const exceptions = asList(t.exceptions).map(String)
    for (const a of [...avoid, ...exceptions]) {
      if (a.startsWith('re:')) { try { new RegExp(a.slice(3), 'u') } catch (e) { problems.push(`${where}: 정규식 「${a}」 — ${e.message}`) } }
    }
    for (const a of avoid) if (!a.startsWith('re:') && a === t.use) problems.push(`${where}: 쓰는 말과 쓰지 않는 말이 같아요 — ${a}`)
    return { id: t.id, use: t.use, avoid, meaning: t.meaning, exceptions, code: t.code ?? '', scope, decided: t.decided, status: t.status, level, aliases: asList(t.aliases).map(String) }
  }).filter(Boolean)
  // 동의어 충돌(사전 안) — 한 항목의 쓰는 말이 다른 항목의 쓰지 않는 말이면 모순이다.
  for (const a of terms) for (const b of terms) {
    if (a === b) continue
    if (b.avoid.includes(a.use) && !b.exceptions.includes(a.use)) problems.push(`${a.id}: 쓰는 말 「${a.use}」가 ${b.id} 의 쓰지 않는 말이에요`)
  }
  return { terms, problems }
}

export function loadTerms(repo = REPO) {
  const doc = parseYaml(fs.readFileSync(path.join(repo, TERMS_FILE), 'utf8'))
  return normalizeTerms(doc)
}

export function loadConfig(repo = REPO) {
  return JSON.parse(fs.readFileSync(path.join(repo, CONFIG_FILE), 'utf8'))
}

/** 가나다순(한글 먼저, 그다음 영문) 비교. */
export function koCompare(a, b) {
  const ha = /^[가-힣]/.test(a), hb = /^[가-힣]/.test(b)
  if (ha !== hb) return ha ? -1 : 1
  return a.localeCompare(b, 'ko')
}

// ─────────────────────────────────────────────────────────────────────────────
// 금지어 판정 — 예외 문구를 같은 길이의 빈칸으로 가린 뒤 쓰지 않는 말을 찾는다(위치 보존).
// ─────────────────────────────────────────────────────────────────────────────
const toRegex = (p, flags = 'gu') => (p.startsWith('re:') ? new RegExp(p.slice(3), flags) : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags))

export function maskExceptions(text, exceptions) {
  let out = text
  for (const ex of exceptions) out = out.replace(toRegex(ex), (m) => ' '.repeat(m.length))
  return out
}

/** text 안의 term 위반 위치 목록 — [{ avoid, index, match }]. */
export function findAvoidHits(text, term) {
  if (!term.avoid.length) return []
  const masked = maskExceptions(text, term.exceptions)
  const hits = []
  for (const a of term.avoid) {
    for (const m of masked.matchAll(toRegex(a))) if (m[0]) hits.push({ avoid: a, index: m.index, match: m[0] })
  }
  return hits.sort((x, y) => x.index - y.index)
}

export function termApplies(term, category) {
  if (term.scope.includes('all')) return true
  if (category === 'manual') return term.scope.includes('manual')
  if (category === 'docs') return term.scope.includes('docs')
  return term.scope.includes('ui') // ui · server · mcp 는 사용자에게 보이는 문구
}

// ─────────────────────────────────────────────────────────────────────────────
// 문구 추출 — 주석을 같은 길이의 공백으로 지운 «가린 원문»을 만든다(줄 번호 보존).
//   사전의 낱말은 모두 한글이라 영문 식별자는 저절로 빠진다. 남는 한글은 문자열 · JSX 글 · 템플릿 글이다.
// ─────────────────────────────────────────────────────────────────────────────
const blank = (s) => s.replace(/[^\n]/g, ' ')
const REGEX_PREV = /[(,=:[!&|?{};+\-*%~^]$|^$|\b(return|typeof|case|in|of|delete|void|throw|new|yield|await)$/

/** JS/TS 소스에서 주석만 지운다. 문자열 · 템플릿 · 정규식 리터럴 안의 // 는 주석으로 보지 않는다. */
export function stripJsComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  const tplStack = [] // 템플릿 리터럴 안의 ${ 깊이
  let lastSig = '' // 마지막으로 본 의미 있는 코드 조각(정규식 판정용)
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? n : j; out += blank(src.slice(i, end)); i = end; continue }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; out += blank(src.slice(i, end)); i = end; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1); i = j + 1; lastSig = 'str'; continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') { tplStack.push(0); break }
        j++
      }
      if (j < n && src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; lastSig = 'str'; continue }
      out += src.slice(i, j + 2); i = j + 2; lastSig = '{'; continue
    }
    if (tplStack.length && (c === '{' || c === '}')) {
      if (c === '{') { tplStack[tplStack.length - 1]++; out += c; i++; lastSig = '{'; continue }
      if (tplStack[tplStack.length - 1] > 0) { tplStack[tplStack.length - 1]--; out += c; i++; lastSig = '}'; continue }
      // 템플릿 ${…} 이 닫혔다 — 이어지는 템플릿 글을 읽는다.
      tplStack.pop()
      let j = i + 1
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') { tplStack.push(0); break }
        j++
      }
      if (j < n && src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; lastSig = 'str'; continue }
      out += src.slice(i, j + 2); i = j + 2; lastSig = '{'; continue
    }
    if (c === '/' && REGEX_PREV.test(lastSig)) {
      // 정규식 리터럴 — 같은 줄 안에서 닫히는 경우만 인정한다(아니면 나눗셈으로 본다).
      let j = i + 1, inClass = false, ok = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) { ok = true; break }
        j++
      }
      if (ok) { j++; while (/[a-z]/.test(src[j] ?? '')) j++; out += src.slice(i, j); i = j; lastSig = 're'; continue }
    }
    out += c
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) { const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i, i + 40)); lastSig = m[0]; out += src.slice(i + 1, i + m[0].length); i += m[0].length; continue }
      lastSig = c
    }
    i++
  }
  return out
}

/** Vue SFC — <template> 의 HTML 주석, <script> 의 JS 주석을 지우고 <style> 은 통째로 지운다. */
// SFC 최상위 블록은 줄 첫 칸에서 열고 닫는다 — 주석 안의 「<style>」 같은 글자를 블록으로 오인하지 않게 줄 첫 칸만 본다.
export function stripVueComments(src) {
  const html = (s) => s.replace(/^<style\b[^>]*>[\s\S]*?^<\/style>/gm, blank).replace(/<!--[\s\S]*?-->/g, blank)
  let out = ''
  let last = 0
  for (const m of src.matchAll(/^(<script\b[^>]*>)([\s\S]*?)^(<\/script>)/gm)) {
    out += html(src.slice(last, m.index)) + m[1] + stripJsComments(m[2]) + m[3]
    last = m.index + m[0].length
  }
  return out + html(src.slice(last))
}

/** Markdown — 코드 블록 · 인라인 코드 · HTML 주석을 지운다(글 본문만 남긴다). */
export function stripMarkdown(src) {
  return src
    .replace(/^( {0,3})(```|~~~)[\s\S]*?^\1\2[^\n]*$/gm, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/`[^`\n]+`/g, blank)
}

export function visibleText(src, file) {
  if (/\.vue$/.test(file)) return stripVueComments(src)
  if (/\.(m?[jt]sx?|cjs|mts)$/.test(file)) return stripJsComments(src)
  if (/\.md$/.test(file)) return stripMarkdown(src)
  return src
}

/** 서버 로그처럼 사용자에게 보이지 않는 줄을 지운다(config.skipLinePatterns). */
export function dropLines(text, patterns) {
  if (!patterns?.length) return text
  const res = patterns.map((p) => new RegExp(p))
  return text.split('\n').map((l) => (res.some((r) => r.test(l)) ? blank(l) : l)).join('\n')
}

/** 검색 동의어처럼 일부러 옛 말을 담는 자리를 같은 길이 공백으로 지운다(config.blankPatterns). */
export function blankMatches(text, patterns) {
  if (!patterns?.length) return text
  let out = text
  for (const p of patterns) out = out.replace(new RegExp(p, 'gu'), blank)
  return out
}

export function lineOf(text, index) {
  let n = 1
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) n++
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// 미등록 후보 — 버튼 · 메뉴 · 제목 · 탭 · 배지 문자열에서 업무 명사 후보를 뽑는다.
// ─────────────────────────────────────────────────────────────────────────────
const LABEL_PATTERNS = [
  // 요소 내용: 버튼 · 제목 · 표 머리 · 옵션 · 범례 · 요약 · 탭 · 배지
  /<(button|h[1-6]|th|option|legend|summary)\b[^>]*>\s*([^<{]+?)\s*</gu,
  /<[A-Za-z]+\b[^>]*\b(role="tab"|role="menuitem"|class(?:Name)?="[^"]*\bgx(?:Badge|Tab|Segment|MenuItem)[^"]*")[^>]*>\s*([^<{]+?)\s*</gu,
  // 속성 · 객체 키: label · title · aria-label · heading · tab · badge
  /\b(label|title|aria-label|heading|tabLabel|menuLabel|buttonLabel|badge)\s*[=:]\s*\{?\s*(?:"'|')?["'`]([^"'`\n{}$<>]+)["'`]/gu,
]

export function extractLabels(text) {
  const out = []
  for (const re of LABEL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const s = m[2].replace(/\s+/g, ' ').trim()
      if (s && /[가-힣]/.test(s) && s.length <= 40) out.push({ text: s, index: m.index })
    }
  }
  return out
}

const PARTICLES2 = ['에서', '으로', '까지', '부터', '에게', '처럼', '보다', '이나', '마다', '별로']
const PARTICLES1 = ['을', '를', '이', '가', '은', '는', '에', '의', '로', '와', '과', '도', '만']
const VERB_END = /(기|요|다|고|게|지|면|서|며|니|해|함|됨|음|임|요\?|까|죠|세요|하기|하는|되는|있는|없는|드는|한다|된다|할|된|돼|줘|봐)$/u

/** 라벨 하나를 업무 명사 후보 낱말로 쪼갠다. */
export function nounCandidates(label) {
  const out = []
  for (let tok of label.split(/[^가-힣]+/u)) {
    if (tok.length < 2) continue
    for (const p of PARTICLES2) if (tok.length - p.length >= 2 && tok.endsWith(p)) { tok = tok.slice(0, -p.length); break }
    // 목적격 조사(을 · 를)는 두 글자 낱말에서도 뗀다(「키를」 → 「키」 → 한 글자라 버림). 나머지는 세 글자 이상에서만 뗀다(「추가」의 「가」 보호).
    for (const p of PARTICLES1) if (tok.endsWith(p) && (tok.length - 1 >= 2 || p === '을' || p === '를')) { tok = tok.slice(0, -1); break }
    if (tok.length < 2 || VERB_END.test(tok)) continue
    out.push(tok)
  }
  return out
}

/** 사전에 등록된 낱말 집합 — 쓰는 말 · 별칭(띄어쓰기 · 가운뎃점 단위로 쪼갠 낱말도 포함). */
export function registeredWords(terms, extra = []) {
  const set = new Set(extra)
  for (const t of terms) {
    for (const w of [t.use, ...t.aliases]) {
      set.add(w)
      for (const part of w.split(/[^가-힣]+/u)) if (part.length >= 2) set.add(part)
    }
  }
  return set
}

/** 쓰지 않는 말(글자 그대로인 것) → 항목 id. 동의어 충돌 판정용. */
export function avoidIndex(terms) {
  const m = new Map()
  for (const t of terms) for (const a of t.avoid) if (!a.startsWith('re:')) m.set(a, t.id)
  return m
}

/** 두 낱말의 편집 거리(동의어 충돌 후보 — 한 글자 차이). */
export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

// ─────────────────────────────────────────────────────────────────────────────
// 파일 수집
// ─────────────────────────────────────────────────────────────────────────────
export function walk(root, { exts, exclude = [] }, repo = REPO) {
  const abs = path.join(repo, root)
  if (!fs.existsSync(abs)) return []
  const ex = exclude.map((p) => new RegExp(p))
  const out = []
  const visit = (p) => {
    const st = fs.statSync(p)
    const r = path.relative(repo, p).split(path.sep).join('/')
    if (ex.some((e) => e.test(r))) return
    if (st.isDirectory()) { if (/(^|\/)(node_modules|dist|coverage|\.git)$/.test(r)) return; for (const f of fs.readdirSync(p).sort()) visit(path.join(p, f)) } else if (exts.some((e) => p.endsWith(e))) out.push(r)
  }
  visit(abs)
  return out
}

/** config.sources 를 펼쳐 [{ file, category }] 로 만든다(앞 규칙이 이긴다 — 매뉴얼을 ui 보다 먼저 적는다). */
export function collectFiles(config, repo = REPO) {
  const seen = new Map()
  for (const s of config.sources) {
    for (const f of walk(s.root, { exts: s.exts, exclude: [...(config.exclude ?? []), ...(s.exclude ?? [])] }, repo)) if (!seen.has(f)) seen.set(f, s.category)
  }
  return [...seen].map(([file, category]) => ({ file, category }))
}

/** R↔V 짝 — apps/react/src/X.tsx ↔ apps/vue/src/X.vue (확장자 무시, 같은 상대 경로). */
export function pairKey(file, pairs) {
  for (const p of pairs ?? []) {
    for (const [side, root] of [['react', p.react], ['vue', p.vue]]) {
      if (file.startsWith(root + '/')) return { side, key: file.slice(root.length + 1).replace(/\.(tsx|ts|vue)$/, '') }
    }
  }
  return null
}
