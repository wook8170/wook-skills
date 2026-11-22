// 제목 고르기(코드 블록 안 주석 제외 · 첫 문단 대체)와 요구사항 ID 정의 경계.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from './support/vitest-shim.ts'
import { firstHeading, firstParagraph } from '../src/core/adapter.ts'
import { definitionText } from '../src/core/links.ts'
import { markdownAdapter } from '../src/core/adapter.ts'

// `# ` 제목 줄이 없고, 뒤쪽 bash 코드 블록 안에 `# 원본 서버 …` 주석이 있는 문서.
const DOC15 = [
  '> **문서 상태**: 현행.',
  '> **상위 인덱스**: [docs/INDEX.md](../INDEX.md)',
  '',
  '## 컨셉',
  '',
  '이 제품은 **사내 설치** 소프트웨어이다.',
  '',
  '```bash',
  '# 원본 서버 — 수동 실행 중이면 그 서버의 대장 DB 경로와 .env 를 지정한다',
  'pnpm start',
  '```',
].join('\n')

describe('제목 고르기', () => {
  it('코드 블록 안의 # 주석은 제목이 아니다', () => {
    expect(firstHeading(DOC15)).toBeNull()
    expect(firstHeading('```sh\n# 주석\n```\n\n# 진짜 제목\n')).toBe('진짜 제목')
  })

  it('제목이 없으면 첫 문단 줄(인용 · 목록 · 표 · 제목 줄 제외)', () => {
    expect(firstParagraph(DOC15)).toBe('이 제품은 사내 설치 소프트웨어이다.')
    expect(firstParagraph('```\n코드\n```\n')).toBeNull()
  })

  it('일반 Markdown 어댑터: # 제목이 있으면 그 제목, 없으면 첫 문단, 둘 다 없으면 파일 이름', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-title-'))
    const dir = path.join(root, 'docs/guide')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '15-install.md'), DOC15)
    fs.writeFileSync(path.join(dir, '00-overview.md'), '# 제품 개요\n\n```\n# 셸 주석\n```\n')
    fs.writeFileSync(path.join(dir, '06-dash.md'), '이 문서는 대시보드를 다룬다.\n\n## 개요\n')
    fs.writeFileSync(path.join(dir, '07-empty.md'), '## 개요\n')
    const out = markdownAdapter.read({ repoRoot: root, spec: { adapter: 'markdown', root: 'docs/guide', level: 'internal' } })
    const titles = Object.fromEntries(out.units.map((u) => [path.basename(u.path), u.title]))
    expect(titles).toEqual({
      '00-overview.md': '제품 개요',
      '06-dash.md': '이 문서는 대시보드를 다룬다.',
      '07-empty.md': '07-empty',
      '15-install.md': '이 제품은 사내 설치 소프트웨어이다.',
    })
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('요구사항 ID 정의 경계', () => {
  const SECTION = ['#### REQ-SEC-01 비밀번호 저장', '', 'scrypt 로 저장한다.', '', '#### REQ-SEC-02 로그인 시도 제한', '', '5회 실패하면 15분 잠근다.', '', '#### REQ-SEC-03 세션 만료', '', '30분.'].join('\n')

  it('그 ID 의 #### 제목부터 다음 제목 앞까지만', () => {
    expect(definitionText(SECTION, 'REQ-SEC-02')).toBe('#### REQ-SEC-02 로그인 시도 제한\n\n5회 실패하면 15분 잠근다.')
    expect(definitionText(SECTION, 'REQ-SEC-03')).toBe('#### REQ-SEC-03 세션 만료\n\n30분.')
  })

  it('앞부분이 같은 다른 ID(REQ-SEC-0 · REQ-SEC-021)와 섞이지 않고, 제목이 없으면 본문 전체', () => {
    expect(definitionText('#### REQ-SEC-021 다른 것\n\n가.', 'REQ-SEC-02')).toBe('#### REQ-SEC-021 다른 것\n\n가.')
    expect(definitionText('그냥 본문', 'REQ-SEC-02')).toBe('그냥 본문')
  })
})
