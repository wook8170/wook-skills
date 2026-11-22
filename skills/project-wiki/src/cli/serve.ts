// serve-mcp 명령. 표준 입출력 MCP 서버를 띄운다. --bundle 이면 고정 묶음, 그 밖에는 작업 트리 색인(뒤에서 다시 만든다)으로 답한다.
// 부르는 곳: cli/main.ts. 먼저 읽을 파일: mcp/server.ts · dev/serve-root.ts.
import { serveStdio } from '../mcp/server.ts'
import { serveRoot } from '../dev/serve-root.ts'
import { UsageError, areaScope, err, str, type Opts } from './args.ts'
import { resolveProject } from './project.ts'
import { capOf, openBundleIndex } from './query.ts'

export async function cmdServeMcp(_pos: string[], opt: Opts): Promise<number> {
  const scope = areaScope(opt)
  if (opt.bundle !== undefined) {
    if (opt.root !== undefined) throw new UsageError('--bundle 과 --root 는 함께 줄 수 없다')
    const index = openBundleIndex(str(opt.bundle))
    const cap = capOf(index, opt.level)
    const areas = scope.areas ? ` · 영역 ${scope.areas.join(',')}` : ''
    const excluded = scope.excludeAreas ? ` · 뺀 영역 ${scope.excludeAreas.join(',')}` : ''
    err(`wiki-index MCP: ${index.manifest.name} ${index.manifest.version} · 등급 상한 ${cap}${areas}${excluded}`)
    await serveStdio(index, { cap, ...scope })
    return 0
  }
  const project = resolveProject(opt)
  await serveRoot({ root: project.root, config: project.configPath, level: str(opt.level), ...scope, log: err })
  return 0
}
