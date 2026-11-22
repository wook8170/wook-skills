// 프로젝트 위키 찾기. 옵션을 주지 않으면 지금 폴더에서 위로 올라가며 `.wiki/config.json` 을 찾는다.
// 부르는 곳: cli/build.ts · cli/query.ts · cli/stale.ts · cli/serve.ts · cli/init.ts.
// 먼저 읽을 파일: dev/cache.ts(색인 폴더 위치).
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError } from '../core/build.ts'
import { str, type Opts } from './args.ts'

export const WIKI_DIR = '.wiki'
export const CONFIG_FILE = 'config.json'

export interface Project {
  /** 색인할 저장소 루트. */
  root: string
  /** 설정 파일(.wiki/config.json 또는 --config). */
  configPath: string
}

/** start 에서 위로 올라가며 `.wiki/config.json` 이 있는 폴더를 찾는다. 없으면 null. */
export function findWikiRoot(start: string): string | null {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, WIKI_DIR, CONFIG_FILE))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * 옵션에서 프로젝트를 정한다. 우선순위: --config(+ --root, 없으면 지금 폴더) → --wiki-dir(+ --root)
 * → 지금 폴더에서 위로 찾은 `.wiki/config.json`. 하나도 없으면 init 을 먼저 하라는 설정 오류다.
 */
export function resolveProject(opt: Opts, cwd: string = process.cwd()): Project {
  const config = str(opt.config)
  const wikiDir = str(opt['wiki-dir'])
  const root = str(opt.root)
  if (config) return { root: path.resolve(root ?? cwd), configPath: path.resolve(config) }
  if (wikiDir) return { root: path.resolve(root ?? cwd), configPath: path.resolve(wikiDir, CONFIG_FILE) }
  const found = findWikiRoot(root ?? cwd)
  if (!found) throw new ConfigError(`위키 설정을 찾지 못했다(${path.join(WIKI_DIR, CONFIG_FILE)}). 먼저 \`wiki-index init\` 을 한다`)
  return { root: found, configPath: path.join(found, WIKI_DIR, CONFIG_FILE) }
}

/** 위치 인자가 묶음(폴더의 manifest.json 또는 .tar.gz 파일)을 가리키는가. */
export function isBundlePath(p: string | undefined): p is string {
  if (!p) return false
  if (/\.tar\.gz$/.test(p)) return fs.existsSync(p)
  return fs.existsSync(path.join(p, 'manifest.json'))
}
