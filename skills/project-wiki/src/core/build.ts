// 묶음 만들기: 설정 → 어댑터 → 나누기 → 보안 검사 → 낡음 후보 → 링크 · 역링크 → 낱말 색인 → 파일.
// 부르는 곳: cli/build.ts · cli/main.ts · cli/project.ts · cli/stale.ts 등. 먼저 읽을 파일: core/adapter.ts · core/chunk.ts.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterOutput, AdapterPack, Mount } from './adapter.ts'
import { MANIFEST, SIGNATURE, finalizeManifest, stableJson, type BundleFiles } from './bundle.ts'
import { DEFAULT_RULES, chunkUnit, rulesLabel, type ChunkRules, type FigureReader } from './chunk.ts'
import { openChunkCache, type ChunkCache } from './chunk-cache.ts'
import { diffChunks } from './diff.ts'
import { buildLexical } from './lexical.ts'
import { buildIds, buildLinks } from './links.ts'
import { annotateModified, lastCommitDates } from './modified.ts'
import { FORMAT_VERSION, levelAllowed, parseLevel, type Chunk, type Level, type Manifest, type Part, type SecurityFinding, type SourceSpec, type SourceUnit } from './model.ts'
import { SectionLevelError } from './section-level.ts'
import { splitQuarantined } from './quarantine.ts'
import { SECURITY_RULES_VERSION, scanText, type SecurityConfig } from './security.ts'
import { gitRunner, markStale, type StaleReport } from './stale.ts'
import { TOKENIZER } from './tokenize.ts'
import { cmp, matchesAny } from './util.ts'

export interface WikiConfig {
  schema: 1
  bundle: { name: string; title: string }
  /** 어댑터 묶음 이름. 지금은 core(일반 Markdown)만 있다. */
  pack?: string
  sources: Array<SourceSpec & Record<string, unknown>>
  chunk?: Partial<ChunkRules>
  /** onSecret: 비밀값이 든 문서를 만나면 빌드를 멈출지(fail, 기본) 그 문서만 뺄지(quarantine) 정한다. */
  security?: SecurityConfig & { maxLevel?: string; excludePaths?: string[]; onSecret?: 'fail' | 'quarantine' }
  /**
   * 「상태를 읽지 못한 결정 · 정책 문서」 기준 목록 파일(설정 파일 기준 상대 경로). 적으면 `stale` 명령이
   * 목록에 없는 문서를 출하 차단으로 싣는다(`core/stale-baseline.ts`).
   */
  noStatusBaseline?: string
}

/** 설정 파일을 읽고 등급 표기를 정규화한다. 형식이 틀리면 오류(종료 코드 2). */
export function loadConfig(file: string): WikiConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as WikiConfig
  return normalizeConfig(raw)
}

export function normalizeConfig(raw: WikiConfig): WikiConfig {
  if (raw.schema !== 1) throw new ConfigError(`설정 schema 는 1 이어야 한다(지금 ${String(raw.schema)})`)
  if (!raw.bundle?.name) throw new ConfigError('bundle.name 이 없다')
  if (!Array.isArray(raw.sources) || !raw.sources.length) throw new ConfigError('sources 가 비었다')
  assertOnSecret(raw.security?.onSecret)
  return { ...raw, sources: raw.sources.map((s) => ({ ...s, level: parseLevel(s.level) })) }
}

export class ConfigError extends Error {}

/** security.onSecret 값 확인. 적지 않으면 fail 이다. */
function assertOnSecret(v: unknown): void {
  if (v !== undefined && v !== 'fail' && v !== 'quarantine') throw new ConfigError(`security.onSecret 은 "fail" 또는 "quarantine" 이다(지금 ${String(v)})`)
}

export class SecurityError extends Error {
  readonly findings: SecurityFinding[]
  constructor(findings: SecurityFinding[]) {
    super(`보안 검사 실패 ${findings.length}건`)
    this.findings = findings
  }
}

/** 원천에 미커밋 변경이 있어 만들지 않았다. */
export class DirtyError extends Error {
  readonly paths: string[]
  constructor(paths: string[]) {
    super(`원천 폴더에 커밋하지 않은 변경이 있다(${paths.length}건). 커밋한 뒤 다시 만들거나 --allow-dirty 로 허용한다`)
    this.paths = paths
  }
}

/** 묶음 이름 · 버전 · 만든 시각을 정하는 값. */
export interface BuildIdentity {
  /** 만든 시각을 원천 커밋 시각으로 둔다. 같은 커밋이면 같은 바이트가 나온다. */
  reproducible?: boolean
  version?: string
  /**
   * 원천 폴더에 커밋하지 않은 변경이 있어도 만든다. 기본은 거절이다.
   * 묶음 이름 · 버전의 커밋과 내용이 달라지는 것을 막으려는 것이다. 허용하면 manifest.dirty 가 true 로 남는다.
   */
  allowDirty?: boolean
}

export interface BuildOptions {
  repoRoot: string
  pack: AdapterPack
  /** server = 다른 곳에 배포하는 묶음(개인 경로 등도 실패), local = 개발 머신 묶음(경고). */
  profile: 'server' | 'local'
  identity?: BuildIdentity
  /** 이전 묶음. 주면 비교 결과를 log.jsonl · aliases.json 에 남긴다. */
  prev?: BundleFiles
  /** 낡음 후보 판정(git 으로 근거 파일이 기준 커밋 뒤 바뀌었는지). 기본 켬. */
  staleCheck?: boolean
  /** 나누기 결과 캐시 파일. 주면 내용이 같은 문서는 다시 나누지 않는다(작업 트리 모드). */
  chunkCacheFile?: string
}

export interface BuildResult {
  files: BundleFiles
  manifest: Manifest
  findings: SecurityFinding[]
  timings: Record<string, number>
  /** 묶음은 만들었지만 알릴 것(예: 수정일을 구하지 못함). CLI 가 「경고」로 찍는다. */
  warnings: string[]
  /** 낡음 판정 수치(판정 불가 · 근거 없음 등). manifest 에는 싣지 않는다. 낡음 판정을 끄면 없다. */
  stale?: StaleReport
  /** 비밀값이 있어 뺀 문서 경로(security.onSecret 이 quarantine 일 때). 묶음 파일에는 수만 싣는다. */
  quarantined: string[]
  /** 캐시에서 꺼낸 문서 수 · 새로 나눈 문서 수. 캐시를 주지 않으면 모두 새로 나눈다. */
  chunking: { reused: number; chunked: number }
}

/** 링크 대상 파일이 있는가. 저장소 밖 원천의 가상 경로는 그 원천 폴더 기준으로 본다. */
function fileExistsIn(repoRoot: string, mounts: Mount[]): (rel: string) => boolean {
  return (rel) => {
    const m = mounts.find((x) => rel.startsWith(`${x.prefix}/`))
    return m ? fs.existsSync(path.join(m.dir, rel.slice(m.prefix.length + 1))) : fs.existsSync(path.join(repoRoot, rel))
  }
}

/** git 을 부른다. 실패하면 null(git 이 없거나 저장소가 아님 — 부르는 쪽이 그 경우를 다룬다). `raw` 면 출력 앞뒤 공백을 지우지 않는다. */
function git(repoRoot: string, args: string[], raw = false): string | null {
  try {
    const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    return raw ? out : out.trim()
  } catch {
    // 실패는 값 없음으로 돌려준다. 알릴지는 부르는 쪽이 정한다(수정일은 lastCommitDates 가 빌드 경고로 남긴다).
    return null
  }
}

/** 나누기 + 절 등급 검사. 절 등급 표시가 잘못됐거나 묶음 상한보다 높으면 설정 오류로 멈춘다. */
function chunkUnitChecked(u: SourceUnit, rules: ChunkRules, figures: FigureReader | undefined, maxLevel: Level): Chunk[] {
  let out: Chunk[]
  try {
    out = chunkUnit(u, rules, figures)
  } catch (e) {
    if (e instanceof SectionLevelError) throw new ConfigError(e.message)
    throw e
  }
  assertUnderCap(out, maxLevel)
  return out
}

function assertUnderCap(out: Chunk[], maxLevel: Level): void {
  const over = out.find((c) => !levelAllowed(c.level, maxLevel))
  if (over) throw new ConfigError(`절 등급(${over.level})이 묶음 상한(${maxLevel})보다 높다: ${over.id}`)
}

/** 캐시에 같은 내용의 조각이 있으면 그것을 쓰고, 없으면 나눠서 캐시에 넣는다. 그림을 읽는 원천은 캐시하지 않는다. */
function chunkWithCache(u: SourceUnit, rules: ChunkRules, figures: FigureReader | undefined, maxLevel: Level, cache: ChunkCache): Chunk[] {
  if (figures) return chunkUnitChecked(u, rules, figures, maxLevel)
  const hit = cache.get(u)
  if (hit) return hit
  const out = chunkUnitChecked(u, rules, undefined, maxLevel)
  cache.set(u, out)
  return out
}

/** 설정의 묶음 등급 상한. 적지 않았으면 대외비(가장 높음)다. */
function bundleMaxLevel(cfg: WikiConfig): Level {
  return cfg.security?.maxLevel ? parseLevel(cfg.security.maxLevel) : 'confidential'
}

/**
 * 원천을 어댑터로 읽고, 제외 경로를 빼고, 등급 상한을 확인한다. 나누기 · 색인은 하지 않는다.
 * 묶음 만들기와 `stale` · `mark-synced` 명령이 함께 써서 판정 대상 단위가 갈리지 않게 한다.
 */
export function readSources(cfg: WikiConfig, repoRoot: string, pack: AdapterPack, profile?: 'server' | 'local'): Array<{ out: AdapterOutput; units: SourceUnit[] }> {
  const maxLevel = bundleMaxLevel(cfg)
  const adapters = new Map<string, Adapter>(pack.adapters.map((a) => [a.name, a]))
  return cfg.sources.map((spec) => {
    const a = adapters.get(spec.adapter)
    if (!a) throw new ConfigError(`알 수 없는 어댑터: ${spec.adapter}`)
    if (!levelAllowed(spec.level, maxLevel)) throw new ConfigError(`원천 등급(${spec.level})이 묶음 상한(${maxLevel})보다 높다: ${spec.adapter}`)
    const out = a.read({ repoRoot, spec, ...(profile ? { profile } : {}), ...(cfg.security ? { security: cfg.security } : {}) })
    const units = out.units.filter((u) => !matchesAny(u.path, cfg.security?.excludePaths))
    const over = units.find((u) => !levelAllowed(u.level, maxLevel))
    if (over) throw new ConfigError(`페이지 등급(${over.level})이 묶음 상한(${maxLevel})보다 높다: ${over.path}`)
    return { out, units }
  })
}

/** 어댑터에서 모은 값. */
interface SourceData {
  units: SourceUnit[]
  chunks: Chunk[]
  catalog: { categories: string[]; books: unknown[] }
  manuscripts: Manifest['manuscripts']
  trace: unknown[]
  mounts: Mount[]
  quarantined: string[]
  /** 캐시에서 꺼낸 문서 수 · 새로 나눈 문서 수. */
  chunking: { reused: number; chunked: number }
}

/** 나누기에 함께 넘기는 값. */
interface ChunkStep {
  rules: ChunkRules
  maxLevel: Level
  cache: ChunkCache
}

/** 어댑터 하나의 결과(제외 경로 · 등급 상한은 `readSources` 가 이미 걸렀다)를 나눠 모은 값에 더한다. */
function addAdapterOutput(acc: SourceData, out: AdapterOutput, units: SourceUnit[], step: ChunkStep): void {
  for (const u of units) {
    acc.units.push(u)
    acc.chunks.push(...chunkWithCache(u, step.rules, out.figures, step.maxLevel, step.cache))
  }
  if (out.catalog) {
    acc.catalog.categories.push(...out.catalog.categories.filter((c) => !acc.catalog.categories.includes(c)))
    acc.catalog.books.push(...out.catalog.books)
  }
  Object.assign(acc.manuscripts, out.manuscripts ?? {})
  acc.trace.push(...(out.trace ?? []))
  if (out.mount) acc.mounts.push(out.mount)
}

/** 1) 어댑터로 원천을 읽고, 격리를 켰으면 비밀값 문서를 빼고, 나눈다. */
function collectSources(cfg: WikiConfig, o: BuildOptions, rules: ChunkRules, maxLevel: Level): SourceData {
  const acc: SourceData = { units: [], chunks: [], catalog: { categories: [], books: [] }, manuscripts: {}, trace: [], mounts: [], quarantined: [], chunking: { reused: 0, chunked: 0 } }
  const step: ChunkStep = { rules, maxLevel, cache: openChunkCache(o.chunkCacheFile, rulesLabel(rules)) }
  const quarantine = cfg.security?.onSecret === 'quarantine'
  for (const { out, units } of readSources(cfg, o.repoRoot, o.pack, o.profile)) {
    const split = quarantine ? splitQuarantined(units, o.profile, cfg.security) : { kept: units, quarantined: [] }
    acc.quarantined.push(...split.quarantined)
    addAdapterOutput(acc, out, split.kept, step)
  }
  step.cache.save()
  acc.chunking = step.cache.stats()
  return acc
}

function assertUniqueChunkIds(chunks: Chunk[]): void {
  const seen = new Map<string, string>()
  for (const c of chunks) {
    const prev = seen.get(c.id)
    if (prev) throw new ConfigError(`같은 조각 ID 가 두 원천에서 나온다: ${c.id} (${prev}, ${c.source.path})`)
    seen.set(c.id, c.source.path)
  }
}

/**
 * `git status --porcelain -z` 출력의 경로들. 항목은 `XY 경로` 이고 NUL 로 끝난다. 이름 바꿈 · 복사(R · C)는 다음 항목이
 * 옛 경로라 건너뛴다. -z 라서 공백 · 따옴표 · 한글이 든 경로도 따옴표로 묶이지 않고 그대로 온다.
 */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    paths.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') i++
  }
  return paths
}

/** 원천 폴더(경로 앞 두 단계)의 미커밋 변경 경로. git 커밋을 모르면 빈 목록이다. */
function dirtyPathsOf(repoRoot: string, commit: string | null, units: SourceUnit[]): string[] {
  const roots = [...new Set(units.map((u) => u.path.split('/').slice(0, 2).join('/')))]
  return commit ? parsePorcelainZ(git(repoRoot, ['status', '--porcelain', '-z', '--', ...roots], true) ?? '') : []
}

/** 만든 시각. 재현 빌드면 SOURCE_DATE_EPOCH → HEAD 커밋 시각 → 0 순서로 쓴다. */
function createdAtOf(o: BuildOptions, commit: string | null): string {
  let createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (o.identity?.reproducible) {
    const epoch = process.env.SOURCE_DATE_EPOCH
    const ct = commit ? git(o.repoRoot, ['show', '-s', '--format=%ct', 'HEAD']) : null
    const sec = Number(epoch ?? ct ?? 0)
    createdAt = new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return createdAt
}

/** 6) 기준 정보. 미커밋 변경이 있고 허용하지 않았으면 멈춘다. */
function bundleIdentity(o: BuildOptions, units: SourceUnit[]): { commit: string | null; dirty: boolean; dirtyPaths: string[]; createdAt: string; version: string } {
  const commit = git(o.repoRoot, ['rev-parse', '--short=10', 'HEAD'])
  const dirtyPaths = dirtyPathsOf(o.repoRoot, commit, units)
  const dirty = dirtyPaths.length > 0
  if (dirty && !o.identity?.allowDirty) throw new DirtyError(dirtyPaths)
  const createdAt = createdAtOf(o, commit)
  const version = o.identity?.version ?? (commit ? `0.0.0+${commit.slice(0, 8)}` : '0.0.0')
  return { commit, dirty, dirtyPaths, createdAt, version }
}

/** 이전 묶음과 비교해 옛 ID(aliases)를 잇고 바뀐 기록을 log 에 더한다. */
function applyPrevDiff(prev: BundleFiles, chunks: Chunk[], aliases: Record<string, string>, log: unknown[], createdAt: string, commit: string | null): void {
  const prevChunks = prev
    .get('chunks.jsonl')!
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Chunk)
  const prevAliases = prev.has('aliases.json') ? (JSON.parse(prev.get('aliases.json')!.toString('utf8')) as Record<string, string>) : {}
  const d = diffChunks(prevChunks, chunks)
  const ids = new Set(chunks.map((c) => c.id))
  for (const [from, to] of d.moved) aliases[from] = to
  for (const [from, to] of Object.entries(prevAliases)) {
    const target = aliases[to] ?? to
    if (!ids.has(from) && ids.has(target)) aliases[from] = target
  }
  for (const id of d.added) log.push({ ts: createdAt, op: 'add', id, commit })
  for (const id of d.changed) log.push({ ts: createdAt, op: 'change', id, commit })
  for (const id of d.removed) log.push({ ts: createdAt, op: 'remove', id, commit })
  for (const [from, to] of d.moved) log.push({ ts: createdAt, op: 'move', from, to, commit })
  for (const s of d.staleChanged) log.push({ ts: createdAt, op: s.to ? 'stale' : 'fresh', id: s.id, from: s.from, to: s.to, commit })
}

/** 7) 이전 묶음과 비교 → 바뀐 기록 · 옛 ID. 페이지 별칭도 aliases 에 넣는다. */
function buildHistory(o: BuildOptions, src: SourceData, id: ReturnType<typeof bundleIdentity>): { aliases: Record<string, string>; log: unknown[] } {
  const { chunks, units } = src
  const aliases: Record<string, string> = {}
  const log: unknown[] = [{ ts: id.createdAt, op: 'build', commit: id.commit, version: id.version, counts: { chunks: chunks.length } }]
  if (o.prev) applyPrevDiff(o.prev, chunks, aliases, log, id.createdAt, id.commit)
  const chunkIds = new Set(chunks.map((c) => c.id))
  for (const u of units) for (const a of u.aliases ?? []) if (!chunkIds.has(a)) aliases[a] = u.page
  return { aliases, log }
}

/** 8) manifest.json 을 뺀 묶음 파일. */
function bundleFiles(
  src: SourceData,
  links: ReturnType<typeof buildLinks>,
  ids: ReturnType<typeof buildIds>,
  history: { aliases: Record<string, string>; log: unknown[] },
  lexical: ReturnType<typeof buildLexical>,
): BundleFiles {
  const files: BundleFiles = new Map()
  files.set('chunks.jsonl', Buffer.from(src.chunks.map((c) => stableJson(c)).join('\n') + '\n'))
  files.set('links.json', Buffer.from(stableJson(links)))
  files.set('ids.json', Buffer.from(stableJson(ids)))
  files.set('catalog.json', Buffer.from(stableJson(src.catalog, 1)))
  files.set('aliases.json', Buffer.from(stableJson(history.aliases, 1)))
  files.set('log.jsonl', Buffer.from(history.log.map((l) => stableJson(l)).join('\n') + '\n'))
  for (const [k, v] of Object.entries(lexical)) files.set(k, v)
  for (const u of src.units) files.set(`pages/${u.path}`, Buffer.from(u.markdown))
  return files
}

/** 8-1) 어댑터 묶음이 정한 색인 밖 파일. 색인기가 만드는 이름과 겹치면 멈춘다. */
function addPackExtras(files: BundleFiles, o: BuildOptions): void {
  for (const [name, data] of o.pack.bundleExtras?.(o.repoRoot) ?? []) {
    if (files.has(name) || name === MANIFEST || name === SIGNATURE) throw new Error(`묶음에 싣는 파일 이름이 겹친다: ${name}`)
    files.set(name, data)
  }
}

function countByLevelPart(chunks: Chunk[]): { byLevel: Partial<Record<Level, number>>; byPart: Partial<Record<Part, number>> } {
  const byLevel: Partial<Record<Level, number>> = {}
  const byPart: Partial<Record<Part, number>> = {}
  for (const c of chunks) {
    byLevel[c.level] = (byLevel[c.level] ?? 0) + 1
    byPart[c.part] = (byPart[c.part] ?? 0) + 1
  }
  return { byLevel, byPart }
}

/** manifest 에 싣는 보안 설정. 값이 있는 항목만 넣는다. */
function manifestSecurity(sec: WikiConfig['security']): SecurityConfig {
  return {
    ...(sec?.allow ? { allow: sec.allow } : {}),
    ...(sec?.ownerDb ? { ownerDb: sec.ownerDb } : {}),
    ...(sec?.customer ? { customer: sec.customer } : {}),
    ...(sec?.emailDomains ? { emailDomains: sec.emailDomains } : {}),
  }
}

interface ManifestInput {
  cfg: WikiConfig
  o: BuildOptions
  rules: ChunkRules
  src: SourceData
  links: ReturnType<typeof buildLinks>
  id: ReturnType<typeof bundleIdentity>
  findings: SecurityFinding[]
}

function manifestBase({ cfg, o, rules, src, links, id, findings }: ManifestInput): Omit<Manifest, 'files'> {
  const { chunks, units } = src
  const maxLevel = bundleMaxLevel(cfg)
  const { byLevel, byPart } = countByLevelPart(chunks)
  return {
    formatVersion: FORMAT_VERSION,
    name: cfg.bundle.name,
    title: cfg.bundle.title,
    version: id.version,
    createdAt: id.createdAt,
    commit: id.commit,
    dirty: id.dirty,
    profile: o.profile,
    rules: { chunker: rulesLabel(rules), tokenizer: TOKENIZER, anchors: 'sha256-16/1', security: SECURITY_RULES_VERSION },
    maxLevel,
    levels: (Object.keys(byLevel) as Level[]).sort((a, b) => cmp(a, b)),
    counts: {
      chunks: chunks.length,
      pages: units.length,
      edges: links.edges.length,
      broken: links.broken.length,
      stale: chunks.filter((c) => c.stale?.state === 'stale').length,
      staleCandidates: chunks.filter((c) => c.stale?.state === 'stale-candidate').length,
      byLevel,
      byPart,
    },
    sources: cfg.sources.map((s) => ({ ...s })),
    manuscripts: src.manuscripts,
    securityWarnings: findings.length,
    security: manifestSecurity(cfg.security),
    vectors: null,
    ...(cfg.security?.onSecret === 'quarantine' ? { quarantined: src.quarantined.length } : {}),
  }
}

export function buildBundle(cfg: WikiConfig, o: BuildOptions): BuildResult {
  const t0 = Date.now()
  const timings: Record<string, number> = {}
  const lap = (k: string, from: number) => (timings[k] = Date.now() - from)
  const rules: ChunkRules = { ...DEFAULT_RULES, ...cfg.chunk }
  const maxLevel = bundleMaxLevel(cfg)

  // 1) 어댑터
  let t = Date.now()
  const src = collectSources(cfg, o, rules, maxLevel)
  const { units, chunks } = src
  lap('read+chunk', t)
  assertUniqueChunkIds(chunks)

  // 2) 보안 검사(원문 전체: 주석 · 머리말 포함 — pages/ 사본이 원문이라서)
  t = Date.now()
  const findings = units.flatMap((u) => scanText(u.markdown, u.path, o.profile, cfg.security))
  lap('security', t)
  const fails = findings.filter((f) => f.severity === 'fail')
  if (fails.length) throw new SecurityError(fails)

  // 3) 낡음 후보
  t = Date.now()
  const stale = o.staleCheck !== false ? markStale(units, chunks, gitRunner(o.repoRoot)) : undefined
  lap('stale', t)

  // 4) 링크 · ID
  t = Date.now()
  const links = buildLinks({
    chunks,
    units,
    rules: o.pack.idRules,
    brokenTypes: o.pack.brokenTypes,
    fileExists: fileExistsIn(o.repoRoot, src.mounts),
  })
  const ids = buildIds(links, o.pack.idTypes, src.trace)
  lap('links', t)

  // 5) 낱말 색인
  t = Date.now()
  const lexical = buildLexical(chunks)
  lap('lexical', t)

  // 6) 기준 정보 · 7) 바뀐 기록 · 8) 파일
  const id = bundleIdentity(o, units)
  // 6-1) 수정일(쪽 머리 줄 「확인」의 기본값). 묶음 커밋 기준 git log 한 번.
  t = Date.now()
  const modified = lastCommitDates((args) => git(o.repoRoot, args, true), id.commit, units)
  annotateModified(chunks, units, modified.dates, id.dirtyPaths)
  lap('modified', t)
  const history = buildHistory(o, src, id)
  const files = bundleFiles(src, links, ids, history, lexical)
  addPackExtras(files, o)
  const manifest = finalizeManifest(manifestBase({ cfg, o, rules, src, links, id, findings }), files)
  files.set('manifest.json', Buffer.from(stableJson(manifest, 2) + '\n'))
  timings.total = Date.now() - t0
  return { files, manifest, findings, timings, warnings: modified.warnings, quarantined: src.quarantined, chunking: src.chunking, ...(stale ? { stale } : {}) }
}
