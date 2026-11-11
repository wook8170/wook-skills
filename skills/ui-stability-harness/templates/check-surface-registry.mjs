#!/usr/bin/env node
// scripts/ui-stability/check-surface-registry.mjs
//
// UI 안정성 레지스트리 누락 가드 — 설계 docs/testing/ui-stability-harness.md §5.
//
// 왜: 실사용 화면 결함(팝오버가 레일 아래로 깔림 · 프로그램으로 연 패널이 곧 접힘 · 투어 딤 아래 패널 · 도킹 창이 탑바를 덮음 …)은
//   단위 · e2e 601건이 모두 통과한 채 남아 있었다. 새 표면(팝오버 · 메뉴 · 패널 · 모달 · 오버레이)이나 «프로그램으로 여는» 호출이 생길 때
//   순회 사양(e2e/specs/95-ui-stability-sweep.spec.ts)의 레지스트리에 오르지 않으면 같은 일이 되풀이된다. 이 가드는 앱 코드의 표지를
//   정적으로 세어 레지스트리 · 베이스라인과 대조한다.
//
// 표지(파일 단위로 센다 — apps/{react,vue}/src 의 *.tsx · *.ts · *.vue, 시험 파일 제외)
//   opener  : 프로그램으로 여는 호출 — openWithPrompt( · openAssistant( · toggleAssistant( · openHelp( · openHelpAt( · openHelpPanel( ·
//             openHelpForDataModel( · toggleHelp( · startTour(   (정의 파일 = stores/{assistant,help,tour}.ts 는 제외)
//             + 2판: 딥링크 이동 navigate('/…#앵커') · router.push('/…#앵커') · href="/…#앵커"(I7 · I16 대상)
//   surface : 떠 있는 표면 — createPortal( · <Teleport · role="menu" · role="dialog" · role="tooltip" · aria-modal · gxTooltip · gxPopoverPanel · gxModalOverlay · gxScrim
//             + 2판: role="alertdialog" · <…Drawer 컴포넌트 사용(I9 · I10 · I13 대상)
//
// 판정
//   ① 어떤 파일의 표지 수가 베이스라인(scripts/ui-stability/surface-baseline.json)보다 늘면 실패.
//      → 레지스트리(e2e/helpers/ui-stability/registry.ts)에 진입점을 추가하고 sources 에 그 파일(R/V)을 적은 뒤 `pnpm uistab:baseline`.
//   ② `--update-baseline` 은 레지스트리 sources 에 오른 파일만 수를 올릴 수 있다. 등록되지 않은 파일의 증가는 갱신을 거부한다(줄이기는 언제나 허용).
//   ③ 레지스트리 무결성 — id 중복 · 드라이버(drivers.ts) 없음 · 원장(docs/e2e/uistab.cases.json) 케이스 없음/남는 케이스 ·
//      sources 의 파일이 없거나 표지가 0 · fixme 에 결함 ID 없음 → 실패.
//   한계: 파일 단위라 «이미 등록된 파일 안에 새 표면» 은 수가 늘어 ①에 걸리지만, 갱신(②)은 그 파일이 등록돼 있으면 허용된다 —
//   그 자리는 스킬 절차(.claude/skills/ui-stability-check)와 리뷰 몫이다.
//
// 사용:
//   node scripts/ui-stability/check-surface-registry.mjs            # 보고(위반이 있으면 exit 1)
//   node scripts/ui-stability/check-surface-registry.mjs --json
//   node scripts/ui-stability/check-surface-registry.mjs --update-baseline

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
export const BASELINE_FILE = path.join(__dirname, 'surface-baseline.json')
const REGISTRY_FILE = path.join(REPO, 'e2e/helpers/ui-stability/registry.ts')
const DRIVERS_FILE = path.join(REPO, 'e2e/helpers/ui-stability/drivers.ts')
const LEDGER_FILE = path.join(REPO, 'docs/e2e/uistab.cases.json')
// ▼ 프로젝트 설정 — 앱 소스 폴더 · 여는 함수 정의 파일 · 표지 정규식(OPENER_RE · SURFACE_RE)을 프로젝트에 맞춘다.
const ROOTS = ['apps/web/src']
const EXTS = ['.tsx', '.ts', '.vue']

/** 여는 호출의 정의 파일 — 정의를 호출로 세지 않는다. */
export const DEFINITION_FILES = new Set([
  // 예: 'apps/web/src/stores/assistant.ts' — 패널을 여는 함수를 «정의» 하는 파일(정의를 호출로 세지 않는다)
])

export const OPENER_RE = /\b(?:openWithPrompt|openAssistant|toggleAssistant|openHelp|openHelpAt|openHelpPanel|openHelpForDataModel|toggleHelp|startTour)\s*\(|\b(?:navigate|router\.push)\(\s*['"`]\/[^'"`\n]*#|\bhref="\/[^"\n]*#[\w-]/g
export const SURFACE_RE = /\bcreatePortal\s*\(|<Teleport\b|\brole\s*=\s*["']menu["']|\brole\s*=\s*["']dialog["']|\baria-modal\b|\brole\s*=\s*["']tooltip["']|\bgxTooltip\b|\bgxPopoverPanel\b|\bgxModalOverlay\b|\bgxScrim\b(?!Inset)|\brole\s*=\s*["']alertdialog["']|<[A-Z]\w*Drawer\b/g

/** 주석 줄은 세지 않는다(// · /* · * · <!-- 로 시작하는 줄 · {/* JSX 주석). */
function stripCommentLines(text) {
  return text.split('\n').filter((ln) => { const t = ln.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--') || t.startsWith('{/*')) }).join('\n')
}

/** 원문 하나의 표지 수. */
export function countMarkers(text, rel = '') {
  const body = stripCommentLines(text)
  const opener = DEFINITION_FILES.has(rel) ? 0 : (body.match(OPENER_RE) ?? []).length
  const surface = (body.match(SURFACE_RE) ?? []).length
  return { opener, surface }
}

function walk(dir, out) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (EXTS.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full)
  }
}

/** 앱 전체 스캔 — { 'apps/…': { opener, surface } } (표지 0 파일은 뺀다). */
export function scan(repo = REPO) {
  const files = []
  for (const r of ROOTS) walk(path.join(repo, r), files)
  const out = {}
  for (const f of files.sort()) {
    const rel = path.relative(repo, f).split(path.sep).join('/')
    const c = countMarkers(fs.readFileSync(f, 'utf8'), rel)
    if (c.opener + c.surface > 0) out[rel] = c
  }
  return out
}

/**
 * 비교(순수 함수 — 단위 시험 대상).
 * @returns {{ increased: Array<{file, kind, base, now, covered}>, decreased: Array<{file, kind, base, now}>, gone: string[] }}
 */
export function compare(baseline, current, covered) {
  const increased = [], decreased = [], gone = []
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)])
  for (const file of [...files].sort()) {
    const b = baseline[file] ?? { opener: 0, surface: 0 }
    const n = current[file] ?? { opener: 0, surface: 0 }
    if (!current[file]) gone.push(file)
    for (const kind of ['opener', 'surface']) {
      if (n[kind] > b[kind]) increased.push({ file, kind, base: b[kind], now: n[kind], covered: covered.has(file) })
      else if (n[kind] < b[kind]) decreased.push({ file, kind, base: b[kind], now: n[kind] })
    }
  }
  return { increased, decreased, gone }
}

/** 갱신 가능 여부 — 등록되지 않은 파일의 증가는 거부한다. */
export function updateBlockers(cmp) {
  return cmp.increased.filter((x) => !x.covered)
}

/** 레지스트리 무결성(순수 함수 — 단위 시험 대상). */
export function registryProblems(registry, { driversSrc, ledger, current, exists }) {
  const problems = []
  const ids = new Set()
  const caseIds = new Map()
  for (const e of registry) {
    if (ids.has(e.id)) problems.push(`id 중복: ${e.id}`)
    ids.add(e.id)
    if (!driversSrc.includes(`'${e.id}'`)) problems.push(`${e.id}: drivers.ts 에 드라이버가 없다`)
    if (!e.invariants?.length) problems.push(`${e.id}: 불변식이 비었다`)
    if (!e.conditions?.length) problems.push(`${e.id}: 조건이 비었다`)
    for (const c of e.conditions ?? []) {
      const cid = e.cases?.[c]
      if (!cid) { problems.push(`${e.id}/${c}: 원장 케이스 ID 가 없다`); continue }
      if (caseIds.has(cid)) problems.push(`케이스 ID 중복: ${cid}(${caseIds.get(cid)} · ${e.id}/${c})`)
      caseIds.set(cid, `${e.id}/${c}`)
    }
    for (const s of e.sources ?? []) {
      if (!exists(s)) problems.push(`${e.id}: sources 파일이 없다 — ${s}`)
      else if (!current[s]) problems.push(`${e.id}: sources 파일에 표면 · 여는 호출 표지가 없다(낡은 등록) — ${s}`)
    }
    for (const f of e.fixme ?? []) if (!f.defect || !/\S/.test(f.reason ?? '')) problems.push(`${e.id}: fixme 에 결함 ID · 사유가 없다`)
  }
  const ledgerIds = new Set(ledger.map((c) => c.id))
  for (const [cid, where] of caseIds) if (!ledgerIds.has(cid)) problems.push(`${where}: 원장(docs/e2e/uistab.cases.json)에 ${cid} 가 없다`)
  // 레지스트리 순회(사양 95) 케이스만 짝을 본다 — 자동 탐색(96) · 자체 시험(97) 케이스는 레지스트리 밖이다.
  for (const c of ledger) if (!caseIds.has(c.id) && (!c.spec || c.spec.includes('95-ui-stability'))) problems.push(`원장 ${c.id}: 레지스트리에 그 케이스가 없다`)
  return problems
}

export async function loadRegistry() {
  const mod = await import(pathToFileURL(REGISTRY_FILE).href)
  return mod.REGISTRY
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const update = args.includes('--update-baseline')
  const registry = await loadRegistry()
  const covered = new Set(registry.flatMap((e) => e.sources ?? []))
  const current = scan()
  const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).files ?? {} : {}
  const cmp = compare(baseline, current, covered)
  const problems = registryProblems(registry, {
    driversSrc: fs.readFileSync(DRIVERS_FILE, 'utf8'),
    ledger: fs.existsSync(LEDGER_FILE) ? JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) : [],
    current,
    exists: (s) => fs.existsSync(path.join(REPO, s)),
  })
  const totals = Object.values(current).reduce((a, c) => ({ opener: a.opener + c.opener, surface: a.surface + c.surface }), { opener: 0, surface: 0 })
  const coveredFiles = Object.keys(current).filter((f) => covered.has(f)).length

  if (update) {
    // 베이스라인 파일이 없을 때(처음 잠글 때)만 등록 여부와 무관하게 현재 수를 잠근다.
    const blockers = fs.existsSync(BASELINE_FILE) ? updateBlockers(cmp) : []
    if (blockers.length) {
      console.error('갱신 거부 — 레지스트리에 등록되지 않은 파일의 표면 · 여는 호출이 늘었다:')
      for (const b of blockers) console.error(`  ${b.file}  ${b.kind} ${b.base} → ${b.now}`)
      console.error('  ↳ e2e/helpers/ui-stability/registry.ts 에 진입점을 추가하고 sources 에 이 파일(R/V)을 적는다. 드라이버(drivers.ts)와 원장(docs/e2e/uistab.cases.json)도 함께.')
      process.exit(1)
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ note: 'UI 안정성 가드 베이스라인 — 파일별 표면(surface) · 여는 호출(opener) 표지 수. 손으로 고치지 말고 pnpm uistab:baseline', files: current }, null, 2) + '\n')
    console.log(`베이스라인 갱신: 파일 ${Object.keys(current).length} · 여는 호출 ${totals.opener} · 표면 ${totals.surface}`)
    if (problems.length) { console.error(problems.map((p) => `  [레지스트리] ${p}`).join('\n')); process.exit(1) }
    return
  }

  const fail = cmp.increased.length > 0 || problems.length > 0
  if (json) {
    console.log(JSON.stringify({ registry: registry.length, files: Object.keys(current).length, coveredFiles, totals, ...cmp, problems }, null, 2))
  } else {
    console.log('=== UI 안정성 레지스트리 가드 ===')
    console.log(`레지스트리 항목 ${registry.length} · 표지 파일 ${Object.keys(current).length}(레지스트리 등록 ${coveredFiles}) · 여는 호출 ${totals.opener} · 표면 ${totals.surface}`)
    for (const x of cmp.increased) console.log(`[증가] ${x.file}  ${x.kind} ${x.base} → ${x.now}${x.covered ? ' (등록된 파일 — 진입점을 레지스트리에 추가했으면 pnpm uistab:baseline)' : ' (등록 안 된 파일 — 레지스트리에 진입점 · sources 등록 필요)'}`)
    for (const x of cmp.decreased) console.log(`[감소] ${x.file}  ${x.kind} ${x.base} → ${x.now} (pnpm uistab:baseline 으로 잠근다)`)
    for (const p of problems) console.log(`[레지스트리] ${p}`)
    console.log(fail ? '실패 — .claude/skills/ui-stability-check/SKILL.md 절차를 따른다.' : '통과')
  }
  if (fail) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
