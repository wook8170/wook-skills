#!/usr/bin/env node
// 화면 목록 자동 수집(범용 템플릿) — 코드에서 «화면» 을 세어 e2e/helpers/ui-stability/screens.json 을 만든다. --check 는 커밋된 목록과 다르면 실패.
//
// 화면 = 들어가는 방법이 있는 상태 하나: 라우트 · 관리자 절 · 설정 카드 앵커(#id) · 매뉴얼 절 · 단계 · 서랍 · 모달 파일 · 패널 탭.
// 프로젝트마다 아래 ▼ 설정과 COLLECTORS 를 채운다. 원칙:
//   · 숫자는 «세어서» 만든다(문서 값을 베끼지 않는다).
//   · 매개변수 라우트는 ROUTE_FILL 에 시드 대표 id 로 채운다 — 채우지 않은 새 라우트는 문제(problems)로 잡혀 --check 가 실패한다.
//   · 자동 탐색에서 빼는 화면은 auto:false + why(사유) — 커버리지 분모에는 남는다.
//   · 모달은 URL 이 없다 — markers(그 파일의 고정 testid 몇 개)를 적어 두면 클릭 탐색이 연 표면에서 보았을 때 «방문» 으로 센다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
export const SCREENS_FILE = path.join(REPO, 'e2e/helpers/ui-stability/screens.json')

// ▼ 프로젝트 설정 ───────────────────────────────────────────────────────────────────────────────
/** 라우터 정의 파일 — { 앱 이름: 파일 }. 두 구현(React · Vue)이면 둘 다. */
const ROUTER_FILES = { web: 'apps/web/src/router.tsx' }
/** 앱 소스 폴더(모달 파일 수집). */
const APP_SRC = { web: 'apps/web/src' }
/** 라우트 → 들어가는 방법. role: owner | anon(비로그인). setup: 순회 사양의 SETUPS 키. p0: 병합 관문 화면. */
export const ROUTE_FILL = {
  '/': { url: '/', role: 'owner', p0: true },
  '/login': { url: '/login', role: 'anon' },
  // '/projects/:id': { url: '/projects/<시드 대표 id>', role: 'owner', p0: true },
  // '/share/:token': { url: '/share/{token}', role: 'anon', setup: 'share-token' },
}
/** 화면 종류별 수집기 — 필요한 것만 남긴다. 각 함수는 [{ id, kind, title, entry, scope? }] 를 돌려준다. */
const COLLECTORS = [
  // 설정 카드 앵커: id="…" 를 단 카드(tabIndex={-1} 등)를 /settings#id 화면으로
  // (r) => cardAnchors(r('apps/web/src/screens/Settings.tsx')).map((id) => ({ id: `anchor:/settings#${id}`, kind: 'anchor', title: `/settings#${id}`, entry: { url: `/settings#${id}` }, scope: `#${id}` })),
]
// ▲ ───────────────────────────────────────────────────────────────────────────────────────────

export function routesFrom(src) {
  const out = new Set()
  for (const m of src.matchAll(/\bpath:\s*'([^']*)'/g)) {
    const p = m[1]
    if (!p || p === '*' || p.startsWith('/:pathMatch')) continue
    if (/:\w+\?$/.test(p)) { out.add(p.replace(/\/:\w+\?$/, '')); out.add(p.replace(/\?$/, '')) } else out.add(p)
  }
  return out
}
export function cardAnchors(src) {
  const out = []
  for (const m of src.matchAll(/\bid="([a-z][\w-]*)"/g)) {
    const tag = src.slice(src.lastIndexOf('<', m.index), src.indexOf('>', m.index) + 1)
    if (/^<(input|select|textarea|label|option)\b/.test(tag)) continue
    if (/tabIndex=\{-1\}|^<section\b/.test(tag) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}
function walk(dir, out) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out); else out.push(full)
  }
}

export function collect(repo = REPO) {
  const r = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8')
  const screens = [], problems = []
  const add = (s) => screens.push({ auto: true, role: 'owner', ...s })
  const routes = Object.fromEntries(Object.entries(ROUTER_FILES).map(([app, f]) => [app, routesFrom(r(f))]))
  const all = [...new Set(Object.values(routes).flatMap((s) => [...s]))].sort()
  for (const p of all) {
    const fill = ROUTE_FILL[p]
    if (!fill) { problems.push(`라우트 ${p}: ROUTE_FILL 에 들어가는 방법(대표 id · 역할)이 없다`); continue }
    if (fill.auto === false && !fill.why) problems.push(`라우트 ${p}: auto=false 사유(why)가 없다`)
    add({ id: `route:${p}`, kind: 'route', title: p, apps: Object.keys(routes).filter((a) => routes[a].has(p)), entry: { url: fill.url, ...(fill.setup ? { setup: fill.setup } : {}) }, role: fill.role, ...(fill.auto === false ? { auto: false, why: fill.why } : {}), ...(fill.p0 ? { p0: true } : {}) })
  }
  for (const p of Object.keys(ROUTE_FILL)) if (!all.includes(p)) problems.push(`ROUTE_FILL ${p}: 라우터에 없는 낡은 항목`)
  for (const c of COLLECTORS) for (const s of c(r)) add({ apps: Object.keys(ROUTER_FILES), ...s })
  for (const [app, dir] of Object.entries(APP_SRC)) {
    const files = []; walk(path.join(repo, dir), files)
    for (const f of files) {
      const m = /^(\w+(?:Modal|Dialog|Drawer))\.(tsx|vue)$/.exec(path.basename(f))
      if (!m || /\.(test|spec)\./.test(f)) continue
      const markers = [...new Set([...fs.readFileSync(f, 'utf8').matchAll(/data-testid="([\w-]+)"/g)].map((x) => x[1]))].slice(0, 6)
      add({ id: `modal:${app}:${m[1]}`, kind: 'modal', title: m[1], apps: [app], entry: { via: 'click-explore' }, markers, auto: false, why: '여는 동작은 클릭 탐색이 찾는다' })
    }
  }
  const seen = new Set()
  for (const s of screens) { if (seen.has(s.id)) problems.push(`화면 id 중복: ${s.id}`); seen.add(s.id) }
  return { screens, problems }
}
export const countBy = (screens) => screens.reduce((a, s) => ({ ...a, [s.kind]: (a[s.kind] ?? 0) + 1 }), {})
export function diffScreens(committed, now) {
  const a = new Map(committed.map((s) => [s.id, s])), b = new Map(now.map((s) => [s.id, s]))
  return { added: [...b.keys()].filter((k) => !a.has(k)), removed: [...a.keys()].filter((k) => !b.has(k)), changed: [...b.keys()].filter((k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))) }
}

function main() {
  const { screens, problems } = collect()
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(SCREENS_FILE) ? JSON.parse(fs.readFileSync(SCREENS_FILE, 'utf8')).screens : []
    const d = diffScreens(committed, screens)
    for (const x of d.added) console.log(`[목록에 없음] ${x}`)
    for (const x of d.removed) console.log(`[사라짐] ${x}`)
    for (const x of d.changed) console.log(`[바뀜] ${x}`)
    for (const p of problems) console.log(`[목록] ${p}`)
    const fail = d.added.length + d.removed.length + d.changed.length + problems.length > 0
    console.log(`화면 ${screens.length} · ${JSON.stringify(countBy(screens))} — ${fail ? '실패(목록을 다시 만들고 커밋한다)' : '통과'}`)
    if (fail) process.exit(1)
    return
  }
  fs.writeFileSync(SCREENS_FILE, JSON.stringify({ note: '자동 생성 — 손으로 고치지 않는다', total: screens.length, byKind: countBy(screens), screens }, null, 2) + '\n')
  console.log(`화면 목록 ${screens.length} · ${JSON.stringify(countBy(screens))}`)
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
