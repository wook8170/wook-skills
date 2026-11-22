// 도구 결과 첫 줄에 붙이는 기준 줄. 부르는 곳: dev/live-index.ts · mcp/server.ts · dev/serve-root.ts.
// 예: `기준 fb3a9b531c · 미커밋 3편 · 다시 만드는 중` · `기준 fb3a9b531c · 부하로 12분 미룸` · `기준 fb3a9b531c · 다시 만들기 실패`.
import type { WikiIndex } from '../core/search.ts'

export type LiveState = 'ready' | 'building' | 'deferred' | 'failed'

export interface Basis {
  /** 지금 답하는 묶음의 기준 커밋(앞 10자). 없으면 null. */
  commit: string | null
  /** 작업 트리 원천 폴더의 미커밋 파일 수. */
  dirtyFiles: number
  state: LiveState
  /** 부하로 미룬 분. state 가 deferred 일 때만. */
  deferredMin?: number
  /** 비밀값으로 격리한 문서 수. 격리를 켠 설정일 때만. */
  quarantined?: number
}

/** 작업 트리 색인의 한 시점. line 은 basis 를 사람이 읽는 한 줄로 쓴 것이다. */
export interface Snapshot {
  index: WikiIndex | null
  basis: Basis
  line: string
}

const STATE_TEXT: Record<Exclude<LiveState, 'ready' | 'deferred'>, string> = { building: '다시 만드는 중', failed: '다시 만들기 실패' }

export function basisLine(b: Basis): string {
  const parts = [`기준 ${b.commit ? b.commit.slice(0, 10) : '커밋 없음'}`]
  if (b.dirtyFiles > 0) parts.push(`미커밋 ${b.dirtyFiles}편`)
  if (b.quarantined) parts.push(`격리 ${b.quarantined}편`)
  if (b.state === 'deferred') parts.push(`부하로 ${b.deferredMin ?? 0}분 미룸`)
  else if (b.state !== 'ready') parts.push(STATE_TEXT[b.state])
  return parts.join(' · ')
}

/** 작업 트리 모드 CLI 의 경고 한 줄. 캐시 묶음의 기준 커밋(묶음은 앞 10자만 싣는다)이 HEAD 와 같으면 null. */
export function headMismatchWarning(bundleCommit: string | null, head: string | null): string | null {
  if (!head || (bundleCommit && head.startsWith(bundleCommit))) return null
  return `경고 색인 기준 ${bundleCommit ? bundleCommit.slice(0, 10) : '커밋 없음'} · 지금 HEAD ${head.slice(0, 10)} · 서버가 다시 만들면 맞춰진다`
}
