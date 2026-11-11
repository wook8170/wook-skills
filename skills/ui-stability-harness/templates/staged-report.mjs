#!/usr/bin/env node
// scripts/ui-stability/staged-report.mjs
//
// UI 안정성 하네스 3판 — 단계 도입 규칙(I38~I47) · 조건 축 결과 요약과 «수» 래칫. 설계 docs/testing/ui-stability-harness.md §3.3 · §6.7.
//
// 입력: coverage/uistab/<앱>[@<조건>]/<화면>.json 의 staged · cls · focusStops · visual · ms
// 출력: coverage/uistab/staged-summary.json(규칙 · 조건별 수, 화면 · 규칙별 목록, 실행 시간)
// 래칫: scripts/ui-stability/staged-baseline.json — counts["<앱[@조건]>|<화면>|<규칙>"] = 잠근 위반 수, screens["<앱[@조건]>|<화면>"] = true.
//   96 사양은 잠근 화면에서 규칙별 위반 수가 늘면 실패한다. 처음 잠금(--lock)은 지금 수 그대로, 그 뒤로는 --shrink 로 줄어든 것만 반영한다.
// 사용:
//   node scripts/ui-stability/staged-report.mjs                 # 요약 쓰기
//   node scripts/ui-stability/staged-report.mjs --lock          # 기준선이 없는 화면만 지금 수로 잠근다(있는 화면은 건드리지 않는다)
//   node scripts/ui-stability/staged-report.mjs --shrink        # 다시 돈 화면에서 줄어든 수만 반영(늘어난 수는 거부 — 고쳐야 한다)
//   node scripts/ui-stability/staged-report.mjs --check         # 결과가 기준선보다 많으면 실패(96 사양과 같은 판정, 결과 파일 기준)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'coverage', 'uistab')
const BASE = path.join(__dirname, 'staged-baseline.json')

/** 결과 폴더 이름(react · vue · react@dark+w768 …) 별로 결과를 모은다. */
export function loadAll(dir = OUT) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const label of fs.readdirSync(dir)) {
    if (!/^(react|vue)(@[\w+]+)?$/.test(label)) continue
    const d = path.join(dir, label)
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))
      out.push({ label, ...r })
    }
  }
  return out
}

/** 화면 · 규칙별 수. */
export function countsOf(results) {
  const counts = {}
  const screens = {}
  for (const r of results) {
    screens[`${r.label}|${r.screenId}`] = true
    for (const v of r.staged ?? []) { const k = `${r.label}|${r.screenId}|${v.inv}`; counts[k] = (counts[k] ?? 0) + 1 }
  }
  return { counts, screens }
}

/** 결과가 기준선보다 늘어난 칸(잠근 화면만). */
export function increases(base, now) {
  const out = []
  for (const k of Object.keys(now.counts)) {
    const scr = k.split('|').slice(0, 2).join('|')
    if (!(scr in (base?.screens ?? {}))) continue
    const lock = base.counts[k] ?? 0
    if (now.counts[k] > lock) out.push({ key: k, lock, now: now.counts[k] })
  }
  return out
}

export function summarize(results) {
  const byRule = {}
  const byLabel = {}
  let ms = 0
  for (const r of results) {
    ms += r.ms ?? 0
    const L = (byLabel[r.label] ??= { screens: 0, ms: 0, staged: 0, violations: 0, errors: 0 })
    L.screens++; L.ms += r.ms ?? 0; L.staged += (r.staged ?? []).length; L.violations += (r.violations ?? []).length; if (r.error) L.errors++
    for (const v of r.staged ?? []) {
      const R = (byRule[v.inv] ??= { total: 0, screens: new Set(), kinds: {}, items: [] })
      R.total++; R.screens.add(`${r.label}|${r.screenId}`); R.kinds[v.kind] = (R.kinds[v.kind] ?? 0) + 1
      if (R.items.length < 400) R.items.push({ label: r.label, screen: r.screenId, kind: v.kind, comp: v.comp, detail: v.detail })
    }
  }
  for (const R of Object.values(byRule)) R.screens = R.screens.size
  const cls = results.filter((r) => typeof r.cls === 'number').map((r) => ({ label: r.label, screen: r.screenId, cls: r.cls })).sort((a, b) => b.cls - a.cls).slice(0, 20)
  return { generatedAt: new Date().toISOString(), screens: results.length, totalMs: ms, byLabel, byRule, clsTop: cls }
}

function main() {
  const args = process.argv.slice(2)
  const results = loadAll()
  const now = countsOf(results)
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : { note: '', counts: {}, screens: {} }
  if (args.includes('--check')) {
    const inc = increases(base, now)
    if (inc.length) { console.error(`[uistab:staged] 단계 규칙 위반 수 증가 ${inc.length}칸\n  - ${inc.slice(0, 30).map((x) => `${x.key} ${x.lock} → ${x.now}`).join('\n  - ')}`); process.exit(1) }
    console.log(`[uistab:staged] 통과 — 잠근 화면 ${Object.keys(base.screens).length} · 결과 화면 ${Object.keys(now.screens).length}`)
    return
  }
  if (args.includes('--lock') || args.includes('--shrink')) {
    const lockNew = args.includes('--lock')
    const inc = increases(base, now)
    if (inc.length && args.includes('--shrink')) { console.error(`[uistab:staged] 늘어난 칸이 있어 줄이기를 거부한다 — 고친 뒤 다시\n  - ${inc.slice(0, 30).map((x) => `${x.key} ${x.lock} → ${x.now}`).join('\n  - ')}`); process.exit(1) }
    let added = 0, shrunk = 0
    for (const scr of Object.keys(now.screens)) {
      const known = scr in base.screens
      if (!known && !lockNew) continue
      if (!known) { base.screens[scr] = true; added++ }
      // 이 화면의 규칙 칸을 지금 수로 맞춘다(알던 화면은 줄어든 칸만).
      const prefix = `${scr}|`
      for (const k of Object.keys(base.counts)) if (k.startsWith(prefix) && known && (now.counts[k] ?? 0) < base.counts[k]) { shrunk += base.counts[k] - (now.counts[k] ?? 0); if (now.counts[k]) base.counts[k] = now.counts[k]; else delete base.counts[k] }
      if (!known) for (const [k, n] of Object.entries(now.counts)) if (k.startsWith(prefix)) base.counts[k] = n
    }
    base.note = '단계 도입 규칙(I38~I47) 화면 · 규칙별 위반 수 래칫 — 손으로 고치지 말고 pnpm uistab:staged --lock(새 화면) · --shrink(줄어든 것만). 늘면 96 사양이 실패한다. 설계 docs/testing/ui-stability-harness.md §6.7'
    const sorted = { note: base.note, counts: Object.fromEntries(Object.entries(base.counts).sort()), screens: Object.fromEntries(Object.keys(base.screens).sort().map((k) => [k, true])) }
    fs.writeFileSync(BASE, JSON.stringify(sorted, null, 1) + '\n')
    console.log(`[uistab:staged] 기준선 — 새로 잠근 화면 ${added} · 줄인 위반 ${shrunk} · 전체 칸 ${Object.keys(sorted.counts).length}`)
  }
  const sum = summarize(results)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'staged-summary.json'), JSON.stringify(sum, null, 1))
  const rules = Object.entries(sum.byRule).sort().map(([k, v]) => `${k} ${v.total}건/${v.screens}화면`).join(' · ')
  console.log(`[uistab:staged] 화면 결과 ${sum.screens} · 순회 ${Math.round(sum.totalMs / 1000)}초 · ${rules || '단계 위반 없음'}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
