import { describe, expect, it } from './support/vitest-shim.ts'
import { isReadError } from '../src/core/search.ts'
import { handleRpc } from '../src/mcp/server.ts'
import { WIKI_TOOLS, callWikiTool } from '../src/mcp/tools.ts'
import { openBundle } from '../src/index.ts'
import { writeBundleDir, packBundle } from '../src/core/bundle.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildIndex } from './helpers.ts'

const { index, result } = buildIndex()

describe('검색 · 읽기 · 역링크(라이브러리 API)', () => {
  it('등급 상한 사내: 대외비 조각은 결과에 없고 건수만 센다', () => {
    const r = index.search({ q: '압축 레이아웃 공용 DB 배포 번들', cap: 'internal', limit: 50 })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits.every((h) => h.level === 'internal')).toBe(true)
    expect(r.filteredCount).toBeGreaterThan(0)
  })

  it('읽기: 대외비 조각을 사내 상한으로 읽으면 wiki_level_required', () => {
    const r = index.read('dev:00-overview#구성', { cap: 'internal' })
    expect(isReadError(r) && r.error).toBe('wiki_level_required')
    const ok = index.read('dev:00-overview#구성', { cap: 'confidential', context: true })
    expect(isReadError(ok)).toBe(false)
    if (!isReadError(ok)) expect(ok.context?.next?.id).toBe('dev:00-overview#배포')
  })

  it('읽기: 페이지 ID 는 페이지 전체, 옛 ID 는 새 ID 로 풀린다', () => {
    const p = index.read('wiki:old-pivot', { cap: 'internal' })
    expect(isReadError(p)).toBe(false)
    if (!isReadError(p)) {
      expect(p.kind).toBe('page')
      expect(p.resolvedFrom).toBe('wiki:old-pivot')
      expect(p.chunks?.map((c) => c.id)).toContain('wiki:feature/pivot#현재-답')
    }
  })

  it('역링크: 볼 수 없는 등급의 가리키는 곳은 건수만', () => {
    const all = index.backlinks('code:apps/server/src/app.ts', { cap: 'confidential' })
    expect(all.backlinks.ref?.count).toBeGreaterThan(0)
    const low = index.backlinks('code:apps/server/src/app.ts', { cap: 'internal' })
    expect(low.backlinks.ref).toBeUndefined()
    expect(low.filteredCount).toBeGreaterThan(0)
    expect(index.backlinks('code:없는/파일.ts', { cap: 'confidential' }).note).toBe('대상 없음')
  })

  it('openBundle: 폴더 · tar.gz 를 열고, 해시가 틀리면 열지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-open-'))
    writeBundleDir(path.join(dir, 'b'), result.files, result.manifest)
    fs.writeFileSync(path.join(dir, 'b.tar.gz'), packBundle(result.files))
    expect(openBundle(path.join(dir, 'b')).chunks.length).toBe(index.chunks.length)
    expect(openBundle(path.join(dir, 'b.tar.gz')).chunks.length).toBe(index.chunks.length)
    fs.appendFileSync(path.join(dir, 'b', 'chunks.jsonl'), '\n')
    expect(() => openBundle(path.join(dir, 'b'))).toThrow(/hash_mismatch/)
  })
})

describe('MCP 도구 3종', () => {
  const rpc = (method: string, params?: Record<string, unknown>, cap: 'internal' | 'confidential' = 'internal', areas?: string[]) =>
    handleRpc(index, { cap, areas }, { jsonrpc: '2.0', id: 1, method, params }) as { result: { structuredContent?: Record<string, unknown>; isError?: boolean; tools?: unknown[] } }

  it('initialize · tools/list', () => {
    expect((rpc('initialize', { protocolVersion: '2025-06-18' }).result as unknown as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
    const names = (rpc('tools/list').result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toEqual(['wiki_search', 'wiki_read', 'wiki_backlinks'])
    expect(handleRpc(index, { cap: 'internal' }, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('범위를 넓히는 인자(level · bundle · cap)는 실행하지 않고 거절한다', () => {
    for (const extra of [{ level: 'confidential' }, { bundle: 'x' }, { cap: 'confidential' }]) {
      const r = rpc('tools/call', { name: 'wiki_search', arguments: { q: '배포', ...extra } })
      expect(r.result.isError).toBe(true)
      expect(r.result.structuredContent?.error).toBe('scope_override_rejected')
    }
  })

  it('wiki_search 출력 모양과 등급 거르기', () => {
    const r = rpc('tools/call', { name: 'wiki_search', arguments: { q: '압축 레이아웃 배포', limit: 20 } })
    const res = r.result.structuredContent as { results: Array<{ level: string; id: string; part: string; source: string }>; filtered_count: number }
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results.every((x) => x.level === 'internal')).toBe(true)
    expect(res.results[0]).toHaveProperty('source')
    expect(res.filtered_count).toBeGreaterThan(0)
  })

  it('wiki_read 대외비 → wiki_level_required, 사내 → 본문', () => {
    const denied = rpc('tools/call', { name: 'wiki_read', arguments: { id: 'dev:00-overview#구성' } })
    expect(denied.result.structuredContent?.error).toBe('wiki_level_required')
    const ok = rpc('tools/call', { name: 'wiki_read', arguments: { id: 'wiki:feature/pivot#현재-답', context: 1 } })
    expect(ok.result.isError).toBeUndefined()
    expect((ok.result.structuredContent as { text: string }).text).toContain('한 열 계층')
  })

  it('영역 제한은 도구 인자로 넓힐 수 없다', () => {
    const r = callWikiTool(index, 'wiki_search', { q: '압축 결정', areas: ['feature', 'ops'] }, { cap: 'confidential', areas: ['decision'] }) as { results: Array<{ id: string }> }
    expect(r.results.every((x) => x.id.startsWith('decision:'))).toBe(true)
  })

  it('{ cap } 만 준 범위의 결과는 라이브러리 API 결과와 같고, 본문에 기준 줄이 없다', () => {
    const cap = 'internal' as const
    expect(callWikiTool(index, 'wiki_read', { id: 'wiki:feature/pivot' }, { cap })).toEqual(index.read('wiki:feature/pivot', { cap }))
    expect(callWikiTool(index, 'wiki_backlinks', { target: 'code:apps/server/src/app.ts' }, { cap })).toEqual(index.backlinks('code:apps/server/src/app.ts', { cap, limit: 20 }))
    const s = callWikiTool(index, 'wiki_search', { q: '압축 레이아웃 배포' }, { cap }) as { results: unknown[]; total: number }
    expect(s.total).toBe(index.search({ q: '압축 레이아웃 배포', cap }).total)
    const r = rpc('tools/call', { name: 'wiki_search', arguments: { q: '압축 레이아웃 배포' } }) as unknown as { result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown> } }
    expect(JSON.parse(r.result.content[0].text)).toEqual(r.result.structuredContent)
    expect(r.result.structuredContent).not.toHaveProperty('basis')
  })

  it('인자 형식 오류', () => {
    const r = rpc('tools/call', { name: 'wiki_search', arguments: { q: '', limit: 99 } })
    expect(r.result.structuredContent?.error).toBe('invalid_arguments')
    expect(WIKI_TOOLS.every((t) => (t.inputSchema as { additionalProperties: boolean }).additionalProperties === false)).toBe(true)
  })
})
