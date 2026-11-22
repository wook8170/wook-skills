// init 명령. 저장소를 훑어 문서 폴더를 찾고 위키 설정 · 프로젝트 설정 문서 · .gitignore 줄을 만든다. 이미 있는 파일은 덮어쓰지 않는다.
// 부르는 곳: cli/main.ts. 먼저 읽을 파일: init/plan.ts(판정) · init/write.ts(쓰기).
import path from 'node:path'
import { listRepoFiles } from '../init/files.ts'
import { planWiki } from '../init/plan.ts'
import { writeInitFiles } from '../init/write.ts'
import { out, str, type Opts } from './args.ts'
import { WIKI_DIR } from './project.ts'

export function cmdInit(_pos: string[], opt: Opts): number {
  const root = path.resolve(str(opt.root) ?? process.cwd())
  const wikiDir = path.resolve(str(opt['wiki-dir']) ?? path.join(root, WIKI_DIR))
  const plan = planWiki(path.basename(root), listRepoFiles(root))
  const actions = writeInitFiles(root, wikiDir, plan)
  if (opt.json === true) {
    out(JSON.stringify({ root, wikiDir, sources: plan.sources, actions }, null, 2))
    return 0
  }
  out(`위키 ${plan.config.bundle.name} · 저장소 ${root}`)
  for (const s of plan.sources) out(`  원천 ${s.name.padEnd(14)} ${s.include.join(' ')}${s.area ? ` · 영역 ${s.area}` : ''} · 문서 ${s.files}`)
  if (!plan.sources.length) out('  Markdown 문서를 찾지 못했다. config.json 의 sources 를 직접 적는다')
  const label = { created: '만듦', kept: '그대로 둠(이미 있음)', appended: '줄 더함' } as const
  for (const a of actions) out(`  ${label[a.action]} ${a.path}`)
  out('다음: build 로 색인을 만든다')
  return 0
}
