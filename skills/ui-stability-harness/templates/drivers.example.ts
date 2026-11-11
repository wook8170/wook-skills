// 드라이버 예시 — 실제 입력(page.mouse · page.keyboard)으로 표면을 열고 불변식을 부른다. dispatchEvent · force 클릭 · 고정 대기 금지.
import type { Page, TestInfo } from '@playwright/test'
import type { Condition } from './registry.js'
import { humanClick, assertVisibleUnobstructed, assertFocusInside, assertEscClosesTopOnly, assertFocusReturned } from './invariants.js'
import { assertSurfaceClean } from './explore.js'

export type DriverCtx = { page: Page; app: string; cond: Condition; testInfo: TestInfo }
export type Driver = (ctx: DriverCtx) => Promise<void>

export const DRIVERS: Record<string, Driver> = {
  'example.rowMenu': async ({ page, testInfo }) => {
    await page.goto('/list')
    const btn = page.getByTestId('row-menu-btn-1')
    await humanClick(page, btn)
    await assertVisibleUnobstructed(page, 'row-menu', { label: '행 ⋯ 메뉴', testInfo })
    await assertFocusInside(page, 'row-menu', { label: '행 ⋯ 메뉴', testInfo })
    await assertSurfaceClean(page, '[data-testid="row-menu"]', ['I11', 'I17'], { label: '행 ⋯ 메뉴', testInfo })
    await assertEscClosesTopOnly(page, ['row-menu'], { label: '행 ⋯ 메뉴', testInfo })
    await assertFocusReturned(page, btn, { label: '행 ⋯ 메뉴', testInfo })
  },
}
