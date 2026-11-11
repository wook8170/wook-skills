#!/usr/bin/env node
// scripts/ui-stability/build-smoke.mjs — I27 둘째 단: React · Vue 프로덕션 빌드 스모크(pnpm uistab:build-smoke · gate:full).
//
// CSS 파싱(check-css-parse.mjs)이 못 잡는 빌드 깨짐(JSX 파스 오류 · 템플릿 컴파일 오류 · 지연 청크 소실)을 잡는다.
// 판정: vite build 성공 · 지연 청크(js) 2개 이상 · CSS 파일이 있고 비어 있지 않음. 결과 폴더는 임시 폴더라 저장소를 더럽히지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let fail = false
for (const app of ['web']) { // ▼ 프로젝트 설정 — apps/<앱> 폴더 이름
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `uistab-build-${app}-`))
  const t0 = Date.now()
  try {
    execFileSync(path.join(REPO, 'apps', app, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: path.join(REPO, 'apps', app), stdio: ['ignore', 'ignore', 'pipe'] })
    const files = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f) } }
    walk(out)
    const js = files.filter((f) => f.endsWith('.js'))
    const css = files.filter((f) => f.endsWith('.css'))
    const emptyCss = css.filter((f) => fs.statSync(f).size === 0)
    const problems = []
    if (js.length < 2) problems.push(`지연 청크가 없다(js ${js.length})`)
    if (!css.length) problems.push('CSS 파일이 없다')
    if (emptyCss.length) problems.push(`빈 CSS ${emptyCss.map((f) => path.basename(f)).join(', ')}`)
    console.log(`${app}: js ${js.length} · css ${css.length} · ${Math.round((Date.now() - t0) / 1000)}초 ${problems.length ? '실패 — ' + problems.join(' · ') : '통과'}`)
    if (problems.length) fail = true
  } catch (e) {
    console.log(`${app}: 빌드 실패\n${String(e.stderr ?? e).slice(0, 2000)}`)
    fail = true
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}
if (fail) process.exit(1)
