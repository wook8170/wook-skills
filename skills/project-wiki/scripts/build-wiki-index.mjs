#!/usr/bin/env node
// src/ 의 TypeScript 원본을 bin/wiki-index.mjs 한 파일로 묶는다(esbuild). --check 면 다시 묶은 결과가 지금 bin 과 같은지만 본다.
// esbuild 는 환경 변수 ESBUILD(실행 파일 경로)가 있으면 그것을, 없으면 `npx --yes esbuild@<고정 버전>` 을 쓴다.
// 먼저 읽을 파일: src/cli/main.ts(묶는 진입점).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ESBUILD_VERSION = '0.28.1'
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(SKILL_DIR, 'src/cli/main.ts')
const BIN = path.join(SKILL_DIR, 'bin/wiki-index.mjs')
const BANNER = [
  '#!/usr/bin/env node',
  '// project-wiki 색인기(wiki-index). src/ 원본을 scripts/build-wiki-index.mjs 로 묶은 파일이다. 직접 고치지 않는다.',
  `// 묶은 도구: esbuild ${ESBUILD_VERSION}. 실행: Node 22 이상, 런타임 의존성 없음. 사용권: MIT.`,
].join('\n')

function esbuildCommand() {
  const local = process.env.ESBUILD
  return local ? { cmd: local, pre: [] } : { cmd: 'npx', pre: ['--yes', `esbuild@${ESBUILD_VERSION}`] }
}

function assertVersion({ cmd, pre }) {
  const version = execFileSync(cmd, [...pre, '--version'], { encoding: 'utf8' }).trim()
  if (version !== ESBUILD_VERSION) {
    throw new Error(`esbuild ${version} 은 고정 버전 ${ESBUILD_VERSION} 과 다르다. 같은 버전이어야 --check 결과가 맞는다`)
  }
}

function bundleTo(outfile) {
  const tool = esbuildCommand()
  assertVersion(tool)
  execFileSync(tool.cmd, [
    ...tool.pre, ENTRY, '--bundle', '--platform=node', '--format=esm', '--target=node22', '--charset=utf8',
    '--legal-comments=none', `--banner:js=${BANNER}`, `--outfile=${outfile}`, '--log-level=warning',
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
}

function main(argv) {
  if (argv.includes('--check')) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-index-')), 'wiki-index.mjs')
    bundleTo(tmp)
    const same = fs.existsSync(BIN) && fs.readFileSync(tmp).equals(fs.readFileSync(BIN))
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    process.stdout.write(same ? 'bin/wiki-index.mjs 가 src/ 와 맞다\n' : 'bin/wiki-index.mjs 가 src/ 와 다르다. scripts/build-wiki-index.mjs 로 다시 묶는다\n')
    return same ? 0 : 1
  }
  bundleTo(BIN)
  fs.chmodSync(BIN, 0o755)
  process.stdout.write(`묶음 ${path.relative(SKILL_DIR, BIN)} · ${fs.statSync(BIN).size} 바이트\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
