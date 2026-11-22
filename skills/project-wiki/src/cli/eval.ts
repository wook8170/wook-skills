// diff · eval 명령. diff 는 두 묶음의 조각을 견주고, eval 은 질문 파일로 검색 재현율을 잰다(회귀선 비교 포함).
// 부르는 곳: cli/main.ts. 먼저 읽을 파일: core/diff.ts · eval/retrieval.ts.
import fs from 'node:fs'
import { readBundle, stableJson } from '../core/bundle.ts'
import { diffChunks } from '../core/diff.ts'
import type { Chunk, Level } from '../core/model.ts'
import type { WikiIndex } from '../core/search.ts'
import { GoldUnresolvedError, evaluate, judge, type EvalSummary, type QuestionFile } from '../eval/retrieval.ts'
import { UsageError, err, out, str, type Opts } from './args.ts'
import { capOf, openBundleIndex } from './query.ts'

function loadChunks(p: string | undefined): Chunk[] {
  return readBundle(p ?? '')
    .get('chunks.jsonl')!
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Chunk)
}

export function cmdDiff(pos: string[], opt: Opts): number {
  const d = diffChunks(loadChunks(pos[0]), loadChunks(pos[1]))
  if (opt.json === true) out(JSON.stringify(d, null, 2))
  else out(`더해짐 ${d.added.length} · 바뀜 ${d.changed.length} · 빠짐 ${d.removed.length} · 옮김 ${d.moved.length} · 낡음 변화 ${d.staleChanged.length}`)
  return 0
}

function loadBaseline(basePath: string | undefined): EvalSummary | null {
  return basePath && fs.existsSync(basePath) ? (JSON.parse(fs.readFileSync(basePath, 'utf8')) as { summary: EvalSummary }).summary : null
}

/** 정답 안정 키가 풀리지 않으면 안내를 쓰고 null 을 돌려준다(종료 코드 2). 다른 오류는 그대로 던진다. */
function evaluateOrReport(index: WikiIndex, qf: QuestionFile, cap: Level): ReturnType<typeof evaluate> | null {
  try {
    return evaluate(index, qf, cap)
  } catch (e) {
    if (!(e instanceof GoldUnresolvedError)) throw e
    err(`gold_unresolved: ${e.ids.join(', ')} — 정답 안정 키(원천 경로 · 절 제목)를 지금 원고에 맞게 고친다`)
    return null
  }
}

function printEval(res: ReturnType<typeof evaluate>, reasons: string[]): void {
  for (const r of res.results) out(`${r.id.padEnd(6)} ${r.inScope ? (r.rank ? `순위 ${r.rank}` : '놓침') : '범위 밖'}  ${r.q}`)
  const s = res.summary
  out(`재현율@5 ${s.recallAt5.toFixed(2)} · 재현율@10 ${s.recallAt10.toFixed(2)} · MRR ${s.mrr.toFixed(3)} · 상위 5 낡음 ${s.staleTop5.toFixed(2)} · 낡음 후보 ${s.staleCandidateTop5.toFixed(2)} (대상 ${s.inScope}/${s.questions})`)
  for (const r of reasons) err(`실패 사유: ${r}`)
}

export function cmdEval(pos: string[], opt: Opts): number {
  const index = openBundleIndex(pos[0])
  const qPath = str(opt.questions)
  if (!qPath) throw new UsageError('--questions 가 필요하다')
  const qf = JSON.parse(fs.readFileSync(qPath, 'utf8')) as QuestionFile
  const basePath = str(opt.baseline)
  const res = evaluateOrReport(index, qf, capOf(index, opt.level))
  if (!res) return 2
  const verdict = judge(res.summary, qf, loadBaseline(basePath))
  printEval(res, verdict.reasons)
  const record = { bundle: { name: index.manifest.name, version: index.manifest.version, commit: index.manifest.commit }, summary: res.summary, results: res.results }
  const outFile = str(opt.out)
  if (outFile) fs.writeFileSync(outFile, stableJson(record, 2) + '\n')
  if (opt['update-baseline'] === true) {
    if (!basePath) throw new UsageError('--update-baseline 에는 --baseline 경로가 필요하다')
    fs.writeFileSync(basePath, stableJson({ bundle: record.bundle, summary: res.summary }, 2) + '\n')
    out(`회귀선 갱신: ${basePath}`)
  }
  return verdict.pass ? 0 : 1
}
