// 실패 증거 — 2x 캡처(CDP Page.captureScreenshot clip.scale=2, 화면 배치를 바꾸지 않는다)와 판정 근거 JSON 을 시험 결과에 첨부한다.
// 1x 캡처는 글자가 뭉개져 회귀를 눈으로 못 잡는다(전역 규칙) — 뷰포트 크기는 그대로 두고 픽셀만 두 배로 굽는다.
import fs from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'

/** 파일로도 남긴다(결과 폴더 artifacts/<시험>/) — 리포터를 list 로만 돌려도 캡처를 Read 로 열 수 있게. */
async function attachFile(testInfo: TestInfo, name: string, body: Buffer, contentType: string): Promise<void> {
  const p = testInfo.outputPath(name)
  fs.writeFileSync(p, body)
  await testInfo.attach(name, { path: p, contentType })
}

/** 현재 뷰포트를 2배 해상도 PNG 로. 크로미움이 아니면 1x 로 대신한다. */
export async function capture2x(page: Page): Promise<Buffer> {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 }
  try {
    const client = await page.context().newCDPSession(page)
    const r = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 2 }, captureBeyondViewport: false })
    await client.detach()
    return Buffer.from(r.data, 'base64')
  } catch {
    return page.screenshot()
  }
}

/** 실패 증거를 첨부한다 — `<이름>.2x.png` + `<이름>.json`. 같은 시험에서 여러 번 불러도 이름이 겹치지 않게 순번을 붙인다. */
export async function attachEvidence(page: Page, testInfo: TestInfo, name: string, detail: Record<string, unknown>): Promise<void> {
  const safe = name.replace(/[^\w가-힣.-]+/g, '_').slice(0, 80)
  const n = testInfo.attachments.filter((a) => a.name.startsWith(safe)).length
  const tag = n ? `${safe}-${n}` : safe
  await attachFile(testInfo, `${tag}.2x.png`, await capture2x(page), 'image/png')
  await attachFile(testInfo, `${tag}.json`, Buffer.from(JSON.stringify({ url: page.url(), viewport: page.viewportSize(), ...detail }, null, 2)), 'application/json')
}

/** 통과한 시험에도 남겨 둘 2x 캡처(스킬 절차 — 서브에이전트가 Read 로 직접 본다). */
export async function attachCapture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await attachFile(testInfo, `${name.replace(/[^\w가-힣.-]+/g, '_').slice(0, 80)}.2x.png`, await capture2x(page), 'image/png')
}
