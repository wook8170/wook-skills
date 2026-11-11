// [템플릿] 실제 적용 프로젝트의 사본이다. import 경로(fixtures · harness)와 ▼ 프로젝트 설정 표시 부분을 프로젝트에 맞춘다. SKILL.md §6.
// 96. UI 자동 탐색 순회 — 화면 목록(helpers/ui-stability/screens.json, 코드에서 센 340여 화면)을 모두 열어 상호작용 요소마다
// 공통 불변식(I1 가림 · I11 말줄임 · I12 가로 넘침 · I17 대비 · 이름 · 링크 대상)과 화면 단위(I12 문서 · I14 콘솔 · I15 요청 반복 · I16 딥링크),
// 안전한 단추의 실제 클릭(I14 · 깨짐 · 열린 표면 I1 · I9 초점 · I10 Esc)을 본다. 설계 docs/testing/ui-stability-harness.md §6.
//
// 운영
//   · P0 관문(@p0): screens.json 의 p0 화면만(핵심 7) — 요소 훑기 + 클릭 10회 이하.
//   · 야간: UISTAB_AUTO=all 이면 자동 탐색 가능한 전 화면, UISTAB_AUTO_DEPTH=nightly 면 클릭 40회 · 요소 800개까지.
//   · 결과: coverage/uistab/<app>/<화면>.json → `pnpm uistab:coverage` 가 docs/testing/ui-coverage.md 와 래칫을 만든다.
//   · 래칫: scripts/ui-stability/coverage-baseline.json 에 없는 위반이 나오면 그 화면 시험이 실패한다(UISTAB_AUTO_RATCHET=0 이면 기록만).
//     처음 잠근 위반은 고치지 않은 기존 결함이다 — 고친 뒤 `pnpm uistab:coverage --update-baseline` 으로 줄인다.
import { test, expect, BUNDLE, WORKSPACE_ID, primeSession, type Api } from '../fixtures/test.js'
import { REPO } from '../harness/env.js'
import fs from 'node:fs'
import path from 'node:path'
import { SCREENS, exploreScreen, writeResult, loadBaseline, newViolations, OUT_DIR, type Screen } from '../helpers/ui-stability/explore.js'
import { attachEvidence } from '../helpers/ui-stability/evidence.js'
import { assertFreshServing } from '../helpers/ui-stability/stale.js'

test.skip(BUNDLE, '시험 데이터를 만드는 하네스 스택 전용')

const ALL = process.env.UISTAB_AUTO === 'all'
const DEPTH = process.env.UISTAB_AUTO_DEPTH === 'nightly' ? 'nightly' : 'p0'
const RATCHET = process.env.UISTAB_AUTO_RATCHET !== '0'
const ONLY = process.env.UISTAB_AUTO_ONLY ? new RegExp(process.env.UISTAB_AUTO_ONLY) : null
// 이어 돌리기 — 부하로 멈춘 야간 순회를 결과 파일이 이미 있는 화면은 건너뛰고 잇는다.
const RESUME = process.env.UISTAB_AUTO_RESUME === '1'

/** 화면이 요구하는 준비 데이터 — 시드 대표 id 로 못 채우는 매개변수. 예시 사이트는 멱등 생성이라 지우지 않는다. */
const SETUPS: Record<string, (api: Api) => Promise<Record<string, string>>> = {
  'bi-sample-portal': async (api) => {
    const r = await api.ok<{ site: { id: string; slug?: string } }>('POST', `/workspaces/${WORKSPACE_ID}/bi-sites/samples`, { kind: 'portal' })
    return { siteId: r.site.id, slug: r.site.slug ?? r.site.id }
  },
  // 스튜디오 우측 패널 — 탭이 있어야 패널 칸이 모두 그려진다(끝에 지운다).
  'studio-tab': async (api) => {
    const t = await api.ok<{ id: string }>('POST', '/projects/proj-sandbox/tabs', { name: `uistab-auto-${Date.now()}`, endpointId: 'ep-ds-sbx-pg-targets', config: { viewMode: 'split', showPivot: true, showChart: false, rows: ['연월'], cols: [], values: [{ field: '목표매출', agg: 'sum' }] } })
    return { tabId: t.id }
  },
  // 예: 공유 토큰이 필요한 공개 화면
  // 'dashboard-share': async (api) => ({ shareToken: (await api.ok<{ token: string }>('POST', '/projects/<시드 id>/dashboard-share', { mode: 'snapshot' })).token }),
}

// ▼ 프로젝트 설정 — 클릭 탐색 앞뒤로 비교할 개인 설정 필드 · 워크스페이스 설정 GET 경로(아래는 예시)
const PREF_KEYS = ['panelLayout', 'studioTabScope', 'themePreference', 'accentPreference', 'radiusPreference', 'numFont', 'borderStrength', 'latinFont', 'railShortcuts', 'studioRecommend', 'hwpxNativeOpen', 'stewardNotify', 'stewardNotifyMail', 'railSide', 'studioBarMode', 'name', 'avatarColor']
async function stateOf(api: Api): Promise<{ prefs: Record<string, unknown>; ws: string; history: number }> {
  const me = await api.ok<{ user: Record<string, unknown> }>('GET', '/auth/me')
  // 워크스페이스 설정 — 목록(이름 · 색 · 브랜딩) + 설정 카드 원본 몇 가지. 시각 필드는 뺀다.
  const parts: string[] = []
  for (const p of ['/workspaces', `/workspaces/${WORKSPACE_ID}/config-history`, `/workspaces/${WORKSPACE_ID}/export-security`, `/workspaces/${WORKSPACE_ID}/blend-limits`, `/workspaces/${WORKSPACE_ID}/calendar`, `/workspaces/${WORKSPACE_ID}/agent-settings`]) {
    const r = await api.req('GET', p)
    parts.push(JSON.stringify(r.body).replace(/"(\w*At|now|lastSeen\w*)":"[^"]*"/g, ''))
  }
  return { prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, me.user[k]])), ws: parts.join('|'), history: 0 }
}

function runnable(s: Screen, app: string): boolean {
  return s.auto && s.apps.includes(app) && (!ONLY || ONLY.test(s.id))
}

test.describe('UI 자동 탐색', () => {
  test.skip(process.env.UISTAB_AUTO_CAPTURE === '1', '캡처 실행 중에는 순회를 건너뛴다')
  const baseline = loadBaseline(REPO)
  // I26 — 전제 검사: 지금 소스의 빌드를 서빙하는가 · 대상 앱인가. 실패하면 이 파일 전체가 멈춘다(스테일 서빙 위에서 돈 결과는 믿을 수 없다).
  test.beforeAll(async ({ browser }, workerInfo) => {
    const app = (workerInfo.project.use as { app?: 'react' | 'vue' }).app ?? 'react'
    const ctx = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
    try { await assertFreshServing(await ctx.newPage(), app) } finally { await ctx.close() }
  })
  for (const s of SCREENS.screens) {
    if (!s.auto) continue
    const p0 = !!s.p0
    const title = `UISTAB-AUTO ${s.id}`
    test(title, p0 ? { tag: '@p0' } : {}, async ({ page, ownerApi, app }, testInfo) => {
      test.skip(!runnable(s, app), `${s.id}: ${app} 에 없는 화면`)
      test.skip(!p0 && !ALL && !ONLY, '야간 전체(UISTAB_AUTO=all)에서만 — P0 관문은 핵심 화면만')
      test.skip(RESUME && fs.existsSync(path.join(OUT_DIR(REPO), app, `${s.id.replace(/[^\w가-힣.-]+/g, '_').slice(0, 120)}.json`)), '이어 돌리기 — 이미 결과가 있다')
      test.setTimeout(DEPTH === 'nightly' ? 240_000 : 120_000)
      const vars = s.entry.setup ? await SETUPS[s.entry.setup]!(ownerApi) : {}
      if (s.role === 'owner') {
        const me = await ownerApi.ok<{ user: unknown }>('GET', '/auth/me')
        await primeSession(page, { token: ownerApi.token!, user: me.user })
      }
      // 좌 · 우 패널은 고정(ON)으로 연다 — 자동 탐색은 «내용» 을 본다. 고정 OFF 호버 패널의 열림 유지 · 이탈 닫힘은 레지스트리(I2)가 본다.
      // ▼ 프로젝트 설정 — 패널 고정 상태를 저장하는 localStorage 키를 프로젝트 값으로 바꾼다.
      await page.addInitScript(() => { try { localStorage.setItem('app:panelPin:left', '1'); localStorage.setItem('app:panelPin:right', '1') } catch { /* 저장소 차단 */ } })
      // 상태 지킴 — 클릭 탐색이 개인 설정 · 워크스페이스 설정을 바꿨는지 앞뒤로 비교하고, 개인 설정은 되돌린다(시험 DB 오염 방지).
      const before = await stateOf(ownerApi)
      const r = await exploreScreen(page, s, app, { depth: DEPTH, vars })
      if (vars.tabId) await ownerApi.req('DELETE', `/tabs/${vars.tabId}`)
      const after = await stateOf(ownerApi)
      const changedPrefs = Object.keys(before.prefs).filter((k) => JSON.stringify(before.prefs[k]) !== JSON.stringify(after.prefs[k]))
      if (changedPrefs.length) {
        r.violations.push({ inv: 'MUTATION', kind: '클릭 탐색이 개인 설정을 바꿈', comp: `screen:${s.id}`, key: changedPrefs.join(','), detail: changedPrefs.map((k) => `${k}: ${JSON.stringify(before.prefs[k])} → ${JSON.stringify(after.prefs[k])}`).join(' · ') })
        await ownerApi.req('PATCH', '/me', Object.fromEntries(changedPrefs.map((k) => [k, before.prefs[k]])))
      }
      if (before.ws !== after.ws || after.history > before.history) r.violations.push({ inv: 'MUTATION', kind: '클릭 탐색이 워크스페이스 설정을 바꿈', comp: `screen:${s.id}`, key: 'workspace', detail: '워크스페이스 설정 GET 응답이 클릭 탐색 앞뒤로 다르다(누른 단추 중 즉시 저장하는 것이 있다)' })
      const f = writeResult(REPO, r)
      testInfo.annotations.push({ type: 'uistab-auto', description: `요소 ${r.checkedEls}/${r.found} · 클릭 ${r.clicked}/${r.clickTargets} · 위반 ${r.violations.length} · ${r.ms}ms · ${f}` })
      expect(r.error, `${s.id} 탐색 중 오류`).toBeUndefined()
      // I26 앱 자기증명 — 열린 페이지가 이 프로젝트의 프레임워크인가(하네스 BASE 고정으로 «vue» 실행이 React 를 치는 사고 방지)
      expect(r.proof?.framework, `${s.id} 앱 자기증명`).toBe(app)
      const fresh = RATCHET ? newViolations(baseline, r) : []
      if (RATCHET && baseline && !(`${app}|${s.id}` in baseline.screens) && r.violations.length) fresh.splice(0, fresh.length, ...r.violations)
      if (fresh.length) {
        await attachEvidence(page, testInfo, `AUTO-${s.id}`, { invariant: 'AUTO', newViolations: fresh })
        throw new Error(`[UI 자동 탐색] ${s.id} — 베이스라인에 없는 새 위반 ${fresh.length}건\n  - ${fresh.slice(0, 15).map((v) => `${v.inv} ${v.kind} · ${v.comp} · ${v.detail}`).join('\n  - ')}`)
      }
    })
  }
})

// 위반 묶음 상위 캡처 — UISTAB_AUTO_CAPTURE=1 이면 coverage/uistab/top-groups.json(pnpm uistab:coverage 가 만든 상위 10 묶음)의 예시 요소를
// 화면에서 찾아 빨간 테두리를 두르고 2x 로 찍는다(coverage/uistab/captures/<순위>-<앱>.2x.png). 열린 표면 위반이면 연 단추를 실제로 눌러 연다.
test.describe('UI 자동 탐색 — 상위 묶음 캡처', () => {
  test('UISTAB-AUTO-CAPTURE 위반 묶음 상위 10', async ({ page, ownerApi, app }) => {
    test.skip(process.env.UISTAB_AUTO_CAPTURE !== '1', '캡처는 요청할 때만')
    test.setTimeout(600_000)
    const top = JSON.parse(fs.readFileSync(path.join(OUT_DIR(REPO), 'top-groups.json'), 'utf8')) as Array<{ rank: number; app: string; screenId: string; key: string; inv: string }>
    const { capture2x } = await import('../helpers/ui-stability/evidence.js')
    const me = await ownerApi.ok<{ user: unknown }>('GET', '/auth/me')
    await primeSession(page, { token: ownerApi.token!, user: me.user })
    const dir = path.join(OUT_DIR(REPO), 'captures')
    fs.mkdirSync(dir, { recursive: true })
    for (const g of top.filter((x) => x.app === app || x.app === 'rv')) {
      const s = SCREENS.screens.find((x) => x.id === g.screenId)
      if (!s) continue
      const vars = s.entry.setup ? await SETUPS[s.entry.setup]!(ownerApi) : {}
      await page.goto((s.entry.url ?? '/').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? k))
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await page.evaluate(fs.readFileSync(path.join(REPO, 'e2e/helpers/ui-stability/explore-lib.browser.js'), 'utf8'))
      const [trigger, rest] = g.key.split('>')
      const mark = async (k: string) => page.evaluate((k) => {
        const lib = (window as any).__uistabLib
        for (const el of document.querySelectorAll('button, a[href], [role], input, select, textarea, [tabindex]')) if (lib.keyOf(el) === k) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); (el as HTMLElement).style.outline = '3px solid red'; (el as HTMLElement).style.outlineOffset = '2px'; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
        return null
      }, k)
      const at = await mark(trigger!)
      if (rest && at) { await page.mouse.move(at.x, at.y, { steps: 4 }); await page.mouse.down(); await page.mouse.up(); await page.waitForLoadState('networkidle').catch(() => undefined) }
      fs.writeFileSync(path.join(dir, `${String(g.rank).padStart(2, '0')}-${app}.2x.png`), await capture2x(page))
    }
  })
})
