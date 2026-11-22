import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { corePack } from '../src/index.ts'
import { ConfigError, DirtyError, SecurityError, buildBundle, normalizeConfig } from '../src/core/build.ts'
import { packBundle, verifyBundle } from '../src/core/bundle.ts'
import type { Manifest } from '../src/core/model.ts'
import { CONFIG, buildIndex, makeRepo } from './helpers.ts'

const GH_KEY = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')

describe('묶음 만들기', () => {
  it('형식 검증을 통과하고, 원천별 등급 기본값을 따른다', () => {
    const { result, index } = buildIndex()
    expect(verifyBundle(result.files).ok).toBe(true)
    const byPath = (p: string) => index.chunks.filter((c) => c.source.path.startsWith(p))
    expect(byPath('docs/guide/').every((c) => c.level === 'confidential')).toBe(true)
    expect(byPath('docs/wiki/ops/').every((c) => c.level === 'confidential')).toBe(true)
    expect(byPath('docs/wiki/feature/').every((c) => c.level === 'internal')).toBe(true)
    expect(byPath('docs/decisions/').every((c) => c.level === 'internal')).toBe(true)
    expect(result.manifest.formatVersion).toBe(1)
    expect(result.files.has('pages/docs/guide/00-overview.md')).toBe(true)
  })

  it('--reproducible 로 두 번 만들면 tar.gz 바이트가 같다', () => {
    const repo = makeRepo()
    const a = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0' } })
    const b = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0' } })
    expect(packBundle(a.files).equals(packBundle(b.files))).toBe(true)
  })

  it('링크: Markdown 링크 · 위키 링크 · 코드 위치 · 근거 앵커 · 옛 ID', () => {
    const { index } = buildIndex()
    expect(index.links.backlinks['decision:D-83']?.ref).toContain('wiki:feature/pivot#바뀐-이력')
    expect(index.links.backlinks['wiki:feature/pivot']?.ref).toContain('decision:D-83#결정')
    expect(index.links.backlinks['code:apps/web/pivot.ts']?.ref).toContain('wiki:feature/pivot#현재-답')
    expect(index.links.backlinks['code:apps/web/pivot.ts']?.evidence?.length).toBeGreaterThan(0)
    expect(index.aliases['wiki:old-pivot']).toBe('wiki:feature/pivot')
  })

  it('비밀값은 프로필과 관계없이 실패', () => {
    const key = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')
    for (const profile of ['server', 'local'] as const) {
      expect(() => buildIndex({ 'docs/guide/01-x.md': `# x\n\n토큰 ${key}\n` }, profile)).toThrow(SecurityError)
    }
  })

  it('개인 경로: 서버 묶음은 실패, 로컬 묶음은 경고', () => {
    const over = { 'docs/guide/01-x.md': '# x\n\n결과는 `/Volumes/Data/.tmp-e2e` 에 있다.\n' }
    expect(() => buildIndex(over, 'server')).toThrow(SecurityError)
    const { result } = buildIndex(over, 'local')
    expect(result.findings.map((f) => [f.rule, f.severity])).toEqual([['personal-path-volumes', 'warn']])
  })

  it('고객 데이터(메일 주소): 서버 실패, 예시 도메인 · git SSH 주소는 걸지 않는다', () => {
    expect(() => buildIndex({ 'docs/guide/01-x.md': '# x\n\n담당 kim.cs@customer-corp.co.kr\n' })).toThrow(SecurityError)
    const ok = buildIndex({ 'docs/guide/01-x.md': '# x\n\nuser@example.com · git@github.com:org/repo.git\n' })
    expect(ok.result.findings).toEqual([])
  })

  it('설정의 allow 로만 예외를 둔다(규칙 · 경로 · 문자열)', () => {
    const repo = makeRepo({ 'docs/guide/01-x.md': '# x\n\nLICENSE_CONTACT 연락처 sales@vendor-corp.co.kr\n' })
    const cfg = { ...CONFIG, security: { allow: [{ rule: 'email', path: 'docs/guide/01-x.md', match: 'LICENSE_CONTACT', reason: '공개 연락처' }] } }
    expect(() => buildBundle(cfg, { repoRoot: repo, pack: corePack, profile: 'server' })).not.toThrow()
  })

  it('미커밋 변경이 있으면 기본은 거절, --allow-dirty 면 manifest.dirty=true', () => {
    const repo = makeRepo()
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
    const clean = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0' } })
    expect(clean.manifest.dirty).toBe(false)
    expect(clean.manifest.commit).toMatch(/^[0-9a-f]{10}$/)
    fs.appendFileSync(path.join(repo, 'docs/guide/00-overview.md'), '\n추가 문장.\n')
    expect(() => buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server' })).toThrow(DirtyError)
    const dirty = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { allowDirty: true } })
    expect((dirty.manifest as Manifest).dirty).toBe(true)
  })

  it('이전 묶음과 비교: 제목만 바뀐 절은 옮김으로 잡고 옛 ID 를 aliases 에 남긴다', () => {
    const prev = buildIndex().result.files
    const repo = makeRepo({ 'docs/guide/00-overview.md': fs.readFileSync(path.join(makeRepo(), 'docs/guide/00-overview.md'), 'utf8').replace('## 배포', '## 배포 방법') })
    const r = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true }, prev })
    const aliases = JSON.parse(r.files.get('aliases.json')!.toString())
    expect(aliases['dev:00-overview#배포']).toBe('dev:00-overview#배포-방법')
    expect(r.files.get('log.jsonl')!.toString()).toContain('"op":"move"')
  })

  it('격리(onSecret: quarantine): 비밀값 문서만 빼고 수를 manifest 에 싣는다', () => {
    const repo = makeRepo({ 'docs/guide/01-x.md': `# x\n\n토큰 ${GH_KEY}\n` })
    const cfg = { ...CONFIG, security: { onSecret: 'quarantine' as const } }
    const r = buildBundle(cfg, { repoRoot: repo, pack: corePack, profile: 'local' })
    expect(r.quarantined).toEqual(['docs/guide/01-x.md'])
    expect(r.manifest.quarantined).toBe(1)
    expect(r.files.has('pages/docs/guide/01-x.md')).toBe(false)
    expect(r.files.has('pages/docs/guide/00-overview.md')).toBe(true)
  })

  it('onSecret 에 모르는 값을 적으면 설정 오류', () => {
    expect(() => normalizeConfig({ ...CONFIG, security: { onSecret: 'skip' as never } })).toThrow(ConfigError)
  })

  it('나누기 캐시: 두 번째 빌드는 바뀐 문서만 다시 나누고 결과 조각은 캐시 없이 만든 것과 같다', () => {
    const repo = makeRepo()
    const cacheFile = path.join(repo, '.cache', 'chunks.json')
    const first = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'local', chunkCacheFile: cacheFile })
    expect(first.chunking).toEqual({ reused: 0, chunked: 4 })
    fs.appendFileSync(path.join(repo, 'docs/guide/00-overview.md'), '\n## 추가\n\n더한 절.\n')
    const second = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'local', chunkCacheFile: cacheFile })
    expect(second.chunking).toEqual({ reused: 3, chunked: 1 })
    const fresh = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'local' })
    expect(second.files.get('chunks.jsonl')!.equals(fresh.files.get('chunks.jsonl')!)).toBe(true)
  })
})
