#!/usr/bin/env node
// scripts/ui-stability/coverage-report.mjs
//
// UI 안정성 자동 탐색 계층 ③ — 커버리지 지표 · 위반 묶음 · R↔V 비교(I19) · 래칫. 설계 docs/testing/ui-stability-harness.md §6.
//
// 입력: coverage/uistab/<app>/<화면>.json(e2e/specs/96-ui-auto-sweep.spec.ts 결과) · e2e/helpers/ui-stability/screens.json
// 출력: coverage/uistab/summary.json · coverage/uistab/top-groups.json · docs/testing/ui-coverage.md
//
// 지표
//   화면 커버리지 = 탐색한 화면 / 전체 화면(앱별 — 그 앱에 있는 화면만). 모달은 클릭 탐색이 연 표면에서 그 파일의 testid 를 보면 «방문».
//   요소 커버리지 = 판정이 하나 이상 돈 요소 / 발견한 요소(보이는 상호작용 요소) · 클릭 커버리지 = 누른 요소(같은 컴포넌트 중복 제외 포함) / 클릭 대상
// 래칫(--check)
//   ① 베이스라인(scripts/ui-stability/coverage-baseline.json)에 없는 위반 서명 → 실패  ② 같은 범위(scope)의 커버리지가 기준선보다 0.5%p 넘게 떨어짐 → 실패
//   ③ parity-allow.json 등재에 사유(why)가 없음 → 실패
// 사용:
//   node scripts/ui-stability/coverage-report.mjs [--scope p0|nightly]               # 보고서 · 요약 쓰기
//   node scripts/ui-stability/coverage-report.mjs --check [--scope …]                # 래칫
//   node scripts/ui-stability/coverage-report.mjs --update-baseline [--scope …]      # 지금 결과로 잠그기(위반은 줄이기만 하는 것이 원칙)

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'coverage', 'uistab')
const BASELINE = path.join(__dirname, 'coverage-baseline.json')
const SCREENS = path.join(REPO, 'e2e/helpers/ui-stability/screens.json')
const ALLOW = path.join(REPO, 'e2e/helpers/ui-stability/parity-allow.json')
const DOC = path.join(REPO, 'docs/testing/ui-coverage.md')
const APPS = ['react', 'vue']

export const sigOf = (app, screenId, v) => `${app}|${screenId}|${v.inv}|${v.kind}|${v.key}`

export function loadResults(dir = OUT) {
  const out = []
  for (const app of APPS) {
    const d = path.join(dir, app)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')))
  }
  return out
}

// ── I19 R↔V 비교 ─────────────────────────────────────────────────────────────────────────────────
const setDiff = (a, b) => { const B = new Set(b); return a.filter((x) => !B.has(x)) }
/** 같은 화면의 R · V 결과에서 차이를 위반 형태로. allow = [{ screen, item, why }] 정규식. */
export function parityDiff(r, v, allow = []) {
  const out = []
  if (!r?.parity || !v?.parity) return out
  const ok = (item) => allow.some((a) => new RegExp(a.screen).test(r.screenId) && new RegExp(a.item).test(item))
  const push = (kind, item) => { if (!ok(item)) out.push({ inv: 'I19', kind, comp: `parity:${r.screenId}`, key: item.slice(0, 160), detail: item }) }
  const ra = r.parity.aria.split('\n').map((l) => l.trim()).filter(Boolean), va = v.parity.aria.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const x of setDiff(ra, va).slice(0, 30)) push('접근성 트리 — React 에만', x)
  for (const x of setDiff(va, ra).slice(0, 30)) push('접근성 트리 — Vue 에만', x)
  for (const x of setDiff(r.parity.lines, v.parity.lines).slice(0, 30)) push('보이는 글자 — React 에만', x)
  for (const x of setDiff(v.parity.lines, r.parity.lines).slice(0, 30)) push('보이는 글자 — Vue 에만', x)
  const rb = r.parity.boxes, vb = v.parity.boxes
  for (const id of Object.keys(rb)) {
    if (!(id in vb)) { push('testid — React 에만', id); continue }
    const [x1, y1, w1, h1] = rb[id], [x2, y2, w2, h2] = vb[id]
    if (Math.abs(x1 - x2) > 4 || Math.abs(y1 - y2) > 4 || Math.abs(w1 - w2) > 2 || Math.abs(h1 - h2) > 2) push('상자 위치 · 크기 차이', `${id} R[${rb[id]}] V[${vb[id]}]`)
  }
  for (const id of Object.keys(vb)) if (!(id in rb)) push('testid — Vue 에만', id)
  return out
}

// ── 추정 원인 위치 ────────────────────────────────────────────────────────────────────────────────
function grepFirst(pattern, dirs, fixed = true) {
  try {
    const out = execFileSync('grep', ['-rn', fixed ? '-F' : '-E', '--include=*.tsx', '--include=*.vue', '--include=*.ts', '--include=*.css', pattern, ...dirs], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const line = out.split('\n').find((l) => l && !/\.test\.|\.spec\./.test(l))
    return line ? line.split(':').slice(0, 2).join(':') : null
  } catch { return null }
}
/** 묶음 열쇠(comp)에서 소스 위치를 추정한다 — testid 원문 · 접두(템플릿 문자열) · CSS 모듈 클래스 순서. */
export function locate(comp, app) {
  const dirs = [`apps/${app}/src`]
  const target = comp.includes('⟶') ? comp.split('⟶')[0].trim() : comp
  const [tidPart, rest] = target.split('>')
  const tid = (tidPart || '').trim()
  // 요청 반복 묶음 — 그 요청 경로를 부르는 클라이언트 코드(앱 → 공용 client 순).
  const req = /^요청 \w+ \/api(\/[^?\s]+)/.exec(comp)
  if (req) {
    const pth = req[1].replace(/ep-\*|ep-[\w-]+/g, '').replace(/\/\//g, '/').replace(/\/$/, '')
    const tail = pth.split('/').filter(Boolean).slice(-2).join('/')
    return grepFirst(tail, [`apps/${app}/src`, 'packages/client/src']) ?? null
  }
  const anchor = /^anchor:#([\w-]+)/.exec(tid)
  if (anchor) { const hit = grepFirst(`id="${anchor[1]}"`, dirs); if (hit) return hit }
  if (tid && !/^(screen|anchor|parity):/.test(tid)) {
    const clean = tid.split(/[*#]/)[0]
    if (clean && clean === tid) { const hit = grepFirst(`data-testid="${tid}"`, dirs); if (hit) return hit }
    if (clean.length >= 4) { const hit = grepFirst(`${clean}`, dirs); if (hit) return hit }
  }
  const cls = rest && /\.([A-Za-z][\w-]+)/.exec(rest)?.[1]
  if (cls) { const hit = grepFirst(`.${cls}`, dirs); if (hit) return hit }
  return null
}

/**
 * 컴포넌트 «가족» — 행마다 데이터 id 가 붙은 testid(<접두>-menu-<id> 등)를 한 묶음으로. 데이터 id 접두(ds- · proj- …)는 프로젝트마다 달라
 * 어댑터 설정(e2e/helpers/ui-stability/project.config.json idPrefixes)에서 받는다.
 */
const PROJECT = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'e2e/helpers/ui-stability/project.config.json'), 'utf8')) } catch { return { idPrefixes: [] } } })()
export function family(comp, prefixes = PROJECT.idPrefixes ?? []) {
  if (!prefixes.length) return comp
  const re = new RegExp(`(-menu|-row|-item|-btn|-card|-chip|-group|-wrap|-toggle|-check)?-(${prefixes.join('|')})[-_][\\w#*-]*`, 'g')
  return comp.replace(re, '$1-*')
}

// ── 요약 ─────────────────────────────────────────────────────────────────────────────────────────
export function summarize(results, screens, allow = []) {
  const byApp = {}
  const groups = new Map()
  const allViolations = []
  for (const app of APPS) {
    const mine = results.filter((r) => r.app === app)
    const total = screens.filter((s) => s.apps.includes(app))
    const explored = new Set(mine.filter((r) => !r.error).map((r) => r.screenId))
    const markers = new Set(mine.flatMap((r) => r.markersSeen ?? []))
    for (const s of total) if (s.kind === 'modal' && (s.markers ?? []).some((m) => markers.has(m))) explored.add(s.id)
    const sum = (k) => mine.reduce((a, r) => a + (r[k] ?? 0), 0)
    const inv = {}
    for (const r of mine) for (const v of r.violations) { inv[v.inv] = (inv[v.inv] ?? 0) + 1; allViolations.push({ app, screenId: r.screenId, ...v }) }
    byApp[app] = {
      screensTotal: total.length, screensExplored: explored.size, screenCoverage: total.length ? explored.size / total.length : 0,
      elementsFound: sum('found'), elementsChecked: sum('checkedEls'), elementCoverage: sum('found') ? sum('checkedEls') / sum('found') : 0,
      clickTargets: sum('clickTargets'), clicked: sum('clicked') + sum('clickDedup'), clickCoverage: sum('clickTargets') ? Math.min(1, (sum('clicked') + sum('clickDedup')) / sum('clickTargets')) : 0,
      surfacesOpened: sum('surfacesOpened'), ms: sum('ms'), errors: mine.filter((r) => r.error).map((r) => `${r.screenId}: ${r.error}`), violationsByInv: inv,
      warnings: sum('warnings') || mine.reduce((a, r) => a + (r.warnings?.length ?? 0), 0),
      byKind: Object.fromEntries([...new Set(total.map((s) => s.kind))].map((k) => [k, { total: total.filter((s) => s.kind === k).length, explored: total.filter((s) => s.kind === k && explored.has(s.id)).length }])),
      unexplored: total.filter((s) => !explored.has(s.id)).map((s) => s.id),
    }
  }
  // I19 — 같은 화면의 R · V 비교
  const parity = []
  for (const r of results.filter((x) => x.app === 'react')) {
    const v = results.find((x) => x.app === 'vue' && x.screenId === r.screenId)
    for (const d of parityDiff(r, v, allow)) { parity.push({ app: 'rv', screenId: r.screenId, ...d }); allViolations.push({ app: 'rv', screenId: r.screenId, ...d }) }
  }
  for (const v of allViolations) {
    // 같은 컴포넌트에서 반복되는 위반은 하나로 — I19 는 화면 단위로 묶는다.
    // 요청 반복(I15) · 콘솔(I14)은 «어느 요청 · 어떤 메시지» 가 원인이라 그것으로 묶는다(화면이 달라도 같은 결함).
    const fam = v.inv === 'I15' ? `요청 ${String(v.detail).split(': ').slice(1).join(': ').replace(/ × \d+.*$/, '').replace(/ep-\d+-\w+/g, 'ep-*')}`
      : v.inv === 'I14' ? `콘솔 ${String(v.detail).split(': ').slice(1).join(': ').replace(/\d+/g, '#').slice(0, 80)}`
      : family(String(v.comp))
    const gk = v.inv === 'I19' ? `I19|${v.kind}|${v.screenId}` : `${v.inv}|${v.kind}|${fam}`
    const g = groups.get(gk) ?? { key: gk, inv: v.inv, kind: v.kind, comp: v.inv === 'I19' ? v.screenId : fam, count: 0, apps: new Set(), screens: new Set(), example: v, byApp: {} }
    g.byApp[v.app] = (g.byApp[v.app] ?? 0) + 1
    if ((g.byApp[v.app] ?? 0) > (g.byApp[g.example.app] ?? 0)) g.example = v
    g.count++; g.apps.add(v.app); g.screens.add(v.screenId)
    groups.set(gk, g)
  }
  const ranked = [...groups.values()].map((g) => ({ ...g, apps: [...g.apps], screens: [...g.screens] }))
    .sort((a, b) => b.screens.length - a.screens.length || b.count - a.count)
  return { byApp, groups: ranked, violations: allViolations, parityCount: parity.length }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`

export function renderDoc(sum, screens, scope, meta) {
  const L = []
  L.push('# UI 자동 탐색 커버리지')
  L.push('')
  L.push(`> 자동 생성(\`pnpm uistab:coverage\`) — 손으로 고치지 않는다. 범위 ${scope} · ${meta.when} · 화면 목록 ${screens.length}개(\`e2e/helpers/ui-stability/screens.json\`) · 설계 \`docs/testing/ui-stability-harness.md\` §6`)
  L.push('')
  L.push('## 1. 지표')
  L.push('')
  L.push('| 앱 | 화면(탐색/전체) | 화면 커버리지 | 요소(검사/발견) | 요소 커버리지 | 클릭(탐색/대상) | 클릭 커버리지 | 연 표면 | 위반 | 경고 | 소요 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [app, a] of Object.entries(sum.byApp)) {
    const nv = Object.values(a.violationsByInv).reduce((x, y) => x + y, 0)
    L.push(`| ${app} | ${a.screensExplored}/${a.screensTotal} | ${pct(a.screenCoverage)} | ${a.elementsChecked}/${a.elementsFound} | ${pct(a.elementCoverage)} | ${a.clicked}/${a.clickTargets} | ${pct(a.clickCoverage)} | ${a.surfacesOpened} | ${nv} | ${a.warnings} | ${Math.round(a.ms / 1000)}초 |`)
  }
  L.push('')
  L.push('## 2. 화면 종류별 탐색')
  L.push('')
  const kinds = [...new Set(screens.map((s) => s.kind))]
  L.push('| 종류 | ' + Object.keys(sum.byApp).map((a) => `${a} 탐색/전체`).join(' | ') + ' |')
  L.push('|---|' + Object.keys(sum.byApp).map(() => '---').join('|') + '|')
  for (const k of kinds) L.push(`| ${k} | ` + Object.values(sum.byApp).map((a) => a.byKind[k] ? `${a.byKind[k].explored}/${a.byKind[k].total}` : '—').join(' | ') + ' |')
  L.push('')
  L.push('## 3. 불변식별 위반')
  L.push('')
  const invs = [...new Set(sum.violations.map((v) => v.inv))].sort()
  L.push('| 불변식 | React | Vue | R↔V | 묶음 수 |')
  L.push('|---|---|---|---|---|')
  for (const i of invs) L.push(`| ${i} | ${sum.violations.filter((v) => v.inv === i && v.app === 'react').length} | ${sum.violations.filter((v) => v.inv === i && v.app === 'vue').length} | ${sum.violations.filter((v) => v.inv === i && v.app === 'rv').length} | ${sum.groups.filter((g) => g.inv === i).length} |`)
  L.push('')
  L.push('## 4. 위반 묶음 상위 40(같은 컴포넌트의 반복은 하나로)')
  L.push('')
  L.push('| # | 불변식 | 종류 | 컴포넌트 | 화면 수 | 건수 | 앱 | 추정 위치 | 예시 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  sum.groups.slice(0, 40).forEach((g, i) => {
    const loc = g.loc ?? ''
    L.push(`| ${i + 1} | ${g.inv} | ${g.kind} | \`${String(g.comp).replace(/\|/g, '/').slice(0, 70)}\` | ${g.screens.length} | ${g.count} | ${g.apps.join('·')} | ${loc ? `\`${loc}\`` : '—'} | ${String(g.example.detail).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 110)} |`)
  })
  L.push('')
  L.push('## 4.1 수정 작업용 상위 10 묶음(R↔V 차이 제외)')
  L.push('')
  L.push('| 순위 | 불변식 | 종류 | 컴포넌트 | 화면 수 | 건수 | 앱 | 추정 위치 | 캡처 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  meta.actionable.slice(0, 10).forEach((g, i) => L.push(`| ${i + 1} | ${g.inv} | ${g.kind} | \`${String(g.comp).replace(/\|/g, '/').slice(0, 60)}\` | ${g.screens.length} | ${g.count} | ${g.apps.join('·')} | ${g.loc ? `\`${g.loc}\`` : '—'} | \`coverage/uistab/captures/${String(i + 1).padStart(2, '0')}-<앱>.2x.png\` |`))
  L.push('')
  L.push('## 5. 화면 × 요소')
  L.push('')
  L.push('| 화면 | 앱 | 요소(검사/발견) | 숨은 요소 | 클릭(누름/대상) | 연 표면 | 위반 | ms |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const r of meta.results.sort((a, b) => a.screenId.localeCompare(b.screenId) || a.app.localeCompare(b.app))) {
    L.push(`| ${r.screenId} | ${r.app} | ${r.checkedEls}/${r.found} | ${r.hidden} | ${r.clicked + r.clickDedup}/${r.clickTargets} | ${r.surfacesOpened} | ${r.violations.length} | ${r.ms}${r.error ? ' · 오류' : ''} |`)
  }
  L.push('')
  L.push('## 6. 탐색하지 않은 화면')
  L.push('')
  for (const [app, a] of Object.entries(sum.byApp)) {
    L.push(`- ${app}(${a.unexplored.length}): ` + a.unexplored.map((id) => { const s = screens.find((x) => x.id === id); return `\`${id}\`${s?.why ? `(${s.why.slice(0, 30)})` : ''}` }).slice(0, 120).join(' · '))
  }
  L.push('')
  return L.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : 'nightly'
  const screens = JSON.parse(fs.readFileSync(SCREENS, 'utf8')).screens
  const allowDoc = fs.existsSync(ALLOW) ? JSON.parse(fs.readFileSync(ALLOW, 'utf8')) : { entries: [] }
  const allowProblems = allowDoc.entries.filter((a) => !a.why || !/\S/.test(a.why)).map((a) => `parity-allow 등재에 사유가 없다: ${JSON.stringify(a)}`)
  const results = loadResults()
  if (!results.length) { console.error('결과 없음 — coverage/uistab/<app>/*.json(e2e/specs/96-ui-auto-sweep.spec.ts 를 먼저 돌린다)'); process.exit(1) }
  const sum = summarize(results, screens, allowDoc.entries)
  // 수정 작업으로 나눌 상위 묶음은 요소 · 표면 불변식에서 고른다 — I19(R↔V)는 화면 단위 차이 목록이라 따로 센다(§4 표에는 함께 나온다).
  const actionable = sum.groups.filter((g) => g.inv !== 'I19')
  for (const g of [...sum.groups.slice(0, 40), ...actionable.slice(0, 10)]) g.loc = g.loc ?? locate(String(g.comp), g.example.app === 'vue' || (!g.apps.includes('react') && !g.apps.includes('rv')) ? 'vue' : 'react')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ scope, when: new Date().toISOString(), byApp: sum.byApp, groups: sum.groups.slice(0, 200) }, null, 2))
  fs.writeFileSync(path.join(OUT, 'top-groups.json'), JSON.stringify(actionable.slice(0, 10).map((g, i) => ({ rank: i + 1, inv: g.inv, kind: g.kind, comp: g.comp, loc: g.loc, app: g.example.app === 'rv' ? 'react' : g.example.app, screenId: g.example.screenId, key: g.example.key, detail: g.example.detail, screens: g.screens.length, count: g.count })), null, 2))
  fs.writeFileSync(DOC, renderDoc(sum, screens, scope, { when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', results, actionable }) + '\n')

  const metrics = Object.fromEntries(Object.entries(sum.byApp).map(([a, m]) => [a, { screenCoverage: m.screenCoverage, elementCoverage: m.elementCoverage, clickCoverage: m.clickCoverage }]))
  const sigs = Object.fromEntries(sum.violations.map((v) => [sigOf(v.app, v.screenId, v), 1]))
  const explored = Object.fromEntries(results.filter((r) => !r.error).map((r) => [`${r.app}|${r.screenId}`, true]))
  if (args.includes('--update-baseline')) {
    const old = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { metrics: {}, violations: {}, screens: {} }
    const next = { note: 'UI 자동 탐색 래칫 기준선 — 손으로 고치지 말고 pnpm uistab:coverage --update-baseline. violations 는 고치지 않은 기존 위반(서명 = 앱|화면|불변식|종류|요소), 고치면 줄어든다.', metrics: { ...old.metrics, [scope]: metrics }, violations: scope === 'nightly' ? sigs : { ...old.violations, ...sigs }, screens: { ...old.screens, ...explored } }
    fs.writeFileSync(BASELINE, JSON.stringify(next, null, 1) + '\n')
    console.log(`기준선 갱신(${scope}): 위반 ${Object.keys(next.violations).length} · 화면 ${Object.keys(next.screens).length}`)
    return
  }
  for (const [app, a] of Object.entries(sum.byApp)) console.log(`${app}: 화면 ${a.screensExplored}/${a.screensTotal}(${pct(a.screenCoverage)}) · 요소 ${a.elementsChecked}/${a.elementsFound}(${pct(a.elementCoverage)}) · 클릭 ${a.clicked}/${a.clickTargets}(${pct(a.clickCoverage)}) · 위반 ${JSON.stringify(a.violationsByInv)} · ${Math.round(a.ms / 1000)}초`)
  console.log(`R↔V(I19) 차이 ${sum.parityCount} · 묶음 ${sum.groups.length} · 보고서 ${path.relative(REPO, DOC)}`)
  if (args.includes('--check')) {
    const b = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null
    const problems = [...allowProblems]
    if (!b) problems.push('기준선 없음 — pnpm uistab:coverage --update-baseline')
    else {
      const fresh = sum.violations.filter((v) => !(sigOf(v.app, v.screenId, v) in b.violations))
      for (const v of fresh.slice(0, 40)) problems.push(`새 위반 ${v.app} ${v.screenId} ${v.inv} ${v.kind} · ${v.comp} · ${String(v.detail).slice(0, 100)}`)
      if (fresh.length > 40) problems.push(`… 새 위반 ${fresh.length - 40}건 더`)
      const base = b.metrics?.[scope]
      if (base) for (const [app, m] of Object.entries(metrics)) for (const k of Object.keys(m)) if (base[app] && m[k] + 0.005 < base[app][k]) problems.push(`커버리지 하락 ${app} ${k} ${pct(m[k])} < 기준선 ${pct(base[app][k])}`)
    }
    for (const p of problems) console.log(`[래칫] ${p}`)
    console.log(problems.length ? '실패' : '통과')
    if (problems.length) process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
