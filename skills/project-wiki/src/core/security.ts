// 묶음에 들어갈 원문 검사. 비밀값은 언제나 실패, 개인 경로 · 내부 DB 주소 · 고객 데이터는
// 부르는 곳: cli/build.ts · core/adapter.ts · core/build.ts · core/quarantine.ts 등. 먼저 읽을 파일: core/quarantine.ts.
// 서버 묶음에서 실패 · 로컬 묶음에서 경고다. 예외는 설정의 allow(규칙 · 경로 글롭 · 문자열 · 사유)로만 둔다.
import type { SecurityFinding } from './model.ts'
import { globToRegExp } from './util.ts'

export const SECURITY_RULES_VERSION = 'builtin/1'

export interface AllowEntry {
  rule: string
  path?: string
  match?: string
  reason: string
}

export interface SecurityConfig {
  allow?: AllowEntry[]
  /** 내부 개발 DB 주소 등 이 저장소에서만 아는 패턴(정규식 문자열). */
  ownerDb?: string[]
  /** 고객 데이터로 볼 추가 패턴(정규식 문자열). 예: 고객 계정 ID 꼴. */
  customer?: string[]
  /** 예시로 쓰는 메일 도메인(이 도메인은 고객 데이터로 보지 않는다). */
  emailDomains?: string[]
}

interface Rule {
  name: string
  category: SecurityFinding['category']
  re: RegExp
  /** 값 부분(그룹 번호). 자리표시자면 걸지 않는다. */
  valueGroup?: number
  mask: boolean
  /** 추가 판정. false 면 걸지 않는다. */
  accept?: (m: RegExpExecArray, line: string, next: string) => boolean
}

const PLACEHOLDER =
  /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\{\{.*\}\}|\*+|x{3,}|\.{3}|…|changeme|change-me|example\w*|your[-_].*|dummy\w*|sample\w*|placeholder|redacted|masked|none|null|undefined|true|false|secret|password|token|test\w*|demo\w*|dev|local|admin|\.\.\.|-+)$/i

function isPlaceholder(v: string): boolean {
  const t = v.replace(/^["'`]|["'`;,]$/g, '')
  return !t || PLACEHOLDER.test(t) || /[가-힣]/.test(t) || /^process\.env/.test(t) || /^env\./.test(t) || t.length < 8
}

/** 섀넌 엔트로피(글자당 비트). 사람이 쓴 낱말은 낮고 무작위 키는 높다. */
function entropy(s: string): number {
  const f = new Map<string, number>()
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

const SECRET_RULES: Rule[] = [
  {
    name: 'private-key',
    category: 'secret',
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    mask: true,
    accept: (_m, _l, next) => /^[A-Za-z0-9+/=]{40,}$/.test(next.trim()),
  },
  { name: 'github-token', category: 'secret', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/, mask: true },
  { name: 'slack-token', category: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, mask: true },
  { name: 'aws-access-key', category: 'secret', re: /\bAKIA[0-9A-Z]{16}\b/, mask: true },
  { name: 'llm-api-key', category: 'secret', re: /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})/, mask: true },
  { name: 'jwt', category: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/, mask: true },
  {
    name: 'url-credential',
    category: 'secret',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@`'"]+:([^\s@/`'"]+)@/i,
    valueGroup: 1,
    mask: true,
  },
  {
    name: 'assigned-secret',
    category: 'secret',
    re: /\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[=:]\s*["']?([^\s"'`,;)]+)/,
    valueGroup: 1,
    mask: true,
    accept: (m) => entropy(m[1]) >= 3.5 && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1]),
  },
]

const PATH_RULES: Rule[] = [
  { name: 'personal-path-volumes', category: 'personal-path', re: /\/Volumes\/(?![<{$])[A-Za-z0-9._-]+\/[^\s`'")\]]*/, mask: false },
  {
    name: 'personal-path-home',
    category: 'personal-path',
    re: /\/home\/(?![<{$]|이름|name\b|username\b|user\b)[A-Za-z0-9._-]+\/[^\s`'")\]]*/,
    mask: false,
  },
  {
    name: 'personal-path-users',
    category: 'personal-path',
    re: /\/Users\/(?![<{$]|이름|name\b|username\b|user\b|me\b|you\b|Shared\b)[A-Za-z0-9._-]+[^\s`'")\]]*/,
    mask: false,
  },
]

function customerRules(cfg: SecurityConfig): Rule[] {
  const domains = ['example.com', 'example.org', 'example.net', 'example', 'test', 'localhost', 'invalid', ...(cfg.emailDomains ?? [])]
  const rules: Rule[] = [
    {
      name: 'email',
      category: 'customer-data',
      re: /(?<![\w@/])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/,
      mask: true,
      // `git@github.com:조직/저장소` 같은 SSH 주소는 메일 주소가 아니다.
      accept: (m) => !m[0].startsWith('git@') && !domains.some((d) => m[1].toLowerCase() === d || m[1].toLowerCase().endsWith(`.${d}`)),
    },
    {
      name: 'phone-kr',
      category: 'customer-data',
      re: /\b01[016789]-?\d{3,4}-?\d{4}\b/,
      mask: true,
      accept: (m) => !/(0000|1234|5678|xxxx)$/i.test(m[0]) && !/^010-?0000/.test(m[0]),
    },
    { name: 'business-no', category: 'customer-data', re: /\b\d{3}-\d{2}-\d{5}\b/, mask: true, accept: (m) => !/^(000|123)-/.test(m[0]) },
  ]
  for (const [i, p] of (cfg.customer ?? []).entries()) rules.push({ name: `customer-${i + 1}`, category: 'customer-data', re: new RegExp(p), mask: true })
  for (const [i, p] of (cfg.ownerDb ?? []).entries()) rules.push({ name: `owner-db-${i + 1}`, category: 'owner-db', re: new RegExp(p), mask: false })
  return rules
}

function maskValue(v: string): string {
  return v.length <= 6 ? '***' : `${v.slice(0, 4)}…(${v.length}자)`
}

type AllowRule = AllowEntry & { re: RegExp | null }

/** 자리표시자 · 추가 판정 · 예외 목록 순서로 걸러서, 보고할 일치인지 정한다. */
function shouldReport(r: Rule, mm: RegExpExecArray, line: string, next: string, file: string, allow: AllowRule[]): boolean {
  if (r.valueGroup && isPlaceholder(mm[r.valueGroup] ?? '')) return false
  if (r.accept && !r.accept(mm, line, next)) return false
  return !allow.some((a) => a.rule === r.name && (!a.re || a.re.test(file)) && (!a.match || line.includes(a.match)))
}

function findingOf(r: Rule, mm: RegExpExecArray, line: string, lineNo: number, file: string, profile: 'server' | 'local'): SecurityFinding {
  const hit = mm[0]
  const severity: SecurityFinding['severity'] = r.category === 'secret' || profile === 'server' ? 'fail' : 'warn'
  const shown = r.mask ? maskValue(hit) : hit
  const start = Math.max(0, (mm.index ?? 0) - 30)
  const excerpt = (line.slice(start, mm.index) + shown + line.slice((mm.index ?? 0) + hit.length, (mm.index ?? 0) + hit.length + 30)).trim()
  return { rule: r.name, category: r.category, severity, path: file, line: lineNo, excerpt }
}

/** 텍스트 하나를 검사한다. profile 이 server 면 비밀값 외 규칙도 실패, local 이면 경고. */
export function scanText(text: string, file: string, profile: 'server' | 'local', cfg: SecurityConfig = {}): SecurityFinding[] {
  const allow: AllowRule[] = (cfg.allow ?? []).map((a) => ({ ...a, re: a.path ? globToRegExp(a.path) : null }))
  return scanRules([...SECRET_RULES, ...PATH_RULES, ...customerRules(cfg)], allow, text, file, profile)
}

/**
 * 대입 꼴의 소문자 · 섞인 이름(`password:` · `apiToken =`). 판정(엔트로피 · 숫자 · 글자)은 `assigned-secret` 과 같다.
 * 격리 판정(`scanSecretsStrict`)에만 쓴다. 묶음 검사(scanText)에 넣으면 격리를 켜지 않은 설정의 판정이 바뀌기 때문이다.
 */
const ASSIGNED_SECRET_ANYCASE: Rule = {
  ...SECRET_RULES.find((r) => r.name === 'assigned-secret')!,
  name: 'assigned-secret-anycase',
  re: /\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|private_?key)\s*[=:]\s*["']?([^\s"'`,;)]+)/i,
}

/**
 * 격리 판정용 원문 검사(core/quarantine.ts). 비밀값 규칙 전부 + 대소문자를 가리지 않는 대입 꼴. 예외 목록(`allow`)은 쓰지 않는다.
 * 그래서 `scanText` 의 비밀값 판정보다 넓거나 같다. 걸린 파일은 격리한다.
 */
export function scanSecretsStrict(text: string, file: string): SecurityFinding[] {
  return scanRules([...SECRET_RULES, ASSIGNED_SECRET_ANYCASE], [], text, file, 'local')
}

function scanRules(rules: Rule[], allow: AllowRule[], text: string, file: string, profile: 'server' | 'local'): SecurityFinding[] {
  const out: SecurityFinding[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const r of rules) {
      const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`)
      for (const m of line.matchAll(re)) {
        const mm = m as unknown as RegExpExecArray
        if (!shouldReport(r, mm, line, lines[i + 1] ?? '', file, allow)) continue
        out.push(findingOf(r, mm, line, i + 1, file, profile))
      }
    }
  })
  return out
}
