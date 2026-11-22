// 원천 파일마다 마지막으로 고친 날(git 커밋 날짜)을 묶음에 싣는다.
// 고정물(helpers FILES)은 git 저장소가 아니라서, 시험 안에서 임시 git 저장소를 만들고 커밋 날짜를 정해 커밋한다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from './support/vitest-shim.ts'
import { corePack } from '../src/index.ts'
import { buildBundle, parsePorcelainZ } from '../src/core/build.ts'
import { lastCommitDates, parseGitVersion, parseLastDates } from '../src/core/modified.ts'
import { WikiIndex } from '../src/core/search.ts'
import { CONFIG, FILES, makeRepo } from './helpers.ts'

const PIVOT = 'docs/wiki/feature/pivot.md'
const OLD = '2026-10-01T10:00:00+09:00'
const NEW = '2026-11-05T23:30:00+09:00' // UTC 로는 11-05 14:30, 미국 서부로는 11-05 06:30 — 커밋의 시간대(+09:00) 그대로 11-05

function git(repo: string, args: string[], date?: string, committerDate?: string) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date ?? OLD, GIT_COMMITTER_DATE: committerDate ?? date ?? OLD, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' })
}

/** 모든 파일을 OLD 에 커밋하고, pivot.md 만 고쳐 NEW 에 다시 커밋한 저장소. */
function gitRepo(overrides: Record<string, string | null> = {}): string {
  const repo = makeRepo(overrides)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'first'])
  fs.appendFileSync(path.join(repo, PIVOT), '\n덧붙인 줄.\n')
  git(repo, ['commit', '-q', '-am', 'second'], NEW)
  return repo
}

const build = (repo: string, allowDirty = false) => buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0', allowDirty } })
const page = (index: WikiIndex, id: string) => index.read(id, { cap: 'confidential' }) as Record<string, unknown>

const tz = process.env.TZ
afterEach(() => {
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
})

describe('수정일(modifiedAt)', () => {
  it('파일마다 마지막 커밋 날짜가 조각과 페이지 읽기에 실린다', () => {
    const index = new WikiIndex(build(gitRepo()).files)
    expect(page(index, 'wiki:feature/pivot')).toMatchObject({ modifiedAt: '2026-11-05' })
    expect(page(index, 'dev:00-overview')).toMatchObject({ modifiedAt: '2026-10-01' })
    expect(index.chunks.filter((c) => c.page === 'wiki:feature/pivot').every((c) => c.modifiedAt === '2026-11-05')).toBe(true)
  })

  it('머리말 verified_at 이 있어도 두 칸을 따로 싣는다(화면은 verified_at 을 먼저 쓴다)', () => {
    const dated = FILES[PIVOT].replace('status: current\n', 'status: current\nverified_at: 2026-09-30\n')
    const r = page(new WikiIndex(build(gitRepo({ [PIVOT]: dated })).files), 'wiki:feature/pivot')
    expect(r).toMatchObject({ verifiedAt: '2026-09-30', modifiedAt: '2026-11-05' })
  })

  it('같은 커밋이면 머신 시간대가 달라도 같은 값 · 같은 바이트다', () => {
    const repo = gitRepo()
    process.env.TZ = 'America/Los_Angeles'
    const a = build(repo)
    process.env.TZ = 'UTC'
    const b = build(repo)
    expect(a.files.get('chunks.jsonl')!.equals(b.files.get('chunks.jsonl')!)).toBe(true)
    expect(page(new WikiIndex(a.files), 'wiki:feature/pivot')).toMatchObject({ modifiedAt: '2026-11-05' })
  })

  it('--allow-dirty: 미커밋 변경 파일 · 새 파일은 싣지 않고, 나머지는 싣는다. 허용하지 않으면 만들지 않는다', () => {
    const repo = gitRepo()
    fs.appendFileSync(path.join(repo, 'docs/guide/00-overview.md'), '\n고치는 중.\n')
    expect(() => build(repo)).toThrow(/커밋하지 않은 변경/)
    const index = new WikiIndex(build(repo, true).files)
    expect(page(index, 'dev:00-overview')).not.toHaveProperty('modifiedAt')
    expect(page(index, 'wiki:feature/pivot')).toMatchObject({ modifiedAt: '2026-11-05' })
  })

  it('가지에서 고친 파일은 병합한 날이 아니라 고친 날(일반 커밋 날짜)이다', () => {
    const repo = gitRepo()
    git(repo, ['checkout', '-q', '-b', 'side'])
    fs.writeFileSync(path.join(repo, 'docs/wiki/feature/merged.md'), '---\nid: feature/merged\ntitle: 병합 문서\n---\n# 병합 문서\n\n## 본문\n\n병합으로 들어온다.\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'side'], '2026-11-06T10:00:00+09:00')
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], '2026-11-08T10:00:00+09:00')
    expect(page(new WikiIndex(build(repo).files), 'wiki:feature/merged')).toMatchObject({ modifiedAt: '2026-11-06' })
  })

  it('git 저장소가 아니면 싣지 않는다', () => {
    const r = buildBundle(CONFIG, { repoRoot: makeRepo(), pack: corePack, profile: 'server', identity: { reproducible: true, version: '1.0.0' } })
    expect(new WikiIndex(r.files).chunks.some((c) => 'modifiedAt' in c)).toBe(false)
  })

  it('git log 출력 읽기: 새 커밋부터라 처음 만난 날이 그 파일의 마지막 날', () => {
    const out = '\u00002026-11-05 p1\n\na.md\n\u00002026-10-01 p0\n\na.md\nb.md\n'
    expect([...parseLastDates(out)]).toEqual([
      ['a.md', '2026-11-05'],
      ['b.md', '2026-10-01'],
    ])
    // 병합 커밋(부모 둘): 일반 커밋이 있는 파일은 그 날, 병합으로만 들어온 파일만 병합 날
    const m = '\u00002026-11-14 p1 p2\n\na.md\nonly-merged.md\n\u00002026-11-11 p0\n\na.md\n'
    expect(Object.fromEntries(parseLastDates(m))).toEqual({ 'a.md': '2026-11-11', 'only-merged.md': '2026-11-14' })
  })

  it('작성자 날짜를 쓴다 — 리베이스처럼 커미터 날짜만 바뀌어도 「확인」은 그대로다', () => {
    const repo = makeRepo()
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'first'], OLD, '2026-12-24T10:00:00+09:00')
    expect(page(new WikiIndex(build(repo).files), 'dev:00-overview')).toMatchObject({ modifiedAt: '2026-10-01' })
  })

  it('미커밋 경로 읽기(-z): 공백 · 한글 · 따옴표가 든 경로도 그대로, 이름 바꿈은 새 경로', () => {
    expect(parsePorcelainZ(' M docs/wiki/a b.md\0?? docs/wiki/한글 문서.md\0 M docs/wiki/"q".md\0R  docs/new.md\0docs/old.md\0')).toEqual([
      'docs/wiki/a b.md',
      'docs/wiki/한글 문서.md',
      'docs/wiki/"q".md',
      'docs/new.md',
    ])
  })

  it('--allow-dirty: 공백 · 한글 경로의 미커밋 변경도 dirty 로 잡혀 날짜를 싣지 않는다', () => {
    const SPACED = 'docs/wiki/feature/새 기능 문서.md'
    const repo = gitRepo({ [SPACED]: '---\nid: feature/spaced\ntitle: 공백 문서\n---\n# 공백 문서\n\n## 본문\n\n공백과 한글이 든 경로다.\n' })
    expect(page(new WikiIndex(build(repo).files), 'wiki:feature/spaced')).toMatchObject({ modifiedAt: '2026-10-01' })
    fs.appendFileSync(path.join(repo, SPACED), '\n고치는 중.\n')
    expect(() => build(repo)).toThrow(/커밋하지 않은 변경/)
    const r = build(repo, true)
    expect(page(new WikiIndex(r.files), 'wiki:feature/spaced')).not.toHaveProperty('modifiedAt')
    expect(r.warnings).toEqual([])
  })

  it('git 2.31 미만: --diff-merges 없이 부르고 빌드 경고를 남긴다 · git log 실패도 경고', () => {
    const calls: string[][] = []
    const units = [{ path: 'docs/wiki/a.md' }] as never
    const old = lastCommitDates((a) => (calls.push(a), a[0] === 'version' ? 'git version 2.30.2\n' : '\u00002026-11-05 p1\n\ndocs/wiki/a.md\n'), 'abc', units)
    expect(calls[1]).not.toContain('--diff-merges=first-parent')
    expect(old.dates?.get('docs/wiki/a.md')).toBe('2026-11-05')
    expect(old.warnings.join()).toMatch(/2\.31 이상이 필요/)
    const fail = lastCommitDates((a) => (a[0] === 'version' ? 'git version 2.50.1\n' : null), 'abc', units)
    expect(fail.dates).toBeNull()
    expect(fail.warnings.join()).toMatch(/git log 가 실패/)
    const ok = lastCommitDates((a) => (a[0] === 'version' ? 'git version 2.50.1 (Apple Git-155)\n' : ''), 'abc', units)
    expect(ok.warnings).toEqual([])
    expect(parseGitVersion('git version 2.31.0')).toEqual([2, 31])
    expect(parseGitVersion(null)).toBeNull()
  })
})
