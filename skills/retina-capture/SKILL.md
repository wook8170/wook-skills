---
name: retina-capture
description: 화면 캡처를 2x 레티나 고화질로 굽는 방법. 오프스크린 NSWindow/AppKit 캡처(bitmapImageRepForCachingDisplay 가 1x 로 떨어지는 함정 · 2배 NSBitmapImageRep 레시피), 헤드리스 Chrome(--force-device-scale-factor=2)·CDP(deviceScaleFactor 2) 캡처 옵션. "캡처", "스크린샷", "2x", "레티나", "글자가 뭉개짐" 상황에서 사용.
---

> 프로젝트 설정: 프로젝트 루트의 `.claude/skills-config/retina-capture.md` 가 있으면 먼저 읽는다. 없으면 이 문서의 기본값과 범용 절차를 쓴다.

# 캡처는 반드시 고화질(2x 레티나)로

- **오프스크린 렌더는 기본이 1x 다.** 화면에 안 붙은 `NSWindow` 는 배율이 1 이고
  `bitmapImageRepForCachingDisplay` 가 그것을 그대로 따른다 — 원격 화면이나 확대해서 보면
  글자가 뭉개져 **회귀를 눈으로 잡을 수 없다.**
- macOS/AppKit 에서 2x 로 굽는 법: 픽셀 수만 2배인 `NSBitmapImageRep` 을 만들고 `rep.size` 는
  **논리 크기 그대로** 둔다 → `NSGraphicsContext` 가 2배 CTM 을 세워 주므로 뷰 코드는 무변경.
  ```swift
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
      pixelsWide: Int(bounds.width * 2), pixelsHigh: Int(bounds.height * 2),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = bounds.size
  let ctx = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = ctx
  view.displayIgnoringOpacity(view.bounds, in: ctx)
  NSGraphicsContext.restoreGraphicsState()
  ```
- 브라우저 캡처는 `--window-size` 와 함께 **`--force-device-scale-factor=2`**, CDP 는
  `Emulation.setDeviceMetricsOverride` 의 `deviceScaleFactor: 2`.
- **그리는 경로를 바꿨으면 그림을 한 장 열어 내용이 그대로인지 확인한다** — 배율만 바꾸려다
  렌더러가 통째로 갈리는 일이 있다.
