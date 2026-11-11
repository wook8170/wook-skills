#!/usr/bin/env node
// scripts/glossary/check.mjs — 용어 사전 게이트.
//
// 사용법
//   node scripts/glossary/check.mjs                    검사(기준선보다 늘면 exit 1)
//   node scripts/glossary/check.mjs --update-baseline  지금 상태를 기준선으로 잠근다(늘어난 것도 받아들인다 — 오너 확인 뒤에만)
//   node scripts/glossary/check.mjs --top 30           미등록 후보 상위 N 개를 표로 출력
//   node scripts/glossary/check.mjs --json <파일>      전체 결과를 JSON 으로 저장
//
// 검사 네 가지
//   ① 금지어 — 사용자 문구(R/V 화면 · 매뉴얼 · 서버 오류 문구 · MCP 도구 설명 · 고객 문서)에서 사전의 avoid 를 찾는다.
//      주석은 지우고, 예외(exceptions)를 먼저 가린 뒤 찾는다. 파일 × 항목별 건수가 기준선보다 늘면 실패.
//   ② R↔V 용어 불일치 — 같은 상대 경로의 React · Vue 파일이 한 항목에서 금지어 건수가 다르면 불일치로 센다. 새 불일치는 실패.
//   ③ 미등록 용어 래칫 — 버튼 · 메뉴 · 제목 · 탭 · 배지 문자열에서 업무 명사 후보를 뽑아 사전에 없는 낱말을 센다.
//      기준선(docs/glossary/unregistered-baseline.json)에 없는 새 낱말이 생기면 실패.
//   ④ 동의어 충돌 — 새 후보가 기존 항목의 avoid 와 같으면 실패, 쓰는 말과 한 글자 차이면 경고.
// 사전 자체의 형식 오류 · 내부 모순(쓰는 말이 다른 항목의 쓰지 않는 말)도 실패다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPO, loadTerms, loadConfig, collectFiles, visibleText, dropLines, blankMatches, findAvoidHits, termApplies, lineOf,
  extractLabels, nounCandidates, registeredWords, avoidIndex, editDistance, pairKey, koCompare,
} from './lib.mjs'

export const BASELINE_FILE = 'docs/glossary/baseline.json'
export const UNREG_FILE = 'docs/glossary/unregistered-baseline.json'

/** 저장소를 훑어 금지어 · R↔V 불일치 · 미등록 후보를 모은다(파일을 쓰지 않는다). */
export function scan({ repo = REPO, terms, config, files } = {}) {
  if (!terms) terms = loadTerms(repo).terms
  if (!config) config = loadConfig(repo)
  files ??= collectFiles(config, repo)
  const registered = registeredWords(terms, config.ignore ?? [])
  const bans = []
  const sides = new Map() // pair key → { react: {termId:n}, vue: {termId:n}, files }
  const candidates = new Map() // 낱말 → { count, files:Set, sample }
  for (const { file, category } of files) {
    const src = fs.readFileSync(path.join(repo, file), 'utf8')
    if (!/[가-힣]/.test(src)) continue
    const text = blankMatches(dropLines(visibleText(src, file), config.skipLinePatterns?.[category]), config.blankPatterns)
    const perTerm = {}
    for (const term of terms) {
      if (!termApplies(term, category)) continue
      for (const h of findAvoidHits(text, term)) {
        bans.push({ file, category, line: lineOf(text, h.index), termId: term.id, use: term.use, avoid: h.avoid, match: h.match, status: term.status, level: term.level })
        perTerm[term.id] = (perTerm[term.id] ?? 0) + 1
      }
    }
    const pk = pairKey(file, config.pairs)
    if (pk && (category === 'ui' || category === 'manual')) {
      const e = sides.get(pk.key) ?? { react: null, vue: null, files: {} }
      e[pk.side] = { ...(e[pk.side] ?? {}), ...perTerm }
      e.files[pk.side] = file
      sides.set(pk.key, e)
    }
    if ((config.candidateCategories ?? ['ui', 'manual']).includes(category) && /\.(tsx|vue)$/.test(file)) {
      for (const label of extractLabels(text)) {
        for (const w of nounCandidates(label.text)) {
          if (registered.has(w)) continue
          const c = candidates.get(w) ?? { count: 0, files: new Set(), sample: label.text }
          c.count++
          c.files.add(file)
          candidates.set(w, c)
        }
      }
    }
  }
  const parity = []
  for (const [key, e] of sides) {
    if (!e.react || !e.vue) continue
    for (const id of new Set([...Object.keys(e.react), ...Object.keys(e.vue)])) {
      const r = e.react[id] ?? 0, v = e.vue[id] ?? 0
      if (r !== v) parity.push({ key, termId: id, react: r, vue: v, files: e.files })
    }
  }
  return { bans, parity, candidates, files: files.length }
}

const banKey = (b) => `${b.file}|${b.termId}`

export function countBans(bans) {
  const out = {}
  for (const b of bans) if (b.status === '확정') out[banKey(b)] = (out[banKey(b)] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

export function candidatesObject(candidates) {
  return Object.fromEntries([...candidates].sort(([a], [b]) => koCompare(a, b)).map(([w, c]) => [w, c.count]))
}

/** 기준선과 비교한다. 순수 함수 — 시험에서 직접 부른다. */
export function compare({ bans, parity, candidates }, baseline, unreg, terms) {
  const fail = [], warn = [], shrink = []
  const now = countBans(bans)
  const base = baseline?.violations ?? {}
  for (const [k, n] of Object.entries(now)) {
    const b = base[k] ?? 0
    if (n > b) {
      const [file, termId] = k.split('|')
      const lines = bans.filter((x) => x.file === file && x.termId === termId).map((x) => `${x.line}행 「${x.match}」`).slice(0, 5).join(' · ')
      const t = terms.find((x) => x.id === termId)
      fail.push(`금지어 ${file} — 「${t?.use}」 항목 ${b} → ${n}건: ${lines} → 「${t?.use}」로 쓰거나, 다른 뜻이면 terms.yaml exceptions 에 더해 주세요`)
    }
  }
  for (const [k, b] of Object.entries(base)) if ((now[k] ?? 0) < b) shrink.push(k)
  for (const b of bans.filter((x) => x.status === '검토')) warn.push(`검토 항목 ${b.file}:${b.line} 「${b.match}」 → 「${b.use}」(${b.termId}, 오너 결정 대기)`)
  const baseParity = new Set(baseline?.parity ?? [])
  for (const p of parity) {
    const k = `${p.key}|${p.termId}`
    if (!baseParity.has(k)) fail.push(`R↔V 용어 불일치 ${p.files.react} ↔ ${p.files.vue} — ${p.termId}: React ${p.react}건 · Vue ${p.vue}건. 두 앱이 같은 말을 쓰게 맞춰 주세요`)
  }
  const nowParity = new Set(parity.map((p) => `${p.key}|${p.termId}`))
  for (const k of baseParity) if (!nowParity.has(k)) shrink.push(`parity:${k}`)
  const baseWords = unreg?.terms ?? {}
  const avoidMap = avoidIndex(terms)
  const uses = terms.map((t) => t.use).filter((u) => /^[가-힣]+$/.test(u) && u.length >= 3)
  for (const [w, c] of candidates) {
    if (w in baseWords) continue
    if (avoidMap.has(w)) { fail.push(`동의어 충돌 「${w}」 — ${avoidMap.get(w)} 항목의 쓰지 않는 말이에요(${[...c.files][0]} 「${c.sample}」)`); continue }
    const near = uses.find((u) => u !== w && editDistance(u, w) === 1)
    if (near) warn.push(`동의어 후보 「${w}」 — 사전의 「${near}」와 한 글자 차이예요(${[...c.files][0]})`)
    fail.push(`미등록 용어 「${w}」 ${c.count}회 — ${[...c.files][0]} 「${c.sample}」. 사전에 등록(status: 검토)하거나 config.json ignore 에 더해 주세요`)
  }
  const unregNow = candidates.size
  return { fail, warn, shrink, unregNow, unregBase: unreg?.count ?? 0 }
}

export function topCandidates(candidates, n = 30) {
  return [...candidates].sort((a, b) => b[1].files.size - a[1].files.size || b[1].count - a[1].count || koCompare(a[0], b[0])).slice(0, n)
    .map(([w, c]) => ({ word: w, count: c.count, files: c.files.size, sample: c.sample, firstFile: [...c.files][0] }))
}

function main() {
  const args = process.argv.slice(2)
  const { terms, problems } = loadTerms()
  const config = loadConfig()
  if (problems.length) {
    console.error('✗ 용어 사전 형식 오류')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  const res = scan({ terms, config })
  const read = (f, d) => (fs.existsSync(path.join(REPO, f)) ? JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8')) : d)
  if (args.includes('--update-baseline')) {
    const baseline = { note: '용어 금지어(파일|항목 → 건수) · R↔V 불일치 기준선. pnpm glossary:baseline 이 쓴다. 줄이는 것은 자유, 늘리는 것은 오너 확인 뒤에만.', violations: countBans(res.bans), parity: res.parity.map((p) => `${p.key}|${p.termId}`).sort() }
    const unreg = { note: '미등록 용어 후보(버튼 · 메뉴 · 제목 · 탭 · 배지의 업무 명사 후보 중 사전에 없는 낱말 → 출현 수). 새 낱말이 생기면 glossary:check 실패.', count: res.candidates.size, terms: candidatesObject(res.candidates) }
    fs.writeFileSync(path.join(REPO, BASELINE_FILE), JSON.stringify(baseline, null, 2) + '\n')
    fs.writeFileSync(path.join(REPO, UNREG_FILE), JSON.stringify(unreg, null, 2) + '\n')
    console.log(`기준선 갱신 — 금지어 ${res.bans.filter((b) => b.status === '확정').length}건(${Object.keys(baseline.violations).length} 파일×항목) · R↔V 불일치 ${baseline.parity.length} · 미등록 ${unreg.count}`)
    return
  }
  const jsonAt = args.indexOf('--json')
  if (jsonAt >= 0) {
    const out = { files: res.files, bans: res.bans, parity: res.parity, candidates: topCandidates(res.candidates, 100000) }
    fs.writeFileSync(args[jsonAt + 1], JSON.stringify(out, null, 2))
  }
  const topAt = args.indexOf('--top')
  if (topAt >= 0) {
    console.log('| 순위 | 낱말 | 파일 수 | 출현 | 예시 문구 | 첫 파일 |\n|---|---|---|---|---|---|')
    topCandidates(res.candidates, Number(args[topAt + 1] ?? 30)).forEach((c, i) => console.log(`| ${i + 1} | ${c.word} | ${c.files} | ${c.count} | ${c.sample.replace(/\|/g, '\\|')} | ${c.firstFile} |`))
    return
  }
  const cmp = compare(res, read(BASELINE_FILE, null), read(UNREG_FILE, null), terms)
  const confirmed = res.bans.filter((b) => b.status === '확정').length
  console.log(`용어 검사 — 파일 ${res.files} · 사전 ${terms.length}항목 · 금지어 ${confirmed}건(검토 ${res.bans.length - confirmed}) · R↔V 불일치 ${res.parity.length} · 미등록 ${cmp.unregNow}(기준선 ${cmp.unregBase})`)
  for (const w of cmp.warn.slice(0, 20)) console.log('  ⚠ ' + w)
  if (cmp.warn.length > 20) console.log(`  ⚠ … 경고 ${cmp.warn.length - 20}건 더`)
  if (cmp.shrink.length) console.log(`  ↓ 기준선보다 줄어든 항목 ${cmp.shrink.length}개 — pnpm glossary:baseline 으로 다시 잠가 주세요`)
  if (cmp.fail.length) {
    console.error(`✗ 용어 검사 실패 ${cmp.fail.length}건`)
    for (const f of cmp.fail.slice(0, 60)) console.error('  - ' + f)
    if (cmp.fail.length > 60) console.error(`  … ${cmp.fail.length - 60}건 더`)
    console.error('  절차: .claude/skills/glossary/SKILL.md · 사전: docs/glossary/terms.yaml')
    process.exit(1)
  }
  console.log('✓ 용어 검사 통과')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
