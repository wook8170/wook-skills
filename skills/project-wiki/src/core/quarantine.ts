// 비밀값 격리. 설정 security.onSecret 이 quarantine 이면 비밀값이 든 문서를 묶음에서 통째로 뺀다.
// 부르는 곳: core/build.ts collectSources. 뺀 경로는 CLI 가 색인 폴더 quarantine.txt(권한 600)에만 쓴다.
// 먼저 읽을 파일: core/security.ts(scanText · scanSecretsStrict).
import type { SourceUnit } from './model.ts'
import { scanSecretsStrict, scanText, type SecurityConfig } from './security.ts'
import { cmp } from './util.ts'

/** 문서 원문에 비밀값이 있는가. 묶음 검사(scanText)의 비밀값 규칙과 넓은 검사(scanSecretsStrict)를 함께 본다. */
export function hasSecret(u: Pick<SourceUnit, 'markdown' | 'path'>, profile: 'server' | 'local', security: SecurityConfig = {}): boolean {
  if (scanSecretsStrict(u.markdown, u.path).length) return true
  return scanText(u.markdown, u.path, profile, security).some((f) => f.category === 'secret')
}

/** 비밀값이 든 문서를 나눈다. 남길 문서는 원래 순서 그대로, 뺀 경로는 정렬해 돌려준다. */
export function splitQuarantined(units: SourceUnit[], profile: 'server' | 'local', security: SecurityConfig = {}): { kept: SourceUnit[]; quarantined: string[] } {
  const kept: SourceUnit[] = []
  const quarantined: string[] = []
  for (const u of units) {
    if (hasSecret(u, profile, security)) quarantined.push(u.path)
    else kept.push(u)
  }
  return { kept, quarantined: quarantined.sort(cmp) }
}
