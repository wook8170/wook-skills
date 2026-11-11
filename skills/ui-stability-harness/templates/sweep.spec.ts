// 진입점 레지스트리 순회(범용 템플릿) — 레지스트리 항목 × 조건마다 드라이버(실제 입력 + 불변식)를 부른다. core 조건은 @p0(병합 관문).
// 아직 못 고친 결함은 레지스트리 fixme(결함 ID)로 그 조합만 보류한다. UISTAB_RUN_FIXME=1 이면 보류도 돌린다(고쳤는지 확인).
import { test } from '@playwright/test' // 프로젝트의 로그인 · API 픽스처가 있으면 그것을 쓴다
import { REGISTRY, CONDITIONS, fixmeFor } from '../helpers/ui-stability/registry.js'
import { DRIVERS } from '../helpers/ui-stability/drivers.js'
import { assertFreshServing } from '../helpers/ui-stability/stale.js'

test.describe('UI 안정성 순회', () => {
  // I26 전제 — 스테일 서빙이면 파일 전체를 멈춘다.
  test.beforeAll(async ({ browser }, workerInfo) => {
    const app = (workerInfo.project.use as { app?: 'react' | 'vue' }).app ?? 'react'
    const ctx = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
    try { await assertFreshServing(await ctx.newPage(), app) } finally { await ctx.close() }
  })
  for (const e of REGISTRY) {
    for (const cid of e.conditions) {
      const cond = CONDITIONS[cid]
      const caseId = e.cases[cid] ?? `(${e.id}/${cid} 원장 없음)`
      test(`${caseId} ${e.title} — ${cid === 'core' ? '핵심 조건' : cond.label}`, cid === 'core' ? { tag: '@p0' } : {}, async ({ page }, testInfo) => {
        const app = testInfo.project.name
        const fx = fixmeFor(e, cid, app)
        test.fixme(!!fx && process.env.UISTAB_RUN_FIXME !== '1', fx ? `${fx.defect} — ${fx.reason}` : '')
        const driver = DRIVERS[e.id]
        if (!driver) throw new Error(`레지스트리 항목 ${e.id} 에 드라이버가 없다`)
        await page.setViewportSize(cond.viewport)
        await page.emulateMedia({ colorScheme: cond.theme })
        await driver({ page, app, cond, testInfo })
      })
    }
  }
})
