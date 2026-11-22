// 근거 경로와 git 색인의 철자 차이: 유니코드 정규화(NFC · NFD)와 대소문자.
// 결과가 파일 시스템(macOS APFS 등)에 따라 달라지지 않게, git 출력을 흉내 낸 실행기로 함수 수준에서 고정한다.
import { describe, expect, test } from './support/vitest-shim.ts'
import { spellingOf } from '../src/core/git-spelling.ts'
import type { Anchor, SourceUnit } from '../src/core/model.ts'
import { BLOCK_REASON, judgeStale, type GitRun } from '../src/core/stale.ts'
import { blockOf, wikiUnit } from './helpers.ts'

const NFC = (s: string) => s.normalize('NFC')
const NFD = (s: string) => s.normalize('NFD')
const HANGUL = 'src/한글 파일.ts'
const BASE = 'b'.repeat(40)

interface Fake {
  /** `git ls-files -z` 이 내는 경로(git 이 기록한 철자). */
  tracked: string[]
  /** 기준 커밋 뒤 한 커밋에서 바뀐 경로(git 이 기록한 철자). */
  changed: string
  /** core.precomposeunicode=true 면 git 이 명령 인자의 경로를 NFC 로 바꿔 받는다. */
  precompose: boolean
  lsFilesFails?: boolean
  /** 기준 커밋의 `ls-tree` 가 내는 경로(git 이 기록한 철자). 경로 인자가 있으면 그 철자와 맞는 것만 낸다. */
  baseTree?: string[]
}

/** 낡음 판정이 부르는 git 명령만 흉내 낸다. 경로 인자(`--` 뒤)가 git 의 철자와 맞을 때만 변경을 낸다. */
function fakeGit(f: Fake): GitRun {
  const hits = (args: string[]) => args.slice(args.indexOf('--') + 1).map((p) => (f.precompose ? NFC(p) : p)).includes(f.changed)
  return (args) => {
    switch (args[0]) {
      case 'ls-files':
        return f.lsFilesFails ? { code: 128, out: '' } : { code: 0, out: f.tracked.map((p) => `${p}\0`).join('') }
      case 'log':
        if (args.includes('--merges') || !hits(args)) return { code: 0, out: '' }
        return { code: 0, out: `\0\x01C ${'c'.repeat(40)} ${BASE}\0\n${f.changed}\0` }
      case 'diff':
        return { code: 0, out: hits(args) ? `${f.changed}\0` : '' }
      case 'ls-tree': {
        const at = args.indexOf('--')
        const specs = at < 0 ? null : args.slice(at + 1).map((p) => (f.precompose ? NFC(p) : p))
        const out = (f.baseTree ?? []).filter((t) => !specs || specs.includes(t))
        return { code: 0, out: out.map((p) => `${p}\0`).join('') }
      }
      default:
        return { code: 0, out: '' }
    }
  }
}

/** 지금 파일 시스템에서 읽힌 근거(해시 있음). 문서에 적은 철자 그대로다. */
const onDisk = (p: string): Anchor => ({ kind: 'file', path: p, hash: 'h' })
/** 지금 파일 시스템에 없는 근거(해시 없음). */
const gone = (p: string): Anchor => ({ kind: 'file', path: p, hash: null })

function pairOf(anchors: Array<string | Anchor>): SourceUnit[] {
  const common = { reviewInSameCommit: true, baseCommit: BASE, anchors: anchors.map((a) => (typeof a === 'string' ? onDisk(a) : a)) }
  return [wikiUnit({ path: 'docs/w/block.md', blockOnStale: true, ...common }), wikiUnit({ path: 'docs/w/plain.md', ...common })]
}

describe('유니코드 정규화가 다른 근거 경로', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['U2 트리 NFC · 문서 NFD · precompose=true', NFC(HANGUL), NFD(HANGUL), true],
    ['U3 트리 NFC · 문서 NFD · precompose=false', NFC(HANGUL), NFD(HANGUL), false],
    ['U4 트리 NFD · 문서 NFC · precompose=false', NFD(HANGUL), NFC(HANGUL), false],
    ['U6 NFD 이름으로 만들었으나 precompose=true 라 트리는 NFC · 문서 NFD', NFC(HANGUL), NFD(HANGUL), true],
    ['U10 결합 문자 é(트리 NFC · 문서 NFD) · precompose=true', NFC('src/café.ts'), NFD('src/café.ts'), true],
  ]
  for (const [name, tree, doc, precompose] of cases) {
    test(`${name}: 차단 대상은 block, 보통 페이지는 문서 철자로 낡음 후보`, () => {
      const run = fakeGit({ tracked: ['src/a.ts', tree], changed: tree, precompose })
      const { verdicts, report } = judgeStale(pairOf(['src/a.ts', doc]), run)
      expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
      expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
      expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set([doc]) })
    })
  }

  test('기존 방식(설계 산출물) 단위도 git 의 철자로 비교한다', () => {
    const run = fakeGit({ tracked: [NFC(HANGUL)], changed: NFC(HANGUL), precompose: false })
    const u = wikiUnit({ path: 'docs/dd/x.md', part: 'dd', baseCommit: BASE, anchors: [onDisk(NFD(HANGUL))] })
    const { verdicts, report } = judgeStale([u], run)
    expect(report.warn).toBe(1)
    expect([...(verdicts.get('docs/dd/x.md') as { changed: Set<string> }).changed]).toContain(NFD(HANGUL))
  })
})

describe('NFD 로 적은 근거를 지우거나 이름을 바꾼 경우', () => {
  // 트리는 NFC, 문서는 NFD, precompose=false(대소문자 · 정규화를 가리는 볼륨이 아님). 지운 근거는 파일이 없어 해시가 null 이다.
  test('B4: NFD 로 적은 근거를 지우면 기준 커밋의 철자로 찾아 낡음, 차단 대상은 block 에 실린다', () => {
    const run = fakeGit({ tracked: ['src/a.ts'], changed: NFC(HANGUL), precompose: false, baseTree: ['src/a.ts', NFC(HANGUL)] })
    const { verdicts, report } = judgeStale(pairOf(['src/a.ts', gone(NFD(HANGUL))]), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set([NFD(HANGUL)]) })
  })

  test('B5: NFD 로 적은 근거의 이름을 바꿔도 옛 경로가 바뀐 것으로 보고 낡음이다', () => {
    const run = fakeGit({ tracked: ['src/a.ts', 'src/새 이름.ts'], changed: NFC(HANGUL), precompose: false, baseTree: ['src/a.ts', NFC(HANGUL)] })
    const { report } = judgeStale(pairOf(['src/a.ts', gone(NFD(HANGUL))]), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(report).toMatchObject({ warn: 1, unverifiableAnchors: 0 })
  })
})

describe('대소문자가 다른 근거 경로', () => {
  test('문서는 src/case.ts, git 은 src/Case.ts 면 git 의 철자로 판정한다', () => {
    const run = fakeGit({ tracked: ['src/a.ts', 'src/Case.ts'], changed: 'src/Case.ts', precompose: false })
    const { verdicts, report } = judgeStale(pairOf(['src/a.ts', 'src/case.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.changed(1)))
    expect(verdicts.get('docs/w/plain.md')).toMatchObject({ kind: 'candidate', changed: new Set(['src/case.ts']) })
  })

  test('대소문자만 다른 git 경로가 둘이면 고르지 않고 근거 확인 불가로 센다', () => {
    const run = fakeGit({ tracked: ['src/a.ts', 'src/Case.ts', 'src/case.ts'], changed: 'src/case.ts', precompose: false })
    const { verdicts, report } = judgeStale(pairOf(['src/a.ts', 'src/CASE.ts']), run)
    expect(report.block).toEqual([])
    expect(verdicts.size).toBe(0)
    expect(report.unverifiableAnchors).toBe(2)
  })
})

describe('git 이 추적하지 않는 근거', () => {
  test('맞는 철자를 찾지 못한 근거는 조용히 통과시키지 않고 근거 확인 불가로 센다', () => {
    const run = fakeGit({ tracked: ['src/a.ts'], changed: 'src/none.ts', precompose: false })
    const { report } = judgeStale(pairOf(['src/a.ts', 'src/추적안함.ts']), run)
    expect(report).toMatchObject({ warn: 0, unverifiableAnchors: 2 })
  })

  test('근거가 모두 추적되지 않으면 차단 대상은 「확인할 근거 없음」, 보통 페이지는 근거 없는 문서', () => {
    const run = fakeGit({ tracked: ['src/a.ts'], changed: 'src/x.ts', precompose: false })
    const { report } = judgeStale(pairOf(['src/x.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.noAnchor))
    expect(report).toMatchObject({ noAnchorDocs: 1, unverifiableAnchors: 2 })
  })

  test('추적 목록을 읽지 못하면 차단 대상은 stale, 그 밖은 판정 불가 +1', () => {
    const run = fakeGit({ tracked: [], changed: 'src/a.ts', precompose: false, lsFilesFails: true })
    const { report } = judgeStale(pairOf(['src/a.ts']), run)
    expect(report.block).toEqual(blockOf(BLOCK_REASON.gitFailed))
    expect(report.unverifiable).toBe(1)
  })
})

describe('spellingOf', () => {
  test('정확히 같은 철자 → NFC 같음 → NFC · 소문자 같음 순서로 찾고, 여럿이면 null', () => {
    const s = spellingOf(['src/a.ts', NFC(HANGUL), 'src/Case.ts', 'x/Dup.ts', 'x/dup.ts'])
    expect(s.resolve('src/a.ts')).toBe('src/a.ts')
    expect(s.resolve(NFD(HANGUL))).toBe(NFC(HANGUL))
    expect(s.resolve('src/CASE.TS')).toBe('src/Case.ts')
    expect(s.resolve('x/dup.ts')).toBe('x/dup.ts')
    expect(s.resolve('x/DUP.ts')).toBeNull()
    expect(s.resolve('src/none.ts')).toBeNull()
  })
})
