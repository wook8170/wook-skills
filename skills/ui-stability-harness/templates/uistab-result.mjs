#!/usr/bin/env node
// scripts/ui-stability/uistab-result.mjs
//
// UI 안정성 순회 결과 → 품질 결과 공통 형식(quality-result/1, 종류 uistab)의 입력. 출하 검증 선행 관문(ship:precheck)의 uistab 칸이 이 결과를 읽는다.
// 형식 정본은 품질 파이프라인(scripts/test-results/quality-lib.mjs · docs/test-results/README.md «공통 머리»).
//
// 판정: 화면 결과마다 ① 탐색 오류 ② 기존 래칫(coverage-baseline)에 없는 위반(기본 조건만) ③ 단계 래칫(staged-baseline) 증가 중 하나라도 있으면 실패.
// 출력: coverage/uistab/quality-input.json(부분 머리 — verdict · counts · suites · failures · detail).
//       scripts/test-results/record-result.mjs 가 있으면(품질 파이프라인 병합 뒤) 그대로 넘겨 docs/test-results/<버전>/<날짜>/uistab-<HHMM>.json · .xlsx 를 쓴다.
// 사용: node scripts/ui-stability/uistab-result.mjs [--started=<ISO>] [--no-record]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadAll, countsOf, increases, summarize } from './staged-report.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'coverage', 'uistab')
const sigOf = (app, screenId, v) => `${app}|${screenId}|${v.inv}|${v.kind}|${v.key}`

/** 결과 목록 + 두 기준선 → 부분 머리. 순수 함수(단위 시험 대상). */
export function buildInput(results, coverageBase, stagedBase) {
  const inc = increases(stagedBase, countsOf(results))
  const incByScreen = new Map()
  for (const x of inc) { const s = x.key.split('|').slice(0, 2).join('|'); incByScreen.set(s, [...(incByScreen.get(s) ?? []), x]) }
  const suites = new Map()
  const failures = []
  for (const r of results) {
    const S = suites.get(r.label) ?? { name: r.label, total: 0, passed: 0, failed: 0, skipped: 0, fixme: 0 }
    suites.set(r.label, S)
    S.total++
    const probs = []
    if (r.error) probs.push(`탐색 오류 — ${r.error.slice(0, 160)}`)
    if (!r.label.includes('@') && coverageBase) {
      const known = `${r.label}|${r.screenId}` in (coverageBase.screens ?? {})
      const fresh = (r.violations ?? []).filter((v) => !known || !(sigOf(r.label, r.screenId, v) in coverageBase.violations))
      for (const v of fresh.slice(0, 5)) probs.push(`새 위반 ${v.inv} ${v.kind} · ${v.comp}`)
    }
    for (const x of incByScreen.get(`${r.label}|${r.screenId}`) ?? []) probs.push(`단계 래칫 ${x.key.split('|')[2]} ${x.lock} → ${x.now}`)
    if (probs.length) { S.failed++; for (const m of probs) failures.push({ suite: r.label, name: r.screenId, message: m }) } else S.passed++
  }
  const list = [...suites.values()]
  const counts = list.reduce((a, s) => ({ total: a.total + s.total, passed: a.passed + s.passed, failed: a.failed + s.failed, skipped: 0, fixme: 0, flaky: 0 }), { total: 0, passed: 0, failed: 0, skipped: 0, fixme: 0, flaky: 0 })
  const sum = summarize(results)
  return {
    verdict: results.length === 0 ? 'failed' : failures.length ? 'failed' : 'passed',
    counts,
    suites: list,
    failures,
    notes: results.length === 0 ? ['결과 파일이 없다 — 96 사양을 먼저 돌린다'] : undefined,
    detail: {
      criteria: '탐색 오류 0 · 기준선에 없는 위반 0(기본 조건) · 단계 규칙 위반 수 증가 0',
      staged: Object.fromEntries(Object.entries(sum.byRule).map(([k, v]) => [k, { total: v.total, screens: v.screens, kinds: v.kinds }])),
      byLabel: sum.byLabel,
      totalSec: Math.round(sum.totalMs / 1000),
      clsTop: sum.clsTop.slice(0, 10),
    },
  }
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true] }))
  const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)
  const input = buildInput(loadAll(), read(path.join(__dirname, 'coverage-baseline.json')), read(path.join(__dirname, 'staged-baseline.json')) ?? { counts: {}, screens: {} })
  fs.mkdirSync(OUT, { recursive: true })
  const f = path.join(OUT, 'quality-input.json')
  fs.writeFileSync(f, JSON.stringify(input, null, 1) + '\n')
  console.log(`[uistab:result] ${path.relative(REPO, f)} · 판정 ${input.verdict} · 화면 ${input.counts.total}(통과 ${input.counts.passed} · 실패 ${input.counts.failed})`)
  const rec = path.join(REPO, 'scripts/test-results/record-result.mjs')
  if (args['no-record']) return
  if (!fs.existsSync(rec)) { console.log('[uistab:result] 품질 파이프라인(record-result.mjs)이 없는 브랜치 — 부분 머리만 남겼다. 병합 뒤 다시 실행하면 docs/test-results/<버전>/<날짜>/uistab-*.json · .xlsx 로 기록된다'); return }
  const r = spawnSync('node', [rec, '--kind=uistab', `--input=${f}`, ...(args.started ? [`--started=${args.started}`] : []), '--command=pnpm uistab:result'], { cwd: REPO, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
