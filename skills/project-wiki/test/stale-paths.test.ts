// 낡음 판정의 경로 처리: 비 ASCII(한글) 경로, 같은 커밋에서 지운 근거, 병합 커밋, 이름 변경. 모두 임시 git 저장소에서 판정한다.
import fs from 'node:fs'
import { afterEach, describe, expect, test } from './support/vitest-shim.ts'
import { fileAnchor } from '../src/core/adapter.ts'
import type { SourceUnit } from '../src/core/model.ts'
import { BLOCK_REASON, gitRunner, judgeStale, splitAnchorValues } from '../src/core/stale.ts'
import { commitFiles, git, gitRepo } from './helpers.ts'

const BASE: Record<string, string> = {
  'docs/w/block.md': '# 차단\n',
  'docs/w/plain.md': '# 보통\n',
  'docs/w/보통.md': '# 한글 이름 문서\n',
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
  'src/한글.ts': 'export const k = 1\n',
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

describe('비 ASCII 경로', () => {
  test('한글 경로 근거가 바뀌면 낡음, 차단 대상은 block 에 실린다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/한글.ts': 'export const k = 2\n' })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/한글.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report.warn).toBe(1)
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/한글.ts']) })
  })

  test('한글 경로 근거를 지우면 낡음, 차단 대상은 block 에 실린다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/한글.ts': null })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/한글.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/한글.ts']) })
  })

  test('한글 이름 문서를 근거와 같은 커밋에서 고치면 같은 커밋 규칙으로 확인한 것으로 본다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'docs/w/보통.md': '# 한글 이름 문서 고침\n' })
    const u = unit({ path: 'docs/w/보통.md', reviewInSameCommit: true, baseCommit: first, anchors: [fileAnchor(dir, 'src/a.ts')] })
    const { verdicts, report } = judgeStale([u], gitRunner(dir))
    expect(verdicts.size).toBe(0)
    expect(report.warn).toBe(0)
  })

  test('기존 방식(설계 산출물) 단위도 한글 경로 근거의 변경을 낡음 후보로 잡는다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/한글.ts': 'export const k = 2\n' })
    const u = unit({ path: 'docs/w/plain.md', part: 'dd', baseCommit: first, anchors: [fileAnchor(dir, 'src/한글.ts')] })
    const { verdicts, report } = judgeStale([u], gitRunner(dir))
    expect(report.warn).toBe(1)
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', prefix: true })
  })
})

describe('같은 커밋 규칙 뒤에도 HEAD 에 없는 근거', () => {
  test('이름 변경과 문서 수정이 같은 커밋이고 문서는 옛 경로를 가리키면, 보통 페이지는 통과하되 근거 확인 불가로 센다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/b.ts': null, 'src/c.ts': BASE['src/b.ts'], 'docs/w/plain.md': '# 보통 고침\n' })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.has('docs/w/plain.md')).toBe(false)
    expect(report).toMatchObject({ warn: 0, unverifiableAnchors: 1 })
  })

  test('삭제와 문서 수정이 같은 커밋이고 문서는 옛 경로를 가리키면, 보통 페이지는 통과하되 근거 확인 불가로 센다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/b.ts': null, 'docs/w/plain.md': '# 보통 고침\n' })
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', 'src/b.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.has('docs/w/plain.md')).toBe(false)
    expect(report).toMatchObject({ warn: 0, unverifiableAnchors: 1 })
  })
})

describe('병합 커밋 안에서만 바뀐 근거', () => {
  test('병합 커밋에서만 근거를 고쳐도(충돌 해결 등) 낡음으로 잡는다', () => {
    const { dir, first } = gitRepo(BASE)
    git(dir, ['checkout', '-q', '-b', 'feat'])
    commitFiles(dir, { 'src/b.ts': 'export const b = 2\n' })
    git(dir, ['checkout', '-q', 'main'])
    commitFiles(dir, { 'docs/w/other.md': '# 다른 문서\n' })
    git(dir, ['merge', '-q', '--no-ff', '--no-commit', 'feat'])
    commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' }, 'merge feat')
    expect(git(dir, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1')
    const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts']), gitRunner(dir))
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/a.ts']) })
  })
})

describe('기존 방식(설계 산출물) 판정의 이름 변경', () => {
  const dd = (dir: string, page: string, baseCommit: string, anchors: string[]) =>
    unit({ path: `docs/dd/${page}.md`, part: 'dd', baseCommit, anchors: anchors.map((a) => fileAnchor(dir, a)) })

  test('옛 경로를 근거로 둔 장만 있으면 이름 변경을 낡음 후보로 잡는다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/b.ts': null, 'src/c.ts': BASE['src/b.ts'] })
    const { verdicts } = judgeStale([dd(dir, 'x', first, ['src/b.ts'])], gitRunner(dir))
    expect(verdicts.get('docs/dd/x.md')).toMatchObject({ kind: 'candidate' })
  })

  test('같은 기준 커밋의 다른 장이 폴더를 근거로 두어도 옛 경로를 근거로 둔 장을 낡음 후보로 잡는다', () => {
    const { dir, first } = gitRepo(BASE)
    commitFiles(dir, { 'src/b.ts': null, 'src/c.ts': BASE['src/b.ts'] })
    const { verdicts, report } = judgeStale([dd(dir, 'x', first, ['src/b.ts']), dd(dir, 'y', first, ['src'])], gitRunner(dir))
    expect(verdicts.get('docs/dd/x.md')).toMatchObject({ kind: 'candidate' })
    expect(verdicts.get('docs/dd/y.md')).toMatchObject({ kind: 'candidate' })
    expect(report.warn).toBe(2)
  })
})

describe('큰따옴표 · 역슬래시 · 탭이 든 경로', () => {
  for (const name of ['src/a"b.ts', 'src/a\\b.ts', 'src/a\tb.ts', ' lead.ts']) {
    test(`근거 ${JSON.stringify(name)} 가 바뀌면 차단 대상은 block, 보통 페이지는 낡음 후보`, () => {
      const { dir, first } = gitRepo({ ...BASE, [name]: 'x\n' })
      commitFiles(dir, { [name]: 'y\n' })
      const { verdicts, report } = judgeStale(pair(dir, first, ['src/a.ts', name]), gitRunner(dir))
      expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
      expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set([name]) })
    })
  }

  test('기존 방식(설계 산출물) 단위도 따옴표가 든 근거의 변경을 낡음 후보로 잡는다', () => {
    const name = 'src/a"b.ts'
    const { dir, first } = gitRepo({ ...BASE, [name]: 'x\n' })
    commitFiles(dir, { [name]: 'y\n' })
    const u = unit({ path: 'docs/w/plain.md', part: 'dd', baseCommit: first, anchors: [fileAnchor(dir, name)] })
    expect(judgeStale([u], gitRunner(dir)).verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate' })
  })
})

describe('정규화하지 않은 근거 경로', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  test('./ · 겹친 / · 안쪽 .. 을 정규화하고 앞의 ./ 를 뗀다', () => {
    expect(splitAnchorValues(['./src/a.ts', 'src//a.ts', 'src/x/../a.ts', '././src/b.ts']).paths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('저장소 밖으로 나가는 경로는 지금처럼 앵커로 넣지 않고 수만 센다', () => {
    expect(splitAnchorValues(['../x.ts', 'src/../../x.ts', '/abs/x.ts'])).toEqual({ paths: [], skipped: 3 })
  })

  for (const written of ['./src/a.ts', 'src//a.ts', 'src/x/../a.ts']) {
    test(`근거를 ${JSON.stringify(written)} 로 적어도 바뀌면 차단 대상은 block 에 실린다`, () => {
      const { dir, first } = gitRepo(BASE)
      dirs.push(dir)
      commitFiles(dir, { 'src/a.ts': 'export const a = 2\n' })
      const { paths } = splitAnchorValues([written, 'src/b.ts'])
      const { report } = judgeStale(pair(dir, first, paths), gitRunner(dir))
      expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
      expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    })
  }
})
