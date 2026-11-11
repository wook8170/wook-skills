#!/usr/bin/env node
// scripts/ui-stability/check-css-parse.mjs
//
// I27 CSS · 템플릿 빌드 검증(정적, pnpm uistab:check → pnpm gate). 설계 docs/testing/ui-stability-harness.md §I27.
//
// 왜: typecheck · vitest · design-lint 는 CSS 를 컴파일하지 않는다. CSS 주석 안의 `*/`(글롭 `apps/*/src` 같은 글자)가 주석을 일찍 닫아
//   빌드 결과 화면을 백지로 만든 결함이 병합 뒤에야 드러난 사례가 있다(references/case-study.md).
// 판정
//   실패: ROOTS 의 *.css 와 .vue <style> 블록 중 postcss 파싱 오류가 하나라도 있으면.
//   경고: 주석 안에 `/*/` · `*/--` 같은 글롭 · 경로 조각, 주석 안 `{` `}`(원문 계약 시험의 추출기를 속인다).
// postcss 는 vite 의존성에서 빌려 쓴다(새 의존성 없음).
//
// 사용: node scripts/ui-stability/check-css-parse.mjs [--json]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
// ▼ 프로젝트 설정 — postcss 를 빌려 올 패키지(vite 를 의존하는 앱)와 검사할 폴더
const APP_WITH_VITE = 'apps/web/package.json'
const ROOTS = ['apps/web/src', 'packages/ui']
// ▲
const req = createRequire(createRequire(path.join(REPO, APP_WITH_VITE)).resolve('vite'))
const postcss = req('postcss')


function walk(dir, out) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.css') || e.name.endsWith('.vue')) out.push(full)
  }
}

/** .vue 의 <style> 블록들 — [본문, 시작 줄]. lang 이 scss · less 면 건너뛴다(postcss 기본 파서 대상 아님). */
export function vueStyles(src) {
  const out = []
  // SFC 최상위 블록만(줄 첫 칸의 <style …> ~ </style>) — 스크립트 안 문자열 · 주석의 «<style» 은 블록이 아니다.
  for (const m of src.matchAll(/^<style\b([^>]*)>([\s\S]*?)^<\/style>/gm)) {
    if (/lang=["'](scss|sass|less|stylus)["']/.test(m[1])) continue
    const line = src.slice(0, m.index).split('\n').length + (m[0].slice(0, m[0].indexOf('>') + 1).split('\n').length - 1)
    out.push([m[2], line])
  }
  return out
}

/** 하나의 CSS 원문 판정 — { error: '줄:칸 사유' | null, warnings: [] }. */
export function checkCss(css, lineOffset = 0) {
  const warnings = []
  for (const m of css.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const body = m[1]
    const ln = css.slice(0, m.index).split('\n').length + lineOffset
    if (/[{}]/.test(body)) warnings.push(`${ln}: 주석 안 중괄호 — 원문 계약 시험의 추출기를 속일 수 있다`)
    if (/\/\*\/|\*\/--|\w\/\*/.test(m[0].slice(2))) warnings.push(`${ln}: 주석 안 글롭 · 경로 조각(/*/ · */--) — 주석이 일찍 닫힐 수 있다`)
  }
  // 주석이 일찍 닫힘 — 주석을 걷어 낸 나머지에 «*/» 가 남아 있으면 주석 안 글롭(apps/*/src)이 주석을 먼저 닫은 것이다.
  // postcss 는 남은 글자를 이상한 선택자로 받아 넘기지만 브라우저 · 압축기는 그 규칙을 버리거나 빌드를 깬다(U063).
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const stray = stripped.indexOf('*/')
  if (stray >= 0) return { error: `${stripped.slice(0, stray).split('\n').length + lineOffset}:0 주석이 일찍 닫혔다 — 남은 «*/»(주석 안 글롭 · 경로의 */ 를 피한다)`, warnings }
  try {
    postcss.parse(css)
    return { error: null, warnings }
  } catch (e) {
    return { error: `${(e.line ?? 0) + lineOffset}:${e.column ?? 0} ${e.reason ?? e.message}`, warnings }
  }
}

export function scanAll(repo = REPO) {
  const files = []
  for (const r of ROOTS) walk(path.join(repo, r), files)
  const errors = [], warnings = []
  let blocks = 0
  for (const f of files.sort()) {
    const rel = path.relative(repo, f).split(path.sep).join('/')
    const src = fs.readFileSync(f, 'utf8')
    const parts = f.endsWith('.vue') ? vueStyles(src) : [[src, 0]]
    for (const [css, off] of parts) {
      blocks++
      const r = checkCss(css, f.endsWith('.vue') ? off - 1 : 0)
      if (r.error) errors.push(`${rel}:${r.error}`)
      for (const w of r.warnings) warnings.push(`${rel}:${w}`)
    }
  }
  return { files: files.length, blocks, errors, warnings }
}

function main() {
  const r = scanAll()
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); if (r.errors.length) process.exit(1); return }
  console.log(`=== I27 CSS 파싱 === 파일 ${r.files} · 스타일 블록 ${r.blocks} · 오류 ${r.errors.length} · 경고 ${r.warnings.length}`)
  for (const e of r.errors) console.log(`[오류] ${e}`)
  for (const w of r.warnings.slice(0, 20)) console.log(`[경고] ${w}`)
  if (r.warnings.length > 20) console.log(`[경고] … ${r.warnings.length - 20}건 더`)
  console.log(r.errors.length ? '실패' : '통과')
  if (r.errors.length) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
