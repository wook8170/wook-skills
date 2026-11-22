// `git log -z` 출력 읽기: 부모가 없는 뿌리 커밋은 머리 줄이 공백으로 끝난다.
import fs from 'node:fs'
import { describe, expect, test } from './support/vitest-shim.ts'
import { LOG_FORMAT, parseLogZ } from '../src/core/git-out.ts'
import { gitRunner } from '../src/core/stale.ts'
import { commitFiles, gitRepo } from './helpers.ts'

const ROOT = 'a'.repeat(40)
const CHILD = 'c'.repeat(40)

describe('뿌리 커밋의 머리 줄', () => {
  test('뿌리 커밋이 둘째로 와도 그 머리 줄을 앞 커밋의 파일로 붙이지 않는다', () => {
    const out = `\0\x01C ${CHILD} ${ROOT}\0\nsrc/b.ts\0\0\x01C ${ROOT} \0\nsrc/a.ts\0`
    expect(parseLogZ(out)).toEqual([
      { hash: CHILD, files: new Set(['src/b.ts']), merge: false },
      { hash: ROOT, files: new Set(['src/a.ts']), merge: false },
    ])
  })

  test('실제 git 출력에서 뿌리 커밋과 그 파일을 읽는다', () => {
    const { dir, first } = gitRepo({ 'src/a.ts': 'a\n' })
    try {
      const second = commitFiles(dir, { 'src/b.ts': 'b\n' })
      const r = gitRunner(dir)(['log', '-z', '--no-renames', LOG_FORMAT, '--name-only', 'HEAD'])
      expect(parseLogZ(r.out)).toEqual([
        { hash: second, files: new Set(['src/b.ts']), merge: false },
        { hash: first, files: new Set(['src/a.ts']), merge: false },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
