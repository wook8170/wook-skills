// 「상태를 읽지 못한 결정 · 정책 문서」 기준 목록 잠금.
// 부르는 곳: cli/main.ts · cli/stale.ts. 먼저 읽을 파일: core/stale.ts.
// 머리말이 원래 없는 정책 문서들이 이 수를 늘 채우고 있어서, 수만 알리면 새로 생긴 문서 하나를 알아보기 어렵다.
// 그래서 지금 목록을 경로와 사유 종류로 잠그고, 목록에 없거나 사유가 달라진 문서가 생기면 출하를 막는다.
// 머리말 모양이 어긋난 문서와 심볼릭 링크 문서는 목록에 넣을 수 없고 늘 막는다. 목록에서 빠진 문서는 막지 않고 알린다.
import fs from 'node:fs'
import path from 'node:path'
import { BLOCK_REASON, type NoStatusKind, type StaleReport } from './stale.ts'
import { cmp } from './util.ts'

/** 목록에 적을 수 있는 사유 종류. 머리말 모양이 어긋난 문서(`misshapen`)와 심볼릭 링크(`link`)는 넣지 않는다. */
export type ListedReason = Exclude<NoStatusKind, 'misshapen' | 'link'>
export interface BaselineEntry {
  path: string
  reason: ListedReason
}

const LISTED: readonly string[] = ['no-frontmatter', 'no-status']
const LABEL: Record<NoStatusKind, string> = { 'no-frontmatter': '머리말 없음', 'no-status': 'status 없음', misshapen: '머리말 모양 어긋남', link: '심볼릭 링크' }

/** 빠진 경로를 지우는 명령과 새 경로를 더하는 명령. 알림 줄과 기준 파일에 적는다. */
export const RELOCK_HINT = 'wiki-index stale --config <설정> --update-baseline'
export const ACCEPT_HINT = 'wiki-index stale --config <설정> --accept-new <경로>'

export class BaselineError extends Error {}

/** 목록을 쓸 때와 견줄 때 경로 철자를 NFC 로 맞춘다. 디스크 철자가 NFD 인 머신에서 잠근 목록도 같은 문서로 본다. */
const nfc = (p: string) => p.normalize('NFC')

/**
 * 설정의 `noStatusBaseline` 칸을 확인하고 목록 파일의 절대 경로를 돌려준다.
 * 칸이 없으면 `required`(출하 관문)일 때 오류, 아니면 null(잠금 없이 판정만 한다). 칸이 있는데 비지 않은 문자열이 아니면 늘 오류다.
 */
export function baselinePath(cfg: object, cfgPath: string, required: boolean): string | null {
  if (!('noStatusBaseline' in cfg)) {
    if (required) throw new BaselineError('설정에 noStatusBaseline 칸이 없다 — 출하 관문은 상태를 읽지 못한 문서의 기준 목록 없이 돌지 않는다(칸 이름 철자도 확인)')
    return null
  }
  const v = (cfg as { noStatusBaseline: unknown }).noStatusBaseline
  if (typeof v !== 'string' || !v.trim()) throw new BaselineError(`설정의 noStatusBaseline 은 목록 파일 경로(비지 않은 문자열)여야 한다(지금 ${JSON.stringify(v)})`)
  return path.resolve(path.dirname(cfgPath), v)
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new BaselineError(`기준 목록 파일을 JSON 으로 읽지 못했다: ${file} (${e instanceof Error ? e.message : String(e)})`)
  }
}

function toEntry(v: unknown, i: number, file: string): BaselineEntry {
  const e = (v ?? {}) as { path?: unknown; reason?: unknown }
  if (typeof e.path !== 'string' || !e.path || typeof e.reason !== 'string' || !LISTED.includes(e.reason)) {
    throw new BaselineError(`기준 목록 파일의 entries[${i}] 가 { path, reason: no-frontmatter | no-status } 꼴이 아니다: ${file}`)
  }
  return { path: nfc(e.path), reason: e.reason as ListedReason }
}

/** 기준 목록 파일을 읽는다. 없거나 꼴이 틀리거나 옛 형식(경로만)이면 오류(종료 코드 2)로 끝낸다. */
export function readBaseline(file: string): BaselineEntry[] {
  if (!fs.existsSync(file)) throw new BaselineError(`상태를 읽지 못한 문서의 기준 목록 파일이 없다: ${file} — ${RELOCK_HINT} 로 만든다`)
  const raw = parseJson(file)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BaselineError(`기준 목록 파일의 꼴이 틀렸다(객체가 아님): ${file}`)
  const o = raw as { schema?: unknown; paths?: unknown; entries?: unknown }
  if ('paths' in o || o.schema !== 2) {
    throw new BaselineError(`기준 목록 파일이 옛 형식(경로만 적은 목록)이거나 schema 가 2 가 아니다: ${file} — 항목마다 path 와 reason(no-frontmatter · no-status)을 적은 schema 2 로 옮긴다`)
  }
  if (!Array.isArray(o.entries)) throw new BaselineError(`기준 목록 파일의 entries 가 목록이 아니다: ${file}`)
  const entries = o.entries.map((v, i) => toEntry(v, i, file))
  const dup = entries.find((e, i) => entries.findIndex((x) => x.path === e.path) !== i)
  if (dup) throw new BaselineError(`기준 목록 파일에 같은 경로가 두 번 있다: ${dup.path}`)
  return entries
}

/** 목록을 경로 순서로 쓴다. */
function writeBaseline(file: string, entries: BaselineEntry[]): void {
  const sorted = [...entries].sort((a, b) => cmp(a.path, b.path))
  const note = `상태(status)를 읽지 못한 결정 · 정책 문서의 기준 목록. reason: no-frontmatter(머리말 없음) · no-status(status 없음). 빠진 경로 지우기: ${RELOCK_HINT} · 새 경로 더하기: ${ACCEPT_HINT}`
  fs.writeFileSync(file, JSON.stringify({ schema: 2, note, entries: sorted }, null, 2) + '\n')
}

/** 더할 경로를 확인한다. 지금 상태를 읽지 못한 문서가 아니거나 머리말 모양이 어긋났으면 오류다. */
function acceptable(raw: string, now: Map<string, NoStatusKind>): BaselineEntry {
  const p = nfc(raw.replace(/^\.\//, ''))
  const kind = now.get(p)
  if (!kind) throw new BaselineError(`--accept-new ${raw}: 지금 상태를 읽지 못한 결정 · 정책 문서가 아니다 — 목록에 더하지 않는다`)
  if (kind === 'misshapen') throw new BaselineError(`--accept-new ${raw}: 머리말 모양이 어긋난 문서는 목록에 더하지 않는다 — 머리말 모양(첫 줄 \`---\`)을 고친다`)
  if (kind === 'link') throw new BaselineError(`--accept-new ${raw}: 심볼릭 링크 문서는 목록에 더하지 않는다 — 링크를 실제 파일로 바꾼다`)
  return { path: p, reason: kind }
}

/**
 * 목록을 고쳐 쓴다. 지금 세지 않는 경로(빠진 문서)는 지운다. 새 경로와 사유가 바뀐 경로는 `acceptNew` 로 준 것만 더한다.
 * 더할 경로를 모두 확인한 뒤에 쓰므로, 하나라도 틀리면 파일은 그대로다. 지운 경로 · 더한 경로 · 사유를 바꾼 경로를 `log` 로 알린다.
 */
export function updateBaseline(file: string, report: StaleReport, acceptNew: string[], log: (s: string) => void): BaselineEntry[] {
  const now = new Map(report.noStatusList.map((d) => [nfc(d.path), d.kind]))
  const added = acceptNew.map((raw) => acceptable(raw, now))
  const old = fs.existsSync(file) ? readBaseline(file) : []
  const kept = old.filter((e) => now.has(e.path))
  for (const e of old) if (!now.has(e.path)) log(`기준 목록에서 지움: ${e.path}`)
  const byPath = new Map(kept.map((e) => [e.path, e]))
  for (const e of added) {
    const was = byPath.get(e.path)?.reason
    byPath.set(e.path, e)
    // 목록에 든 문서의 사유를 바꾸면 그 사실을 따로 적는다. 새 경로를 더하는 줄과 구분해 검토할 수 있게 한다.
    if (!was) log(`기준 목록에 더함: ${e.path} (${LABEL[e.reason]})`)
    else if (was !== e.reason) log(`기준 목록의 사유를 바꿈: ${e.path} (${LABEL[was]} → ${LABEL[e.reason]})`)
    else log(`기준 목록에 이미 같은 사유로 있음: ${e.path} (${LABEL[e.reason]})`)
  }
  const entries = [...byPath.values()]
  writeBaseline(file, entries)
  return entries
}

/** 이 문서를 막을 사유. 막지 않으면 null. */
function blockReason(kind: NoStatusKind, listed: ListedReason | undefined): string | null {
  if (kind === 'misshapen') return BLOCK_REASON.headMisshapen
  if (kind === 'link') return BLOCK_REASON.link
  if (!listed) return BLOCK_REASON.noStatusNew
  return listed === kind ? null : BLOCK_REASON.noStatusChanged(LABEL[listed], LABEL[kind])
}

/** 차단 목록에 싣는다. 이미 다른 사유로 막힌 문서면 그 줄에 사유를 덧붙인다. */
function addBlock(report: StaleReport, d: { id: string; title: string }, reason: string): void {
  const hit = report.block.find((b) => b.id === d.id)
  if (hit) hit.reason = `${hit.reason} · ${reason.replace('출하 차단 — ', '')}`
  else report.block.push({ id: d.id, title: d.title, reason })
}

/**
 * 기준 목록과 견준다. 목록에 없거나 사유가 다르거나 머리말 모양이 어긋난 문서는 출하 차단에 싣는다.
 * 목록에 있는데 지금 세지 않는 문서는 `noStatusGone` 에 세고 다시 잠그라는 경고 한 줄을 남긴다.
 */
export function lockNoStatus(report: StaleReport, baseline: BaselineEntry[]): void {
  const listed = new Map(baseline.map((e) => [nfc(e.path), e.reason]))
  const now = new Set(report.noStatusList.map((d) => nfc(d.path)))
  for (const d of report.noStatusList) {
    const reason = blockReason(d.kind, listed.get(nfc(d.path)))
    if (reason) addBlock(report, d, reason)
  }
  report.block.sort((a, b) => cmp(a.id, b.id))
  report.noStatusGone = baseline.filter((e) => !now.has(nfc(e.path))).length
  if (report.noStatusGone) report.warnings.push(`상태를 읽지 못한 문서의 기준 목록에서 ${report.noStatusGone}편이 빠짐 — 기준을 다시 잠그세요(${RELOCK_HINT})`)
}
