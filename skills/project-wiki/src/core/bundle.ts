// 묶음 쓰기 · 읽기 · 검증 · tar.gz 묶기.
// 부르는 곳: cli/build.ts · cli/eval.ts · cli/query.ts · core/build.ts 등. 먼저 읽을 파일: core/model.ts(Manifest).
// 묶음 = 폴더 하나. manifest.json 이 묶음 안 모든 파일의 해시를 갖는다(SIGNATURE 는 manifest.json 바이트에 대한 서명이라 제외).
// 색인기는 서명하지 않는다. 서명은 묶음을 받는 서버 쪽 빌더가 manifest.json 에 대해 하고 SIGNATURE 를 더한 뒤 packBundle 로 묶는다.
import fs from 'node:fs'
import path from 'node:path'
import { FORMAT_MAX, FORMAT_MIN, type Manifest } from './model.ts'
import { DEFAULT_LIMITS, TarError, packTarGz, safeEntryPath, unpackTarGz, type TarLimits } from './tar.ts'
import { cmp, sha256Hex } from './util.ts'

export const MANIFEST = 'manifest.json'
export const SIGNATURE = 'SIGNATURE'
/** 서버 라우트 매개변수 규칙과 같다. */
export const BUNDLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const BUNDLE_VERSION_RE = /^\d+\.\d+\.\d+(\+[0-9a-f]{8})?$/

export type BundleFiles = Map<string, Buffer>

/** 키 순서를 고정한 JSON(같은 값이면 같은 바이트). */
export function stableJson(v: unknown, indent = 0): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(x as object).sort(cmp)) {
        const val = (x as Record<string, unknown>)[k]
        if (val !== undefined) o[k] = norm(val)
      }
      return o
    }
    return x
  }
  return JSON.stringify(norm(v), null, indent)
}

/** 파일 해시를 채운 manifest 를 만든다. */
export function finalizeManifest(base: Omit<Manifest, 'files'>, files: BundleFiles): Manifest {
  const hashes: Record<string, string> = {}
  for (const name of [...files.keys()].sort(cmp)) {
    if (name === MANIFEST || name === SIGNATURE) continue
    hashes[name] = `sha256:${sha256Hex(files.get(name)!)}`
  }
  return { ...base, files: hashes }
}

/** 묶음 폴더를 쓴다. 폴더가 이미 있으면 묶음 폴더(manifest.json 이 있음)이거나 빈 폴더일 때만 지우고 다시 쓴다. */
export function writeBundleDir(outDir: string, files: BundleFiles, manifest: Manifest): void {
  if (fs.existsSync(outDir)) {
    const entries = fs.readdirSync(outDir)
    if (entries.length && !entries.includes(MANIFEST)) throw new Error(`묶음 폴더가 아닌 곳에는 쓰지 않는다: ${outDir}`)
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  for (const [name, data] of files) {
    const dest = path.join(outDir, safeEntryPath(name))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
  }
  fs.writeFileSync(path.join(outDir, MANIFEST), stableJson(manifest, 2) + '\n')
}

/** 폴더 묶음을 메모리로 읽는다. 링크 · 특수 파일이 있으면 거절한다. */
export function readBundleDir(dir: string): BundleFiles {
  const out: BundleFiles = new Map()
  const rec = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) throw new TarError('UNSUPPORTED_ENTRY', `링크는 받지 않는다: ${r}`)
      if (e.isDirectory()) rec(r)
      else if (e.isFile()) out.set(r, fs.readFileSync(path.join(dir, r)))
      else throw new TarError('UNSUPPORTED_ENTRY', `일반 파일이 아니다: ${r}`)
    }
  }
  rec('')
  return out
}

/** 폴더 또는 tar.gz 를 읽는다. */
export function readBundle(p: string, limits: TarLimits = DEFAULT_LIMITS): BundleFiles {
  return fs.statSync(p).isDirectory() ? readBundleDir(p) : unpackTarGz(fs.readFileSync(p), limits)
}

/**
 * 폴더 묶음을 tar.gz 로 묶는다. manifest.json · SIGNATURE 를 맨 앞에 두고 나머지는 경로 순서다.
 * 항목 시각은 manifest.createdAt 이라 같은 묶음이면 같은 바이트다.
 */
export function packBundle(files: BundleFiles): Buffer {
  const manifest = JSON.parse(files.get(MANIFEST)!.toString('utf8')) as Manifest
  const names = [...files.keys()].sort((a, b) => {
    const rank = (n: string) => (n === MANIFEST ? 0 : n === SIGNATURE ? 1 : 2)
    return rank(a) - rank(b) || cmp(a, b)
  })
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1000) || 0
  return packTarGz(names.map((n) => [n, files.get(n)!]), mtime)
}

export interface VerifyIssue {
  code: 'manifest_missing' | 'manifest_invalid' | 'format_unsupported' | 'name_invalid' | 'version_invalid' | 'hash_mismatch' | 'file_missing' | 'file_unlisted' | 'unsafe_path'
  message: string
}

export interface VerifyOptions {
  formatMin?: number
  formatMax?: number
}

/**
 * 묶음 형식 검증: manifest 형식 · formatVersion 범위 · 이름 · 버전 규칙 · 파일 해시 · 목록에 없는 파일.
 * 서명 확인은 하지 않는다(서명은 서버가 신뢰 공개키로 확인한다).
 */
export function verifyBundle(files: BundleFiles, opts: VerifyOptions = {}): { ok: boolean; manifest: Manifest | null; issues: VerifyIssue[] } {
  const issues: VerifyIssue[] = []
  const raw = files.get(MANIFEST)
  if (!raw) return { ok: false, manifest: null, issues: [{ code: 'manifest_missing', message: 'manifest.json 이 없다' }] }
  const parsed = parseManifest(raw)
  if ('issue' in parsed) return { ok: false, manifest: null, issues: [parsed.issue] }
  const m = parsed.manifest
  const min = opts.formatMin ?? FORMAT_MIN
  const max = opts.formatMax ?? FORMAT_MAX
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < min || m.formatVersion > max) {
    issues.push({ code: 'format_unsupported', message: `formatVersion ${String(m.formatVersion)} 은 지원 범위(${min} ~ ${max}) 밖이다` })
    return { ok: false, manifest: m, issues }
  }
  checkNameVersion(m, issues)
  if (!m.files || typeof m.files !== 'object') {
    issues.push({ code: 'manifest_invalid', message: 'manifest.files 가 없다' })
    return { ok: false, manifest: m, issues }
  }
  checkListedFiles(m.files, files, issues)
  checkUnlistedFiles(m.files, files, issues)
  return { ok: issues.length === 0, manifest: m, issues }
}

function parseManifest(raw: Buffer): { manifest: Manifest } | { issue: VerifyIssue } {
  try {
    return { manifest: JSON.parse(raw.toString('utf8')) as Manifest }
  } catch (e) {
    return { issue: { code: 'manifest_invalid', message: `manifest.json 을 읽을 수 없다: ${(e as Error).message}` } }
  }
}

function checkNameVersion(m: Manifest, issues: VerifyIssue[]): void {
  if (typeof m.name !== 'string' || !BUNDLE_NAME_RE.test(m.name)) issues.push({ code: 'name_invalid', message: `묶음 이름 규칙에 맞지 않는다: ${String(m.name)}` })
  if (typeof m.version !== 'string' || !BUNDLE_VERSION_RE.test(m.version)) issues.push({ code: 'version_invalid', message: `버전 규칙에 맞지 않는다: ${String(m.version)}` })
}

/** 목록 경로가 안전하고 이미 정규화된 꼴인지. 정규화하면 달라지거나 거절되는 경로는 false. */
function isNormalizedEntry(name: string): boolean {
  try {
    return safeEntryPath(name) === name
  } catch {
    return false
  }
}

/** manifest.files 목록의 경로 · 있는지 · 해시를 확인한다. */
function checkListedFiles(listed: Manifest['files'], files: BundleFiles, issues: VerifyIssue[]): void {
  for (const [name, want] of Object.entries(listed)) {
    if (!isNormalizedEntry(name)) {
      issues.push({ code: 'unsafe_path', message: `안전하지 않은 경로: ${name}` })
      continue
    }
    const data = files.get(name)
    if (!data) issues.push({ code: 'file_missing', message: `목록의 파일이 없다: ${name}` })
    else if (`sha256:${sha256Hex(data)}` !== want) issues.push({ code: 'hash_mismatch', message: `해시가 다르다: ${name}` })
  }
}

/** manifest.json · SIGNATURE 외에 목록에 없는 파일이 있으면 문제로 남긴다. */
function checkUnlistedFiles(listed: Manifest['files'], files: BundleFiles, issues: VerifyIssue[]): void {
  for (const name of files.keys()) {
    if (name === MANIFEST || name === SIGNATURE) continue
    if (!(name in listed)) issues.push({ code: 'file_unlisted', message: `목록에 없는 파일: ${name}` })
  }
}
