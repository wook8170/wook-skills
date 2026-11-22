// 영역 가중(AREA_WEIGHT): 시험 시나리오 매트릭스(testing)는 같은 점수면 다른 영역 뒤로 가고, 직접 물으면 그대로 나온다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { corePack } from '../src/index.ts'
import { buildBundle, normalizeConfig } from '../src/core/build.ts'
import { AREA_WEIGHT, WikiIndex } from '../src/core/search.ts'

const BODY = '# 임베딩 키\n\n## 권한\n\n임베딩 키는 읽기 전용이고 권한은 뷰어로 고정한다.\n'

function buildIndex(): WikiIndex {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-area-weight-'))
  const files: Record<string, string> = {
    // 경로 순서로는 시험 문서가 먼저다. 가중이 없으면 같은 점수에서 시험 문서가 앞에 온다.
    'docs/a-e2e/dash.md': BODY,
    'docs/b-guide/embed.md': BODY,
    'docs/a-e2e/admin.md': '# 관리 화면 시나리오\n\n## 시나리오 매트릭스\n\nE2E-admin-1074 위키 없는 ID 주소를 열면 찾지 못했다고 보인다.\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), body)
  }
  const config = normalizeConfig({
    schema: 1,
    bundle: { name: 'area-weight', title: '영역 가중' },
    pack: 'core',
    sources: [
      { adapter: 'markdown', root: 'docs', include: ['docs/a-e2e/*.md'], level: 'internal' as never, area: 'testing', idNamespace: 'doc' },
      { adapter: 'markdown', root: 'docs', include: ['docs/b-guide/*.md'], level: 'internal' as never, area: 'guide', idNamespace: 'doc' },
    ],
  })
  try {
    const r = buildBundle(config, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0' } })
    return new WikiIndex(r.files)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
}

describe('영역 가중', () => {
  const index = buildIndex()

  it('같은 본문이면 testing 영역 조각이 낮은 점수로 뒤에 온다', () => {
    const hits = index.search({ q: '임베딩 키 권한 뷰어', cap: 'internal' }).hits.filter((h) => h.id.includes('#권한'))
    expect(hits.map((h) => h.area)).toEqual(['guide', 'testing'])
    // 근접 가산은 가중 뒤에 더하므로 비율은 정확히 가중값이 아니다. 낮은 점수인지만 본다.
    expect(AREA_WEIGHT.testing).toBeLessThan(1)
    expect(hits[1].score).toBeLessThan(hits[0].score)
  })

  it('시험 시나리오를 직접 물으면 testing 조각이 그대로 맨 앞에 나온다', () => {
    const hits = index.search({ q: '관리 화면 위키 시나리오 매트릭스', cap: 'internal' }).hits
    expect(hits[0]?.id).toMatch(/^doc:a-e2e\/admin#/)
    expect(hits[0]?.area).toBe('testing')
  })
})
