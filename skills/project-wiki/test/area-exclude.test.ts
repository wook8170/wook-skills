// 영역 제외(excludeAreas) — 검색 · 읽기 · 역링크가 같은 판정(core/scope.ts)을 쓰는지.
import { describe, expect, it } from './support/vitest-shim.ts'
import { areaAllowed } from '../src/core/scope.ts'
import { isReadError } from '../src/core/search.ts'
import { callWikiTool, type ToolScope } from '../src/mcp/tools.ts'
import { FILES, buildIndex } from './helpers.ts'

// ops 페이지가 피벗 페이지와 그 첫 절을 가리키게 한다. 그래서 역링크 세 경로에 ops 가 나온다.
const OPS_LINKS = `${FILES['docs/wiki/ops/trap.md']}\n관련: [[wiki:feature/pivot]] 와 [피벗](../feature/pivot.md#현재-답)\n`
const { index } = buildIndex({ 'docs/wiki/ops/trap.md': OPS_LINKS })
const OPS_CHUNK = 'wiki:ops/trap#기본-주소'
const ALL: ToolScope = { cap: 'confidential' }
const NO_OPS: ToolScope = { cap: 'confidential', excludeAreas: ['ops'] }

type Backlinks = { backlinks: Record<string, { top: Array<{ id: string; title: string }> }>; filteredCount: number }
const ids = (r: Backlinks): string[] => Object.values(r.backlinks).flatMap((k) => k.top.map((t) => t.id))
const titles = (r: Backlinks): string[] => Object.values(r.backlinks).flatMap((k) => k.top.map((t) => t.title))

describe('areaAllowed', () => {
  it('제외 영역은 막고, area 가 없는 조각은 보인다', () => {
    expect(areaAllowed('ops', { excludeAreas: ['ops'] })).toBe(false)
    expect(areaAllowed('feature', { excludeAreas: ['ops'] })).toBe(true)
    expect(areaAllowed(undefined, { excludeAreas: ['ops'] })).toBe(true)
    expect(areaAllowed(undefined, { areas: ['ops'] })).toBe(false)
    expect(areaAllowed('ops', {})).toBe(true)
  })
})

describe('excludeAreas: ops', () => {
  it('wiki_search 에 ops 조각이 없다', () => {
    const before = callWikiTool(index, 'wiki_search', { q: '공용 DB 전용 컨테이너', limit: 20 }, ALL) as { results: Array<{ id: string }> }
    expect(before.results.map((r) => r.id)).toContain(OPS_CHUNK)
    const after = callWikiTool(index, 'wiki_search', { q: '공용 DB 전용 컨테이너', limit: 20 }, NO_OPS) as { results: Array<{ id: string }> }
    expect(after.results.map((r) => r.id)).not.toContain(OPS_CHUNK)
  })

  it('wiki_search 가 areas: ["ops"] 로 되살리지 못한다(빈 결과)', () => {
    const r = callWikiTool(index, 'wiki_search', { q: '공용 DB', areas: ['ops'] }, NO_OPS) as { results: unknown[] }
    expect(r.results).toEqual([])
  })

  it('wiki_read 의 ops 조각 · 페이지 ID 는 not_found', () => {
    for (const id of [OPS_CHUNK, 'wiki:ops/trap']) {
      expect(() => callWikiTool(index, 'wiki_read', { id }, NO_OPS)).toThrow(expect.objectContaining({ code: 'not_found' }))
      expect(isReadError(index.read(id, { cap: 'confidential', excludeAreas: ['ops'] }))).toBe(true)
    }
  })
})

describe('area 가 없는 조각', () => {
  it('excludeAreas 에 걸리지 않고 검색 · 읽기에 보인다', () => {
    const local = buildIndex().index
    const c = local.chunks.find((x) => x.id === 'dev:00-overview#배포')!
    delete c.area
    const r = local.search({ q: '배포 번들', cap: 'confidential', excludeAreas: ['ops', 'dev-doc'] })
    expect(r.hits.map((h) => h.id)).toContain(c.id)
    expect(isReadError(local.read(c.id, { cap: 'confidential', excludeAreas: ['dev-doc'] }))).toBe(false)
  })
})

describe('역링크 세 경로', () => {
  it('wiki_backlinks: ops 제목 · ID 가 없고 filteredCount 가 1 늘어난다(회귀: 전에는 영역을 보지 않았다)', () => {
    const all = callWikiTool(index, 'wiki_backlinks', { target: 'wiki:feature/pivot' }, ALL) as Backlinks
    const no = callWikiTool(index, 'wiki_backlinks', { target: 'wiki:feature/pivot' }, NO_OPS) as Backlinks
    expect(ids(all)).toContain(OPS_CHUNK)
    expect(ids(no)).not.toContain(OPS_CHUNK)
    expect(titles(no).some((t) => t.includes('시험 DB 함정'))).toBe(false)
    expect(no.filteredCount).toBe(all.filteredCount + 1)
  })

  it('페이지 읽기(wiki_read 페이지 ID): ops 가 빠지고 filteredCount +1', () => {
    const all = callWikiTool(index, 'wiki_read', { id: 'wiki:feature/pivot' }, ALL) as Backlinks
    const no = callWikiTool(index, 'wiki_read', { id: 'wiki:feature/pivot' }, NO_OPS) as Backlinks
    expect(ids(all)).toContain(OPS_CHUNK)
    expect(ids(no)).not.toContain(OPS_CHUNK)
    expect(no.filteredCount).toBe(all.filteredCount + 1)
  })

  it('조각 읽기(wiki_read 조각 ID): ops 가 빠지고 filteredCount +1', () => {
    const all = callWikiTool(index, 'wiki_read', { id: 'wiki:feature/pivot#현재-답' }, ALL) as Backlinks
    const no = callWikiTool(index, 'wiki_read', { id: 'wiki:feature/pivot#현재-답' }, NO_OPS) as Backlinks
    expect(ids(all)).toContain(OPS_CHUNK)
    expect(ids(no)).not.toContain(OPS_CHUNK)
    expect(no.filteredCount).toBe(all.filteredCount + 1)
  })

  it('areas 범위도 wiki_backlinks 에 적용된다', () => {
    const r = callWikiTool(index, 'wiki_backlinks', { target: 'wiki:feature/pivot' }, { cap: 'confidential', areas: ['decision'] }) as Backlinks
    expect(ids(r)).toEqual(['decision:D-83#결정'])
  })
})
