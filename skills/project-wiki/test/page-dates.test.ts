// 쪽 머리말의 시작 버전(`since`) · 확인일(`verified_at`)을 묶음에 싣는다.
// 값이 없는 쪽과 옛 묶음(두 칸이 없는 chunks.jsonl)은 칸을 싣지 않는다.
// 묶음 형식(formatVersion)은 그대로다 — 조각에 선택 칸만 더했고, 읽는 쪽은 모르는 칸을 무시한다.
import { describe, expect, it } from './support/vitest-shim.ts'
import { FORMAT_VERSION } from '../src/core/model.ts'
import { WikiIndex } from '../src/core/search.ts'
import { buildIndex, FILES } from './helpers.ts'

const DATED = FILES['docs/wiki/feature/pivot.md'].replace('status: current\n', 'status: current\nsince: 1.12.0\nverified_at: 2026-11-10\n')
const PAGE = 'wiki:feature/pivot'

describe('쪽 머리말 since · verified_at', () => {
  it('머리말에 두 값이 있으면 그 쪽의 조각과 페이지 읽기 응답에 싣는다', () => {
    const { index, result } = buildIndex({ 'docs/wiki/feature/pivot.md': DATED })
    const chunks = index.chunks.filter((c) => c.page === PAGE)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.since === '1.12.0' && c.verifiedAt === '2026-11-10')).toBe(true)
    const r = index.read(PAGE, { cap: 'confidential' })
    expect(r).toMatchObject({ kind: 'page', since: '1.12.0', verifiedAt: '2026-11-10' })
    expect(result.manifest.formatVersion).toBe(FORMAT_VERSION)
    expect(FORMAT_VERSION).toBe(1)
  })

  it('값이 없는 쪽(다른 페이지 · 개발 문서)은 칸을 싣지 않는다', () => {
    const { index } = buildIndex({ 'docs/wiki/feature/pivot.md': DATED })
    const other = index.chunks.filter((c) => c.page !== PAGE)
    expect(other.some((c) => 'since' in c || 'verifiedAt' in c)).toBe(false)
    const r = index.read('dev:00-overview', { cap: 'confidential' })
    expect(r).not.toHaveProperty('since')
    expect(r).not.toHaveProperty('verifiedAt')
  })

  it('한 칸만 있으면 그 칸만 싣는다 · 빈 값은 없는 것으로 본다', () => {
    const onlySince = FILES['docs/wiki/feature/pivot.md'].replace('status: current\n', 'status: current\nsince: 1.13.0\nverified_at: ""\n')
    const r = buildIndex({ 'docs/wiki/feature/pivot.md': onlySince }).index.read(PAGE, { cap: 'confidential' })
    expect(r).toMatchObject({ since: '1.13.0' })
    expect(r).not.toHaveProperty('verifiedAt')
  })

  it('옛 묶음(두 칸이 없는 chunks.jsonl)도 그대로 읽고, 페이지 응답에 두 칸이 없다', () => {
    const { result } = buildIndex({ 'docs/wiki/feature/pivot.md': DATED })
    const files = new Map(result.files)
    const old = files
      .get('chunks.jsonl')!
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const { since: _s, verifiedAt: _v, ...rest } = JSON.parse(l) as Record<string, unknown>
        return JSON.stringify(rest)
      })
      .join('\n')
    files.set('chunks.jsonl', Buffer.from(`${old}\n`))
    const index = new WikiIndex(files, { skipVerify: true })
    const r = index.read(PAGE, { cap: 'confidential' })
    expect(r).toMatchObject({ kind: 'page', id: PAGE })
    expect(r).not.toHaveProperty('since')
    expect(r).not.toHaveProperty('verifiedAt')
  })
})
