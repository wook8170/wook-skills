// `wiki-index mark-synced`: 근거를 확인한 문서의 기준 커밋 칸을 지금 HEAD 로 쓴다. 파일만 고치고 커밋하지 않는다.
// 부르는 곳: cli/main.ts · cli/stale.ts. 먼저 읽을 파일: core/stale.ts.
// 위키 페이지는 머리말 `base_commit`, 그 밖의 형식은 어댑터 묶음의 writeBaseCommit 이 쓴다.
// 출하 차단 대상 페이지에 써도 따로 기록을 남기지 않고 값만 쓴다.
import fs from 'node:fs'
import path from 'node:path'
import type { AdapterPack } from './adapter.ts'
import type { SourceUnit } from './model.ts'
import { editKeepingEol, frontmatterClose } from './util.ts'

export class MarkSyncedError extends Error {}

/**
 * 머리말의 한 칸을 쓴다. 칸이 있으면 값을 바꾸고, 없으면 닫는 `---` 앞에 더한다. 머리말이 없으면 새로 만든다.
 * 머리말이 닫히지 않았으면 고치지 않고 오류로 끝낸다. 새 머리말을 앞에 붙이면 다음 실행 때 또 붙기 때문이다.
 * CRLF 문서는 고친 줄도 CRLF 로 쓰고, BOM 으로 시작하는 문서는 BOM 을 지킨다.
 */
export function setFrontmatterField(markdown: string, key: string, value: string): string {
  return editKeepingEol(markdown, (md) => setFrontmatterFieldLf(md, key, value))
}

function setFrontmatterFieldLf(markdown: string, key: string, value: string): string {
  const line = `${key}: "${value}"`
  const lines = markdown.split('\n')
  const end = frontmatterClose(lines)
  if (end === null) return `---\n${line}\n---\n${markdown}`
  if (end < 0) throw new MarkSyncedError('머리말이 닫히지 않았다(코드 블록 밖에 닫는 --- 줄이 없다)')
  const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}\\s*:`).test(l))
  if (at >= 0) lines[at] = line
  else lines.splice(end, 0, line)
  return lines.join('\n')
}

/** 한 문서의 원문에 기준 커밋을 쓴 결과. 쓸 수 없는 원천(설계 산출물 등)이면 null. */
export function writeBaseCommit(u: SourceUnit, markdown: string, sha: string, pack: AdapterPack): string | null {
  const custom = pack.writeBaseCommit?.(u, markdown, sha)
  if (custom !== undefined) return custom
  return u.part === 'dd' ? null : setFrontmatterField(markdown, 'base_commit', sha)
}

export interface MarkSyncedInput {
  repoRoot: string
  /** 저장소 기준 상대 경로 또는 절대 경로. */
  paths: string[]
  units: SourceUnit[]
  pack: AdapterPack
  /** 쓸 커밋(`git rev-parse HEAD`). */
  head: string
}

/**
 * 모든 문서를 먼저 확인하고, 하나라도 쓸 수 없으면 아무 파일도 고치지 않는다. 고친 문서 경로를 돌려준다.
 * 설정 원천에 없는 문서 · 기준 커밋을 쓸 수 없는 원천 · 머리말 모양이 어긋난 문서는 쓸 수 없다.
 */
export function markSynced(i: MarkSyncedInput): string[] {
  const byPath = new Map(i.units.map((u) => [u.path, u]))
  const plan: Array<{ abs: string; rel: string; text: string }> = []
  for (const p of i.paths) {
    const abs = path.resolve(i.repoRoot, p)
    const rel = path.relative(i.repoRoot, abs).split(path.sep).join('/')
    const u = byPath.get(rel)
    if (!u) throw new MarkSyncedError(`설정 원천에 없는 문서: ${rel}`)
    // 모양이 어긋난 머리말 앞에 새 머리말을 붙이면 원래 머리말이 본문이 되어 차단이 사라진다. 그래서 거절한다.
    if (u.headMisshapen || u.headMisspelled) throw new MarkSyncedError(`머리말 모양이 어긋난 문서: ${rel} — 머리말 모양(첫 줄 \`---\`)을 먼저 고친다`)
    const text = writeBaseCommit(u, fs.readFileSync(abs, 'utf8'), i.head, i.pack)
    if (text === null) throw new MarkSyncedError(`기준 커밋을 쓸 수 없는 원천: ${rel}`)
    plan.push({ abs, rel, text })
  }
  for (const w of plan) fs.writeFileSync(w.abs, w.text)
  return plan.map((w) => w.rel)
}
