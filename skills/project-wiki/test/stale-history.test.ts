// 기준 커밋 뒤에 생겼다가 사라진 근거와 대소문자만 다른 근거 표기.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { BLOCK_REASON, gitRunner, judgeStale, type GitRun } from '../src/core/stale.ts'
import { blockOf, commitFiles, git, gitRepo, wikiPair } from './helpers.ts'

const BASE: Record<string, string> = {
  'docs/w/block.md': '# 차단\n',
  'docs/w/plain.md': '# 보통\n',
  'src/b.ts': 'export const b = 1\n',
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 기준 커밋(src/b.ts 만 있음) 뒤에 src/n.ts 를 더한 저장소. */
function repoWithLateAnchor(): { dir: string; first: string } {
  const r = gitRepo(BASE)
  dirs.push(r.dir)
  commitFiles(r.dir, { 'src/n.ts': 'export const n = 1\n' }, 'add n')
  return r
}

describe('기준 커밋 뒤에 생긴 근거가 사라짐', () => {
  test('A6-0: 근거가 남아 있으면 기준 커밋 뒤 생긴 것이라 낡음이다', () => {
    const { dir, first } = repoWithLateAnchor()
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
  })

  test('A6: 지우면 낡음, 근거 확인 불가로 세지 않는다', () => {
    const { dir, first } = repoWithLateAnchor()
    commitFiles(dir, { 'src/n.ts': null }, 'rm n')
    const { verdicts, report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/n.ts']) })
  })

  test('A6b: 추적에서 빼면(파일은 남김) 낡음이다', () => {
    const { dir, first } = repoWithLateAnchor()
    git(dir, ['rm', '-q', '--cached', 'src/n.ts'])
    git(dir, ['commit', '-q', '-m', 'untrack n'])
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.unverifiableAnchors).toBe(0)
  })

  test('A6c: 이름을 바꾸면 옛 경로가 낡음이다', () => {
    const { dir, first } = repoWithLateAnchor()
    commitFiles(dir, { 'src/n.ts': null, 'src/m.ts': 'export const n = 1\n' }, 'rename n')
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
  })

  test('A6d: 고친 뒤 지워도 낡음이다', () => {
    const { dir, first } = repoWithLateAnchor()
    commitFiles(dir, { 'src/n.ts': 'export const n = 2\n' }, 'edit n')
    commitFiles(dir, { 'src/n.ts': null }, 'rm n')
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
  })

  test('곁가지에서 더한 뒤 병합하고 지워도 낡음이다', () => {
    const { dir, first } = gitRepo(BASE)
    dirs.push(dir)
    git(dir, ['checkout', '-q', '-b', 'side'])
    commitFiles(dir, { 'src/n.ts': 'export const n = 1\n' }, 'side add n')
    git(dir, ['checkout', '-q', 'main'])
    commitFiles(dir, { 'src/z.ts': 'export const z = 1\n' }, 'main z')
    git(dir, ['-c', 'user.name=wiki-test', '-c', 'user.email=wiki@test.invalid', 'merge', '-q', '--no-edit', 'side'])
    commitFiles(dir, { 'src/n.ts': null }, 'rm n')
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
  })

  test('기록에 한 번도 없던 경로는 지금처럼 근거 확인 불가로 센다', () => {
    const { dir, first } = repoWithLateAnchor()
    const { verdicts, report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/never.ts']), gitRunner(dir))
    expect(verdicts.size).toBe(0)
    expect(report).toMatchObject({ block: [], warn: 0, unverifiableAnchors: 2 })
  })

  test('기록을 읽지 못하면 차단 대상은 「근거 변경을 확인하지 못함」이다', () => {
    const { dir, first } = repoWithLateAnchor()
    commitFiles(dir, { 'src/n.ts': null }, 'rm n')
    const real = gitRunner(dir)
    const run: GitRun = (args) => (args.includes('--diff-filter=A') ? { code: 128, out: '' } : real(args))
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/n.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
  })
})

// 이 시험은 대소문자를 가리는 볼륨에서만 뜻이 있다. 가리지 않는 볼륨이면 파일이 그대로 읽혀 철자가 맞춰진다.
const caseSensitive = (() => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'wiki-case-'))
  try {
    fs.writeFileSync(path.join(d, 'a'), '')
    return !fs.existsSync(path.join(d, 'A'))
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})()

describe.skipIf(!caseSensitive)('대소문자만 다른 근거 표기', () => {
  const repo = (files: Record<string, string> = {}) => {
    const r = gitRepo({ ...BASE, 'src/a.ts': 'export const a = 1\n', ...files })
    dirs.push(r.dir)
    return r
  }

  test('문서가 src/A.ts 로 적고 추적 파일은 바뀌지 않은 src/a.ts 면 「대소문자가 다름」으로 막는다', () => {
    const { dir, first } = repo()
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/A.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.caseMismatch(1)))
  })

  test('다른 근거도 바뀌었으면 두 사유를 함께 적는다', () => {
    const { dir, first } = repo()
    commitFiles(dir, { 'src/b.ts': 'export const b = 2\n' })
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/A.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(`${BLOCK_REASON.changed(1)} · ${BLOCK_REASON.caseMismatch(1).replace('출하 차단 — ', '')}`))
  })

  test('대소문자가 다른 근거 자체가 바뀌었으면 「바뀜」으로 막는다', () => {
    const { dir, first } = repo()
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
    const { report } = judgeStale(wikiPair(dir, first, ['src/b.ts', 'src/A.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
  })
})
