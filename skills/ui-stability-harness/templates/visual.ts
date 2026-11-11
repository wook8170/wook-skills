// I47 시각 기준선 — 화면을 연 직후(요소 훑기 전) 2x 캡처를 기준 그림과 화소 단위로 비교한다. 설계 docs/testing/ui-stability-harness.md §3.3.
//
// · 캡처는 evidence.ts capture2x(CDP clip.scale=2 — 화면 배치는 그대로, 화소만 두 배)를 쓴다. 1x 는 글자가 뭉개져 회귀를 못 본다.
// · 매번 바뀌는 자리(시각 · 상대 시각 · 입력 커서)는 explore-lib visualMask 와 설정 visualMask 선택자로 가린다.
// · 비교는 브라우저 캔버스에서 한다(새 의존성 없음). 화소마다 RGB 차이 합이 pixelTolerance 를 넘으면 다른 화소로 세고,
//   다른 화소 비율이 화면별 임계(visual-thresholds.json)를 넘으면 위반이다. 크기가 다르면 비율 1(전부 다름)로 본다.
// · 기준 그림은 저장소에 넣지 않는다(화면 540장 × 2x ≈ 수백 MB). 기본 자리 coverage/uistab/visual-baseline/<조건>/<화면>.png,
//   UISTAB_VISUAL_DIR 로 바꾼다. 없으면 지금 그림을 기준으로 저장하고 위반 없이 넘어간다(created).
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { capture2x } from './evidence.js'
import { PROJECT_CONFIG } from './project.config.js'
import type { ScreenResult, Violation } from './explore.js'

const DIR = path.dirname(new URL(import.meta.url).pathname)
type Thresholds = { default: number; pixelTolerance: number; screens: Record<string, { ratio: number; why: string }> }
export const VISUAL_THRESHOLDS: Thresholds = JSON.parse(fs.readFileSync(path.join(DIR, 'visual-thresholds.json'), 'utf8'))

/** 두 PNG 를 같은 컨텍스트의 빈 페이지 캔버스에서 비교한다. diff = 다른 화소를 빨갛게 칠한 PNG. */
export async function diffPng(page: Page, a: Buffer, b: Buffer, tol: number): Promise<{ ratio: number; diff: Buffer | null; size: string }> {
  const p = await page.context().newPage()
  try {
    const r = await p.evaluate(async ([a64, b64, t]) => {
      const load = async (s: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
      const [ia, ib] = await Promise.all([load(a64), load(b64)])
      if (ia.width !== ib.width || ia.height !== ib.height) return { ratio: 1, diff: null, size: `${ia.width}×${ia.height} ≠ ${ib.width}×${ib.height}` }
      const w = ia.width, h = ia.height
      const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h)
      const xa = ca.getContext('2d')!, xb = cb.getContext('2d')!
      xa.drawImage(ia, 0, 0); xb.drawImage(ib, 0, 0)
      const da = xa.getImageData(0, 0, w, h), db = xb.getImageData(0, 0, w, h)
      const out = xa.getImageData(0, 0, w, h)
      let bad = 0
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.abs(da.data[i]! - db.data[i]!) + Math.abs(da.data[i + 1]! - db.data[i + 1]!) + Math.abs(da.data[i + 2]! - db.data[i + 2]!)
        if (d > t) { bad++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255 } else { out.data[i + 3] = 60 }
      }
      if (!bad) return { ratio: 0, diff: null, size: `${w}×${h}` }
      xa.putImageData(out, 0, 0)
      const blob = await ca.convertToBlob({ type: 'image/png' })
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return { ratio: bad / (w * h), diff: btoa(s), size: `${w}×${h}` }
    }, [a.toString('base64'), b.toString('base64'), tol] as const)
    return { ratio: r.ratio, diff: r.diff ? Buffer.from(r.diff, 'base64') : null, size: r.size }
  } finally {
    await p.close()
  }
}

/** 96 사양의 onSettled 훅 — 기준 그림과 비교하고 위반(I47)을 돌려준다. mode=update 면 기준 그림을 지금 것으로 바꾼다. */
export function visualHook(opts: { dir: string; label: string; mode: 'compare' | 'update' }) {
  return async (page: Page, res: ScreenResult): Promise<Violation[]> => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate((sel) => (window as any).__uistabLib.visualMask(sel), PROJECT_CONFIG.visualMask ?? [])
    await page.mouse.move(1, 1)
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
    const cur = await capture2x(page)
    const safe = res.screenId.replace(/[^\w가-힣.-]+/g, '_').slice(0, 120)
    const base = path.join(opts.dir, opts.label, `${safe}.png`)
    const thr = VISUAL_THRESHOLDS.screens[res.screenId]?.ratio ?? VISUAL_THRESHOLDS.default
    // 가린 자리를 되돌린다 — 뒤따르는 요소 훑기 · 문구 검사가 처음 모습을 보게.
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-uistab-masked]')) { (e as HTMLElement).style.visibility = ''; e.removeAttribute('data-uistab-masked') } })
    await page.emulateMedia({ reducedMotion: null })
    if (opts.mode === 'update' || !fs.existsSync(base)) {
      fs.mkdirSync(path.dirname(base), { recursive: true })
      fs.writeFileSync(base, cur)
      res.visual = { ratio: 0, threshold: thr, baseline: base, created: true }
      return []
    }
    const d = await diffPng(page, fs.readFileSync(base), cur, VISUAL_THRESHOLDS.pixelTolerance)
    let diffPath: string | undefined
    if (d.diff) { diffPath = base.replace(/\.png$/, `.diff-${Date.now()}.png`); fs.writeFileSync(diffPath, d.diff); fs.writeFileSync(base.replace(/\.png$/, '.current.png'), cur) }
    res.visual = { ratio: Math.round(d.ratio * 10000) / 10000, threshold: thr, baseline: base, ...(diffPath ? { diff: diffPath } : {}) }
    res.checks.I47 = 1
    if (d.ratio > thr) return [{ inv: 'I47', kind: '시각 기준선과 다름', comp: `visual:${res.screenId}`, key: `visual|${res.screenId}`, detail: `다른 화소 ${(d.ratio * 100).toFixed(2)}%(임계 ${(thr * 100).toFixed(2)}%) · ${d.size} · 차이 그림 ${diffPath ?? '없음'}` }]
    return []
  }
}
