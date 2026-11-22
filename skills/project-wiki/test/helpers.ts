// 시험용 작은 저장소와 git 도우미. 저장소 고정물에 기대지 않고 임시 폴더에 만든다.
// 부르는 곳: test/*.test.ts. CLI 를 띄우는 시험은 `CLI` 를 쓴다(WIKI_INDEX_BIN 으로 묶은 파일을 시험할 수 있다).
// 먼저 읽을 파일: src/core/build.ts.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileAnchor } from '../src/core/adapter.ts'
import { buildBundle, normalizeConfig, type WikiConfig } from '../src/core/build.ts'
import type { SourceUnit } from '../src/core/model.ts'
import { WikiIndex } from '../src/core/search.ts'
import { corePack } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 시험할 CLI 진입 파일. 기본은 원본(src/cli/main.ts), WIKI_INDEX_BIN 을 주면 그 파일(예: bin/wiki-index.mjs). */
export const CLI = path.resolve(HERE, '..', process.env.WIKI_INDEX_BIN ?? 'src/cli/main.ts')
// 자식 빌드(dev/rebuild.ts)는 진입 파일을 process.argv[1] 로 찾는다. 시험 실행기에서는 그 값이 시험 파일이라 CLI 로 정해 둔다.
process.env.WIKI_INDEX_ENTRY = CLI

export const FILES: Record<string, string> = {
  'docs/wiki/feature/pivot.md': `---
id: feature/pivot
title: 피벗 압축 레이아웃
area: feature
status: current
aliases: [old-pivot]
sources: [apps/web/pivot.ts]
---
# 피벗 압축 레이아웃

## 현재 답

행 차원이 둘 이상이어도 압축 그대로 한 열 계층으로 그린다. 근거는 \`apps/web/pivot.ts:10-20\` 이다.

## 바뀐 이력

1.12.0 에서 outline 강제를 걷어냈다. 관련 결정은 [결정](../../decisions/D-83.md) 이다.
`,
  'docs/wiki/ops/trap.md': `---
title: 시험 DB 함정
---
# 시험 DB 함정

## 기본 주소

기본값으로 돌리면 공용 DB 에 쓴다. 전용 컨테이너를 띄운다.
`,
  'docs/decisions/D-83.md': `---
id: D-83
title: 피벗 압축 계층화
---
# D-83 피벗 압축 계층화

## 결정

압축 레이아웃은 행이 둘 이상이어도 한 열 계층으로 그린다. [[wiki:feature/pivot]]
`,
  'docs/guide/00-overview.md': `# 제품 개요

## 구성

서버는 \`apps/server/src/app.ts\` 에서 시작한다.

## 배포

배포 묶음은 배포 서버에서 만든다.
`,
  'apps/server/src/app.ts': 'export function buildApp() {}\n',
  'apps/server/src/db.ts': 'export const db = 1\n',
  'apps/web/pivot.ts': 'export const pivot = 1\n',
}

export const CONFIG: WikiConfig = normalizeConfig({
  schema: 1,
  bundle: { name: 'test-wiki', title: '시험 위키' },
  pack: 'core',
  sources: [
    { adapter: 'markdown', root: 'docs/guide', idNamespace: 'dev', part: 'dev', level: 'confidential' as never },
    { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/**/*.md'], exclude: ['docs/wiki/ops/**'], level: 'internal' as never },
    { adapter: 'markdown', root: 'docs/wiki', include: ['docs/wiki/ops/**/*.md'], level: 'confidential' as never, area: 'ops' },
    { adapter: 'markdown', root: 'docs/decisions', include: ['docs/decisions/*.md'], level: 'internal' as never, idNamespace: 'decision', area: 'decision' },
  ],
})

export function makeRepo(overrides: Record<string, string | null> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-wiki-test-'))
  for (const [rel, body] of Object.entries({ ...FILES, ...overrides })) {
    if (body === null) continue
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

export function buildIndex(overrides: Record<string, string | null> = {}, profile: 'server' | 'local' = 'server') {
  const repo = makeRepo(overrides)
  const r = buildBundle(CONFIG, { repoRoot: repo, pack: corePack, profile, identity: { reproducible: true, version: '1.0.0' } })
  return { repo, result: r, index: new WikiIndex(r.files) }
}

// ── 낡음 판정 시험용 git 저장소 ─────────────────────────────────────────────
// 임시 폴더에 git 저장소를 만들고 커밋한다. 사용자 설정에 기대지 않도록 이름 · 주소 · 서명을 명령에서 정한다.

export function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=wiki-test', '-c', 'user.email=wiki@test.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 파일을 쓰고(null 이면 지우고) 한 커밋으로 남긴다. 새 커밋 해시를 돌려준다. */
export function commitFiles(dir: string, files: Record<string, string | null>, message = 'change'): string {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    if (body === null) fs.rmSync(p, { force: true })
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
    }
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '--allow-empty', '-m', message])
  return git(dir, ['rev-parse', 'HEAD'])
}

/** 빈 git 저장소에 첫 커밋을 만든다. */
export function gitRepo(files: Record<string, string>): { dir: string; first: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-wiki-stale-'))
  git(dir, ['init', '-q', '-b', 'main'])
  return { dir, first: commitFiles(dir, files, 'first') }
}

// ── 위키 페이지 방식 판정 시험용 단위 ───────────────────────────────────────

/** 위키 페이지 단위. 넘긴 칸이 기본값을 덮는다. */
export function wikiUnit(o: Partial<SourceUnit> & { path: string }): SourceUnit {
  return { adapter: 'markdown', page: `wiki:${o.path}`, part: 'wiki', title: o.path, titlePrefix: [], level: 'internal', generated: false, markdown: '', anchors: [], ...o }
}

/** 같은 근거 · 기준 커밋을 가진 차단 대상 페이지(`docs/w/block.md`)와 보통 페이지(`docs/w/plain.md`). 앵커는 지금 작업 트리에서 만든다. */
export function wikiPair(dir: string, baseCommit: string, anchors: string[]): SourceUnit[] {
  const common = { reviewInSameCommit: true, baseCommit, anchors: anchors.map((a) => fileAnchor(dir, a)) }
  return [wikiUnit({ path: 'docs/w/block.md', blockOnStale: true, ...common }), wikiUnit({ path: 'docs/w/plain.md', ...common })]
}

/** `wikiPair` 의 차단 대상 페이지가 실린 `report.block`. */
export const blockOf = (reason: string) => [{ id: 'wiki:docs/w/block.md', title: 'docs/w/block.md', reason }]
