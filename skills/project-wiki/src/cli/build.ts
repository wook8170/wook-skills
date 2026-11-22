// build · check 명령. build 는 --out 을 주면 그 폴더에 묶음을 만들고, 주지 않으면 프로젝트 색인 폴더(.wiki/index/)를 새로 만든다.
// 부르는 곳: cli/main.ts(명령) · cli/query.ts(검색 앞 새로 고침).
// 먼저 읽을 파일: core/build.ts(buildBundle) · dev/refresh.ts.
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, SecurityError, buildBundle, loadConfig, type BuildResult, type WikiConfig } from '../core/build.ts'
import { packBundle, readBundle, verifyBundle, writeBundleDir } from '../core/bundle.ts'
import type { LinksFile, SecurityFinding } from '../core/model.ts'
import { scanText, type SecurityConfig } from '../core/security.ts'
import { chunkCachePath, nextBundleDir, quarantinePath } from '../dev/cache.ts'
import { refreshIndex } from '../dev/refresh.ts'
import { rootContext } from '../dev/serve-root.ts'
import { corePack } from '../index.ts'
import { UsageError, buildProfile, err, out, str, type Opts } from './args.ts'
import { resolveProject } from './project.ts'

export function packOf(name: string | undefined): typeof corePack {
  if (!name || name === 'core') return corePack
  throw new ConfigError(`알 수 없는 어댑터 묶음: ${name}`)
}

/** 규칙별 수 한 줄(--quiet). 경로 · 줄 · 발췌는 넣지 않는다. */
function ruleCounts(label: string, findings: SecurityFinding[]): string {
  const n = new Map<string, number>()
  for (const f of findings) n.set(f.rule, (n.get(f.rule) ?? 0) + 1)
  return `${label} ${findings.length}건(${[...n].map(([r, c]) => `${r} ${c}`).join(' · ')})`
}

export class QuietSecurityError extends Error {}

/** 빌드 한 번에 필요한 값. */
export interface BuildJobSpec {
  cfg: WikiConfig
  repoRoot: string
  outDir: string
  opt: Opts
  /** 프로젝트 모드: 미커밋 변경을 허용하고 나누기 캐시 · 격리 목록을 색인 폴더에 둔다. */
  cacheDir?: string
}

/** 묶음을 만들어 outDir 에 쓴다. --quiet 면 보안 실패를 규칙별 수 한 줄로 바꿔 던진다(종료 1 은 그대로). */
export function runBuild(job: BuildJobSpec): BuildResult {
  const { cfg, repoRoot, outDir, opt, cacheDir } = job
  const prevPath = str(opt.prev)
  const quiet = opt.quiet === true
  let r: BuildResult
  try {
    r = buildBundle(cfg, {
      repoRoot,
      pack: packOf(cfg.pack),
      profile: buildProfile(opt),
      identity: { reproducible: opt.reproducible === true, version: str(opt.version), allowDirty: cacheDir !== undefined || opt['allow-dirty'] === true },
      prev: prevPath ? readBundle(prevPath) : undefined,
      staleCheck: opt['no-stale'] !== true,
      chunkCacheFile: str(opt['chunk-cache']) ?? (cacheDir ? chunkCachePath(cacheDir) : undefined),
    })
  } catch (e) {
    if (quiet && e instanceof SecurityError) throw new QuietSecurityError(ruleCounts('보안 실패', e.findings))
    throw e
  }
  writeBundleDir(outDir, r.files, r.manifest)
  const qOut = str(opt['quarantine-out']) ?? (cacheDir ? quarantinePath(cacheDir) : undefined)
  if (qOut) writeQuarantineList(qOut, r.quarantined)
  return r
}

/** 격리 목록 파일. 경로만 적고, 다른 사용자가 읽지 못하게 600 으로 쓴다. 격리가 없어도 빈 파일로 덮는다. */
function writeQuarantineList(file: string, quarantined: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, quarantined.length ? `${quarantined.map((p) => `격리 ${p}`).join('\n')}\n` : '', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function writeTar(tar: string, files: Map<string, Buffer>): void {
  const gz = packBundle(files)
  fs.mkdirSync(path.dirname(path.resolve(tar)), { recursive: true })
  fs.writeFileSync(tar, gz)
  out(`  tar.gz ${tar} (${(gz.length / 1048576).toFixed(1)} MB)`)
}

/** build 결과 요약을 찍는다. --quiet 면 경고를 수로만 낸다. */
export function reportBuild(r: BuildResult, outDir: string, quiet = false): void {
  let size = 0
  for (const b of r.files.values()) size += b.length
  const m = r.manifest
  out(`묶음 ${m.name} ${m.version} → ${outDir}${m.dirty ? ' (미커밋 변경 포함 — dirty)' : ''}`)
  out(`  조각 ${m.counts.chunks} · 페이지 ${m.counts.pages} · 간선 ${m.counts.edges} · 끊긴 링크 ${m.counts.broken} · 낡음 후보 ${m.counts.staleCandidates}`)
  out(`  다시 나눈 문서 ${r.chunking.chunked} · 그대로 쓴 문서 ${r.chunking.reused}${r.quarantined.length ? ` · 격리 ${r.quarantined.length}편` : ''}`)
  out(`  파일 ${r.files.size}개 · 합계 ${(size / 1048576).toFixed(1)} MB · 걸린 시간 ${r.timings.total} ms (${Object.entries(r.timings).map(([k, v]) => `${k} ${v}`).join(' · ')})`)
  if (quiet) {
    if (r.findings.length) err(`  ${ruleCounts('경고', r.findings)}`)
    if (r.warnings.length) err(`  경고 줄 ${r.warnings.length}`)
  } else {
    for (const f of r.findings) err(`  경고 ${f.rule} ${f.path}:${f.line} ${f.excerpt}`)
    for (const w of r.warnings) err(`  경고 ${w}`)
  }
  if (r.stale) out(`  낡음 판정: 판정 불가 ${r.stale.unverifiable} · 근거 없는 문서 ${r.stale.noAnchorDocs} · 근거 확인 불가 ${r.stale.unverifiableAnchors}${r.stale.warnings.length ? ` · 경고 줄 ${r.stale.warnings.length}` : ''}`)
}

/** 프로젝트 색인 폴더를 새로 만든다. force 가 아니면 원천이 그대로일 때 만들지 않는다. 다시 만들었으면 결과를 돌려준다. */
export async function buildProject(opt: Opts, force: boolean): Promise<{ result: BuildResult | null; bundleDir: string }> {
  const project = resolveProject(opt)
  const ctx = rootContext(project.root, project.configPath)
  let result: BuildResult | null = null
  const job = { cfg: ctx.cfg, repoRoot: ctx.worktree, outDir: nextBundleDir(ctx.cacheDir), opt, cacheDir: ctx.cacheDir }
  await refreshIndex(ctx, () => (result = runBuild(job)), { force })
  return { result, bundleDir: path.join(ctx.cacheDir, 'bundle') }
}

export async function cmdBuild(_pos: string[], opt: Opts): Promise<number> {
  const outDir = str(opt.out)
  if (!outDir) {
    const { result, bundleDir } = await buildProject(opt, opt.force === true || !opt['if-changed'])
    if (result) reportBuild(result, bundleDir, opt.quiet === true)
    else out(`색인이 최신이다 → ${bundleDir}`)
    return 0
  }
  const cfgPath = str(opt.config)
  if (!cfgPath) throw new UsageError('build --out 에는 --config 가 필요하다(프로젝트 색인은 --out 없이 build)')
  const r = runBuild({ cfg: loadConfig(cfgPath), repoRoot: path.resolve(str(opt.root) ?? process.cwd()), outDir, opt })
  reportBuild(r, outDir, opt.quiet === true)
  const tar = str(opt.tar)
  if (tar) writeTar(tar, r.files)
  return 0
}

/** pages/ 아래 원고를 보안 검사한다. 실패 판정이 하나라도 있으면 true. */
function checkPagesSecurity(files: Map<string, Buffer>, profile: 'server' | 'local', security: SecurityConfig): boolean {
  let failed = false
  for (const [name, data] of files) {
    if (!name.startsWith('pages/')) continue
    for (const f of scanText(data.toString('utf8'), name.slice(6), profile, security)) {
      if (f.severity === 'fail') failed = true
      err(`보안 ${f.severity === 'fail' ? '실패' : '경고'} ${f.rule} ${f.path}:${f.line} ${f.excerpt}`)
    }
  }
  return failed
}

export function cmdCheck(pos: string[], opt: Opts): number {
  const files = readBundle(pos[0] ?? '')
  const v = verifyBundle(files)
  let failed = !v.ok
  for (const i of v.issues) err(`형식 ${i.code}: ${i.message}`)
  if (v.ok && v.manifest) {
    const profile = (str(opt.profile) ?? v.manifest.profile) as 'server' | 'local'
    if (checkPagesSecurity(files, profile, v.manifest.security ?? {})) failed = true
    const links = JSON.parse(files.get('links.json')!.toString('utf8')) as LinksFile
    for (const b of links.broken.slice(0, 50)) err(`끊긴 링크 ${b[0]} → ${b[1]}`)
    if (links.broken.length > 50) err(`끊긴 링크 ${links.broken.length - 50}건 더 있음`)
    if (opt.strict === true && links.broken.length) failed = true
    out(`검사 ${failed ? '실패' : '통과'}: 형식 ${v.ok ? '맞음' : '틀림'} · 끊긴 링크 ${links.broken.length} · 낡음 ${v.manifest.counts.stale} · 낡음 후보 ${v.manifest.counts.staleCandidates}`)
  }
  return failed ? 1 : 0
}
