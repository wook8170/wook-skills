// 97. UI 안정성 하네스 자체 시험 — «실제로 실패하게 만들어 보는 검증». 결함을 일부러 넣은 시험용 페이지(가짜 출처 http://uistab.test)에서
// 불변식이 실패하고, 같은 페이지의 고친 판에서는 통과하는지 본다. 앱 · 스택과 무관하게 돌므로 React 프로젝트에서만 한 번 돈다.
// 설계 docs/testing/ui-stability-harness.md §7(실패 검증). 원장 docs/e2e/uistab.cases.json E2E-uistab-1xx.
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import {
  assertFocusInside, assertFocusReturned, assertEscClosesTopOnly, assertNoClickThrough, assertSurvivesReload, assertNoDragResidue,
  assertNoHorizontalOverflow, watchConsoleAndRequests, assertQuiet, measureTransition, assertVisibleUnobstructed, UiStabilityError,
} from '../helpers/ui-stability/invariants.js'
import { exploreScreen, assertSurfaceClean, type Screen } from '../helpers/ui-stability/explore.js'

const ORIGIN = 'http://uistab.test'

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'react', '앱과 무관한 자체 시험 — 한 프로젝트에서만')
})

/** 가짜 출처에 페이지를 올린다(새로고침 · fetch 가 되게). /api/* 는 빈 JSON. */
async function serve(page: Page, html: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (r) => {
    const u = new URL(r.request().url())
    if (u.pathname.startsWith('/api/')) return r.fulfill({ json: { ok: true } })
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{font:14px sans-serif;margin:0;background:#fff;color:#111}button{font:inherit}</style></head><body>${html}</body></html>` })
  })
  await page.goto(`${ORIGIN}/`)
}

/** fn 이 UiStabilityError(또는 Error)로 실패해야 한다 — 메시지에 tag 가 들어 있어야 한다. */
async function mustFail(fn: () => Promise<unknown>, tag: string): Promise<void> {
  let err: unknown = null
  try { await fn() } catch (e) { err = e }
  expect(err, `${tag} 판정이 결함 페이지에서 실패해야 한다`).not.toBeNull()
  expect(String(err)).toContain(tag)
}

const MODAL = (opts: { focus: boolean; trap: boolean; restore: boolean }) => `
<button id="open" data-testid="open">열기</button><button>뒤 버튼</button>
<div id="m" data-testid="m" role="dialog" aria-modal="true" hidden style="position:fixed;inset:100px;background:#eee;padding:20px">
  <button id="a">확인</button><button id="b">취소</button>
</div>
<script>
  const m = document.getElementById('m'), open = document.getElementById('open')
  open.onclick = () => { m.hidden = false; ${opts.focus ? "document.getElementById('a').focus()" : ''} }
  document.addEventListener('keydown', (e) => {
    if (m.hidden) return
    if (e.key === 'Escape') { m.hidden = true; ${opts.restore ? 'open.focus()' : ''} }
    ${opts.trap ? "if (e.key === 'Tab') { const f = [...m.querySelectorAll('button')]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + 1) % f.length].focus() }" : ''}
  })
</script>`

test.describe('UI 안정성 하네스 자체 시험(결함 주입)', () => {
  test('E2E-uistab-101 I9 초점 관리 — 초점이 안 들어감 · Tab 이 샘 · 닫은 뒤 복귀 없음을 잡는다', async ({ page }, testInfo) => {
    await serve(page, MODAL({ focus: false, trap: false, restore: false }))
    await page.getByTestId('open').click()
    await mustFail(() => assertFocusInside(page, 'm', { label: '결함', testInfo, modal: true }), 'I9')
    await serve(page, MODAL({ focus: true, trap: false, restore: false }))
    await page.getByTestId('open').click()
    await mustFail(() => assertFocusInside(page, 'm', { label: 'Tab 샘', testInfo, modal: true }), 'Tab')
    await page.keyboard.press('Escape')
    await mustFail(() => assertFocusReturned(page, page.getByTestId('open'), { label: '복귀 없음', testInfo }), 'I9')
    await serve(page, MODAL({ focus: true, trap: true, restore: true }))
    await page.getByTestId('open').click()
    await assertFocusInside(page, 'm', { label: '고친 판', testInfo, modal: true })
    await page.keyboard.press('Escape')
    await assertFocusReturned(page, page.getByTestId('open'), { label: '고친 판', testInfo })
  })

  test('E2E-uistab-102 I10 Esc 계층 — 미리보기 Esc 가 아래 목록까지 닫으면 잡는다', async ({ page }, testInfo) => {
    const html = (both: boolean) => `
      <div data-testid="list" style="position:fixed;inset:40px;background:#ddd">목록<div data-testid="preview" style="position:fixed;inset:120px;background:#bbb">미리보기</div></div>
      <script>document.addEventListener('keydown',(e)=>{ if(e.key!=='Escape')return; const p=document.querySelector('[data-testid=preview]'); if(p){p.remove(); ${both ? "document.querySelector('[data-testid=list]').remove()" : ''}} })</script>`
    await serve(page, html(true))
    await mustFail(() => assertEscClosesTopOnly(page, ['list', 'preview'], { label: '둘 다 닫힘', testInfo }), 'I10')
    await serve(page, html(false))
    await assertEscClosesTopOnly(page, ['list', 'preview'], { label: '고친 판', testInfo })
  })

  test('E2E-uistab-103 I13 클릭 관통 — 딤을 눌렀는데 아래 버튼이 받으면 잡는다', async ({ page }, testInfo) => {
    const html = (passThrough: boolean) => `<button data-testid="under" style="position:fixed;left:50px;top:50px;width:200px;height:80px">아래 버튼</button>
      <div data-testid="dim" style="position:fixed;inset:0;background:rgba(0,0,0,.4);${passThrough ? 'pointer-events:none' : ''}"></div>`
    await serve(page, html(true))
    await mustFail(() => assertNoClickThrough(page, { x: 120, y: 90 }, { label: '관통', testInfo }), 'I13')
    await serve(page, html(false))
    await assertNoClickThrough(page, { x: 120, y: 90 }, { label: '고친 판', testInfo })
  })

  test('E2E-uistab-104 I16 새로고침 복원 — 선택이 새로고침 뒤 사라지면 잡는다', async ({ page }, testInfo) => {
    const html = (persist: boolean) => `<button data-testid="t1">탭1</button><button data-testid="t2">탭2</button><div data-testid="active"></div>
      <script>const a=document.querySelector('[data-testid=active]'); a.textContent=${persist ? "localStorage.getItem('tab')||'t1'" : "'t1'"};
      for(const id of ['t1','t2']) document.querySelector('[data-testid='+id+']').onclick=()=>{a.textContent=id; localStorage.setItem('tab',id)}</script>`
    const probe = () => page.getByTestId('active').innerText()
    await serve(page, html(false))
    await page.getByTestId('t2').click()
    await mustFail(() => assertSurvivesReload(page, probe, { label: '복원 없음', testInfo }), 'I16')
    await page.unrouteAll()
    await serve(page, html(true))
    await page.getByTestId('t2').click()
    await assertSurvivesReload(page, probe, { label: '고친 판', testInfo })
  })

  test('E2E-uistab-105 I18 끌기 잔여물 — 고스트 · user-select:none 이 남으면 잡는다', async ({ page }, testInfo) => {
    await serve(page, `<div data-chip-ghost style="position:fixed;left:10px;top:10px;width:60px;height:20px;background:#09f"></div><script>document.body.style.userSelect='none'</script>`)
    await mustFail(() => assertNoDragResidue(page, { label: '잔여물', testInfo }), 'I18')
    await serve(page, `<div>깨끗함</div>`)
    await assertNoDragResidue(page, { label: '고친 판', testInfo })
  })

  test('E2E-uistab-106 I12 가로 넘침 — 390 폭에서 고정 폭 요소가 넘치면 잡는다', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await serve(page, `<div data-testid="wide" style="width:600px;height:20px;background:#eee">넓음</div>`)
    await mustFail(() => assertNoHorizontalOverflow(page, { label: '390', testInfo }), 'I12')
    await serve(page, `<div style="max-width:100%;height:20px;background:#eee">맞춤</div>`)
    await assertNoHorizontalOverflow(page, { label: '고친 판', testInfo })
  })

  test('E2E-uistab-107 I14 · I15 — 콘솔 오류와 같은 요청 5번을 잡는다', async ({ page }, testInfo) => {
    await serve(page, `<button data-testid="go">불러오기</button><script>document.querySelector('[data-testid=go]').onclick=()=>{console.error('터짐'); for(let i=0;i<5;i++) fetch('/api/same?x=1')}</script>`)
    let w = watchConsoleAndRequests(page)
    await page.getByTestId('go').click()
    await page.waitForLoadState('networkidle')
    await mustFail(() => assertQuiet(page, w.stop(), { label: '결함', testInfo }), 'I14')
    await serve(page, `<button data-testid="go">불러오기</button><script>document.querySelector('[data-testid=go]').onclick=()=>{fetch('/api/same?x=1')}</script>`)
    w = watchConsoleAndRequests(page)
    await page.getByTestId('go').click()
    await page.waitForLoadState('networkidle')
    await assertQuiet(page, w.stop(), { label: '고친 판', testInfo })
  })

  test('E2E-uistab-108 I20 전환 깜빡임 — 빈 프레임 · NaN 프레임 · 레이아웃 이동을 잡는다', async ({ page }, testInfo) => {
    const html = (bad: boolean) => `<main data-testid="content" style="padding:10px"><div id="c" style="height:300px;background:#cde">내용 A</div></main><button data-testid="sw" style="position:fixed;bottom:0">전환</button>
      <script>document.querySelector('[data-testid=sw]').onclick=()=>{const c=document.getElementById('c');
        ${bad ? "c.remove(); setTimeout(()=>{const n=document.createElement('div');n.id='c';n.style.cssText='height:300px;background:#cde';n.textContent='합계 NaN';document.querySelector('main').appendChild(n); setTimeout(()=>{n.textContent='내용 B'},80)},250)" : "c.textContent='내용 B'"} }</script>`
    await serve(page, html(true))
    await mustFail(() => measureTransition(page, async () => { await page.getByTestId('sw').click() }, 'content', { label: '결함', testInfo }), 'I20')
    await serve(page, html(false))
    await measureTransition(page, async () => { await page.getByTestId('sw').click() }, 'content', { label: '고친 판', testInfo })
  })

  test('E2E-uistab-109 I1 · I11 · I17 · 이름 — 표면 스캔이 가림 · 말줄임 · 대비 · 이름 없음을 잡는다', async ({ page }, testInfo) => {
    await serve(page, `<section data-testid="s" style="position:relative;padding:20px">
      <button style="width:120px">가려진 버튼</button><div style="position:absolute;left:20px;top:20px;width:120px;height:30px;background:#f00"></div>
      <button style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">아주 긴 이름의 단추입니다</button>
      <button style="color:#bbb;background:#fff">흐린 글자</button>
      <button><svg width="10" height="10"></svg></button></section>`)
    for (const inv of ['I1', 'I11', 'I17', 'A11Y-NAME']) await mustFail(() => assertSurfaceClean(page, '[data-testid="s"]', [inv], { label: inv, testInfo }), inv)
    await serve(page, `<section data-testid="s" style="padding:20px"><button>버튼</button><button title="아주 긴 이름의 단추입니다" style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">아주 긴 이름의 단추입니다</button><button style="color:#333">진한 글자</button><button aria-label="닫기"><svg width="10" height="10"></svg></button></section>`)
    await assertSurfaceClean(page, '[data-testid="s"]', ['I1', 'I11', 'I17', 'A11Y-NAME'], { label: '고친 판', testInfo })
  })

  test('E2E-uistab-110 자동 탐색 — 결함 페이지에서 I1 · I9 · I10 · I14 · I15 · I22 · I25 · 링크를 모두 잡고 고친 판은 0건', async ({ page }) => {
    const bad = `<p>합계 undefined · 그룹 __sum_amount</p><a href="/nowhere">없는 화면</a>
      <div style="height:60px;overflow:hidden;position:relative;border:1px solid #ccc"><button data-testid="menu-btn" aria-haspopup="menu">메뉴 열기</button>
        <div data-testid="menu" role="menu" hidden style="position:absolute;top:30px;left:0;width:160px;background:#fff;border:1px solid #999"><button role="menuitem">항목 하나</button><button role="menuitem">항목 둘</button><button role="menuitem">항목 셋</button></div></div>
      <button data-testid="noisy">로그 보기</button>
      <script>
        const m=document.querySelector('[data-testid=menu]'); document.querySelector('[data-testid=menu-btn]').onclick=()=>{m.hidden=false}
        document.querySelector('[data-testid=noisy]').onclick=()=>{console.error('부서짐'); for(let i=0;i<5;i++) fetch('/api/again')}
      </script>`
    await page.route(`${ORIGIN}/**`, (r) => new URL(r.request().url()).pathname.startsWith('/api/') ? r.fulfill({ json: {} }) : r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ko"><body style="font:14px sans-serif">${bad}</body></html>` }))
    const screen: Screen = { id: 'selftest:bad', kind: 'route', title: '/', apps: ['react'], entry: { url: `${ORIGIN}/` }, role: 'anon', auto: true }
    const r = await exploreScreen(page, screen, 'selftest', { depth: 'nightly' })
    expect(r.error).toBeUndefined()
    const invs = new Set(r.violations.map((v) => v.inv))
    for (const inv of ['I9', 'I10', 'I14', 'I15', 'I22', 'I25', 'LINK']) expect([...invs], `${inv} 를 잡아야 한다 — ${JSON.stringify(r.violations.map((v) => `${v.inv} ${v.kind}`))}`).toContain(inv)
    const good = `<p>합계 1,200</p><a href="/">처음</a><button data-testid="ok">보기</button>`
    await page.unrouteAll()
    await page.route(`${ORIGIN}/**`, (r) => new URL(r.request().url()).pathname.startsWith('/api/') ? r.fulfill({ json: {} }) : r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ko"><body style="font:14px sans-serif">${good}</body></html>` }))
    const r2 = await exploreScreen(page, { ...screen, id: 'selftest:good' }, 'selftest', { depth: 'nightly' })
    expect(r2.violations.map((v) => `${v.inv} ${v.kind} ${v.detail}`)).toEqual([])
  })

  test('E2E-uistab-111 I1 1판 판정 회귀 — 메뉴가 레일 아래에 깔리면 여전히 잡는다', async ({ page }, testInfo: TestInfo) => {
    await serve(page, `<nav style="position:fixed;left:0;top:0;bottom:0;width:60px;background:#333;z-index:20"></nav><div data-testid="pop" role="menu" style="position:fixed;left:30px;top:40px;width:200px;height:120px;background:#fff;border:1px solid #999;z-index:10">메뉴</div>`)
    await mustFail(() => assertVisibleUnobstructed(page, 'pop', { label: '레일 아래', testInfo }), 'I1')
    expect(UiStabilityError).toBeTruthy()
  })
})
