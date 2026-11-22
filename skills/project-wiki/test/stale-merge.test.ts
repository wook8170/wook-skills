// 낡음 판정과 병합 커밋: 같은 커밋 규칙의 범위, 병합이 버린 근거 변경. 모두 임시 git 저장소에서 판정한다.
import { describe, expect, test } from './support/vitest-shim.ts'
import { BLOCK_REASON, gitRunner, judgeStale, type GitRun } from '../src/core/stale.ts'
import { blockOf, commitFiles, git, gitRepo, wikiPair } from './helpers.ts'

const BASE: Record<string, string> = {
  'docs/w/block.md': '# 차단\n',
  'docs/w/plain.md': '# 보통\n',
  'src/a.ts': 'export const a = 1\n',
}

describe('병합 커밋에는 같은 커밋 규칙을 적용하지 않는다', () => {
  test('M6: 근거는 병합 커밋에서만 바뀌고 문서는 곁가지 커밋에서 바뀌면 보통 페이지도 낡음 후보다', () => {
    const { dir, first } = gitRepo(BASE)
    git(dir, ['checkout', '-q', '-b', 'side'])
    commitFiles(dir, { 'docs/w/plain.md': '# 보통 고침\n', 'docs/w/block.md': '# 차단 고침\n' })
    git(dir, ['checkout', '-q', 'main'])
    commitFiles(dir, { 'other.txt': 'x\n' })
    git(dir, ['merge', '-q', '--no-ff', '--no-commit', 'side'])
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' }, 'merge side + a.ts')
    const { verdicts, report } = judgeStale(wikiPair(dir, first, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(1)
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('곁가지가 문서만 고치고 병합이 근거를 기준 커밋 이전 내용으로 되돌리면 보통 페이지도 낡음 후보다', () => {
    const { dir } = gitRepo(BASE)
    git(dir, ['checkout', '-q', '-b', 'side'])
    commitFiles(dir, { 'docs/w/plain.md': '# 보통 고침\n', 'docs/w/block.md': '# 차단 고침\n' })
    git(dir, ['checkout', '-q', 'main'])
    const c1 = commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    git(dir, ['merge', '-q', '--no-ff', '--no-commit', 'side'])
    git(dir, ['checkout', 'side', '--', 'src/a.ts'])
    commitFiles(dir, {}, 'merge side, a.ts 는 곁가지 쪽')
    const { verdicts, report } = judgeStale(wikiPair(dir, c1, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('부모가 하나인 커밋에서 근거와 문서를 함께 고치면 지금처럼 같은 커밋 규칙을 적용한다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/w/plain.md': '# 보통 고침\n' })
    const { verdicts, report } = judgeStale(wikiPair(dir, first, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(0)
    expect(verdicts.has('docs/w/plain.md')).toBe(false)
  })
})

describe('병합이 기준 커밋 쪽의 근거 변경을 버려도 낡음으로 잡는다', () => {
  /** 기준 커밋 c1 을 본가지에 만든 뒤, 곁가지에서 `-s ours` 로 본가지를 합치고 본가지를 빨리 감는다. c1 의 변경은 HEAD 에서 사라진다. */
  function dropByOursMerge(dir: string, change: Record<string, string>): string {
    git(dir, ['checkout', '-q', '-b', 'side'])
    commitFiles(dir, { 'other.txt': 'x\n' })
    git(dir, ['checkout', '-q', 'main'])
    const c1 = commitFiles(dir, change)
    git(dir, ['checkout', '-q', 'side'])
    git(dir, ['merge', '-q', '-s', 'ours', '-m', 'ours', 'main'])
    git(dir, ['checkout', '-q', 'main'])
    git(dir, ['merge', '-q', '--ff-only', 'side'])
    return c1
  }

  test('M4: 근거를 고친 기준 커밋의 변경을 병합이 버리면 차단 대상은 block, 보통 페이지는 낡음 후보', () => {
    const { dir } = gitRepo(BASE)
    const c1 = dropByOursMerge(dir, { 'src/a.ts': 'export const a = 2\n' })
    expect(git(dir, ['diff', '--name-only', c1, 'HEAD'])).toContain('src/a.ts')
    const { verdicts, report } = judgeStale(wikiPair(dir, c1, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(1)
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('M11: 기준 커밋이 새로 만든 근거를 병합이 버려 HEAD 에 없으면 차단 대상은 block, 보통 페이지는 낡음 후보', () => {
    const { dir } = gitRepo(BASE)
    const c1 = dropByOursMerge(dir, { 'src/new.ts': 'export const n = 1\n' })
    const { verdicts, report } = judgeStale(wikiPair(dir, c1, ['src/new.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/new.ts']) })
  })

  test('기준 커밋과 HEAD 의 근거 내용이 같으면(고쳤다가 되돌림) 지금처럼 이력으로 판정한다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/w/plain.md': '# 보통 고침\n' })
    commitFiles(dir, { 'src/a.ts': BASE['src/a.ts'], 'docs/w/plain.md': '# 보통 다시 고침\n' })
    const { verdicts, report } = judgeStale(wikiPair(dir, first, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.has('docs/w/plain.md')).toBe(false)
  })

  test('기준 커밋과 HEAD 의 차이를 읽지 못하면 차단 대상은 stale, 그 밖은 판정 불가 +1', () => {
    const { dir, first } = gitRepo(BASE)
    const real = gitRunner(dir)
    const run: GitRun = (args) => (args[0] === 'diff' ? { code: 128, out: '' } : real(args))
    const { report } = judgeStale(wikiPair(dir, first, ['src/a.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
    expect(report.unverifiable).toBe(1)
  })
})
