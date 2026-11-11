// UI 안정성 자동 탐색 — 브라우저 안에서 도는 판정 묶음. explore.ts 가 이 파일을 «글자 그대로» page.evaluate 로 심는다
// (Playwright 의 함수 직렬화 · 번들러 이름 보존 도우미가 끼지 않게 순수 JS 로 둔다). 프로젝트 고유 값은 없다 — 전역 스킬 템플릿과 같은 본.
//
// window.__uistabLib = { scan, prepClick, afterClick, focusInfo, surfaces, anchorProbe, truncatedHoverTargets, docOverflow,
//                        stagedScan(I38~I41) · clsProbe(I42) · focusProbe(I43) · stateProbe(I45) · visualMask(I47) }
//
// 판정은 «화면에서 보이는 결과» 로 한다 — elementFromPoint · 계산된 색 · 상자. 입력은 하지 않는다(입력은 Node 쪽 page.mouse).
(() => {
  if (window.__uistabLib && window.__uistabLib.version === 4) return
  // 프로젝트 고유 선택자는 설정으로 받는다(explore.ts 가 심기 전에 window.__uistabConfig 에 넣는다 — 어댑터 project.config.json).
  //   popoverSelectors: 떠 있는 패널 클래스 · modalOverlaySelectors: 모달 딤(창 바깥) · tooltipSelectors: 툴팁 · choiceGroupSelectors: 즉시 적용 선택 묶음
  const CFG = window.__uistabConfig || {}
  const POPOVER = (CFG.popoverSelectors || []).join(', ')
  const OVERLAY = (CFG.modalOverlaySelectors || []).join(', ')
  const isOverlay = (s) => !!OVERLAY && s.matches(OVERLAY)
  const isPopover = (s) => !!POPOVER && s.matches(POPOVER)
  const INTERACTIVE = 'button, a[href], [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=link], [role=switch], [role=checkbox], [role=radio], [role=combobox], [role=option], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'
  const SURFACE = ['[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [aria-modal="true"]', POPOVER, OVERLAY].filter(Boolean).join(', ')
  const NAME_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'checkbox', 'radio', 'combobox', 'option', 'textbox', 'listbox', 'searchbox', 'slider', 'spinbutton'])

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  /** 매번 달라지는 조각(숫자 · uuid · 해시)을 * 로 — 같은 컴포넌트의 반복을 한 묶음으로 센다. */
  const generic = (s) => String(s || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
    .replace(/\b[a-z]+-\d{6,}-[a-z0-9]+\b/gi, '*')
    .replace(/\d+/g, '#')
  /** CSS 모듈 클래스(_card_x1y2z · card__abc12)에서 해시를 뗀 뿌리 이름. */
  const classRoot = (el) => {
    const c = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean)[0] || '' : ''
    return c.replace(/^_/, '').replace(/_[A-Za-z0-9-]{4,}$/, '').replace(/__?[A-Za-z0-9-]{5,}$/, '')
  }
  const testidOf = (el) => (el.getAttribute && el.getAttribute('data-testid')) || ''
  const nearestTestid = (el) => { const t = el.closest && el.closest('[data-testid]'); return t ? t.getAttribute('data-testid') : '' }
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r
    const t = el.tagName.toLowerCase()
    if (t === 'a') return 'link'
    if (t === 'button') return 'button'
    if (t === 'select') return 'combobox'
    if (t === 'textarea') return 'textbox'
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ty === 'range' ? 'slider' : ty === 'number' ? 'spinbutton' : ['button', 'submit', 'reset', 'image'].includes(ty) ? 'button' : ty === 'search' ? 'searchbox' : 'textbox' }
    return ''
  }
  function describe(el) {
    if (!el) return '(없음)'
    const tid = nearestTestid(el)
    const role = el.getAttribute && el.getAttribute('role')
    const cls = classRoot(el)
    return [el.tagName.toLowerCase(), tid && ('testid=' + tid), role && ('role=' + role), cls && ('.' + cls)].filter(Boolean).join(' ')
  }
  /** 접근성 이름(근사 — accname 1.2 의 흔한 경로만). */
  function accName(el) {
    const lb = el.getAttribute('aria-labelledby')
    if (lb) { const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : '' }).join(' '); if (norm(t)) return norm(t) }
    const al = el.getAttribute('aria-label'); if (norm(al)) return norm(al)
    const t = el.tagName.toLowerCase()
    if (t === 'input' || t === 'select' || t === 'textarea') {
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && norm(l.textContent)) return norm(l.textContent) }
      const wrap = el.closest('label'); if (wrap && norm(wrap.textContent)) return norm(wrap.textContent)
      const ty = (el.getAttribute('type') || '').toLowerCase()
      if (['button', 'submit', 'reset'].includes(ty) && norm(el.value)) return norm(el.value)
      if (el.getAttribute('title')) return norm(el.getAttribute('title'))
      if (el.getAttribute('placeholder')) return norm(el.getAttribute('placeholder'))
      return ''
    }
    // 내용 — 숨은(aria-hidden) 자손은 뺀다. 그림은 alt.
    let s = ''
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.textContent
        else if (c.nodeType === 1) {
          if (c.getAttribute('aria-hidden') === 'true') continue
          const cs = getComputedStyle(c); if (cs.display === 'none' || cs.visibility === 'hidden') continue
          if (c.tagName === 'IMG') s += ' ' + (c.getAttribute('alt') || '')
          else if (c.tagName === 'svg' || c.tagName === 'SVG') { const ti = c.querySelector('title'); s += ' ' + (c.getAttribute('aria-label') || (ti ? ti.textContent : '')) }
          else walk(c)
        }
      }
    }
    walk(el)
    if (norm(s)) return norm(s)
    if (el.getAttribute('title')) return norm(el.getAttribute('title'))
    return ''
  }
  const visibleStyle = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
      if (Number(cs.opacity) === 0) return false
      if (e.hasAttribute('inert')) return false
    }
    return true
  }
  /** 조상 overflow 가 잘라 낸 뒤 «실제로 보이는» 상자(뷰포트 포함). */
  function visibleRect(el) {
    const r = el.getBoundingClientRect()
    let L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, innerWidth), B = Math.min(r.bottom, innerHeight)
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.position === 'fixed') { /* fixed 조상 위로는 문서 스크롤 잘림이 없다 */ }
      if (/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) {
        const ar = a.getBoundingClientRect()
        // 스크롤 막대 자리는 뺀다(client 상자) — 막대 위 점은 스크롤 상자 자신이 잡힌다.
        const cl = ar.left + a.clientLeft, ct = ar.top + a.clientTop
        if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) { L = Math.max(L, cl); R = Math.min(R, cl + a.clientWidth) }
        if (/(hidden|clip|auto|scroll)/.test(cs.overflowY)) { T = Math.max(T, ct); B = Math.min(B, ct + a.clientHeight) }
      }
      if (cs.position === 'fixed') break
    }
    return { r, vis: { x: L, y: T, width: Math.max(0, R - L), height: Math.max(0, B - T) } }
  }
  const ownsHit = (el, hit) => {
    if (!hit) return false
    if (el === hit || el.contains(hit)) return true
    // 레이블이 입력을 대신 받는 경우(숨긴 체크박스 위 레이블)
    const lab = hit.closest && hit.closest('label')
    if (lab && (lab.control === el || lab.contains(el))) return true
    // 캔버스 그리드 — 그림은 canvas 에 그리고 입력은 그 위 투명한 스크롤 상자가 받는다(가상 스크롤 그리드의 정상 구조).
    // 가까운 공통 조상(3단 안) 아래의 투명한 스크롤 상자가 잡히면 캔버스 자신으로 본다(2026-10-17, 스튜디오 그리드 오탐).
    if (el.tagName === 'CANVAS') {
      const cs = getComputedStyle(hit)
      const scroller = /(auto|scroll)/.test(cs.overflowX + cs.overflowY) && alphaOf(cs.backgroundColor) === 0
      let a = el.parentElement
      for (let i = 0; scroller && a && i < 3; i++, a = a.parentElement) if (a.contains(hit)) return true
    }
    // 같은 단추의 일부로 그려진 형제(배지 등)는 단추가 품는다고 보지 않는다 — 실제로 가린 것이다.
    return false
  }
  /** 점 5개(가운데 + 안쪽 2px 모서리)에서 누가 잡히는가. 보이는 넓이가 원래의 60% 미만이면 가운데만. */
  function hitPoints(el, vis, full) {
    const pts = []
    const cx = vis.x + vis.width / 2, cy = vis.y + vis.height / 2
    pts.push(['가운데', cx, cy])
    const partial = vis.width * vis.height < 0.6 * full.width * full.height
    if (!partial && vis.width >= 10 && vis.height >= 10) {
      // 둥근 모서리(원형 단추 등)는 상자 모서리가 모양 밖이다 — 반지름의 0.35 + 2px 안쪽을 찍는다(원이면 모양 안).
      let br = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
      // 둥근 모서리로 자르는 조상(overflow + border-radius)의 모서리에 요소가 닿아 있으면 그 반지름도 본다(표 마지막 행의 모서리).
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (!/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) continue
        const ar = parseFloat(cs.borderBottomRightRadius) || parseFloat(cs.borderTopLeftRadius) || 0
        if (!ar) continue
        const b = a.getBoundingClientRect()
        const touches = (Math.abs(vis.x - b.left) < 3 || Math.abs(vis.x + vis.width - b.right) < 3) && (Math.abs(vis.y - b.top) < 3 || Math.abs(vis.y + vis.height - b.bottom) < 3)
        if (touches) br = Math.max(br, ar)
      }
      const i = Math.min(2 + 0.35 * Math.min(br, vis.width / 2, vis.height / 2), vis.width / 2 - 1, vis.height / 2 - 1)
      pts.push(['왼쪽 위', vis.x + i, vis.y + i], ['오른쪽 위', vis.x + vis.width - i, vis.y + i], ['왼쪽 아래', vis.x + i, vis.y + vis.height - i], ['오른쪽 아래', vis.x + vis.width - i, vis.y + vis.height - i])
    }
    return pts.map(([n, x, y]) => { const h = document.elementFromPoint(x, y); return { n, x: Math.round(x), y: Math.round(y), own: ownsHit(el, h), hit: h } })
  }

  // ── 색 · 대비 ─────────────────────────────────────────────────────────────────────────────────
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx2 = cv.getContext('2d', { willReadFrequently: true })
  function paint(colors) {
    cx2.clearRect(0, 0, 1, 1)
    cx2.globalCompositeOperation = 'source-over'
    cx2.fillStyle = '#fff'; cx2.fillRect(0, 0, 1, 1)
    for (const c of colors) { cx2.fillStyle = '#000'; cx2.fillStyle = c; cx2.fillRect(0, 0, 1, 1) }
    const d = cx2.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const alphaOf = (c) => { cx2.fillStyle = 'rgba(0,0,0,0)'; cx2.fillStyle = c; const s = cx2.fillStyle; const m = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(s); return m ? Number(m[1]) : (s === 'transparent' ? 0 : 1) }
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  /** 글자 색 대비 — 배경 사슬(뿌리 → 가까운 조상) 색을 겹쳐 칠한 뒤 글자 색을 얹어 비교. 배경 그림 · 그라데이션이면 판정 불가(null). */
  /** 배경 사슬(뿌리 → 가까운 조상) — 배경 그림이면 null. 떠 있는(fixed · sticky) 층에 닿으면 그 층을 돌려준다. */
  function bgChain(node, stopAtOverlay) {
    const chain = []
    for (let e = node; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.backgroundImage && s.backgroundImage !== 'none') return null
      if (alphaOf(s.backgroundColor) > 0) chain.unshift(s.backgroundColor)
      if (alphaOf(s.backgroundColor) >= 1) return { chain, overlay: null }
      if (stopAtOverlay && (s.position === 'fixed' || s.position === 'sticky')) return { chain, overlay: e }
    }
    return { chain, overlay: null }
  }
  function contrastOf(node) {
    const cs = getComputedStyle(node)
    const own = bgChain(node, true)
    if (!own) return null
    let chain = own.chain
    // 떠 있는(fixed · sticky) 반투명 층 아래는 조상이 아니라 그 자리에 그려진 다른 요소(사진 · 무대)가 비친다.
    // 그 점에서 층 밖의 맨 위 요소를 찾아 그 배경 사슬 위에 층의 사슬을 얹는다. 그 아래가 배경 그림이면 판정하지 않는다.
    if (own.overlay) {
      const r = node.getBoundingClientRect()
      const under = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).find((e) => !own.overlay.contains(e))
      if (!under) return null
      const back = bgChain(under, false)
      if (!back) return null
      chain = [...back.chain, ...chain]
    }
    const rootBg = getComputedStyle(document.body).backgroundColor
    if (chain.length === 0 || alphaOf(chain[0]) < 1) chain.unshift(alphaOf(rootBg) > 0 ? rootBg : getComputedStyle(document.documentElement).backgroundColor || '#fff')
    const bg = paint(chain)
    const fg = paint([...chain, cs.color])
    const size = parseFloat(cs.fontSize)
    const bold = Number(cs.fontWeight) >= 700
    const large = size >= 24 || (bold && size >= 18.66)
    return { ratio: ratio(fg, bg), need: large ? 3 : 4.5, fg: 'rgb(' + fg.join(',') + ')', bg: 'rgb(' + bg.join(',') + ')' }
  }
  /** 글자를 직접 가진 첫 노드(자신 또는 자손). */
  /** 화면에 실제로 그려지는 글자 상자인가 — 시각 숨김(sr-only: 1px 상자 · clip · clip-path)은 대비 대상이 아니다. */
  const paintsText = (e) => {
    const r = e.getBoundingClientRect()
    if (r.width <= 2 || r.height <= 2) return false
    const cs = getComputedStyle(e)
    if (/rect\(0/.test(cs.clip) || /inset\(50%/.test(cs.clipPath)) return false
    return visibleStyle(e)
  }
  function textNodeHost(el) {
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && norm(c.textContent))
    if (own && paintsText(el)) return el
    const it = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = it.nextNode())) { if (norm(n.textContent) && n.parentElement && paintsText(n.parentElement)) return n.parentElement }
    return null
  }

  // ── 잘림(말줄임) ──────────────────────────────────────────────────────────────────────────────
  function truncatedIn(el) {
    const out = []
    const cands = [el, ...el.querySelectorAll('*')].slice(0, 30)
    for (const n of cands) {
      if (!n.textContent || !norm(n.textContent)) continue
      const cs = getComputedStyle(n)
      const clampX = (cs.textOverflow === 'ellipsis' || /hidden|clip/.test(cs.overflowX)) && n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0
      const clampY = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && n.scrollHeight > n.clientHeight + 1
      if (clampX || clampY) out.push(n)
    }
    return out
  }
  /** 말줄임 글자의 전체를 알려 주는 정적 단서 — title · aria-label · aria-describedby(자신 ~ 조상 3단계 · 대상 요소). */
  function hasStaticTip(node, el) {
    const full = norm(node.textContent)
    for (let e = node, i = 0; e && i < 6; e = e.parentElement, i++) {
      const t = e.getAttribute && (e.getAttribute('title') || e.getAttribute('data-tooltip') || e.getAttribute('data-tip'))
      if (t && norm(t).length >= Math.min(full.length, 4)) return true
      const al = e.getAttribute && e.getAttribute('aria-label'); if (al && norm(al).length >= full.length - 1) return true
      if (e.getAttribute && e.getAttribute('aria-describedby')) return true
      if (e === el) { /* 대상 요소까지 올라왔으면 2단계만 더 */ i = Math.max(i, 4) }
    }
    return false
  }

  // ── 요소 열쇠 ─────────────────────────────────────────────────────────────────────────────────
  function keyOf(el) {
    const tid = testidOf(el)
    const role = roleOf(el)
    const name = generic(accName(el)).slice(0, 40)
    const anc = tid ? '' : generic(nearestTestid(el.parentElement || el))
    return [generic(tid), el.tagName.toLowerCase(), role, name, anc].join('|')
  }
  /** 같은 컴포넌트의 반복을 하나로 묶는 열쇠 — testid(일반화) 또는 가까운 testid 조상 + 클래스 뿌리. */
  function compOf(el) {
    const tid = testidOf(el)
    if (tid) return generic(tid)
    return generic(nearestTestid(el)) + '>' + el.tagName.toLowerCase() + (classRoot(el) ? '.' + classRoot(el) : '')
  }

  const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'
  /** 문서 가로 넘침 — 넘친 만큼과 가장 오른쪽으로 삐져나간 요소. */
  function docOverflow() {
    const se = document.scrollingElement || document.documentElement
    const over = se.scrollWidth - se.clientWidth
    if (over <= 1) return null
    let worst = null, wr = 0
    for (const e of document.body.querySelectorAll('*')) {
      const r = e.getBoundingClientRect()
      if (r.right > wr && r.width > 0) { const cs = getComputedStyle(e); if (cs.position !== 'fixed') { wr = r.right; worst = e } }
    }
    return { over, worst: describe(worst), worstComp: worst ? compOf(worst) : '', right: Math.round(wr), vw: se.clientWidth }
  }

  /** 스크롤 상태를 저장 · 복원(요소마다 scrollIntoView 로 옮긴 뒤 되돌린다). */
  function saveScroll() {
    const list = []
    for (const e of [document.scrollingElement, ...document.querySelectorAll('*')]) { if (e && (e.scrollTop || e.scrollLeft)) list.push([e, e.scrollTop, e.scrollLeft]) }
    return () => { for (const [e, t, l] of list) { e.scrollTop = t; e.scrollLeft = l } }
  }

  /**
   * 화면 훑기 — 상호작용 요소를 모두 모아 요소마다 I1 · I11 · I12 · I17 · 이름 · 링크 대상을 본다.
   * opts: { scope?: CSS, routes: string[](정규식 원문), max: number, checkContrast: boolean }
   */
  function scan(opts) {
    const root = opts.scope ? document.querySelector(opts.scope) : document.body
    if (!root) return { error: '범위 요소 없음: ' + opts.scope, elements: [], hidden: 0 }
    const routeRes = (opts.routes || []).map((r) => new RegExp(r))
    const all = [...root.querySelectorAll(INTERACTIVE)]
    const restore = saveScroll()
    const elements = []
    let hidden = 0, capped = 0
    for (const el of all) {
      const r0 = el.getBoundingClientRect()
      if (r0.width < 1 || r0.height < 1 || !visibleStyle(el)) { hidden++; continue }
      if (elements.length >= (opts.max || 600)) { capped++; continue }
      const role = roleOf(el)
      const tag = el.tagName.toLowerCase()
      const rec = { key: keyOf(el), comp: compOf(el), tag, role, name: accName(el).slice(0, 80), testid: testidOf(el), checked: [], v: [] }
      // I1 — 요소를 가운데로 옮겨(즉시) 보이는 상자에서 점 5개
      const inView = r0.top >= 0 && r0.bottom <= innerHeight && r0.left >= 0 && r0.right <= innerWidth
      if (!inView) { try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch (e) { el.scrollIntoView() } }
      const { r, vis } = visibleRect(el)
      // 화면 밖에 숨겨 두었다가 초점을 받을 때만 나타나는 요소(본문 건너뛰기 링크 · 시각 숨김)는 가려진 것이 아니라 숨은 것이다.
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || (r.width <= 1 && r.height <= 1)) { hidden++; continue }
      // 조상이 잘라 보이는 넓이가 0 인 요소(접힌 아코디언 · 높이 0 영역 안)는 «숨은 요소» 다 — 가림이 아니다. 열린 목록이 잘리는 것은 I22 가 본다.
      if (vis.width < 2 || vis.height < 2) { hidden++; continue }
      if (vis.width >= 2 && vis.height >= 2 && getComputedStyle(el).pointerEvents !== 'none') {
        const pts = hitPoints(el, vis, r)
        rec.checked.push('I1')
        // 복합 컨트롤 — 같은 부모(또는 조부모) 안의 다른 조작 요소가 모서리를 덮는 것(입력 칸 안 증감 단추 · 지우기 단추)은 설계다.
        const sameControl = (h) => !!h && h.closest && !!h.closest(INTERACTIVE) && (el.parentElement && el.parentElement.contains(h) || (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.contains(h) && el.parentElement.parentElement.querySelectorAll(INTERACTIVE).length <= 4))
        const bad = pts.filter((p) => !p.own && !(p.n !== '가운데' && sameControl(p.hit)))
        if (bad.length) {
          const coverer = bad[0].hit
          rec.v.push({ inv: 'I1', kind: bad.length === pts.length ? '가려짐' : '일부 가려짐', detail: bad.map((p) => p.n + '(' + p.x + ',' + p.y + ')→' + describe(p.hit)).join(' · '), by: coverer ? compOf(coverer) : '(없음)' })
        }
      }
      // I12 — 요소가 뷰포트 가로 밖으로 나감(가로 스크롤 상자 안은 제외)
      rec.checked.push('I12')
      const r2 = el.getBoundingClientRect()
      if (r2.right > innerWidth + 1 || r2.left < -1) {
        let inHScroll = false
        for (let a = el.parentElement; a; a = a.parentElement) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) { inHScroll = true; break } }
        if (!inHScroll) rec.v.push({ inv: 'I12', kind: '뷰포트 가로 밖', detail: 'left ' + Math.round(r2.left) + ' · right ' + Math.round(r2.right) + ' / ' + innerWidth, by: '' })
      }
      // I11 — 말줄임에는 전체를 보여 주는 단서(정적: title · aria-label · describedby). 정적 단서가 없으면 Node 쪽이 실제 호버로 다시 본다.
      rec.checked.push('I11')
      for (const n of truncatedIn(el)) {
        if (!hasStaticTip(n, el)) rec.v.push({ inv: 'I11', kind: '말줄임 + 단서 없음', detail: norm(n.textContent).slice(0, 60), by: '', hover: true })
        break
      }
      // I17 — 대비(비활성은 WCAG 예외)
      if (opts.checkContrast !== false && !isDisabled(el)) {
        const host = textNodeHost(el)
        if (host) {
          const c = contrastOf(host)
          if (c) {
            rec.checked.push('I17')
            if (c.ratio + 1e-6 < c.need) rec.v.push({ inv: 'I17', kind: '대비 미달', detail: c.ratio.toFixed(2) + ' < ' + c.need + ' (' + c.fg + ' on ' + c.bg + ')', by: '' })
          }
        }
      }
      // 접근성 이름
      if (NAME_ROLES.has(role)) {
        rec.checked.push('A11Y-NAME')
        if (!rec.name) rec.v.push({ inv: 'A11Y-NAME', kind: '이름 없음', detail: describe(el), by: '' })
      }
      // 링크 대상 — 같은 출처의 화면 경로는 알려진 라우트여야 한다(와일드카드로 떨어지면 404 상당)
      if (tag === 'a' && el.getAttribute('href')) {
        const href = el.getAttribute('href')
        if (!/^(#|mailto:|tel:|javascript:)/i.test(href)) {
          let u = null
          try { u = new URL(href, location.href) } catch (e) { u = null }
          if (u && u.origin === location.origin && !/^\/(api|rhwp|assets|manual-assets|downloads?)\//.test(u.pathname) && !/\.\w{2,5}$/.test(u.pathname)) {
            rec.checked.push('LINK')
            if (routeRes.length && !routeRes.some((re) => re.test(u.pathname))) rec.v.push({ inv: 'LINK', kind: '알 수 없는 경로', detail: u.pathname, by: '' })
          }
        }
      }
      // 클릭 탐색 후보 정보(Node 쪽이 거른다)
      rec.click = {
        disabled: isDisabled(el), href: tag === 'a' ? (el.getAttribute('href') || '') : '', target: el.getAttribute('target') || '',
        type: (el.getAttribute('type') || '').toLowerCase(), cls: typeof el.className === 'string' ? el.className.slice(0, 160) : '', variant: el.getAttribute('data-variant') || '',
        text: norm(el.textContent).slice(0, 40), ariaHaspopup: el.getAttribute('aria-haspopup') || '', ariaExpanded: el.getAttribute('aria-expanded') || '',
        // 상태를 바꾸는 단추의 단서 — 토글(aria-pressed · aria-checked) · 선택 묶음(radiogroup · 세그먼트) 안의 단추는 즉시 적용 설정일 수 있다.
        toggle: el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-selected') && roleOf(el) !== 'tab',
        inGroup: !!el.closest(['[role=radiogroup], [role=listbox], [class*="swatch" i], [class*="preset" i]', ...(CFG.choiceGroupSelectors || [])].join(', ')),
      }
      elements.push(rec)
    }
    restore()
    return { elements, hidden, capped, found: elements.length + capped, scrollY: scrollY, doc: docOverflow() }
  }

  /** 열린 표면(표시 중) 목록에 표지를 단다 — 클릭 전 «원래 있던 것» 을 구분한다. */
  function surfaces(mark) {
    const out = []
    for (const s of document.querySelectorAll(SURFACE)) {
      const r = s.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || !visibleStyle(s)) continue
      if (mark) s.setAttribute('data-uistab-pre', '1')
      out.push(s)
    }
    return out
  }
  function findByKey(key) { for (const el of document.querySelectorAll(INTERACTIVE)) if (keyOf(el) === key) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && visibleStyle(el)) return el } return null }

  /** 누르기 준비 — 대상을 화면 가운데로 옮기고, 가운데가 대상 자신인지 · 원래 있던 표면에 표지를 단다. */
  function prepClick(key, block) {
    const el = findByKey(key)
    if (!el) return { ok: false, why: '요소를 다시 찾지 못함' }
    // 목록을 여는 단추(aria-haspopup · combobox)는 «아래 끝» 에 붙여 연다(I22 배치 변형 — 하단 잘림은 이 자리에서 드러난다).
    const b = block || (el.getAttribute('aria-haspopup') || el.getAttribute('role') === 'combobox' ? 'end' : 'center')
    try { el.scrollIntoView({ block: b, inline: 'nearest', behavior: 'instant' }) } catch (e) { el.scrollIntoView() }
    const { vis } = visibleRect(el)
    const x = vis.x + vis.width / 2, y = vis.y + vis.height / 2
    const h = document.elementFromPoint(x, y)
    for (const s of document.querySelectorAll('[data-uistab-pre]')) s.removeAttribute('data-uistab-pre')
    surfaces(true)
    window.__uistabTrigger = el
    window.__uistabBodyEls = document.body.querySelectorAll('*').length
    window.__uistabUrl = location.href
    return { ok: ownsHit(el, h), x, y, url: location.href, hit: describe(h) }
  }
  /** 루트가 pointer-events:none 인 부유 창(뒤를 누를 수 있는 전체 보기 창)은 실제로 누르는 카드가 표면이다 — 가장 큰 보이는 pointer-events 자손. */
  function cardOf(s) {
    if (getComputedStyle(s).pointerEvents !== 'none') return s
    let best = null, area = 0
    for (const d of [...s.querySelectorAll('*')].slice(0, 300)) {
      if (getComputedStyle(d).pointerEvents === 'none') continue
      if (d.parentElement && getComputedStyle(d.parentElement).pointerEvents !== 'none') continue
      const r = d.getBoundingClientRect(); const a = r.width * r.height
      if (a > area && visibleStyle(d)) { best = d; area = a }
    }
    return best || s
  }
  /** 표면의 가림 판정(가운데 + 안쪽 4px 모서리). */
  function surfaceHit(s0) {
    const s = cardOf(s0)
    const r = s.getBoundingClientRect()
    const vw = innerWidth, vh = innerHeight
    const inViewport = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1
    const L = Math.max(r.left + 4, 0), R = Math.min(r.right - 4, vw - 1), T = Math.max(r.top + 4, 0), B = Math.min(r.bottom - 4, vh - 1)
    const pts = [['왼쪽 위', L, T], ['오른쪽 위', R, T], ['왼쪽 아래', L, B], ['오른쪽 아래', R, B], ['가운데', (L + R) / 2, (T + B) / 2]]
    // 모달 딤은 창 자신이 아니라 바깥이다 — 창 본체([role=dialog] 자손)로 판정한다.
    const body = isOverlay(s) ? (s.querySelector('[role=dialog], [aria-modal="true"]') || s.firstElementChild || s) : s
    const bad = []
    if (body !== s) return surfaceHit(body)
    for (const [n, x, y] of pts) { const h = document.elementFromPoint(x, y); if (!(h && (s.contains(h) || h === s))) bad.push(n + '→' + describe(h)) }
    return { inViewport, bad, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  }
  /**
   * I22 — 열린 목록 · 팝오버의 잘림: ① overflow 조상이 표면을 자름(교집합 99% 미만) ② 항목 가로 잘림(말줄임이면 단서 필요)
   * ③ 넘치는데 스크롤할 수 없는 영역(overflow-y hidden). 표면 자체가 스크롤 목록이면 자기 자신은 조상으로 보지 않는다.
   */
  function surfaceClip(s0) {
    const s = cardOf(s0)
    const out = []
    const body = isOverlay(s) ? (s.querySelector('[role=dialog], [aria-modal="true"]') || s) : s
    const r = body.getBoundingClientRect()
    const area = Math.max(1, r.width * r.height)
    // overflow 조상이 표면을 자르는 것은 그 조상이 표면의 «포함 블록» 이거나 그 위일 때뿐이다.
    // fixed 표면은 transform · filter · contain 조상만, absolute 표면은 가장 가까운 위치 지정 조상(포함 블록)부터 위만 본다.
    const pos = getComputedStyle(body).position
    const makesFixedCB = (cs) => cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain || '') || /transform|filter/.test(cs.willChange || '')
    let cbReached = pos !== 'absolute' && pos !== 'fixed'
    for (let a = body.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (pos === 'fixed' && !cbReached) { if (makesFixedCB(cs)) cbReached = true; else continue }
      if (pos === 'absolute' && !cbReached) { if (cs.position !== 'static' || makesFixedCB(cs)) cbReached = true; else continue }
      if (!/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) continue
      const ar = a.getBoundingClientRect()
      const w = Math.min(r.right, ar.right) - Math.max(r.left, ar.left), h = Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top)
      const inter = w > 0 && h > 0 ? w * h : 0
      if (inter / area < 0.99) { out.push({ kind: 'overflow 조상이 표면을 자름', detail: describe(a) + ' 가 ' + Math.round(100 - (inter / area) * 100) + '% 를 자름' }); break }
      if (cs.position === 'fixed') break
    }
    for (const it of [...body.querySelectorAll('[role=menuitem], [role=option], [role=menuitemradio], [role=menuitemcheckbox], li, button')].slice(0, 80)) {
      const ir = it.getBoundingClientRect(); if (ir.width < 1 || !visibleStyle(it)) continue
      const tr = truncatedIn(it)[0]
      if (tr && !hasStaticTip(tr, it)) { out.push({ kind: '항목 가로 잘림', detail: describe(it) + ' 「' + norm(tr.textContent).slice(0, 40) + '」' }); break }
      if (!tr && it.scrollWidth > it.clientWidth + 1 && getComputedStyle(it).overflowX !== 'visible') { out.push({ kind: '항목 가로 잘림', detail: describe(it) + ' 「' + norm(it.textContent).slice(0, 40) + '」' }); break }
    }
    for (const e of [body, ...body.querySelectorAll('*')].slice(0, 400)) {
      const cs = getComputedStyle(e)
      // 가상 스크롤 그리드는 바깥 상자(가로 스크롤 · overflow-y hidden)가 안쪽 세로 스크롤 상자를 품는다 — 안쪽에서 스크롤되면 넘침이 아니다.
      const innerScroll = () => [...e.querySelectorAll('*')].slice(0, 300).some((d) => /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.scrollHeight > d.clientHeight + 4)
      // 누를 수 없는 덧그림 층(pointer-events:none)은 스크롤 영역이 아니다 — 그리드 범위 선택 층은 보이는 칸만큼 자르는 창 안에
      //   전체 높이의 층을 두고 스크롤에 맞춰 옮긴다(스튜디오 전체 화면 그리드 `data-gg-range-selection-clip` — uistab-left I22 오탐).
      if (cs.overflowY === 'hidden' && cs.pointerEvents !== 'none' && e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 40 && !(cs.webkitLineClamp && cs.webkitLineClamp !== 'none') && cs.textOverflow !== 'ellipsis' && !innerScroll()) {
        out.push({ kind: '넘치는데 스크롤 불가', detail: describe(e) + ' 내용 ' + e.scrollHeight + 'px / 보이는 ' + e.clientHeight + 'px' }); break
      }
    }
    return out
  }
  /** 누른 뒤 — 새로 열린 표면(가림 · 초점 안) · 주소 변화 · 깨짐. */
  function afterClick(errorSelectors) {
    const now = surfaces(false).filter((s) => !s.hasAttribute('data-uistab-pre'))
    // 바깥 층만(새 표면 안의 표면은 그 표면의 일부)
    const top0 = now.filter((s) => !now.some((o) => o !== s && o.contains(s)))
    // 딤과 창이 형제(딤 다음에 창을 따로 둔 구조 — 필터 편집기 등)면 창이 그 표면이다. 창이 없는 딤만 따로 판정하면
    // 가운데가 창에 «가려짐» · 초점이 딤 밖이라 잘못 센다(2026-10-17).
    const hasDialog = top0.some((s) => !isOverlay(s) && (s.getAttribute('role') === 'dialog' || s.getAttribute('aria-modal') === 'true'))
    const top = top0.filter((s) => !(hasDialog && isOverlay(s) && !s.querySelector('[role=dialog], [aria-modal="true"]')))
    const a = document.activeElement
    const res = top.map((s) => {
      const role = s.getAttribute('role') || (isOverlay(s) ? 'dialog' : isPopover(s) ? 'popover' : '')
      const modal = role === 'dialog' || role === 'alertdialog' || s.getAttribute('aria-modal') === 'true' || isOverlay(s)
      // Tab 가둠은 «모달» 만 — aria-modal 없는 role=dialog(투어 말풍선 같은 비차단 대화상자)는 WAI-ARIA 상 Tab 이 밖으로 나가는 것이 정상이다.
      const trap = role === 'alertdialog' || s.getAttribute('aria-modal') === 'true' || isOverlay(s)
      const testids = [...new Set([testidOf(s), ...[...s.querySelectorAll('[data-testid]')].slice(0, 200).map((e) => e.getAttribute('data-testid'))].filter(Boolean))]
      return { role, modal, trap, desc: describe(s), comp: compOf(s), hit: surfaceHit(s), focusInside: !!a && a !== document.body && s.contains(a), testids, clip: surfaceClip(s) }
    })
    for (const s of top) s.setAttribute('data-uistab-new', '1')
    const bodyEls = document.body.querySelectorAll('*').length
    // 깨짐 — 오류 경계가 떴거나, 누르기 전보다 요소 수가 30% 미만으로 줄었다(백지).
    // 다른 화면으로 넘어갔으면(주소 바뀜) 요소 수 비교는 뜻이 없다 — 오류 경계 · 거의 빈 문서만 본다.
    const before = window.__uistabBodyEls || bodyEls
    const sameUrl = window.__uistabUrl === location.href
    const broken = !!((errorSelectors && errorSelectors.length) && document.querySelector(errorSelectors.join(', '))) || (bodyEls < 20 && before >= 40) || (sameUrl && bodyEls < before * 0.3)
    return { url: location.href, surfaces: res, active: describe(a), broken, bodyEls }
  }
  /** Esc 뒤 — 새 표면이 닫혔는가 · 원래 있던 표면은 남았는가 · 초점이 연 단추로 돌아왔는가. */
  function afterEscape() {
    const stillNew = [...document.querySelectorAll('[data-uistab-new]')].filter((s) => { const r = s.getBoundingClientRect(); return s.isConnected && r.width > 1 && r.height > 1 && visibleStyle(s) })
    const preGone = [...document.querySelectorAll('[data-uistab-pre]')].filter((s) => { const r = s.getBoundingClientRect(); return !(r.width > 1 && r.height > 1 && visibleStyle(s)) }).length
    const t = window.__uistabTrigger
    const a = document.activeElement
    const returned = !!t && t.isConnected && !!a && (a === t || t.contains(a))
    const triggerGone = !t || !t.isConnected
    for (const s of document.querySelectorAll('[data-uistab-new]')) s.removeAttribute('data-uistab-new')
    return { stillOpen: stillNew.length, preGone, focusReturned: returned, triggerGone, active: describe(a) }
  }
  /** Tab 을 눌러 초점이 모달 밖으로 새는지(I9) — Node 쪽이 Tab 을 친 뒤 부른다. */
  function focusInfo() {
    const a = document.activeElement
    const m = [...document.querySelectorAll(['[aria-modal="true"], [role=dialog]', OVERLAY].filter(Boolean).join(', '))].filter((s) => { const r = s.getBoundingClientRect(); return r.width > 1 && r.height > 1 && visibleStyle(s) })
    return { inModal: m.length === 0 ? null : m.some((s) => s.contains(a)), active: describe(a) }
  }
  /** 딥링크 대상(I16) — 보이는가 · 초점 · 강조. */
  function anchorProbe(sel) {
    const el = document.querySelector(sel)
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const inView = r.height > 0 && r.top >= -1 && r.top < innerHeight - 8 && r.left < innerWidth && r.right > 0
    const a = document.activeElement
    const focused = !!a && a !== document.body && (el === a || el.contains(a))
    const anims = typeof el.getAnimations === 'function' ? el.getAnimations({ subtree: true }).length : 0
    const highlighted = anims > 0 || el.hasAttribute('data-fix-flash') || /flash|highlight|landed/i.test(typeof el.className === 'string' ? el.className : '')
    return { found: true, inView, focused, highlighted, visible: visibleStyle(el), top: Math.round(r.top) }
  }
  /** 실제 호버로 다시 볼 말줄임 대상 — 정적 단서가 없던 요소의 화면 좌표. */
  function hoverTarget(key) {
    const el = findByKey(key); if (!el) return null
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch (e) { el.scrollIntoView() }
    const n = truncatedIn(el)[0] || el
    const r = n.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, text: norm(n.textContent) }
  }
  /** 호버 뒤 — 전체 글자를 담은 툴팁(role=tooltip · 설정의 툴팁 선택자) 또는 title 이 생겼는가. */
  function tooltipShows(text) {
    const want = norm(text).slice(0, 20)
    for (const t of document.querySelectorAll(['[role=tooltip]', ...(CFG.tooltipSelectors || [])].join(', '))) {
      const r = t.getBoundingClientRect()
      if (r.width > 1 && r.height > 1 && visibleStyle(t) && norm(t.textContent).includes(want)) return true
    }
    return false
  }

  /**
   * I25 — 화면 문구 스캔. fail: 값 누출(undefined · NaN · [object Object] · Infinity · 단독 null) · 내부 식별자(__sum · UUID · tab-숫자 · snake_case 3단) ·
   * 영문 리터럴(Total · rows · values · free · Loading · Error). warn: 용어 사전 금지어 · 닫는 따옴표 뒤 공백 소실.
   * 제외: pre · code · kbd · 입력 칸 · 편집 영역 · 그리드(사용자 데이터) · [data-uistab-text-skip].
   */
  function textScan(terms, scope) {
    const fail = [], warn = []
    // 코드 · 기술 표기 영역(코드 상자 · 단축키 · 고정폭 글꼴 클래스 · 키 이름 칸)과 사용자 데이터(그리드 · 표 칸)는 보지 않는다.
    // 프로젝트가 «쓰지 않는 말» 을 일부러 보여 주는 자리(용어 기준표 등)는 설정 textSkipSelectors 로 뺀다.
    const SKIP = ['pre, code, kbd, samp, textarea, input, [contenteditable="true"], [role=grid], [role=treegrid], [role=table] td, svg, canvas, iframe, [data-uistab-text-skip], script, style, noscript, [class*="mono" i], [class*="kbd" i], [class*="code" i], [class*="kvKey" i], [class*="propName" i], [class*="path" i]', ...(CFG.textSkipSelectors || [])].join(', ')
    const root = (scope && document.querySelector(scope)) || document.body
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n, count = 0
    while ((n = it.nextNode()) && count < 6000) {
      const t = norm(n.textContent)
      if (!t || !n.parentElement) continue
      const p = n.parentElement
      if (p.closest(SKIP)) continue
      const r = p.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || !visibleStyle(p)) continue
      count++
      const where = describe(p)
      const comp = compOf(p)
      let m
      if ((m = /(^|[^A-Za-z])(undefined|NaN|Infinity|\[object Object\])(?![A-Za-z])/.exec(t)) || /^null$/.test(t)) fail.push({ kind: '값 누출', text: t.slice(0, 60), hit: m ? m[2] : 'null', where, comp })
      // 내부 식별자 — 집계 열 이름 · UUID · 탭 id · 소문자 snake_case 3단(이벤트 · 오류 코드 이름). 대문자 환경 변수(APP_…)와 파일 이름(x_y_z.py)은 운영 안내라 뺀다.
      else if ((m = /(__(sum|avg|min|max|count)|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\btab-\d{10,}|\b[a-z]+_[a-z]+_[a-z]+\b(?!\.\w))/.exec(t))) fail.push({ kind: '내부 식별자', text: t.slice(0, 60), hit: m[1], where, comp })
      // HTTP 상태 줄(「500 Internal Server Error」 등 세 자리 코드 + 표준 문구)은 프로토콜 이름이라 영문 리터럴로 보지 않는다(개발자 포털 오류 코드 표).
      else if (/[가-힣]/.test(document.body.innerText.slice(0, 400)) && (m = /(^|[^A-Za-z])(Total|rows|values|free|Loading|Error)(?![A-Za-z])/.exec(t.replace(/\b[1-5]\d\d (?:[A-Z][a-z]+ ?)+/g, '')))) fail.push({ kind: '영문 리터럴', text: t.slice(0, 60), hit: m[2], where, comp })
      for (const rule of (terms && terms.rules) || []) {
        // 사전 예외(allow — 「미리보기」 · 「오른쪽」 등)는 규칙을 찾기 전에 가린다.
        let tt = t
        for (const a of rule.allow || []) tt = tt.split(a).join(' ')
        const mm = new RegExp(rule.pattern).exec(tt)
        if (mm) { (rule.level === 'fail' ? fail : warn).push({ kind: '용어', text: t.slice(0, 60), hit: mm[0] + '→' + rule.prefer, where, comp }); break }
      }
      // 「적재」 뜻의 「추출」 — 「뽑아내다」 뜻의 합성어(스타일 추출 등)는 허용 목록으로 뺀다. 단계는 설정 한 줄(extractAsLoadLevel).
      if (terms && /추출/.test(t)) {
        let rest = t
        for (const a of terms.extractAllow || []) rest = rest.split(a).join('')
        if (/추출/.test(rest)) (terms.extractAsLoadLevel === 'fail' ? fail : warn).push({ kind: '용어 — 적재 뜻의 추출', text: t.slice(0, 60), hit: '추출→적재', where, comp })
      }
      if (/[」"][가-힣]/.test(t)) warn.push({ kind: '닫는 따옴표 뒤 공백 소실', text: t.slice(0, 60), hit: '', where, comp })
    }
    return { fail, warn, nodes: count }
  }
  /**
   * I37 — 밑줄 글자. 기본 상태(호버 아님)에서 계산된 text-decoration-line 에 underline 이 있는 보이는 요소를 모두 모은다(밑줄을 물려준 바깥 요소 하나만).
   * 판정: 밑줄은 «문장 안» 의 이동 · 설명 링크(앞뒤에 같은 문장 글자가 있는 인라인 요소)와 값 링크([data-link-role="value"])에만 허용한다.
   *   그 밖(문장 밖에 혼자 선 밑줄 · 블록 · 단추 모양 자리)은 위반 — 실행은 버튼, 행 동작은 작은 버튼으로 바꾼다(명세 20 §2.12.1 C580).
   * 허용 목록은 설정 underlineAllow(선택자 + 사유)로 받는다. 기술 영역(코드 · 입력 · 그림)은 보지 않는다.
   */
  function underlineScan(scope) {
    const root = (scope && document.querySelector(scope)) || document.body
    const SKIP = 'svg, canvas, iframe, input, textarea, select, [contenteditable="true"], pre, code, kbd, script, style, noscript, [data-uistab-underline-skip]'
    const allow = (CFG.underlineAllow || []).filter((a) => a && a.selector)
    const isUnder = (e) => /underline/.test(getComputedStyle(e).textDecorationLine || '')
    const blockOf = (e) => { for (let a = e.parentElement; a; a = a.parentElement) { const d = getComputedStyle(a).display; if (!/^inline/.test(d) && d !== 'contents') return a } return document.body }
    const out = []
    for (const el of root.querySelectorAll('*')) {
      if (out.length >= 300) break
      if (!isUnder(el) || el.closest(SKIP)) continue
      let outer = false
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) if (isUnder(a)) { outer = true; break }
      if (outer) continue
      const text = norm(el.innerText || el.textContent)
      if (!text) continue
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || !visibleStyle(el)) continue
      const cs = getComputedStyle(el)
      const block = blockOf(el)
      const rest = norm(String(block.innerText || '').split(el.innerText || text).join(' ')).replace(/[·|•→←\-–—:()[\]]/g, '')
      // 문장 안 = 인라인 요소이고, 같은 블록에 링크 밖 글자가 있다(구분 기호만이면 문장이 아니다).
      const inSentence = /^inline(-block)?$/.test(cs.display) && /[가-힣A-Za-z0-9]{2,}/.test(rest)
      const value = !!el.closest('[data-link-role="value"]')
      const allowed = allow.find((a) => { try { return el.closest(a.selector) } catch (e) { return false } })
      const host = el.closest('a[href], button, [role=button], [role=link]')
      const verdict = value ? 'value' : allowed ? 'allow' : inSentence ? 'sentence' : 'alone'
      out.push({ text: text.slice(0, 60), tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className.slice(0, 120) : '', testid: testidOf(el) || nearestTestid(el), role: host ? roleOf(host) : '', href: host && host.tagName === 'A' ? (host.getAttribute('href') || '').slice(0, 80) : '', display: cs.display, comp: compOf(el), where: describe(el), verdict, why: allowed ? allowed.why : '', rest: rest.slice(0, 60) })
    }
    return out
  }
  /** I19 — R↔V 비교용 화면 요약: 보이는 글자 줄(숫자 일반화) · testid 상자(보이는 것, 앞 400개). */
  function paritySnap() {
    const lines = norm(document.body.innerText).length ? document.body.innerText.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).map(generic) : []
    const boxes = {}
    let k = 0
    for (const e of document.querySelectorAll('[data-testid]')) {
      if (k >= 400) break
      const id = e.getAttribute('data-testid'); if (id in boxes) continue
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || !visibleStyle(e)) continue
      // 문서 좌표(조상 스크롤 양을 더한다) — 두 앱의 스크롤 위치가 달라도 같은 자리면 같은 값.
      let sx = 0, sy = 0
      for (let a = e.parentElement; a; a = a.parentElement) { sx += a.scrollLeft || 0; sy += a.scrollTop || 0 }
      boxes[id] = [Math.round(r.x + sx), Math.round(r.y + sy), Math.round(r.width), Math.round(r.height)]; k++
    }
    const se = document.scrollingElement || document.documentElement
    return { lines: lines.slice(0, 1500), boxes, framework: document.querySelector('[data-v-app]') ? 'vue' : document.querySelector('#root') ? 'react' : '?', origin: location.origin, hidden: document.hidden, docH: se.scrollHeight }
  }


  // ── 단계 도입 규칙(3판, 2026-10-20) ─────────────────────────────────────────────────────────────
  // 새 규칙은 먼저 «단계 도입(staged)» 으로 기록만 하고, 위반 수를 화면 · 규칙별로 잠근 기준선(staged-baseline.json)보다 늘면 실패한다.
  // 기존 화면에서 잡힌 위반은 사용성 수정의 근거 목록이다. 줄어든 만큼만 다시 잠근다.
  const SENTENCE_RE = /[가-힣A-Za-z0-9]{2,}/
  /** 인라인 요소가 문장 안에 있는가 — 같은 블록에 자기 밖 글자가 있다(밑줄 판정과 같은 기준). */
  function inSentence(el) {
    const cs = getComputedStyle(el)
    if (!/^inline/.test(cs.display)) return false
    let b = el.parentElement
    while (b && /^inline/.test(getComputedStyle(b).display)) b = b.parentElement
    if (!b) return false
    const rest = norm(String(b.innerText || '').split(el.innerText || el.textContent || '').join(' ')).replace(/[·|•→←\-–—:()[\]]/g, '')
    return SENTENCE_RE.test(rest)
  }
  /** 비활성 사유 — 정적 단서(title · aria-describedby · data-disabled-reason, 자신 ~ 조상 3단) 또는 가까이 보이는 안내 문장. */
  const REASON_WORDS = /(하려면|고르면|골라야|입력하면|입력해야|넣으면|있어야|있으면|필요|없어|없어서|없을|때문|먼저|권한|만 할 수|수 없|안 돼|못 해|끝나면|켜면|켜야|연결하면|저장하면|바꾸면)/
  function disabledReason(el) {
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      const t = e.getAttribute('title') || e.getAttribute('data-tooltip') || e.getAttribute('data-tip') || e.getAttribute('data-disabled-reason')
      if (t && norm(t)) return 'title'
      const d = e.getAttribute('aria-describedby')
      if (d && d.split(/\s+/).some((id) => { const n = document.getElementById(id); return !!n && !!norm(n.textContent) })) return 'describedby'
    }
    // 가까운 안내 문장 — 같은 묶음(부모 ~ 조부모) 안에 보이는 글자가 사유 말투를 담고 있다(「수신자를 고르면 예약할 수 있어요」).
    for (let a = el.parentElement, i = 0; a && a !== document.body && i < 3; a = a.parentElement, i++) {
      for (const n of a.querySelectorAll('p, span, small, div, li, [role=note], [role=status]')) {
        if (n.contains(el) || el.contains(n)) continue
        if ([...n.childNodes].every((c) => c.nodeType !== 3)) continue
        const t = norm(n.textContent)
        if (t && t.length <= 160 && REASON_WORDS.test(t) && visibleStyle(n) && n.getBoundingClientRect().width > 1) return 'hint'
      }
    }
    return ''
  }
  /** 쪽 넘김 · 증감처럼 비활성 이유가 자명한 단추. */
  const OBVIOUS_DISABLED = /^(이전|다음|처음|마지막|이전 쪽|다음 쪽|첫 쪽|끝 쪽|맨 앞|맨 뒤|위로|아래로|증가|감소|[‹›«»<>↑↓←→+−-])$/
  /** 이름표 글자 — 체크 · 스위치 · 라디오 옆에 선 짧은 글자 노드(같은 줄). 누르면 바뀌는 영역 밖이면 돌려준다. */
  function strayLabel(el) {
    if (el.labels && el.labels.length) return null
    if (el.closest('label')) return null
    const pointer = (n) => { for (let e = n, i = 0; e && i < 3; e = e.parentElement, i++) { const c = getComputedStyle(e).cursor; if (c === 'pointer') return true; if (e.matches && e.matches(INTERACTIVE)) return true } return false }
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const t = document.getElementById(lb.split(/\s+/)[0])
      if (!t || el.contains(t) || t.closest('label') || pointer(t)) return null
      return norm(t.textContent) ? t : null
    }
    const row = el.parentElement; if (!row || row === document.body) return null
    if (getComputedStyle(row).cursor === 'pointer' || row.matches(INTERACTIVE)) return null
    const r = el.getBoundingClientRect()
    for (const n of row.querySelectorAll('span, div, p, strong, b, em')) {
      if (n.contains(el) || el.contains(n)) continue
      if ([...n.childNodes].every((c) => c.nodeType !== 3 || !norm(c.textContent))) continue
      const t = norm(n.textContent)
      if (!t || t.length > 40 || !visibleStyle(n)) continue
      const nr = n.getBoundingClientRect()
      const sameLine = nr.height > 0 && nr.top < r.bottom && nr.bottom > r.top
      if (sameLine && !pointer(n)) return n
    }
    return null
  }
  /**
   * 단계 도입 규칙 훑기 — I38 비활성 사유 없음 · I39 누름 대상 크기(WCAG 2.5.8, 24px · 간격 예외) · I40 이름표 글자가 누름 영역 밖 ·
   * I41 말줄임 없는 글자 잘림. opts: { scope?: CSS, max?: number }. 반환 = [{ inv, kind, comp, key, detail, hover? }]
   */
  function stagedScan(opts) {
    const o = opts || {}
    const root = o.scope ? document.querySelector(o.scope) : document.body
    if (!root) return []
    const out = []
    const seen = new Set()
    const push = (v) => { const k = v.inv + '|' + v.comp + '|' + v.kind; if (seen.has(k)) return; seen.add(k); out.push(v) }
    const els = [...root.querySelectorAll(INTERACTIVE)].filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 && visibleStyle(el) }).slice(0, o.max || 800)
    const rects = els.map((el) => el.getBoundingClientRect())
    els.forEach((el, i) => {
      const role = roleOf(el)
      const tag = el.tagName.toLowerCase()
      const name = accName(el).slice(0, 40)
      const r = rects[i]
      if (el.closest('[role=grid], [role=treegrid], canvas, svg, iframe, [contenteditable="true"]')) return
      // I38 — 비활성 단추 · 메뉴 항목에는 왜 못 누르는지 알 수 있어야 한다(테스터 1 · 2 「예약」 · 테스터 3 「만들기」).
      if (isDisabled(el) && ['button', 'menuitem', 'tab', 'link'].includes(role) && !OBVIOUS_DISABLED.test(name)) {
        const why = disabledReason(el)
        if (!why) push({ inv: 'I38', kind: '비활성 사유 없음', comp: compOf(el), key: keyOf(el), detail: '「' + name + '」 ' + describe(el) + ' — title · aria-describedby · 가까운 안내 문장 없음', hover: true })
      }
      // I39 — 누름 대상 24×24 미만이면 중심 반지름 12px 원 안에 다른 누름 대상이 없어야 한다. 문장 안 링크 · 글 입력 칸은 예외.
      const textInput = (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'color'].includes((el.getAttribute('type') || 'text').toLowerCase())) || tag === 'textarea' || tag === 'select'
      if (!textInput && (r.width < 24 || r.height < 24) && !(tag === 'a' && inSentence(el)) && !isDisabled(el)) {
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2
        const near = els.find((o2, j) => {
          if (j === i || o2.contains(el) || el.contains(o2)) return false
          const q = rects[j]
          const dx = Math.max(q.left - cx, 0, cx - q.right), dy = Math.max(q.top - cy, 0, cy - q.bottom)
          return dx * dx + dy * dy < 144
        })
        if (near) push({ inv: 'I39', kind: '누름 대상 작음 + 간격 부족', comp: compOf(el), key: keyOf(el), detail: '「' + name + '」 ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px · 12px 안에 ' + describe(near) })
      }
      // I40 — 체크 · 스위치 · 라디오 옆 이름표 글자를 눌러도 바뀌지 않음(테스터 2 「실제 데이터로 보기」).
      if (['checkbox', 'switch', 'radio'].includes(role) && !isDisabled(el)) {
        const n = strayLabel(el)
        if (n) push({ inv: 'I40', kind: '이름표 글자가 누름 영역 밖', comp: compOf(el), key: keyOf(el), detail: '「' + norm(n.textContent).slice(0, 30) + '」 ' + describe(n) + ' 옆 ' + describe(el) + ' — label 로 묶거나 줄 전체를 누름 영역으로' })
      }
    })
    // I41 — 말줄임 없이 잘린 글자(자기 글자를 가진 요소 · overflow hidden/clip · 내용이 상자보다 큼 · text-overflow 없음).
    const SKIP = 'pre, code, kbd, samp, textarea, input, select, [contenteditable="true"], [role=grid], [role=treegrid], svg, canvas, iframe, script, style, noscript, [aria-hidden="true"], [data-uistab-text-skip]'
    let n = 0
    for (const e of root.querySelectorAll('*')) {
      if (++n > 4000) break
      if (![...e.childNodes].some((c) => c.nodeType === 3 && norm(c.textContent))) continue
      if (e.closest(SKIP)) continue
      const cs = getComputedStyle(e)
      if (/rect\(0/.test(cs.clip) || /inset\(50%/.test(cs.clipPath)) continue
      const r = e.getBoundingClientRect()
      if (r.width < 6 || r.height < 6 || !visibleStyle(e)) continue
      const clampY = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
      const cutX = /(hidden|clip)/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 18
      const cutY = /(hidden|clip)/.test(cs.overflowY) && !clampY && e.scrollHeight > e.clientHeight + 3 && e.clientHeight > 0 && e.clientHeight < lh * 30
      if (cutX || cutY) push({ inv: 'I41', kind: cutX ? '글자 가로 잘림(말줄임 없음)' : '글자 세로 잘림', comp: compOf(e), key: compOf(e), detail: '「' + norm(e.textContent).slice(0, 40) + '」 ' + describe(e) + ' 내용 ' + (cutX ? e.scrollWidth + 'px / 보이는 ' + e.clientWidth : e.scrollHeight + 'px / 보이는 ' + e.clientHeight) + 'px' })
    }
    return out
  }
  /**
   * I42 — 화면 열기 동안의 레이아웃 이동(CLS, 입력 직후 500ms 제외). 세션 창(간격 1초 미만 · 최대 5초)의 최댓값이 web-vitals CLS 와 같은 셈이다.
   * 옮겨진 노드 상위 3개(넓이 × 거리)와, 그중 누름 대상(또는 그 조상)을 같이 돌려준다 — D-STUDIO-12(진입 서랍 확보값 늦게 붙어 단추가 28px 밀림) 범주.
   */
  function clsProbe() {
    return new Promise((resolve) => {
      let entries = []
      try {
        const po = new PerformanceObserver((l) => { entries = entries.concat(l.getEntries()) })
        po.observe({ type: 'layout-shift', buffered: true })
        entries = entries.concat(po.takeRecords())
        setTimeout(() => {
          entries = entries.concat(po.takeRecords()); po.disconnect()
          const list = entries.filter((e) => !e.hadRecentInput).sort((a, b) => a.startTime - b.startTime)
          let best = 0, cur = 0, first = 0, last = 0
          for (const e of list) {
            if (cur && (e.startTime - last < 1000) && (e.startTime - first < 5000)) cur += e.value
            else { cur = e.value; first = e.startTime }
            last = e.startTime
            best = Math.max(best, cur)
          }
          const moved = []
          for (const e of list) for (const s of e.sources || []) {
            if (!s.node || s.node.nodeType !== 1) continue
            const p = s.previousRect, c = s.currentRect
            const dist = Math.hypot(c.x - p.x, c.y - p.y)
            moved.push({ score: dist * Math.max(1, c.width * c.height), dist: Math.round(dist), dy: Math.round(c.y - p.y), desc: describe(s.node), comp: compOf(s.node), at: Math.round(e.startTime), interactive: !!(s.node.matches(INTERACTIVE) || s.node.querySelector(INTERACTIVE)) })
          }
          moved.sort((a, b) => b.score - a.score)
          resolve({ cls: Math.round(best * 1000) / 1000, shifts: list.length, top: moved.slice(0, 3), targets: moved.filter((m) => m.interactive && m.dist >= 8).slice(0, 3) })
        }, 60)
      } catch (err) { resolve(null) }
    })
  }
  /**
   * I43 — 초점 보임. Tab 으로 초점이 간 요소의 모습(외곽선 · 그림자 · 테두리 · 배경 · 글자색 · 밑줄 · 가상 요소, 자신 ~ 조부모)을 재고,
   * 초점을 빼(blur) 다시 재 같으면 «초점 표시 없음». 전환 효과는 잠시 끄고 잰다(중간 값으로 같게 보이는 오판 방지). 순차 탐색 시작점은 남는다.
   */
  function focusProbe() {
    const a = document.activeElement
    if (!a || a === document.body || a === document.documentElement) return { none: true }
    if (a.tagName === 'IFRAME') return { none: true, frame: true }
    const r = a.getBoundingClientRect()
    const cs0 = getComputedStyle(a)
    const visible = r.width >= 1 && r.height >= 1 && visibleStyle(a) && !/rect\(0/.test(cs0.clip)
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    const chain = [a, a.parentElement, a.parentElement && a.parentElement.parentElement].filter((e) => e && e !== document.body)
    const saved = chain.map((e) => e.style.transition)
    for (const e of chain) e.style.transition = 'none'
    const pick = (e) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.borderTopWidth, s.backgroundColor, s.color, s.textDecorationLine].join('|') }
    const pse = (e) => ['::before', '::after'].map((p) => { const s = getComputedStyle(e, p); return [s.content, s.outlineStyle, s.boxShadow, s.borderTopColor, s.backgroundColor, s.opacity].join('|') }).join('#')
    const on = chain.map(pick).join('§') + pse(a)
    const info = { visible, inView, desc: describe(a), comp: compOf(a), key: keyOf(a), name: accName(a).slice(0, 40) }
    a.blur()
    const off = chain.map(pick).join('§') + pse(a)
    chain.forEach((e, i) => { e.style.transition = saved[i] })
    return { ...info, indicator: on !== off }
  }
  /**
   * I45 — 상태 축(오류 응답) 판정 재료: 보이는 로딩 표시 · 오류 안내 문장 · 문서 요소 수.
   */
  function stateProbe() {
    const busy = [...document.querySelectorAll('[aria-busy="true"], [role=progressbar], [class*="spinner" i], [class*="skeleton" i], [class*="loading" i]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && visibleStyle(e) })
    const text = norm(document.body.innerText)
    return { bodyEls: document.body.querySelectorAll('*').length, busy: busy.slice(0, 3).map(describe), busyComp: busy[0] ? compOf(busy[0]) : '', errorText: /(오류|실패|불러오지 못|불러올 수 없|다시 시도|문제가|연결할 수 없|응답이 없)/.test(text), textLen: text.length }
  }
  /** 호버 뒤 — 글자가 있는 툴팁이 하나라도 떴는가(I38 비활성 사유를 툴팁으로 알려 주는 경우). */
  function tooltipAny() {
    for (const t of document.querySelectorAll(['[role=tooltip]', ...(CFG.tooltipSelectors || [])].join(', '))) {
      const r = t.getBoundingClientRect()
      if (r.width > 1 && r.height > 1 && visibleStyle(t) && norm(t.textContent).length >= 4) return true
    }
    return false
  }
  /** I47 — 시각 비교 전에 매번 바뀌는 자리(시각 · 상대 시각 · 깜빡이는 입력 커서)를 가린다. 되돌리는 함수 대신 표지를 남긴다. */
  function visualMask(selectors) {
    let n = 0
    const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur()
    for (const sel of selectors || []) {
      let list = []
      try { list = document.querySelectorAll(sel) } catch (e) { list = [] }
      for (const e of list) { e.style.visibility = 'hidden'; e.setAttribute('data-uistab-masked', '1'); n++ }
    }
    // 상대 시각 글자(「7분 전」 · 「방금」 · 「2026-10-20 13:05」)를 가진 잎 요소도 가린다.
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let t
    while ((t = it.nextNode())) {
      const s = norm(t.textContent)
      if (s && s.length < 40 && /(\d+\s*(초|분|시간|일|주|개월|달)\s*전|방금|\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}|\d{1,2}:\d{2}(:\d{2})?$)/.test(s) && t.parentElement) { t.parentElement.style.visibility = 'hidden'; n++ }
    }
    return n
  }

  window.__uistabLib = { version: 4, stagedScan, clsProbe, focusProbe, stateProbe, visualMask, tooltipAny, textScan, underlineScan, paritySnap, surfaceClip, scan, prepClick, afterClick, afterEscape, focusInfo, anchorProbe, hoverTarget, tooltipShows, docOverflow, surfaces, keyOf, describe }
})()
