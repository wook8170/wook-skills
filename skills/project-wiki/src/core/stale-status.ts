// 결정 · 정책 문서의 상태(`status`) 표기를 점검한다. 낡음 판정(`stale.ts`)이 판정을 마친 뒤 부른다.
// 부르는 곳: cli/stale.ts · core/stale.ts. 먼저 읽을 파일: core/stale.ts.
// 상태를 읽지 못한 문서는 출하 차단 대상에서 빠지므로 수와 경고 줄로 알리고, 기준 목록 잠금(`stale-baseline.ts`)에 넘긴다.
import type { SourceUnit } from './model.ts'
import type { NoStatusKind, StaleReport } from './stale.ts'
import { frontmatterClose } from './util.ts'

const isDecisionOrPolicy = (area: string | undefined) => area === 'decision' || area === 'policy'

/** 머리말이 아예 없는가(첫 줄이 `---` 가 아님). 문서 앞 BOM 은 떼고 본다. */
const noFrontmatter = (u: SourceUnit) => frontmatterClose(u.markdown.replace(/^﻿/, '').split('\n')) === null

/**
 * 상태를 읽지 못한 문서를 센다. 사유 종류는 셋이다.
 * - `misshapen`: 머리말 모양이 어긋났거나(`headMisshapen`) area · category · status 표기가 어긋났다(`headMisspelled`).
 *   영역을 머리말에서 읽는 원천은 이때 결정 문서인지 알 수 없으므로 영역과 관계없이 센다. 기준 목록에 넣을 수 없다.
 * - `no-frontmatter`: 영역이 결정 · 정책인데 머리말이 없다.
 * - `no-status`: 영역이 결정 · 정책이고 머리말도 있는데 `status` 가 없다.
 * `status` 값이 정한 낱말 밖이거나 `Current` 처럼 대소문자만 다르면 `headMisspelled` 로 센다(`head-shape.ts`).
 * 그 밖에 `status` 를 읽은 결정 · 정책 문서는 값에 대문자가 있는지(`Draft` 등)만 본다. 판정은 바꾸지 않고 알림 한 줄을 낸다.
 * `status` 를 두 번 적은 문서는 `headMisshapen` 으로 센다(`head-shape.ts` `unreadStateLine`).
 */
export function countNoStatus(units: SourceUnit[], report: StaleReport): void {
  for (const u of units) {
    const known = isDecisionOrPolicy(u.area)
    if (u.headMisshapen) addNoStatus(u, report, 'misshapen', '머리말 모양이 어긋나 영역 · status 를 읽지 못함(결정 · 정책 문서라면 출하 차단 대상에서 빠짐)')
    else if (u.headMisspelled) addNoStatus(u, report, 'misshapen', '머리말의 area · category · status 표기가 어긋나 차단 대상으로 읽지 못함(대소문자 · 공백 · area 와 category · 값이 정한 낱말인지 확인)')
    else if (known && u.status === undefined) addNoStatus(u, report, noFrontmatter(u) ? 'no-frontmatter' : 'no-status', '결정 · 정책 문서인데 status 를 읽지 못함(출하 차단 대상에서 빠짐)')
    else if (known) noteStatusSpelling(u, report)
  }
}

/**
 * 원천 글롭에 맞지만 심볼릭 링크라서 읽지 않은 문서를 센다. 영역 · 상태를 읽을 수 없으므로 영역과 관계없이 센다.
 * 사유 종류 `link` 는 기준 목록에 넣을 수 없고, 기준 목록과 견줄 때 늘 막는다(`stale-baseline.ts`).
 */
export function countLinks(paths: string[], report: StaleReport): void {
  for (const p of paths) {
    report.noStatusDocs++
    report.noStatusList.push({ path: p, id: p, title: p, kind: 'link' })
    report.warnings.push(`${p}: 문서가 심볼릭 링크라 영역 · status 를 읽지 못함(링크를 실제 파일로 바꾸세요)`)
  }
}

function addNoStatus(u: SourceUnit, report: StaleReport, kind: NoStatusKind, why: string): void {
  report.noStatusDocs++
  report.noStatusList.push({ path: u.path, id: u.page, title: u.title, kind })
  report.warnings.push(`${u.path}: ${why}`)
}

function noteStatusSpelling(u: SourceUnit, report: StaleReport): void {
  const s = u.status!
  if (s !== s.toLowerCase()) report.warnings.push(`${u.path}: status 값 「${s}」에 대문자가 있음(대소문자를 가려 판정하므로 차단 대상은 소문자 「current」만이다)`)
}
