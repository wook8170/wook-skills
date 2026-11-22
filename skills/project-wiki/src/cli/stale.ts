// stale · mark-synced 명령. stale 은 결정 · 정책 문서의 근거가 기준 커밋 뒤 바뀌었는지 판정하고(출하 차단 0건이면 종료 0),
// mark-synced 는 문서의 기준 커밋 칸을 HEAD 로 쓴다. 부르는 곳: cli/main.ts.
// 먼저 읽을 파일: core/stale.ts · core/stale-baseline.ts.
import { ConfigError, loadConfig, readSources, type WikiConfig } from '../core/build.ts'
import { markSynced } from '../core/mark-synced.ts'
import type { SourceUnit } from '../core/model.ts'
import { gitRunner, judgeStale, staleJson, type StaleReport } from '../core/stale.ts'
import { baselinePath, lockNoStatus, readBaseline, updateBaseline } from '../core/stale-baseline.ts'
import { countLinks } from '../core/stale-status.ts'
import { cmp } from '../core/util.ts'
import { UsageError, err, many, out, type Opts } from './args.ts'
import { packOf } from './build.ts'
import { resolveProject } from './project.ts'

function configAndRoot(opt: Opts): { cfg: WikiConfig; cfgPath: string; repoRoot: string } {
  const project = resolveProject(opt)
  return { cfg: loadConfig(project.configPath), cfgPath: project.configPath, repoRoot: project.root }
}

/** 원천을 읽고, 글롭에 맞지만 심볼릭 링크라서 읽지 않은 문서 경로도 함께 돌려준다. */
function readUnitsAndLinks(cfg: WikiConfig, repoRoot: string): { units: SourceUnit[]; links: string[] } {
  const sources = readSources(cfg, repoRoot, packOf(cfg.pack))
  return { units: sources.flatMap((s) => s.units), links: [...new Set(sources.flatMap((s) => s.out.links ?? []))].sort(cmp) }
}

/**
 * 설정에 기준 목록 파일이 있으면 견준다. `--update-baseline` · `--accept-new` 면 먼저 목록을 고쳐 쓴다
 * (빠진 경로 지우기 · 준 경로 더하기). `--require-baseline` 이면 설정에 칸이 없을 때 종료 2 다.
 */
function applyBaseline(cfg: WikiConfig, cfgPath: string, report: StaleReport, opt: Opts): void {
  const accept = many(opt['accept-new'])
  const write = opt['update-baseline'] === true || accept.length > 0
  const file = baselinePath(cfg, cfgPath, opt['require-baseline'] === true)
  if (!file) {
    if (write) throw new UsageError('--update-baseline · --accept-new 에는 설정의 noStatusBaseline 이 필요하다')
    return
  }
  lockNoStatus(report, write ? updateBaseline(file, report, accept, err) : readBaseline(file))
}

function printStale(report: StaleReport): void {
  for (const b of report.block) out(`차단 ${b.id}  ${b.title} — ${b.reason}`)
  const gone = report.noStatusGone ? ` · 기준 목록에서 빠진 문서 ${report.noStatusGone}` : ''
  out(`출하 차단 ${report.block.length} · 경고 ${report.warn} · 판정 불가 ${report.unverifiable} · 근거 없는 문서 ${report.noAnchorDocs} · 근거 확인 불가 ${report.unverifiableAnchors} · 상태를 읽지 못한 결정 · 정책 문서 ${report.noStatusDocs}${gone}`)
}

/** 낡음 판정. 미커밋 변경이 있어도 작업 트리를 그대로 읽는다. */
export function cmdStale(_pos: string[], opt: Opts): number {
  const { cfg, cfgPath, repoRoot } = configAndRoot(opt)
  const { units, links } = readUnitsAndLinks(cfg, repoRoot)
  const { report } = judgeStale(units, gitRunner(repoRoot))
  countLinks(links, report)
  applyBaseline(cfg, cfgPath, report, opt)
  if (opt.json === true) out(JSON.stringify(staleJson(report), null, 2))
  else printStale(report)
  for (const w of report.warnings) err(`경고 ${w}`)
  return report.block.length ? 1 : 0
}

export function cmdMarkSynced(pos: string[], opt: Opts): number {
  const { cfg, repoRoot } = configAndRoot(opt)
  if (!pos.length) throw new UsageError('mark-synced 에 문서 경로가 없다')
  const head = gitRunner(repoRoot)(['rev-parse', 'HEAD'])
  const sha = head.out.trim()
  if (head.code !== 0 || !sha) throw new ConfigError('HEAD 커밋을 읽지 못했다(git 저장소인지 확인한다)')
  const units = readUnitsAndLinks(cfg, repoRoot).units
  const written = markSynced({ repoRoot, paths: pos, units, pack: packOf(cfg.pack), head: sha })
  for (const rel of written) out(`기준 커밋 ${sha.slice(0, 10)} → ${rel}`)
  return 0
}
