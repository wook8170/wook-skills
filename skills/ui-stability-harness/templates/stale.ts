// I26 스테일 서빙 감지 — 모든 UI 안정성 점검의 전제 검사. 설계 docs/testing/ui-stability-harness.md §I26.
//
// 왜: 수정 전 코드를 서빙하는 서버(Vite 스테일 · 다른 워크트리 서버 · 재사용 스택의 옛 빌드)에서 돌린 점검은 가짜 통과 · 가짜 실패를 낸다.
//   「고쳤는데 여전히 안 된다」 신고의 상당수가 이 경우다(references/case-study.md).
// 판정
//   ① 빌드 표식: 하네스 빌드가 index.html 에 넣은 <meta name="app-build"> 가 지금 소스의 빌드 키(harness/stack.ts buildKey)와 같다.
//   ② 서버 위치: 대상 포트를 LISTEN 하는 프로세스의 cwd 가 이 워크트리 안이다.
//   ③ 앱 자기증명: 열린 페이지가 대상 프레임워크다(React = #root, Vue = [data-v-app]).
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { REPO, PORTS } from '../../harness/env.js'
// ▼ 프로젝트 설정 — 하네스가 빌드할 때 쓰는 «빌드 키» 함수(소스 트리 해시 + 미커밋 변경 해시). 빌드 설정의 transformIndexHtml 로 같은 값을 meta 에 넣는다.
import { buildKey } from '../../harness/stack.js'

export class StaleServingError extends Error {}

function listenCwd(port: number): string | null {
  try {
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]
    if (!pid) return null
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null
  } catch { return null }
}

export type FreshReport = { app: string; origin: string; framework: string; served: string; expected: string; cwd: string | null; hidden: boolean }

/** 실패하면 StaleServingError — 순회 사양은 beforeAll 에서 불러 그 파일 전체를 멈춘다. */
export async function assertFreshServing(page: Page, app: 'react' | 'vue', opts: { checkCwd?: boolean } = {}): Promise<FreshReport> {
  await page.goto('/about')
  await page.waitForFunction(() => !!document.querySelector('#root > *, [data-v-app]'), undefined, { timeout: 30_000 }).catch(() => undefined)
  const info = await page.evaluate(() => ({
    served: document.querySelector('meta[name="app-build"]')?.getAttribute('content') ?? '',
    framework: document.querySelector('[data-v-app]') ? 'vue' : document.querySelector('#root') ? 'react' : '?',
    origin: location.origin,
    hidden: document.hidden,
  }))
  const expected = buildKey(app)
  const cwd = opts.checkCwd === false ? null : listenCwd(app === 'react' ? PORTS.react : PORTS.vue)
  const rep: FreshReport = { app, ...info, expected, cwd }
  const problems: string[] = []
  if (!info.served) problems.push('빌드 표식(meta app-build)이 없다 — 하네스 설정 이전의 빌드를 서빙 중이다(pnpm e2e:stop → e2e:start)')
  else if (info.served !== expected) problems.push('스테일 서빙 — 서빙 중인 빌드 키가 지금 소스의 빌드 키와 다르다(소스를 고친 뒤 스택을 다시 띄우지 않았다)')
  if (info.framework !== app) problems.push(`앱 자기증명 실패 — ${app} 를 기대했는데 ${info.framework} 가 열렸다(${info.origin})`)
  if (cwd && !cwd.startsWith(REPO) && !cwd.includes('e2e-tmp')) problems.push(`서버 위치 — 포트를 LISTEN 하는 프로세스의 cwd(${cwd})가 이 워크트리(${REPO}) 밖이다`)
  if (info.hidden) problems.push('측정 탭이 숨은 상태(document.hidden) — 배경 탭 스로틀로 시간 측정이 틀어진다')
  if (problems.length) throw new StaleServingError(`[I26 스테일 서빙] ${app}\n  - ${problems.join('\n  - ')}\n  ${JSON.stringify(rep)}`)
  return rep
}
