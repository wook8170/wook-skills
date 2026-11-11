// [템플릿] 실제 적용 프로젝트의 사본이다. import 경로(fixtures · harness)와 ▼ 프로젝트 설정 표시 부분을 프로젝트에 맞춘다. SKILL.md §6.
// UI 안정성 불변식 I1~I8 검사 함수 — 설계 docs/testing/ui-stability-harness.md.
//
// 원칙
// · 입력은 실제 입력만 쓴다 — page.mouse 를 여러 걸음으로 움직이고 page.keyboard 로 친다. dispatchEvent · 합성 이벤트 금지.
// · 판정은 «화면에서 보이는 결과» 로 한다 — 요소가 DOM 에 있는지가 아니라 그 자리를 가리키면 그 요소가 잡히는지(elementFromPoint),
//   어느 층이 위에 그려지는지(쌓임 순서), 열린 채로 몇 ms 버티는지, 프레임마다 얼마나 흔들리는지, 첫 표시까지 몇 ms 인지.
// · 실패하면 2x 캡처와 판정 근거(elementFromPoint 결과 · 쌓임 순서 · 시간 기록)를 시험 결과에 첨부한다(evidence.ts).
//
// 다른 레인(열기 진입점 통합)이 같은 폴더에 헬퍼를 둔다 — 여기 이름은 index.ts 에서 그대로 내보내며 겹치지 않게 한다.
import type { Locator, Page, TestInfo } from '@playwright/test'
import { attachEvidence } from './evidence.js'

export type Rect = { x: number; y: number; width: number; height: number }
export type Pt = { x: number; y: number }

// ▼ 프로젝트 설정(아래 값은 예시) — 딤 · 탑바 예외 층 · 탑바 버튼 testid 를 프로젝트 것으로 바꾼다.
/** 딤(덮개) 층 — I3 판정과 I4 예외 판정에 쓴다. 새 딤 프리미티브를 만들면 여기에 등록한다. */
export const DIM_SELECTORS = [
  '[data-testid="tour-spotlight"]', // 투어 딤(스포트라이트 상자의 큰 그림자) — 포인터를 통과시키므로 elementFromPoint 로는 안 잡힌다
  '[data-testid="tour-scrim"]',
  '[data-testid="tour-overlay"]',
  '.gxModalOverlay',
  '.gxScrim',
] as const

/**
 * I4 예외 — 떠 있는 동안 탑바를 덮는 것이 «설계» 인 층. 모달 딤(포커스를 가두는 창)과 가벼운 닫기용 투명 막(누르면 닫히는 메뉴 ·
 * 검색 팔레트 바깥)만 둔다. 늘리려면 설계 문서 §I4 예외 표에 사유와 함께 먼저 적는다.
 */
export const TOPBAR_EXEMPT_LAYERS = [
  { selector: '.gxModalOverlay', why: '모달 딤 — 창이 포커스를 가둔다' },
  { selector: '.gxScrim', why: '모달 딤 — 창이 포커스를 가둔다' },
  { selector: '[data-testid="tour-overlay"]', why: '투어 — 다음 · 건너뛰기 · Esc 로만 진행' },
  { selector: '.gxPopoverBackdrop', why: '가벼운 닫기 막 — 바깥을 한 번 누르면 닫히는 팝오버(검색 팔레트 등)' },
  { selector: '[aria-label="메뉴 닫기"]', why: '가벼운 닫기 막 — 트리 행 ⋯ 메뉴 바깥' },
] as const

/** 탑바 핵심 버튼(R/V 같은 testid). 화면마다 없을 수 있는 것은 있는 것만 본다. */
export const TOPBAR_BUTTONS = ['search-input', 'topbar-tour', 'help-btn', 'bell-btn', 'avatar-btn'] as const

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 브라우저 안 판정 — page.evaluate 로 넘기는 함수(직렬화되므로 바깥 변수를 쓰지 않는다)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type HitReport = {
  found: boolean
  rect: Rect | null
  viewport: { w: number; h: number }
  inViewport: boolean
  points: Array<{ name: string; x: number; y: number; hit: string; own: boolean }>
}

/** 요소를 사람이 읽을 이름으로 — testid · role · 클래스 앞부분. */
const DESCRIBE = `function describe(el) {
  if (!el) return '(없음)'
  const t = el.closest('[data-testid]')
  const tid = t ? t.getAttribute('data-testid') : ''
  const role = el.getAttribute && el.getAttribute('role')
  const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 2).join('.') : ''
  return [el.tagName.toLowerCase(), tid && ('testid=' + tid), role && ('role=' + role), cls && ('.' + cls)].filter(Boolean).join(' ')
}`

/** el 의 쌓임 맥락 사슬(뿌리 → el) — [요소, z(숫자 · auto=0), 맥락을 만드는가]. */
const PAINT = `function chain(el) {
  const out = []
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) out.unshift(e)
  return out
}
function makesContext(e) {
  if (e === document.documentElement) return true
  const s = getComputedStyle(e)
  if (s.position === 'fixed' || s.position === 'sticky') return true
  if (s.zIndex !== 'auto' && (s.position !== 'static' || (e.parentElement && /flex|grid/.test(getComputedStyle(e.parentElement).display)))) return true
  if (Number(s.opacity) < 1 || s.transform !== 'none' || s.filter !== 'none' || s.isolation === 'isolate' || (s.mixBlendMode && s.mixBlendMode !== 'normal')) return true
  if (s.contain && /paint|layout|strict|content/.test(s.contain)) return true
  return false
}
function zOf(e) { const z = getComputedStyle(e).zIndex; return z === 'auto' ? 0 : Number(z) || 0 }
function positioned(e) { return getComputedStyle(e).position !== 'static' }
/** 쌓임 단계 — 같은 맥락 안의 비교 키(z, 위치 지정 여부, 문서 순서는 호출부). */
function stackOf(el) {
  // 뿌리부터 쌓임 맥락을 만드는 조상만 단계로 삼고, 끝에 요소 자신을 붙인다(맥락을 안 만들어도 비교 대상).
  // 근사: z 가 auto 인 위치 지정 조상(맥락을 안 만듦)의 자손 순서는 문서 순서로 본다.
  const c = chain(el)
  const parts = []
  for (let i = 1; i < c.length; i++) {
    const e = c[i]
    if (makesContext(e) || e === el) parts.push({ el: e, z: zOf(e), pos: positioned(e) })
  }
  return parts
}
/** a 가 b 위에 그려지는가(근사 — CSS 2.1 부록 E 의 z/위치 지정/문서 순서). */
function paintsAbove(a, b) {
  if (a === b || a.contains(b)) return false
  if (b.contains(a)) return true
  const sa = stackOf(a), sb = stackOf(b)
  const n = Math.min(sa.length, sb.length)
  let i = 0
  while (i < n && sa[i].el === sb[i].el) i++
  // 갈라진 첫 단계(같은 맥락 안의 형제 참가자)끼리 비교한다. 한쪽이 끝났으면 그 쪽은 맥락 자체의 일반 흐름이다(z 0, 비위치).
  const pa = sa[i] || { z: 0, pos: false, el: a }
  const pb = sb[i] || { z: 0, pos: false, el: b }
  if (pa.z !== pb.z) return pa.z > pb.z
  if (pa.pos !== pb.pos) return pa.pos
  return !!(pb.el.compareDocumentPosition(pa.el) & Node.DOCUMENT_POSITION_FOLLOWING)
}`

function rectOf(r: DOMRect | Rect): Rect { return { x: r.x, y: r.y, width: r.width, height: r.height } }

/** 표면의 네 모서리(안쪽 inset px) + 중심을 찍어 누가 잡히는지 본다. own = 표면 자신(또는 자손 · ownSelectors). */
async function hitProbe(page: Page, sel: string, inset: number, ownSelectors: readonly string[]): Promise<HitReport> {
  return page.evaluate(([sel, inset, own, DESCRIBE]) => {
    // eslint-disable-next-line no-new-func
    const describe = new Function(`${DESCRIBE}; return describe`)() as (el: Element | null) => string
    const el = document.querySelector(sel)
    const vw = window.innerWidth, vh = window.innerHeight
    if (!el) return { found: false, rect: null, viewport: { w: vw, h: vh }, inViewport: false, points: [] }
    // 포인터를 통과시키는 표면(툴팁 등)은 판정하는 동안만 포인터를 받게 한다 — «그 자리에 그려진 맨 위가 무엇인가» 를 보려는 것이다.
    const he = el as HTMLElement
    const restorePe = getComputedStyle(he).pointerEvents === 'none' ? he.style.pointerEvents : null
    if (restorePe !== null) he.style.setProperty('pointer-events', 'auto', 'important')
    const r = el.getBoundingClientRect()
    const inViewport = r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1
    const L = Math.max(r.left + inset, 0), R = Math.min(r.right - inset, vw - 1), T = Math.max(r.top + inset, 0), B = Math.min(r.bottom - inset, vh - 1)
    const pts: Array<[string, number, number]> = [['왼쪽 위', L, T], ['오른쪽 위', R, T], ['왼쪽 아래', L, B], ['오른쪽 아래', R, B], ['가운데', (L + R) / 2, (T + B) / 2]]
    const points = pts.map(([name, x, y]) => {
      const hit = document.elementFromPoint(x, y)
      const isOwn = !!hit && (el.contains(hit) || (own as string[]).some((s) => !!hit.closest(s)))
      return { name, x: Math.round(x), y: Math.round(y), hit: describe(hit), own: isOwn }
    })
    if (restorePe !== null) { he.style.removeProperty('pointer-events'); if (restorePe) he.style.pointerEvents = restorePe }
    return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { w: vw, h: vh }, inViewport, points }
  }, [sel, inset, ownSelectors as unknown as string[], DESCRIBE] as const)
}

/** 보이는 딤 층 중 표면보다 위에 그려지는 것 — 표면이 그 딤 안(자손)이면 세지 않는다. */
async function dimsAbove(page: Page, sel: string, dims: readonly string[]): Promise<string[]> {
  return page.evaluate(([sel, dims, DESCRIBE, PAINT]) => {
    // eslint-disable-next-line no-new-func
    const lib = new Function(`${DESCRIBE}; ${PAINT}; return { describe, paintsAbove }`)() as { describe: (e: Element) => string; paintsAbove: (a: Element, b: Element) => boolean }
    const el = document.querySelector(sel)
    if (!el) return []
    const out: string[] = []
    for (const d of dims as string[]) {
      for (const dim of Array.from(document.querySelectorAll(d))) {
        if (dim.contains(el) || el.contains(dim)) continue
        const r = dim.getBoundingClientRect()
        const s = getComputedStyle(dim)
        const shadow = s.boxShadow && s.boxShadow !== 'none'
        if ((r.width === 0 || r.height === 0) && !shadow) continue
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue
        // 실제로 어둡게 칠하는 층만 본다 — 배경이 투명하고 그림자 · 배경 흐림도 없으면(투어 루트 같은 빈 틀) 딤이 아니다.
        const bgAlpha = (() => { const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor); if (!m) return s.backgroundColor === 'transparent' ? 0 : 1; const p = m[1]!.split(/[ ,/]+/).filter(Boolean); return p.length >= 4 ? Number(p[3]) : 1 })()
        const blur = (s as unknown as { backdropFilter?: string }).backdropFilter
        if (bgAlpha === 0 && !shadow && (!blur || blur === 'none')) continue
        if (!lib.paintsAbove(dim, el)) continue
        const sr = el.getBoundingClientRect()
        if (bgAlpha === 0 && shadow) {
          // 스포트라이트(투명 상자 + 큰 그림자) — 어두운 곳은 상자 «밖» 이다. 표면이 상자 안(2px 여유)에 다 들면 밝은 구멍 안이다.
          const inside = sr.left >= r.left - 2 && sr.top >= r.top - 2 && sr.right <= r.right + 2 && sr.bottom <= r.bottom + 2
          if (inside) continue
        } else {
          const ov = Math.min(sr.right, r.right) - Math.max(sr.left, r.left) > 0 && Math.min(sr.bottom, r.bottom) - Math.max(sr.top, r.top) > 0
          if (!ov) continue
        }
        out.push(`${d} (${lib.describe(dim)})`)
      }
    }
    return out
  }, [sel, dims as unknown as string[], DESCRIBE, PAINT] as const)
}

/** Locator → 브라우저 쪽에서 다시 찾을 수 있는 CSS 선택자. 표면은 대개 testid 로 등록하므로 그 형태만 받는다. */
export function surfaceSelector(testIdOrSelector: string): string {
  return /^[\w-]+$/.test(testIdOrSelector) ? `[data-testid="${testIdOrSelector}"]` : testIdOrSelector
}

export class UiStabilityError extends Error {}

/** 표면 상자가 연속 3프레임 같아질 때까지(최대 2초) 기다려 그 상자를 돌려준다(펼침 · 미끄러짐 애니메이션 끝). */
export async function settledBox(page: Page, sel: string): Promise<Rect> {
  const r = await page.evaluate((sel) => new Promise<Rect | null>((resolve) => {
    let last = '', same = 0
    const t0 = performance.now()
    const tick = () => {
      const el = document.querySelector(sel as string)
      if (!el) return resolve(null)
      const b = el.getBoundingClientRect()
      const k = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`
      same = k === last ? same + 1 : 0
      last = k
      if (same >= 3 || performance.now() - t0 > 2000) return resolve({ x: b.x, y: b.y, width: b.width, height: b.height })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), sel)
  if (!r) throw new UiStabilityError(`표면 ${sel} 이 자리를 잡기 전에 사라졌다`)
  return r
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I1 가시성 · 가림 없음
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type VisibleOpts = {
  label: string
  testInfo: TestInfo
  /** 표면의 일부로 치는 다른 층(예: 같은 메뉴의 하위 팝오버). */
  ownSelectors?: readonly string[]
  /** 모서리 안쪽 여백(px) — 둥근 모서리 · 테두리 1px 를 피한다. 기본 4. */
  inset?: number
  /** 딤 층 목록(I1 도 «딤 아래에 깔림» 을 가림으로 본다). 기본 DIM_SELECTORS. */
  dims?: readonly string[]
}

/** I1 — 열린 표면이 뷰포트 안에 있고, 네 모서리와 중심을 가리키면 그 표면이 잡히며, 어떤 딤도 그 위에 그려지지 않는다. */
export async function assertVisibleUnobstructed(page: Page, surface: string, opts: VisibleOpts): Promise<void> {
  const sel = surfaceSelector(surface)
  await page.locator(sel).first().waitFor({ state: 'visible' })
  await settledBox(page, sel)
  const rep = await hitProbe(page, sel, opts.inset ?? 4, opts.ownSelectors ?? [])
  const covered = await dimsAbove(page, sel, opts.dims ?? DIM_SELECTORS)
  const problems: string[] = []
  if (!rep.found) problems.push('표면을 찾지 못했다')
  if (rep.found && !rep.inViewport) problems.push(`뷰포트(${rep.viewport.w}×${rep.viewport.h}) 밖으로 나갔다 — ${JSON.stringify(rep.rect)}`)
  for (const p of rep.points) if (!p.own) problems.push(`${p.name}(${p.x},${p.y}) 를 가리키면 «${p.hit}» 가 잡힌다`)
  for (const c of covered) problems.push(`딤 층이 위에 그려진다: ${c}`)
  if (problems.length) {
    await attachEvidence(page, opts.testInfo, `I1-${opts.label}`, { invariant: 'I1', surface: sel, report: rep, dimsAbove: covered, problems })
    throw new UiStabilityError(`[I1 가시성 · 가림 없음] ${opts.label}\n  - ${problems.join('\n  - ')}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I2 열림 유지
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type StaysOpenOpts = {
  label: string
  testInfo: TestInfo
  /** 관찰 시간(ms). 기본 1000. */
  ms?: number
  /**
   * 포인터를 실제로 옮길 자리(순서대로, 걸음 수 8). 비우면 가운데 → 표면 반대편 → 위쪽 가운데 → 아래 가운데.
   * 표면 «안» 으로는 들어가지 않는다 — 고정 OFF 패널은 포인터가 한 번 들어왔다 나가면 닫히는 것이 정상 동작(C310)이라서다.
   */
  path?: Pt[]
  /** 닫히는 중 표지(예: data-slide-out) — 이 속성이 붙어도 «닫힘» 으로 본다. */
  closingAttrs?: string[]
}

/**
 * I2 — 프로그램으로 연 표면이 포인터를 화면 여러 곳으로 실제로 옮기는 동안 ms 동안 열려 있다. 판정은 페이지 안 rAF 관찰
 * (표면이 사라지거나 · 크기 0 이 되거나 · 닫힘 표지가 붙은 첫 순간을 기록)이라 그 사이 한 프레임이라도 닫히면 잡는다.
 */
export async function assertStaysOpen(page: Page, surface: string, opts: StaysOpenOpts): Promise<void> {
  const sel = surfaceSelector(surface)
  await page.locator(sel).first().waitFor({ state: 'visible' })
  // 펼침 애니메이션이 끝난 자리에서 경로를 잡는다 — 미끄러져 들어오는 중의 상자로 «반대편» 을 잡으면 그 점이 다 펼친 패널 안이 된다.
  const box = await settledBox(page, sel)
  const vw = page.viewportSize()?.width ?? 1440, vh = page.viewportSize()?.height ?? 900
  const ms = opts.ms ?? 1000
  const opposite = box.x + box.width / 2 > vw / 2 ? { x: Math.max(360, box.x - 300), y: vh / 2 } : { x: Math.min(vw - 8, box.x + box.width + 300), y: vh / 2 }
  const inside = (p: Pt) => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height
  // 왼쪽 가장자리(레일 · 좌측 패널 자리)는 피한다 — 그 자리 호버는 좌측 패널을 여는 별개의 동작이다.
  const path = opts.path ?? [{ x: vw / 2, y: vh / 2 }, opposite, { x: vw * 0.45, y: 120 }, { x: vw / 2, y: vh - 40 }].filter((p) => !inside(p))
  await page.evaluate(([sel, attrs]) => {
    const w = window as unknown as { __uistabOpen?: { closedAt: number | null; start: number; why: string } }
    const st = { closedAt: null as number | null, start: performance.now(), why: '' }
    w.__uistabOpen = st
    const tick = () => {
      if (st.closedAt !== null) return
      const el = document.querySelector(sel as string)
      let why = ''
      if (!el) why = '표면이 문서에서 사라졌다'
      else {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 1 || r.height < 1) why = '표면 크기가 0 이 됐다'
        else if (cs.visibility === 'hidden' || cs.display === 'none') why = '표면이 숨었다'
        else for (const a of attrs as string[]) if (el.hasAttribute(a) || el.closest(`[${a}]`)) why = `닫힘 표지 ${a}`
      }
      if (why) { st.closedAt = performance.now(); st.why = why; return }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [sel, opts.closingAttrs ?? ['data-slide-out']] as const)
  for (const p of path) await page.mouse.move(p.x, p.y, { steps: 8 })
  // 관찰 창이 끝날 때까지(페이지 시계 기준) 기다린다 — 고정 대기가 아니라 «관찰 창 경과» 라는 조건이다.
  await page.waitForFunction((ms) => {
    const st = (window as unknown as { __uistabOpen: { start: number; closedAt: number | null } }).__uistabOpen
    return st.closedAt !== null || performance.now() - st.start >= (ms as number)
  }, ms, { polling: 'raf', timeout: ms + 10_000 })
  const st = await page.evaluate(() => (window as unknown as { __uistabOpen: { start: number; closedAt: number | null; why: string } }).__uistabOpen)
  if (st.closedAt !== null) {
    const after = Math.round(st.closedAt - st.start)
    await attachEvidence(page, opts.testInfo, `I2-${opts.label}`, { invariant: 'I2', surface: sel, closedAfterMs: after, why: st.why, path })
    throw new UiStabilityError(`[I2 열림 유지] ${opts.label} — 포인터를 옮기는 동안 ${after}ms 만에 닫혔다(${st.why}). 기준 ${ms}ms`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I3 겹 순서(딤 위)
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type AboveDimOpts = { label: string; testInfo: TestInfo; dims?: readonly string[]; /** 열려야 하는 표면(투어가 그 표면을 가리키는 단계) — 안 열리면 실패. */ requireOpen?: boolean }

/**
 * I3 — 딤(투어 등)이 떠 있는 동안 새로 열린 표면은 딤 위에 그려지거나 아예 열리지 않아야 한다. surface 가 없으면(열리지 않음) 통과.
 * 딤이 하나도 떠 있지 않으면 전제가 깨진 것이라 실패로 본다(시험이 딤을 못 띄웠는데 통과하는 일을 막는다).
 */
export async function assertAboveDim(page: Page, surface: string, opts: AboveDimOpts): Promise<'above' | 'not-opened'> {
  const sel = surfaceSelector(surface)
  const dims = opts.dims ?? DIM_SELECTORS
  const anyDim = await page.evaluate((dims) => (dims as string[]).some((d) => Array.from(document.querySelectorAll(d)).some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })), dims as unknown as string[])
  if (!anyDim) throw new UiStabilityError(`[I3 겹 순서] ${opts.label} — 전제 실패: 딤이 떠 있지 않다`)
  const visible = await page.locator(sel).first().isVisible().catch(() => false)
  if (!visible) {
    if (opts.requireOpen) {
      await attachEvidence(page, opts.testInfo, `I3-${opts.label}`, { invariant: 'I3', surface: sel, opened: false })
      throw new UiStabilityError(`[I3 겹 순서] ${opts.label} — 이 단계는 표면이 열려야 하는데 열리지 않았다`)
    }
    return 'not-opened'
  }
  const covered = await dimsAbove(page, sel, dims)
  if (covered.length) {
    await attachEvidence(page, opts.testInfo, `I3-${opts.label}`, { invariant: 'I3', surface: sel, dimsAbove: covered })
    throw new UiStabilityError(`[I3 겹 순서] ${opts.label} — 딤이 떠 있는 동안 열린 표면이 딤 아래에 그려진다: ${covered.join(' · ')}`)
  }
  return 'above'
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I4 탑바 · 핵심 버튼 접근성
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type TopbarOpts = { label: string; testInfo: TestInfo; buttons?: readonly string[] }

/**
 * I4 — 떠 있는 표면이 무엇이든 탑바 버튼 가운데를 가리키면 그 버튼이 잡힌다. 등록된 예외 층(모달 딤 · 가벼운 닫기 막)이 떠 있으면
 * 그 층 때문에 가려진 것만 예외로 둔다(무엇 때문에 넘어갔는지 결과에 남긴다). 화면에 없는 버튼(스튜디오의 어시스턴트 등)은 건너뛴다.
 */
export async function assertTopbarReachable(page: Page, opts: TopbarOpts): Promise<{ checked: string[]; exempt: string[] }> {
  const res = await page.evaluate(([buttons, exempt, DESCRIBE]) => {
    // eslint-disable-next-line no-new-func
    const describe = new Function(`${DESCRIBE}; return describe`)() as (el: Element | null) => string
    const out = { checked: [] as string[], exempt: [] as string[], blocked: [] as string[] }
    for (const id of buttons as string[]) {
      const b = document.querySelector(`[data-testid="${id}"]`)
      if (!b) continue
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      if (hit && (b === hit || b.contains(hit))) { out.checked.push(id); continue }
      const ex = (exempt as Array<{ selector: string; why: string }>).find((e) => !!hit?.closest(e.selector))
      if (ex) { out.exempt.push(`${id} ← ${ex.why}`); continue }
      out.blocked.push(`${id} 가운데(${Math.round(x)},${Math.round(y)}) 를 가리키면 «${describe(hit)}» 가 잡힌다`)
    }
    return out
  }, [opts.buttons ?? TOPBAR_BUTTONS, TOPBAR_EXEMPT_LAYERS as unknown as Array<{ selector: string; why: string }>, DESCRIBE] as const)
  if (res.blocked.length || res.checked.length + res.exempt.length === 0) {
    await attachEvidence(page, opts.testInfo, `I4-${opts.label}`, { invariant: 'I4', ...res })
    throw new UiStabilityError(`[I4 탑바 접근성] ${opts.label}\n  - ${res.blocked.length ? res.blocked.join('\n  - ') : '탑바 버튼을 하나도 찾지 못했다'}`)
  }
  return { checked: res.checked, exempt: res.exempt }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I5 레이아웃 흔들림
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type Jitter = { samples: number; maxMove: number; maxResize: number; sumShift: number }

/** 연속 표본(같은 대상의 상자)에서 프레임 간 위치 · 크기 변화량. 기대 이동(expected)이 있으면 그만큼을 뺀 «남는 흔들림» 을 잰다. */
export function jitterOf(samples: Array<Rect | null>, expected?: Array<Pt | null>): Jitter {
  let maxMove = 0, maxResize = 0, sumShift = 0, n = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    if (!a || !b) continue
    n++
    const ex = expected ? { x: (expected[i]?.x ?? 0) - (expected[i - 1]?.x ?? 0), y: (expected[i]?.y ?? 0) - (expected[i - 1]?.y ?? 0) } : { x: 0, y: 0 }
    const mv = Math.hypot(b.x - a.x - ex.x, b.y - a.y - ex.y)
    const rs = Math.max(Math.abs(b.width - a.width), Math.abs(b.height - a.height))
    maxMove = Math.max(maxMove, mv)
    maxResize = Math.max(maxResize, rs)
    sumShift += mv
  }
  return { samples: n, maxMove, maxResize, sumShift }
}

export type JitterOpts = { label: string; testInfo: TestInfo; maxMove: number; maxResize: number; extra?: Record<string, unknown> }

/** I5 — 흔들림이 임계값 이하인지 판정한다(표본은 호출부가 실제 입력 걸음마다 모은다 — measureJitter 참조). */
export async function assertJitterWithin(page: Page, j: Jitter, opts: JitterOpts): Promise<void> {
  if (j.samples === 0) throw new UiStabilityError(`[I5 흔들림] ${opts.label} — 표본이 없다(대상을 한 번도 재지 못했다)`)
  if (j.maxMove > opts.maxMove || j.maxResize > opts.maxResize) {
    await attachEvidence(page, opts.testInfo, `I5-${opts.label}`, { invariant: 'I5', jitter: j, limit: { maxMove: opts.maxMove, maxResize: opts.maxResize }, ...opts.extra })
    throw new UiStabilityError(`[I5 흔들림] ${opts.label} — 최대 이동 ${j.maxMove.toFixed(1)}px(기준 ${opts.maxMove}) · 최대 크기 변화 ${j.maxResize.toFixed(1)}px(기준 ${opts.maxResize})`)
  }
}

/**
 * I5 표본 모으기 — drive(i) 로 실제 입력 한 걸음을 하고 나서 measure() 로 대상 상자를 잰다. 반환값을 jitterOf 에 넘긴다.
 */
export async function measureJitter(steps: number, drive: (i: number) => Promise<void>, measure: () => Promise<Rect | null>): Promise<Array<Rect | null>> {
  const out: Array<Rect | null> = [await measure()]
  for (let i = 1; i <= steps; i++) {
    await drive(i)
    out.push(await measure())
  }
  return out
}

/** 사각형 겹침 넓이(px²) — 칩끼리 겹침(I5 «칩 겹침») 판정용. */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I6 성능 예산
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type TimeToOpts = { label: string; testInfo: TestInfo; budgetMs: number; timeoutMs?: number }

/**
 * I6 — 실제 입력(누르기)부터 «첫 의미 있는 표시»(ready 선택자가 보임)까지 ms. 시작 시각은 페이지 안 pointerdown(캡처 단계)이고,
 * 끝 시각은 페이지 안 rAF 관찰이라 시험 쪽 폴링 간격이 섞이지 않는다. 예산을 넘으면 실패.
 */
export async function measureTimeTo(page: Page, act: () => Promise<void>, ready: string, opts: TimeToOpts): Promise<number> {
  const sel = surfaceSelector(ready)
  await page.evaluate((sel) => {
    const w = window as unknown as { __uistabTime?: { down: number | null; ready: number | null } }
    const st = { down: null as number | null, ready: null as number | null }
    w.__uistabTime = st
    addEventListener('pointerdown', () => { if (st.down === null) st.down = performance.now() }, { capture: true, once: true })
    const tick = () => {
      if (st.ready !== null) return
      const el = document.querySelector(sel as string)
      if (st.down !== null && el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { st.ready = performance.now(); return } }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, sel)
  await act()
  await page.waitForFunction(() => (window as unknown as { __uistabTime: { ready: number | null } }).__uistabTime.ready !== null, undefined, { polling: 'raf', timeout: opts.timeoutMs ?? 60_000 })
  const st = await page.evaluate(() => (window as unknown as { __uistabTime: { down: number; ready: number } }).__uistabTime)
  const ms = Math.round(st.ready - st.down)
  opts.testInfo.annotations.push({ type: 'I6', description: `${opts.label} ${ms}ms (예산 ${opts.budgetMs}ms)` })
  if (ms > opts.budgetMs) {
    await attachEvidence(page, opts.testInfo, `I6-${opts.label}`, { invariant: 'I6', ms, budgetMs: opts.budgetMs, ready: sel })
    throw new UiStabilityError(`[I6 성능 예산] ${opts.label} — 첫 표시까지 ${ms}ms(예산 ${opts.budgetMs}ms)`)
  }
  return ms
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I7 앵커 이동
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type AnchoredOpts = { label: string; testInfo: TestInfo; timeoutMs?: number }

/**
 * I7 — 「…열기 · 설정 열기 · 지금 고치기」 로 도착한 화면에서 대상 요소가 뷰포트 안(위아래 모두)에 있고, 포커스가 그 안에 있거나
 * 강조(애니메이션 · data-fix-flash · 강조 클래스)가 걸려 있다. 강조는 잠깐이라 timeoutMs 안에 한 번이라도 성립하면 통과.
 */
export async function assertAnchored(page: Page, target: string, opts: AnchoredOpts): Promise<void> {
  const sel = surfaceSelector(target)
  const probe = () => page.evaluate((sel) => {
    const el = document.querySelector(sel as string)
    if (!el) return { found: false, inView: false, focused: false, highlighted: false, rect: null as Rect | null, active: '' }
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight, vw = window.innerWidth
    const inView = r.height > 0 && r.top >= -1 && r.top < vh - 8 && r.left < vw && r.right > 0 && (r.bottom <= vh + 1 || r.height > vh * 0.6)
    const a = document.activeElement
    const focused = !!a && a !== document.body && (el === a || el.contains(a))
    const anims = typeof (el as HTMLElement).getAnimations === 'function' ? (el as HTMLElement).getAnimations({ subtree: true }).length : 0
    const highlighted = anims > 0 || el.hasAttribute('data-fix-flash') || /flash|highlight|landed/i.test(typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '')
    return { found: true, inView, focused, highlighted, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, active: a ? `${a.tagName.toLowerCase()}#${a.id}[${a.getAttribute('data-testid') ?? ''}]` : '' }
  }, sel)
  const deadline = Date.now() + (opts.timeoutMs ?? 4000)
  let last = await probe()
  while (!(last.found && last.inView && (last.focused || last.highlighted)) && Date.now() < deadline) {
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => r(true))), undefined, { polling: 'raf' })
    last = await probe()
  }
  if (!(last.found && last.inView && (last.focused || last.highlighted))) {
    await attachEvidence(page, opts.testInfo, `I7-${opts.label}`, { invariant: 'I7', target: sel, url: page.url(), probe: last })
    const why = !last.found ? '대상 요소가 없다' : !last.inView ? `대상이 뷰포트 밖(${JSON.stringify(last.rect)})` : `포커스 · 강조가 없다(포커스=${last.active || 'body'})`
    throw new UiStabilityError(`[I7 앵커 이동] ${opts.label} — ${why} · 도착 ${page.url()}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// I8 레이아웃 정렬
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type AlignedOpts = { label: string; testInfo: TestInfo; /** 허용 오차(px) — 기본 2. */ tolerancePx?: number }
export type AlignedSpec = {
  /** 본문 칸(스크롤 칸) 선택자 — 안쪽 여백을 뺀 내용 상자가 «열의 바깥» 이다. 첫 보이는 직속 자식이 본문 첫 덩어리(카드)다. */
  column: string
  /** 그 위 띠의 «내용» 선택자(예: 빌더 안내 줄 `bi-guide`) — 보이는 직속 자식들의 좌우 끝이 본문 첫 덩어리와 같아야 한다. 없으면 ①만 본다. */
  strip?: string
}

/**
 * I8 — 폼 화면의 열 정렬(C514 · 오너 신고 2026-10-15 「왼쪽으로 치우침」 · 「탑바 아래 배우기 진도 … 콘텐츠 영역 시작 위치에 맞춰서」).
 *   ① 가운데 정렬: 본문 첫 덩어리의 좌우 여백(칸 내용 상자 기준) 차가 허용 오차 이하.
 *   ② 같은 열: 위 띠 내용의 왼쪽 · 오른쪽 끝이 본문 첫 덩어리의 왼쪽 · 오른쪽 끝과 허용 오차 이하.
 * 레이아웃이 자리 잡은 뒤(연속 두 프레임 같은 값) 판정한다.
 */
export async function assertLayoutAligned(page: Page, spec: AlignedSpec, opts: AlignedOpts): Promise<void> {
  const tol = opts.tolerancePx ?? 2
  const probe = () => page.evaluate(([colSel, stripSel]) => {
    const col = document.querySelector(colSel as string) as HTMLElement | null
    if (!col) return null
    const cs = getComputedStyle(col); const c = col.getBoundingClientRect()
    const inL = c.left + parseFloat(cs.paddingLeft); const inR = c.right - parseFloat(cs.paddingRight)
    const block = [...col.children].find((k) => k.getBoundingClientRect().width > 0)
    if (!block) return null
    const b = block.getBoundingClientRect()
    let strip: { l: number; r: number } | null = null
    if (stripSel) {
      const st = document.querySelector(stripSel as string)
      const rs = st ? [...st.children].map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0) : []
      strip = rs.length ? { l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)) } : null
    }
    return { gapL: b.left - inL, gapR: inR - b.right, blockL: b.left, blockR: b.right, strip, viewport: window.innerWidth }
  }, [spec.column, spec.strip ?? ''] as const)
  let last = await probe()
  for (let i = 0; i < 20; i++) {
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
    const n = await probe()
    const same = JSON.stringify(n) === JSON.stringify(last)
    last = n
    if (same) break
  }
  const fails: string[] = []
  if (!last) fails.push(`본문 칸(${spec.column}) 또는 그 첫 덩어리가 없다`)
  else {
    if (Math.abs(last.gapL - last.gapR) > tol) fails.push(`① 가운데 정렬 — 좌우 여백 ${Math.round(last.gapL)} / ${Math.round(last.gapR)}px`)
    if (spec.strip) {
      if (!last.strip) fails.push(`② 띠 내용(${spec.strip})이 없다`)
      else {
        if (Math.abs(last.strip.l - last.blockL) > tol) fails.push(`② 같은 열 — 띠 내용 왼쪽 ${Math.round(last.strip.l)} · 본문 왼쪽 ${Math.round(last.blockL)}`)
        if (Math.abs(last.strip.r - last.blockR) > tol) fails.push(`② 같은 열 — 띠 내용 오른쪽 ${Math.round(last.strip.r)} · 본문 오른쪽 ${Math.round(last.blockR)}`)
      }
    }
  }
  opts.testInfo.annotations.push({ type: 'I8', description: `${opts.label} ${last ? JSON.stringify(last) : '(없음)'}` })
  if (fails.length) {
    await attachEvidence(page, opts.testInfo, `I8-${opts.label}`, { invariant: 'I8', spec, tolerancePx: tol, probe: last, url: page.url() })
    throw new UiStabilityError(`[I8 레이아웃 정렬] ${opts.label} — ${fails.join(' · ')}`)
  }
}

/** 포인터를 사람처럼 옮겨 누른다(page.mouse 여러 걸음 — dispatchEvent 를 쓰지 않는다). */
export async function humanClick(page: Page, target: Locator, opts: { steps?: number; button?: 'left' | 'right' } = {}): Promise<Rect> {
  await target.scrollIntoViewIfNeeded()
  // 미끄러져 들어오는 패널 안의 단추는 움직이는 중이다 — 두 프레임 간격으로 잰 상자가 같아질 때까지(최대 20회) 기다린 뒤 누른다.
  let b = (await target.boundingBox())!
  for (let i = 0; i < 20; i++) {
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
    const n = (await target.boundingBox())!
    const same = Math.abs(n.x - b.x) < 0.5 && Math.abs(n.y - b.y) < 0.5
    b = n
    if (same) break
  }
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: opts.steps ?? 6 })
  await page.mouse.down({ button: opts.button ?? 'left' })
  await page.mouse.up({ button: opts.button ?? 'left' })
  return rectOf(b)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2판 불변식(I9~I20) — 레지스트리 드라이버용 «깊은» 판정. 자동 탐색 계층(explore.ts)은 같은 판정을 전 화면에 얕게 돈다.
// I8(레이아웃 정렬)은 bib-guidealign 레인 몫이라 여기 없다.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** 지금 초점이 sel 안에 있는가 · 초점 요소 설명. */
async function focusIn(page: Page, sel: string): Promise<{ inside: boolean; active: string }> {
  return page.evaluate(([sel, DESCRIBE]) => {
    // eslint-disable-next-line no-new-func
    const describe = new Function(`${DESCRIBE}; return describe`)() as (el: Element | null) => string
    const s = document.querySelector(sel as string)
    const a = document.activeElement
    return { inside: !!s && !!a && a !== document.body && s.contains(a), active: describe(a) }
  }, [sel, DESCRIBE] as const)
}

export type FocusOpts = { label: string; testInfo: TestInfo; /** 모달이면 Tab 가둠까지 본다. */ modal?: boolean; tabs?: number }

/**
 * I9 초점 관리 — ① 연 직후 초점이 표면 안 ② (모달) Tab 을 여러 번 쳐도 표면 밖으로 새지 않음. 닫은 뒤 복귀는 assertFocusReturned.
 * 잡는 결함: 모달 · 서랍을 열어도 초점이 뒤 화면에 남아 키보드 사용자가 창을 조작할 수 없음, Tab 이 딤 뒤 화면으로 샘(결함 이력 U121 U176 U186).
 */
export async function assertFocusInside(page: Page, surface: string, opts: FocusOpts): Promise<void> {
  const sel = surfaceSelector(surface)
  await page.locator(sel).first().waitFor({ state: 'visible' })
  await settledBox(page, sel)
  const problems: string[] = []
  const f0 = await focusIn(page, sel)
  if (!f0.inside) problems.push(`열었는데 초점이 표면 밖이다(초점 ${f0.active})`)
  if (opts.modal) {
    for (let i = 0; i < (opts.tabs ?? 6); i++) {
      await page.keyboard.press('Tab')
      const f = await focusIn(page, sel)
      if (!f.inside) { problems.push(`Tab ${i + 1}번째에 초점이 모달 밖으로 샜다(초점 ${f.active})`); break }
    }
  }
  if (problems.length) {
    await attachEvidence(page, opts.testInfo, `I9-${opts.label}`, { invariant: 'I9', surface: sel, problems })
    throw new UiStabilityError(`[I9 초점 관리] ${opts.label}\n  - ${problems.join('\n  - ')}`)
  }
}

/** I9 — 닫은 뒤 초점이 연 단추(trigger)로 돌아왔다. */
export async function assertFocusReturned(page: Page, trigger: Locator, opts: { label: string; testInfo: TestInfo }): Promise<void> {
  const ok = await trigger.evaluate((t) => { const a = document.activeElement; return !!a && (a === t || t.contains(a)) }).catch(() => false)
  if (!ok) {
    const active = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}[${a.getAttribute('data-testid') ?? ''}]` : '(없음)' })
    await attachEvidence(page, opts.testInfo, `I9-${opts.label}`, { invariant: 'I9', active })
    throw new UiStabilityError(`[I9 초점 관리] ${opts.label} — 닫은 뒤 초점이 연 단추로 돌아오지 않았다(초점 ${active})`)
  }
}

/**
 * I10 Esc 계층 — layers 는 아래 → 위 순서로 떠 있는 표면들. Esc 한 번에 맨 위 하나만 닫히고 나머지는 남는다.
 * 잡는 결함: 미리보기 창 안 Esc 가 미리보기와 그 아래 목록 모달을 함께 닫음, Vue Teleport 순서로 확인창이 모달 아래에서 Esc 를 받음(U059 U125 U151).
 */
export async function assertEscClosesTopOnly(page: Page, layers: string[], opts: { label: string; testInfo: TestInfo }): Promise<void> {
  const sels = layers.map(surfaceSelector)
  for (const s of sels) await page.locator(s).first().waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  const top = sels[sels.length - 1]!
  await page.locator(top).first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
  const state = await page.evaluate((sels) => (sels as string[]).map((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }), sels)
  const problems: string[] = []
  if (state[state.length - 1]) problems.push(`맨 위 표면(${top})이 Esc 로 닫히지 않았다`)
  state.slice(0, -1).forEach((open, i) => { if (!open) problems.push(`아래 표면(${sels[i]})까지 닫혔다`) })
  if (problems.length) {
    await attachEvidence(page, opts.testInfo, `I10-${opts.label}`, { invariant: 'I10', layers: sels, open: state, problems })
    throw new UiStabilityError(`[I10 Esc 계층] ${opts.label}\n  - ${problems.join('\n  - ')}`)
  }
}

/**
 * I13 클릭 관통 없음 — 딤 · 오버레이의 (x, y)를 실제로 눌렀을 때 그 아래에 깔린 조작 요소가 반응하지 않는다.
 * 판정: elementsFromPoint 로 오버레이 아래 첫 조작 요소를 찾아 pointerdown · click 수신을 기록하고 page.mouse 로 누른다.
 * 잡는 결함: 가벼운 닫기 막이 첫 클릭을 삼키거나 반대로 통과시켜 뒤 버튼이 눌림(UX-03 · 1판 §6 한계).
 */
export async function assertNoClickThrough(page: Page, at: Pt, opts: { label: string; testInfo: TestInfo }): Promise<{ underneath: string | null }> {
  const under = await page.evaluate(([x, y, DESCRIBE]) => {
    // eslint-disable-next-line no-new-func
    const describe = new Function(`${DESCRIBE}; return describe`)() as (el: Element | null) => string
    const stack = document.elementsFromPoint(x as number, y as number)
    const top = stack[0]
    const INTER = 'button, a[href], [role=button], [role=menuitem], [role=tab], input, select, textarea'
    // 그 점에 쌓인 층 중 첫 조작 요소 — 오버레이가 포인터를 막으면 그 요소는 이벤트를 못 받고, 통과시키면(pointer-events:none) 맨 위가 곧 그 요소다.
    void top
    const target = stack.map((e) => e.closest(INTER)).find((e) => !!e) as HTMLElement | undefined
    const w = window as unknown as { __uistabThrough?: string[] }
    w.__uistabThrough = []
    if (target) for (const t of ['pointerdown', 'click']) target.addEventListener(t, () => w.__uistabThrough!.push(t), { capture: true })
    return target ? describe(target) : null
  }, [at.x, at.y, DESCRIBE] as const)
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await page.mouse.down(); await page.mouse.up()
  const got = await page.evaluate(() => (window as unknown as { __uistabThrough?: string[] }).__uistabThrough ?? [])
  if (got.length) {
    await attachEvidence(page, opts.testInfo, `I13-${opts.label}`, { invariant: 'I13', at, underneath: under, received: got })
    throw new UiStabilityError(`[I13 클릭 관통] ${opts.label} — 오버레이를 눌렀는데 아래 요소 «${under}» 가 ${got.join(' · ')} 를 받았다`)
  }
  return { underneath: under }
}

/**
 * I16 새로고침 · 딥링크 복원 — probe() 가 돌려준 상태 서명이 새로고침 뒤에도 같다(예: 활성 탭 · 선택 · 열린 서랍 · 앵커 착지).
 * 잡는 결함: 분할 비율 · 활성 탭 · 단계가 새로고침하면 처음으로 돌아감(U089 U188 · #720).
 */
export async function assertSurvivesReload(page: Page, probe: () => Promise<string>, opts: { label: string; testInfo: TestInfo }): Promise<void> {
  const before = await probe()
  await page.reload()
  let after = ''
  const deadline = Date.now() + 8000
  do { after = await probe().catch(() => ''); if (after === before) break; await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => r(true)))) } while (Date.now() < deadline)
  if (after !== before) {
    await attachEvidence(page, opts.testInfo, `I16-${opts.label}`, { invariant: 'I16', before, after, url: page.url() })
    throw new UiStabilityError(`[I16 새로고침 복원] ${opts.label} — 새로고침 전 «${before}» · 뒤 «${after}»`)
  }
}

/**
 * I18 끌기 잔여물 없음 — 끌기를 마치거나 Esc 로 취소한 뒤 고스트 · 삽입 막대 · 끌기 표지 · 문서 user-select:none · grabbing 커서가 남지 않는다.
 * frames: iframe 안 편집기(칩)는 그 프레임도 본다. 잡는 결함: 끌기 상태 서랍 투명 잔류 · body user-select 상속(드랍 멈칫 PR #254).
 */
export const DRAG_RESIDUE_SELECTORS = ['[data-chip-ghost]', '[data-drag-ghost]', '[data-dragging="true"]', '[data-drop-indicator]', '.dragGhost', '.dropIndicator'] as const
export async function assertNoDragResidue(page: Page, opts: { label: string; testInfo: TestInfo; frames?: import('@playwright/test').Frame[]; extra?: string[] }): Promise<void> {
  const sels = [...DRAG_RESIDUE_SELECTORS, ...(opts.extra ?? [])]
  const check = (sels: string[]) => {
    const left = sels.flatMap((s) => [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none' }).map(() => s))
    const bs = getComputedStyle(document.body)
    const us = (bs as unknown as { userSelect?: string; webkitUserSelect?: string }).userSelect || (bs as unknown as { webkitUserSelect?: string }).webkitUserSelect
    if (us === 'none') left.push('body user-select:none')
    if (/grabbing/.test(bs.cursor) || /grabbing/.test(getComputedStyle(document.documentElement).cursor)) left.push('grabbing 커서')
    return left
  }
  const deadline = Date.now() + 1500
  let left: string[] = []
  do {
    left = await page.evaluate(check, sels)
    for (const f of opts.frames ?? []) left.push(...(await f.evaluate(check, sels).catch(() => [])).map((x) => `iframe: ${x}`))
    if (!left.length) return
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => r(true))))
  } while (Date.now() < deadline)
  await attachEvidence(page, opts.testInfo, `I18-${opts.label}`, { invariant: 'I18', left })
  throw new UiStabilityError(`[I18 끌기 잔여물] ${opts.label} — 끝난 뒤에도 남았다: ${[...new Set(left)].join(' · ')}`)
}

/**
 * I12 가로 넘침 없음 — 폭마다 문서 가로 스크롤이 없다(넘친 만큼 · 가장 오른쪽 요소를 근거로 남긴다).
 * 잡는 결함: 390 폭 글자 세로 쏟아짐 · 고정 레이아웃이 화면 밖으로 나감(U003 U073 U081).
 */
export async function assertNoHorizontalOverflow(page: Page, opts: { label: string; testInfo: TestInfo }): Promise<void> {
  const r = await page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement
    const over = se.scrollWidth - se.clientWidth
    let worst = '', wr = 0
    if (over > 1) for (const e of document.body.querySelectorAll('*')) { const b = e.getBoundingClientRect(); if (b.right > wr && getComputedStyle(e).position !== 'fixed') { wr = b.right; worst = `${e.tagName.toLowerCase()}[${e.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}]` } }
    return { over, worst, wr: Math.round(wr), vw: se.clientWidth }
  })
  if (r.over > 1) {
    await attachEvidence(page, opts.testInfo, `I12-${opts.label}`, { invariant: 'I12', ...r })
    throw new UiStabilityError(`[I12 가로 넘침] ${opts.label} — 문서가 가로로 ${r.over}px 넘친다(가장 오른쪽 ${r.worst} right ${r.wr} / ${r.vw})`)
  }
}

/** I14 · I15 감시 — 드라이버가 상호작용 구간을 감싸 쓴다. known: 알려진 예외 정규식(known-console.json 과 같은 규칙). */
export function watchConsoleAndRequests(page: Page, known: RegExp[] = []): { stop: () => { errors: string[]; dup: Array<[string, number]> } } {
  const errors: string[] = []
  const reqs = new Map<string, number>()
  const onC = (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !known.some((k) => k.test(m.text()))) errors.push(m.text().slice(0, 300)) }
  const onE = (e: Error) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`)
  const onR = (r: import('@playwright/test').Request) => { if (['fetch', 'xhr'].includes(r.resourceType())) { const u = new URL(r.url()); const k = `${r.method()} ${u.pathname}${u.search}`; reqs.set(k, (reqs.get(k) ?? 0) + 1) } }
  page.on('console', onC); page.on('pageerror', onE); page.on('request', onR)
  return { stop: () => { page.off('console', onC); page.off('pageerror', onE); page.off('request', onR); return { errors, dup: [...reqs].filter(([, n]) => n > 3) } } }
}

/** I14 · I15 판정 — watch 결과에서 콘솔 오류 0 · 같은 요청 상한(3) 이하. */
export async function assertQuiet(page: Page, w: { errors: string[]; dup: Array<[string, number]> }, opts: { label: string; testInfo: TestInfo; dupMax?: number }): Promise<void> {
  const dup = w.dup.filter(([, n]) => n > (opts.dupMax ?? 3))
  if (w.errors.length || dup.length) {
    await attachEvidence(page, opts.testInfo, `I14-${opts.label}`, { invariant: 'I14/I15', errors: w.errors, dup })
    throw new UiStabilityError(`[I14 콘솔 · I15 요청] ${opts.label}\n  - ${[...w.errors.map((e) => `콘솔: ${e}`), ...dup.map(([k, n]) => `요청 반복: ${k} × ${n}`)].join('\n  - ')}`)
  }
}

export type TransitionReport = { frames: number; blankFrames: number; minAreaRatio: number; cls: number; valueFrames: string[]; settledMs: number; jolt: number }

/**
 * I20 전환 깜빡임 · 레이아웃 이동 — act() 동안 페이지 안 rAF 샘플러 · layout-shift 관찰자 · 글자 표본으로
 * ① 빈 프레임(보이는 자식 면적이 직전의 10% 미만으로 떨어졌다가 50% 이상으로 돌아옴) ② CLS(입력 없는 이동 합) > 0.05 ③ 값 프레임(undefined · NaN · null)
 * 을 판정한다. delayMs 를 주면 /query · /aggregate · /tabs 응답을 늦추고(로컬 100ms 응답으로는 안 보인다), cpu 를 주면 CDP 로 CPU 를 느리게 한다.
 * 같은 자리 · 같은 크기의 스켈레톤(aria-busy) · 반투명 스크림은 빈 프레임이 아니다. 의도된 애니메이션은 prefers-reduced-motion 으로 끈다.
 * 잡는 결함: 엔드포인트 전환 블랭크 · 사이드바 주기 깜빡임 · 2↔4분할 잔상(U024~U026 U033 U034 U036 U037 …).
 */
export async function measureTransition(page: Page, act: () => Promise<void>, content: string, opts: { label: string; testInfo: TestInfo; delayMs?: number; cpu?: number; routes?: RegExp; maxCls?: number }): Promise<TransitionReport> {
  const sel = surfaceSelector(content)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const pattern = opts.routes ?? /\/api\/(query|aggregate|endpoints\/[^/]+\/(rows|query)|tabs)/
  const handler = async (route: import('@playwright/test').Route) => { await new Promise((r) => setTimeout(r, opts.delayMs ?? 0)); await route.continue().catch(() => undefined) }
  if (opts.delayMs) await page.route(pattern, handler)
  const cdp = opts.cpu ? await page.context().newCDPSession(page) : null
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu! })
  try {
    await page.evaluate((sel) => {
      const w = window as unknown as { __uistabTr?: unknown }
      const st = { frames: 0, areas: [] as number[], texts: [] as string[], cls: 0, start: performance.now(), stable: 0, last: '', done: false, settledAt: 0, jolt: 0, top0: null as number | null }
      w.__uistabTr = st
      const shifts: Array<{ t: number; value: number; nodes: string[] }> = []
      ;(st as unknown as { shifts: typeof shifts }).shifts = shifts
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; startTime: number; sources?: Array<{ node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> }>) {
            if (e.hadRecentInput) continue
            st.cls += e.value
            // 움직인 요소(근거) — testid · 클래스 앞부분 · 이전→이후 상자
            shifts.push({ t: Math.round(e.startTime - st.start), value: Number(e.value.toFixed(4)), nodes: (e.sources ?? []).slice(0, 4).map((s) => { const n = s.node as Element | null; const el = n && n.nodeType === 1 ? n : n?.parentElement ?? null; const tid = el?.closest('[data-testid]')?.getAttribute('data-testid') ?? ''; const cls = el && typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''; return `${el?.tagName.toLowerCase() ?? '?'}[${tid}]${cls ? '.' + cls : ''} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}` }) })
          }
        }).observe({ type: 'layout-shift', buffered: false })
      } catch { /* 미지원 */ }
      const area = () => {
        const root = document.querySelector(sel as string)
        if (!root) return 0
        let a = 0
        for (const c of root.querySelectorAll('*')) {
          if (c.children.length) continue
          const r = c.getBoundingClientRect()
          if (r.width < 1 || r.height < 1) continue
          const cs = getComputedStyle(c)
          if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
          a += r.width * r.height
        }
        return a
      }
      const tick = () => {
        if (st.done) return
        const root = document.querySelector(sel as string)
        const a = area()
        st.frames++; st.areas.push(a)
        const txt = root ? (root as HTMLElement).innerText.slice(0, 4000) : ''
        const m = /(^|[^A-Za-z])(undefined|NaN)(?![A-Za-z])|\bnull\b(?=\s*$)/m.exec(txt)
        if (m) st.texts.push(m[0].trim())
        const rr = root?.getBoundingClientRect()
        if (rr) { if (st.top0 === null) st.top0 = rr.top; st.jolt = Math.max(st.jolt, Math.abs(rr.top - st.top0)) }
        const key = `${Math.round(a / 50)}|${txt.length}`
        st.stable = key === st.last ? st.stable + 1 : 0
        st.last = key
        // 안정 = 10프레임 무변화 + 300ms 경과 + 처음 면적의 절반 이상으로 돌아옴(빈 화면으로 «안정» 된 로딩 중에는 멈추지 않는다). 최대 3초.
        const a0 = st.areas[0] ?? 0
        if ((st.stable >= 10 && performance.now() - st.start > 300 && (a0 === 0 || a >= 0.5 * a0)) || performance.now() - st.start > 3000) { st.done = true; st.settledAt = performance.now() - st.start; return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, sel)
    await act()
    await page.waitForFunction(() => (window as unknown as { __uistabTr: { done: boolean } }).__uistabTr.done, undefined, { timeout: 30_000, polling: 'raf' })
    const st = await page.evaluate(() => (window as unknown as { __uistabTr: { frames: number; areas: number[]; texts: string[]; cls: number; settledAt: number; jolt: number; shifts: unknown[] } }).__uistabTr)
    const a0 = st.areas[0] ?? 0
    let blank = 0, minRatio = 1
    for (let i = 1; i < st.areas.length; i++) {
      const r = a0 > 0 ? st.areas[i]! / a0 : 1
      minRatio = Math.min(minRatio, r)
      if (a0 > 0 && r < 0.1) blank++
    }
    const final = a0 > 0 ? (st.areas[st.areas.length - 1] ?? 0) / a0 : 1
    const rep: TransitionReport = { frames: st.frames, blankFrames: final >= 0.5 ? blank : 0, minAreaRatio: Number(minRatio.toFixed(3)), cls: Number(st.cls.toFixed(4)), valueFrames: [...new Set(st.texts)], settledMs: Math.round(st.settledAt), jolt: Math.round(st.jolt) }
    opts.testInfo.annotations.push({ type: 'I20', description: `${opts.label} ${JSON.stringify(rep)}` })
    const problems: string[] = []
    if (rep.blankFrames > 0) problems.push(`빈 프레임 ${rep.blankFrames}개(보이는 면적이 직전의 ${(rep.minAreaRatio * 100).toFixed(1)}% 까지 떨어졌다가 돌아옴)`)
    if (rep.cls > (opts.maxCls ?? 0.05)) problems.push(`레이아웃 이동 CLS ${rep.cls}(기준 ${opts.maxCls ?? 0.05})`)
    if (rep.valueFrames.length) problems.push(`값 프레임: ${rep.valueFrames.join(' · ')}`)
    if (problems.length) {
      await attachEvidence(page, opts.testInfo, `I20-${opts.label}`, { invariant: 'I20', content: sel, ...rep, shifts: st.shifts, areas: st.areas.slice(0, 200) })
      throw new UiStabilityError(`[I20 전환 깜빡임] ${opts.label}\n  - ${problems.join('\n  - ')}`)
    }
    return rep
  } finally {
    if (cdp) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined); await cdp.detach().catch(() => undefined) }
    if (opts.delayMs) await page.unroute(pattern, handler)
    await page.emulateMedia({ reducedMotion: null })
  }
}
