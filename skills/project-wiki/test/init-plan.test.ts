// init 판정(init/plan.ts): 파일 목록에서 문서 폴더 · 영역 하위 폴더 · 맨 위 문서 · 그 밖 문서를 원천으로 나누는지 본다.
import { describe, expect, it } from './support/vitest-shim.ts'
import { bundleNameOf, planWiki } from '../src/init/plan.ts'
import { isIndexCurrent } from '../src/dev/refresh.ts'

const FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/guide.md',
  'docs/adr/0001-cache.md',
  'docs/ops/restart.md',
  'design/screens.md',
  'packages/core/README.md',
  'packages/core/node_modules/x/README.md',
  'dist/out.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'src/index.ts',
]

describe('planWiki', () => {
  const plan = planWiki('My Repo', FILES)
  const byName = Object.fromEntries(plan.sources.map((s) => [s.name, s]))

  it('문서 폴더는 원천 하나, 영역 하위 폴더(adr · ops)는 영역을 단 원천으로 뗀다', () => {
    expect(Object.keys(byName).sort()).toEqual(['design', 'docs', 'docs-adr', 'docs-ops', 'other', 'root'])
    expect(byName['docs-adr']).toMatchObject({ root: 'docs/adr', area: 'decision', files: 1 })
    expect(byName['docs-ops']).toMatchObject({ root: 'docs/ops', area: 'ops', files: 1 })
    expect(byName.docs.files).toBe(1)
    expect(byName.docs.exclude).toContain('docs/adr/**')
    expect(byName.design).toMatchObject({ area: 'design', files: 1 })
  })

  it('맨 위 문서는 root, 그 밖 폴더의 문서는 other 로 모으고 의존성 · 산출물 · 숨김 폴더는 뺀다', () => {
    expect(byName.root).toMatchObject({ include: ['*.md'], files: 2 })
    expect(byName.other.files).toBe(1)
    expect(byName.other.exclude).toEqual(expect.arrayContaining(['docs/**', 'design/**', '*.md', '**/node_modules/**', '**/dist/**']))
  })

  it('설정 기본값: 등급 internal · 상한 confidential · 비밀값 격리 · 원천마다 이름공간', () => {
    expect(plan.config.bundle.name).toBe('my-repo')
    expect(plan.config.security).toEqual({ maxLevel: 'confidential', excludePaths: ['**/.env*'], onSecret: 'quarantine' })
    expect(plan.config.sources.every((s) => s.level === 'internal' && s.adapter === 'markdown')).toBe(true)
    expect(new Set(plan.config.sources.map((s) => s.idNamespace)).size).toBe(plan.config.sources.length)
  })

  it('Markdown 이 없으면 원천이 비고, 묶음 이름은 규칙에 맞게 고친다', () => {
    expect(planWiki('x', ['src/a.ts']).sources).toEqual([])
    expect(bundleNameOf('__한글만__')).toBe('project-wiki')
    expect(bundleNameOf('A'.repeat(60))).toHaveLength(40)
  })
})

describe('isIndexCurrent', () => {
  const sig = { tree: 'abc', outside: 0 }
  it('묶음이 있고 지난 신호가 같을 때만 최신이다', () => {
    expect(isIndexCurrent(true, sig, { ...sig })).toBe(true)
    expect(isIndexCurrent(false, sig, sig)).toBe(false)
    expect(isIndexCurrent(true, undefined, sig)).toBe(false)
    expect(isIndexCurrent(true, sig, { tree: 'abd', outside: 0 })).toBe(false)
  })
})
