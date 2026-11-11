// [템플릿] 실제 적용 프로젝트의 사본이다. import 경로(fixtures · harness)와 ▼ 프로젝트 설정 표시 부분을 프로젝트에 맞춘다. SKILL.md §6.
// UI 안정성 자동 탐색 계층 ② — 화면 하나를 열어 상호작용 요소를 모두 모으고 공통 불변식을 요소마다 본다. 설계 docs/testing/ui-stability-harness.md §6.
//
// 화면 목록은 screens.json(scripts/ui-stability/collect-screens.mjs 가 코드에서 센 것), 판정 본체는 explore-lib.browser.js(브라우저 안).
// 이 파일은 실제 입력(page.mouse · page.keyboard)과 결과 기록 · 베이스라인 래칫을 맡는다.
//
// 요소마다:  I1 가림 없음 · I11 말줄임 + 단서(정적 단서가 없으면 실제 호버로 툴팁 확인) · I12 뷰포트 가로 밖 · I17 대비 · 접근성 이름 · 링크 대상
// 화면마다:  I12 문서 가로 넘침 · I14 콘솔 · 예외 · I15 같은 요청 반복 · (anchor · manual) I16 딥링크 착지
// 클릭 탐색:  안전한 단추만 page.mouse 로 눌러 I14 · 깨짐 · 열린 표면의 I1 · I9(초점 들어감 · Tab 가둠 · 닫은 뒤 복귀) · I10(Esc 는 맨 위 하나만)
import fs from 'node:fs'
import path from 'node:path'
import type { Page, Request } from '@playwright/test'
import { AUTO } from './budgets.js'
import { PROJECT_CONFIG } from './project.config.js'

export type Screen = {
  id: string
  kind: string
  title: string
  apps: string[]
  entry: { url?: string; setup?: string; state?: string; click?: string | string[]; pick?: { select: string; option: string }; via?: string }
  role: 'owner' | 'anon'
  auto: boolean
  why?: string
  p0?: boolean
  scope?: string
  markers?: string[]
  sources?: string[]
}
export type Violation = { inv: string; kind: string; comp: string; key: string; detail: string; by?: string }
export type ScreenResult = {
  app: string; screenId: string; kind: string; url: string; ms: number; depth: string
  found: number; hidden: number; capped: number; checkedEls: number; checks: Record<string, number>
  clickTargets: number; clicked: number; clickDedup: number; clickSkipped: number; surfacesOpened: number
  markersSeen: string[]; violations: Violation[]; warnings: Violation[]; error?: string
  /** I26 앱 자기증명 · I19 R↔V 비교 재료(라우트 · 관리자 절만). */
  proof?: { framework: string; origin: string; hidden: boolean }
  parity?: { lines: string[]; boxes: Record<string, number[]>; aria: string }
}

const DIR = path.dirname(new URL(import.meta.url).pathname)
const LIB = fs.readFileSync(path.join(DIR, 'explore-lib.browser.js'), 'utf8')
export const SCREENS: { total: number; screens: Screen[] } = JSON.parse(fs.readFileSync(path.join(DIR, 'screens.json'), 'utf8'))

type Known = { pattern: string; why: string }
const KNOWN_CONSOLE: Known[] = JSON.parse(fs.readFileSync(path.join(DIR, 'known-console.json'), 'utf8')).entries
const EXCLUDE: { testid: Known[]; text: Known[] } = JSON.parse(fs.readFileSync(path.join(DIR, 'explore-exclude.json'), 'utf8'))
// I25 용어 규칙은 용어 사전 생성물을 읽는다(경로는 어댑터 설정).
const TERMS: unknown = JSON.parse(fs.readFileSync(path.resolve(DIR, '../../..', PROJECT_CONFIG.termsFile), 'utf8'))

/** 라우트 화면 제목('/project/:projectId')에서 링크 대상 판정용 정규식 원문. */
export function routePatterns(screens: Screen[] = SCREENS.screens): string[] {
  // 루트(/)는 라우터가 기본 화면으로 넘기는 정상 주소다.
  return ['^/$', ...screens.filter((s) => s.kind === 'route').map((s) => '^' + s.title.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '/?$')]
}

async function install(page: Page): Promise<void> {
  const { popoverSelectors, modalOverlaySelectors, tooltipSelectors, choiceGroupSelectors, textSkipSelectors } = PROJECT_CONFIG
  await page.evaluate((cfg) => { (window as unknown as { __uistabConfig: unknown }).__uistabConfig = cfg }, { popoverSelectors, modalOverlaySelectors, tooltipSelectors, choiceGroupSelectors, textSkipSelectors })
  await page.evaluate(LIB)
}

/** 화면이 자리를 잡을 때까지 — 네트워크가 조용해지고(최대 8초) 두 프레임. 고정 대기를 쓰지 않는다. */
export async function settle(page: Page, netMs = 8000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: netMs }).catch(() => undefined)
  await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), undefined, { timeout: 5000 }).catch(() => undefined)
}

const DESTRUCTIVE_ID = /(delete|remove|revoke|reset|logout|log-out|sign-?out|purge|drop|destroy|wipe|rotate|disable|deactivate|terminate|publish|send|submit|save|apply|import|upload|download|export|sync|run|retry|restart|approve|reject|transfer|leave|issue|reissue|regenerate|clear|unlink|disconnect|install|restore|backup|archive|kick|invite|accept|confirm|create|duplicate|copy|new-|add-|close-all)/i
const STATEFUL_ID = /(-up$|-down$|increment|decrement|stepper|swatch|color-dot|preset|-option-|choice|-pick-|theme-|accent-|radius-|font-|layout-|density|border-strength|rail-side|panel-layout)/i
const DESTRUCTIVE_TEXT = /(삭제|제거|지우|폐기|회수|초기화|되돌리|로그아웃|탈퇴|비활성|내보내|다운로드|업로드|가져오|저장|적용|게시|발송|보내|전송|실행|동기화|추출|재시작|승인|거절|교체|발급|해제|나가기|만들|추가|복제|복사|초대|확인|새로|백업|복구|설치|연결|끊기|잠그|잠금|변경|바꾸|등록|생성|시작|중지|취소)/

/** 클릭 탐색 대상인가 — 파괴 · 외부 · 입력 계열은 뺀다(사유를 돌려준다). */
export function clickVerdict(el: { tag: string; role: string; name: string; testid: string; click: { disabled: boolean; href: string; target: string; type: string; cls: string; variant: string; text: string; toggle?: boolean; inGroup?: boolean } }): string | null {
  const c = el.click
  if (c.disabled) return '비활성'
  // 즉시 적용되는 설정(토글 · 선택 묶음 · 증감 단추)은 누르면 저장된다 — 시험 DB 를 바꿔 다음 화면 · 다른 시험을 오염시킨다(실측: 패널 배치가 dock 으로 바뀜).
  if (c.toggle) return '토글(상태 변경)'
  if (c.inGroup) return '선택 묶음(즉시 적용 설정)'
  if (el.testid && STATEFUL_ID.test(el.testid)) return `상태 변경 testid(${el.testid})`
  if (/(증가|감소)/.test(`${el.name} ${c.text}`)) return '증감 단추'
  if (!['button', 'tab', 'menuitem'].includes(el.role)) return `역할 ${el.role || el.tag}(누르기 대상 아님 — 입력 · 링크는 정적 판정)`
  if (c.type === 'submit') return '양식 제출'
  if (c.target === '_blank') return '새 창'
  if (/danger/i.test(c.cls) || /danger/i.test(c.variant)) return '위험 변형(danger)'
  if (el.testid && DESTRUCTIVE_ID.test(el.testid)) return `testid 규칙(${el.testid})`
  const label = `${el.name} ${c.text}`
  if (DESTRUCTIVE_TEXT.test(label)) return `문구 규칙(${label.slice(0, 20)})`
  for (const x of EXCLUDE.testid) if (el.testid && new RegExp(x.pattern).test(el.testid)) return `제외 목록(${x.why})`
  for (const x of EXCLUDE.text) if (new RegExp(x.pattern).test(label)) return `제외 목록(${x.why})`
  return null
}

const knownConsole = (msg: string) => KNOWN_CONSOLE.find((k) => new RegExp(k.pattern).test(msg))
const sigOf = (app: string, screenId: string, v: Violation) => `${app}|${screenId}|${v.inv}|${v.kind}|${v.key}`
export { sigOf }

export type ExploreOpts = { depth: 'p0' | 'nightly'; theme?: 'light' | 'dark'; vars?: Record<string, string> }

/** 동작별 «한 번 본 컴포넌트» — 같은 실행(작업자) 안에서 탑바 단추처럼 모든 화면에 있는 것은 한 번만 누른다. */
const CLICKED = new Set<string>()

/** 화면 하나를 연다(설정 데이터 자리표시 치환 포함). */
export function urlOf(s: Screen, vars: Record<string, string> = {}): string {
  return (s.entry.url ?? '/').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `uistab-${k}`)
}

async function mouseClick(page: Page, testid: string): Promise<void> {
  const b = page.getByTestId(testid).first()
  const bb = (await b.boundingBox())!
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 6 })
  await page.mouse.down(); await page.mouse.up()
}

/** 앞선 조작 — 단추(click)가 보이면 누르고, 아니면 고르개(pick: Select 를 열어 항목 고르기)로 연다. 실제 입력만 쓴다. */
async function openEntry(page: Page, s: Screen): Promise<void> {
  if (!s.entry.click && !s.entry.pick) return
  const ids = s.entry.click ? (Array.isArray(s.entry.click) ? s.entry.click : [s.entry.click]) : []
  const btns = ids.map((id) => page.getByTestId(id).first())
  const sel = s.entry.pick ? page.getByTestId(s.entry.pick.select).first() : null
  const any = [...btns, ...(sel ? [sel] : [])].reduce((a, b) => a.or(b))
  await any.first().waitFor({ state: 'visible', timeout: 15_000 })
  let clicked = false
  for (let i = 0; i < btns.length && !clicked; i++) if (await btns[i]!.isVisible()) { await mouseClick(page, ids[i]!); clicked = true }
  if (!clicked && sel && s.entry.pick) {
    await mouseClick(page, s.entry.pick.select)
    const opt = page.getByRole('option', { name: s.entry.pick.option, exact: true }).first()
    await opt.waitFor({ state: 'visible', timeout: 5000 })
    const ob = (await opt.boundingBox())!
    await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 4 })
    await page.mouse.down(); await page.mouse.up()
  }
  await settle(page, 4000)
}

/**
 * 화면 하나 탐색. page 는 역할에 맞게 세션이 심겨 있어야 한다(owner = primeSession, anon = 빈 페이지).
 */
export async function exploreScreen(page: Page, s: Screen, app: string, opts: ExploreOpts): Promise<ScreenResult> {
  const t0 = Date.now()
  const lim = opts.depth === 'nightly' ? AUTO.nightly : AUTO.p0
  const url = urlOf(s, opts.vars)
  const res: ScreenResult = { app, screenId: s.id, kind: s.kind, url, ms: 0, depth: opts.depth, found: 0, hidden: 0, capped: 0, checkedEls: 0, checks: {}, clickTargets: 0, clicked: 0, clickDedup: 0, clickSkipped: 0, surfacesOpened: 0, markersSeen: [], violations: [], warnings: [] }
  const V = (v: Omit<Violation, 'key'> & { key?: string }) => res.violations.push({ key: v.key ?? v.comp, ...v } as Violation)

  // I14 — 콘솔 오류 · 처리 안 된 예외(처리 안 된 Promise 거부는 크로미움이 콘솔 오류 «Uncaught (in promise)» 로 낸다)
  const errors: string[] = []
  const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) }
  const onPageError = (e: Error) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`)
  // I15 — fetch · xhr 요청(방법 + 경로 + 쿼리)
  let reqs: string[] = []
  const onReq = (r: Request) => { if (['fetch', 'xhr'].includes(r.resourceType())) { const u = new URL(r.url()); reqs.push(`${r.method()} ${u.pathname}${u.search}`) } }
  page.on('console', onConsole); page.on('pageerror', onPageError); page.on('request', onReq)
  const flushErrors = (comp: string, where: string) => {
    for (const e of errors.splice(0)) {
      const k = knownConsole(e)
      if (!k) V({ inv: 'I14', kind: e.startsWith('[pageerror]') ? '처리 안 된 예외' : '콘솔 오류', comp, key: `${comp}|${e.replace(/\d+/g, '#').slice(0, 80)}`, detail: `${where}: ${e}` })
    }
  }
  const storm = (comp: string, where: string) => {
    const by = new Map<string, number>()
    for (const r of reqs) by.set(r, (by.get(r) ?? 0) + 1)
    for (const [r, n] of by) if (n > AUTO.dupRequestMax) V({ inv: 'I15', kind: '같은 요청 반복', comp, key: `${comp}|${r.replace(/\d+/g, '#').slice(0, 100)}`, detail: `${where}: ${r} × ${n}(상한 ${AUTO.dupRequestMax})` })
    reqs = []
  }

  try {
    reqs = []
    await page.goto(url)
    await settle(page)
    await openEntry(page, s)
    await install(page)
    flushErrors(`screen:${s.id}`, '화면 열기')
    storm(`screen:${s.id}`, '화면 열기')

    // I16 — 딥링크(해시) 착지: 대상이 문서에 있고 보이며 뷰포트 안(4초 안에 한 번이라도)
    if (s.scope && (s.kind === 'anchor' || s.kind === 'manual')) {
      const deadline = Date.now() + 4000
      let p = await page.evaluate((sel) => (window as any).__uistabLib.anchorProbe(sel), s.scope)
      while (!(p.found && p.inView && p.visible) && Date.now() < deadline) {
        await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => r(true))))
        p = await page.evaluate((sel) => (window as any).__uistabLib.anchorProbe(sel), s.scope)
      }
      res.checks.I16 = 1
      if (!p.found) V({ inv: 'I16', kind: '딥링크 대상 없음', comp: `anchor:${s.scope}`, detail: `${url} — ${s.scope} 가 문서에 없다` })
      else if (!p.visible) V({ inv: 'I16', kind: '딥링크 대상 숨음(접힘)', comp: `anchor:${s.scope}`, detail: `${url} — 대상이 접혀 있거나 숨어 있다` })
      else if (!p.inView) V({ inv: 'I16', kind: '딥링크 대상 뷰포트 밖', comp: `anchor:${s.scope}`, detail: `${url} — 대상 top ${p.top}px` })
    }

    // I26 자기증명 · I19 비교 재료 — 요소 훑기(스크롤 이동) 전에 처음 모습으로 찍는다.
    const snap = await page.evaluate(() => (window as any).__uistabLib.paritySnap())
    res.proof = { framework: snap.framework, origin: snap.origin, hidden: snap.hidden }
    if (s.kind === 'route' || s.kind === 'admin-section') {
      const aria = await page.locator('body').ariaSnapshot({ timeout: 10_000 }).catch(() => '')
      res.parity = { lines: snap.lines, boxes: snap.boxes, aria: aria.replace(/\d+/g, '#') }
    }

    // 요소 훑기
    const scan = await page.evaluate((o) => (window as any).__uistabLib.scan(o), { scope: s.kind === 'anchor' || s.kind === 'manual' || s.kind === 'studio-panel' ? s.scope : undefined, routes: routePatterns(), max: lim.maxElements, checkContrast: true })
    if (scan.error) throw new Error(scan.error)
    res.found = scan.found; res.hidden = scan.hidden; res.capped = scan.capped
    type El = { key: string; comp: string; tag: string; role: string; name: string; testid: string; checked: string[]; v: Array<{ inv: string; kind: string; detail: string; by: string; hover?: boolean }>; click: any }
    const els = scan.elements as El[]
    res.checkedEls = els.filter((e) => e.checked.length > 0).length
    for (const e of els) for (const c of e.checked) res.checks[c] = (res.checks[c] ?? 0) + 1
    if (scan.doc) V({ inv: 'I12', kind: '문서 가로 넘침', comp: scan.doc.worstComp || `screen:${s.id}`, key: `doc|${scan.doc.worstComp}`, detail: `가로 ${scan.doc.over}px 넘침 — 가장 오른쪽 ${scan.doc.worst} right ${scan.doc.right} / ${scan.doc.vw}` })
    res.checks.I12doc = 1

    // I25 화면 문구
    const scoped = s.kind === 'anchor' || s.kind === 'manual' || s.kind === 'studio-panel' ? s.scope : undefined
    const ts = await page.evaluate(([t, sc]) => (window as any).__uistabLib.textScan(t, sc), [TERMS, scoped] as const)
    res.checks.I25 = ts.nodes
    for (const f of ts.fail) V({ inv: 'I25', kind: f.kind, comp: f.comp, key: `${f.comp}|${f.hit}`, detail: `「${f.text}」 — ${f.hit} @ ${f.where}` })
    for (const w of ts.warn) res.warnings.push({ inv: 'I25', kind: w.kind, comp: w.comp, key: `${w.comp}|${w.hit}`, detail: `「${w.text}」 ${w.hit} @ ${w.where}` })

    // 말줄임: 정적 단서가 없던 것만 실제 호버로 툴팁을 확인(화면당 상한)
    let hovers = 0
    for (const e of els) {
      for (const v of e.v) {
        if (v.inv === 'I11' && v.hover) {
          if (hovers >= lim.hoverMax) { V({ inv: 'I11', kind: v.kind, comp: e.comp, key: e.key, detail: `${v.detail}(호버 상한 초과 — 정적 판정)` }); continue }
          hovers++
          const t = await page.evaluate((k) => (window as any).__uistabLib.hoverTarget(k), e.key)
          if (!t) continue
          await page.mouse.move(t.x - 30, t.y - 30, { steps: 2 })
          await page.mouse.move(t.x, t.y, { steps: 4 })
          const shown = await page.waitForFunction((txt) => (window as any).__uistabLib.tooltipShows(txt), t.text, { timeout: 1500, polling: 'raf' }).then(() => true).catch(() => false)
          if (!shown) V({ inv: 'I11', kind: '말줄임 + 툴팁 없음', comp: e.comp, key: e.key, detail: `「${t.text.slice(0, 50)}」 — title · aria · 호버 툴팁 없음` })
        } else if (v.inv !== 'I11') {
          V({ inv: v.inv, kind: v.kind, comp: v.inv === 'I1' && v.by ? `${v.by} ⟶ ${e.comp}` : e.comp, key: e.key, detail: `${e.name ? `「${e.name.slice(0, 30)}」 ` : ''}${v.detail}`, by: v.by })
        }
      }
    }
    await page.mouse.move(2, 2)

    // 클릭 탐색
    const targets = els.filter((e) => clickVerdict(e) === null)
    res.clickTargets = targets.length
    res.clickSkipped = els.length - targets.length
    const deadline = t0 + lim.screenMs
    const markers = new Set<string>()
    const back = async () => {
      if (page.url() !== new URL(url, page.url()).href || (await page.evaluate(() => (window as any).__uistabLib?.version !== 3).catch(() => true))) {
        await page.goto(url); await settle(page)
        await openEntry(page, s).catch(() => undefined)
        await install(page)
        errors.splice(0); reqs = []
      }
    }
    for (const e of targets) {
      if (res.clicked >= lim.clicks || Date.now() > deadline) break
      const ck = `${app}|${e.comp}|${e.name}`
      if (CLICKED.has(ck)) { res.clickDedup++; continue }
      CLICKED.add(ck)
      const prep = await page.evaluate((k) => (window as any).__uistabLib.prepClick(k), e.key)
      if (!prep.ok) continue
      errors.splice(0); reqs = []
      await page.mouse.move(prep.x, prep.y, { steps: 4 })
      await page.mouse.down(); await page.mouse.up()
      res.clicked++
      await settle(page, 3000)
      const lost = await page.evaluate(() => (window as any).__uistabLib?.version !== 3).catch(() => true)
      if (lost) { flushErrors(e.comp, `「${e.name}」 누른 뒤`); await back(); continue }
      const after = await page.evaluate((eb) => (window as any).__uistabLib.afterClick(eb), PROJECT_CONFIG.errorBoundarySelectors)
      flushErrors(e.comp, `「${e.name}」 누른 뒤`)
      storm(e.comp, `「${e.name}」 누른 뒤`)
      if (after.broken) V({ inv: 'BROKEN', kind: '화면 깨짐(오류 경계 · 빈 화면)', comp: e.comp, key: e.key, detail: `「${e.name}」 누른 뒤 — 요소 ${after.bodyEls}` })
      for (const sf of after.surfaces as Array<{ role: string; modal: boolean; desc: string; comp: string; hit: { inViewport: boolean; bad: string[]; rect: unknown }; focusInside: boolean; testids: string[] }>) {
        res.surfacesOpened++
        for (const t of sf.testids) markers.add(t)
        if (!sf.hit.inViewport) V({ inv: 'I1', kind: '열린 표면 뷰포트 밖', comp: sf.comp, key: `${e.key}>${sf.comp}`, detail: `「${e.name}」 → ${sf.desc} ${JSON.stringify(sf.hit.rect)}` })
        if (sf.hit.bad.length) V({ inv: 'I1', kind: '열린 표면 가려짐', comp: sf.comp, key: `${e.key}>${sf.comp}`, detail: `「${e.name}」 → ${sf.desc}: ${sf.hit.bad.join(' · ')}` })
        for (const c of (sf as unknown as { clip: Array<{ kind: string; detail: string }> }).clip ?? []) V({ inv: 'I22', kind: c.kind, comp: sf.comp, key: `${e.key}>${sf.comp}|${c.kind}`, detail: `「${e.name}」 → ${sf.desc}: ${c.detail}` })
        const needsFocus = sf.modal || sf.role === 'menu'
        if (needsFocus && !sf.focusInside) V({ inv: 'I9', kind: '열 때 초점이 표면 안으로 안 들어감', comp: sf.comp, key: `${e.key}>${sf.comp}`, detail: `「${e.name}」 → ${sf.desc} · 초점 ${after.active}` })
        if (sf.modal) {
          for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
          const fi = await page.evaluate(() => (window as any).__uistabLib.focusInfo())
          if (fi.inModal === false) V({ inv: 'I9', kind: 'Tab 이 모달 밖으로 샘', comp: sf.comp, key: `${e.key}>${sf.comp}`, detail: `「${e.name}」 → ${sf.desc} · Tab 4번 뒤 초점 ${fi.active}` })
        }
      }
      if (after.surfaces.length) {
        await page.keyboard.press('Escape')
        await settle(page, 2000)
        const esc = await page.evaluate(() => (window as any).__uistabLib.afterEscape())
        const top = after.surfaces[after.surfaces.length - 1]
        if (esc.stillOpen > 0) V({ inv: 'I10', kind: 'Esc 로 안 닫힘', comp: top.comp, key: `${e.key}>${top.comp}`, detail: `「${e.name}」 → ${top.desc} — Esc 뒤에도 열려 있음` })
        if (esc.preGone > 0) V({ inv: 'I10', kind: 'Esc 가 아래 표면까지 닫음', comp: top.comp, key: `${e.key}>${top.comp}`, detail: `「${e.name}」 → ${top.desc} — 원래 떠 있던 표면 ${esc.preGone}개도 닫힘` })
        if ((top.modal || top.role === 'menu') && esc.stillOpen === 0 && !esc.focusReturned && !esc.triggerGone) V({ inv: 'I9', kind: '닫은 뒤 초점이 연 단추로 안 돌아옴', comp: top.comp, key: `${e.key}>${top.comp}`, detail: `「${e.name}」 → ${top.desc} — 닫은 뒤 초점 ${esc.active}` })
        flushErrors(e.comp, `「${e.name}」 Esc 뒤`)
        if (esc.stillOpen > 0) { await page.keyboard.press('Escape'); await settle(page, 1000); await page.goto(url); await settle(page); await install(page); errors.splice(0); reqs = [] }
      }
      await back()
    }
    res.markersSeen = [...markers]
  } catch (err) {
    res.error = String(err).slice(0, 400)
  } finally {
    page.off('console', onConsole); page.off('pageerror', onPageError); page.off('request', onReq)
    res.ms = Date.now() - t0
  }
  return res
}

// ── 결과 · 베이스라인 ──────────────────────────────────────────────────────────────────────────
export const OUT_DIR = (repo: string) => path.join(repo, 'coverage', 'uistab')
export function writeResult(repo: string, r: ScreenResult): string {
  const dir = path.join(OUT_DIR(repo), r.app)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `${r.screenId.replace(/[^\w가-힣.-]+/g, '_').slice(0, 120)}.json`)
  fs.writeFileSync(f, JSON.stringify(r, null, 2))
  return f
}
export type CoverageBaseline = { violations: Record<string, number>; screens: Record<string, true> }
export function loadBaseline(repo: string): CoverageBaseline | null {
  const f = path.join(repo, 'scripts/ui-stability/coverage-baseline.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}
/** 베이스라인에 없는 위반(새 위반). 화면이 베이스라인에 없으면 그 화면의 위반 전부가 새 위반이다. */
export function newViolations(b: CoverageBaseline | null, r: ScreenResult): Violation[] {
  if (!b) return []
  return r.violations.filter((v) => !(sigOf(r.app, r.screenId, v) in b.violations))
}

/**
 * 레지스트리 드라이버용 — 열린 표면(scope) 안 요소를 자동 탐색과 같은 판정으로 훑어 지정 불변식 위반이 있으면 실패한다.
 * 주로 I11(말줄임 + 단서) · I17(다크 대비) · A11Y-NAME 을 등록 표면에 깊게 걸 때 쓴다.
 */
export async function assertSurfaceClean(page: Page, scope: string, invs: string[], opts: { label: string; testInfo: import('@playwright/test').TestInfo }): Promise<void> {
  await install(page)
  const scan = await page.evaluate((o) => (window as any).__uistabLib.scan(o), { scope, routes: routePatterns(), max: 400, checkContrast: true })
  if (scan.error) throw new Error(scan.error)
  const bad: string[] = []
  for (const e of scan.elements as Array<{ name: string; comp: string; v: Array<{ inv: string; kind: string; detail: string }> }>) for (const v of e.v) if (invs.includes(v.inv)) bad.push(`${v.inv} ${v.kind} · ${e.comp} · 「${e.name.slice(0, 30)}」 ${v.detail}`)
  if (bad.length) {
    const { attachEvidence } = await import('./evidence.js')
    await attachEvidence(page, opts.testInfo, `${invs.join('-')}-${opts.label}`, { invariant: invs.join(','), scope, problems: bad })
    throw new Error(`[${invs.join(' · ')}] ${opts.label}\n  - ${bad.slice(0, 20).join('\n  - ')}`)
  }
}
