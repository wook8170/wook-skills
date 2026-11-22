// 근거 파일을 지우거나 이름을 바꾸면 낡음으로 잡는다.
// 기준 커밋에 파일로 있던 경로는 지금 없어도 판정한다. 기준 커밋에도 없던 경로만 「근거 확인 불가」로 센다.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { fileAnchor } from '../src/core/adapter.ts'
import type { SourceUnit } from '../src/core/model.ts'
import { BLOCK_REASON, gitRunner, judgeStale, type GitRun } from '../src/core/stale.ts'
import { commitFiles, git, gitRepo } from './helpers.ts'

const BASE: Record<string, string> = {
  'docs/w/block.md': '# 차단\n',
  'docs/w/plain.md': '# 보통\n',
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
}

function unit(o: Partial<SourceUnit> & { path: string }): SourceUnit {
  return { adapter: 'markdown', page: `wiki:${o.path}`, part: 'wiki', title: o.path, titlePrefix: [], level: 'internal', generated: false, markdown: '', anchors: [], ...o }
}

/** 같은 근거 · 기준 커밋을 가진 차단 대상 페이지와 보통 페이지. 앵커는 지금 작업 트리에서 만든다. */
function pair(dir: string, baseCommit: string, anchors: string[]): SourceUnit[] {
  const common = { reviewInSameCommit: true, baseCommit, anchors: anchors.map((a) => fileAnchor(dir, a)) }
  return [unit({ path: 'docs/w/block.md', blockOnStale: true, ...common }), unit({ path: 'docs/w/plain.md', ...common })]
}

const blockOf = (reason: string) => [{ id: 'wiki:docs/w/block.md', title: 'docs/w/block.md', reason }]

describe('근거 파일 삭제 · 이름 변경', () => {
  test('근거 둘 가운데 하나를 지우면 낡음, 차단 대상은 block 에 실린다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': null })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0, noAnchorDocs: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('이름을 바꿔도 옛 경로가 바뀐 것으로 보고 낡음, 차단 대상은 block 에 실린다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/b.ts': null, 'src/c.ts': BASE['src/b.ts'] })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(1)
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/b.ts']) })
  })

  test('기준 커밋에도 없던 경로는 판정하지 않고 근거 확인 불가로 센다', () => {
    const { dir, first } = gitRepo(BASE)
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/none.ts']), gitRunner(dir))
    expect(verdicts.size).toBe(0)
    expect(report).toMatchObject({ block: [], warn: 0, unverifiableAnchors: 2 })
  })

  test('남은 근거가 모두 기준 커밋에 없던 경로면 근거 없는 문서로 본다', () => {
    const { dir, first } = gitRepo(BASE)
    const { report } = judgeStale(pair(dir, first, ['src/none.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.noAnchor))
    expect(report).toMatchObject({ noAnchorDocs: 1, unverifiableAnchors: 2 })
  })

  test('기준 커밋의 파일 목록을 읽지 못하면 차단 대상은 stale, 그 밖은 판정 불가 +1', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': null })
    const real = gitRunner(dir)
    const run: GitRun = (args) => (args[0] === 'ls-tree' ? { code: 128, out: '' } : real(args))
    const { report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
    expect(report.unverifiable).toBe(1)
    expect(report.warnings).toHaveLength(1)
  })

  test('지운 근거가 여러 단위에 걸쳐도 기준 커밋마다 파일 목록은 한 번만 읽는다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': null, 'src/b.ts': null })
    const calls: string[] = []
    const real = gitRunner(dir)
    const run: GitRun = (args) => (calls.push(args[0]), real(args))
    judgeStale([...pair(dir, first, ['src/a.ts']), unit({ path: 'docs/w/other.md', reviewInSameCommit: true, baseCommit: first, anchors: [fileAnchor(dir, 'src/b.ts')] })], run)
    expect(calls.filter((c) => c === 'ls-tree')).toHaveLength(1)
    expect(calls.filter((c) => c === 'log')).toHaveLength(1)
  })
})

describe('추적에서 빠졌지만 작업 폴더에 남은 근거', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const repo = () => {
    const r = gitRepo(BASE)
    dirs.push(r.dir)
    return r
  }

  test('A1: 추적에서 빼고 커밋해도(파일은 남김) 낡음, 차단 대상은 block 에 실린다', () => {
    const { dir, first } = repo()
    git(dir, ['rm', '-q', '--cached', 'src/a.ts'])
    git(dir, ['commit', '-q', '-m', 'untrack'])
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })

  test('A3: 지우고 커밋한 뒤 같은 경로에 추적하지 않는 파일을 다시 둬도 낡음이다', () => {
    const { dir, first } = repo()
    commitFiles(dir, { 'src/a.ts': null })
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 9\n')
    const { report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
  })

  test('기준 커밋에도 없고 지금도 추적하지 않는 파일만 근거 확인 불가로 센다', () => {
    const { dir, first } = repo()
    fs.writeFileSync(path.join(dir, 'src/local.ts'), 'export const l = 1\n')
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/b.ts', 'src/local.ts']), gitRunner(dir))
    expect(verdicts.size).toBe(0)
    expect(report).toMatchObject({ block: [], warn: 0, unverifiableAnchors: 2 })
  })
})
