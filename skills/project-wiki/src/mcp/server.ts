// 표준 입출력 MCP 서버(JSON-RPC 2.0, 줄 단위). initialize · tools/list · tools/call · ping 만 다룬다.
// 부르는 곳: cli/serve.ts · dev/serve-root.ts · index.ts. 먼저 읽을 파일: mcp/tools.ts.
// 범위(묶음 · 등급 상한 · 영역)는 띄울 때 정하고, 도구 인자로는 넓힐 수 없다.
// 색인 원천은 고정 묶음(--bundle) 또는 작업 트리 색인(--root, dev/live-index.ts)이다. 작업 트리 색인이면 결과 첫 줄에 기준 줄을 붙인다.
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { WikiIndex } from '../core/search.ts'
import type { Snapshot } from '../dev/basis.ts'
import { ToolInputError, WIKI_TOOLS, callWikiTool, type ToolScope } from './tools.ts'

export const SERVER_INFO = { name: 'wiki-indexer', version: '0.1.0' }
const DEFAULT_PROTOCOL = '2025-06-18'

/** 작업 트리 색인. 부를 때마다 지금 답할 색인과 기준을 돌려준다. 색인이 아직 없으면 index 가 null 이다. */
export interface IndexSource {
  snapshot(): Snapshot
}


export type IndexInput = WikiIndex | IndexSource

const BUILDING = { error: 'index_building', message: '색인을 만드는 중이다 · rg -a 로 찾으세요' }

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/** 도구 결과. 작업 트리 색인이면 본문 첫 줄에 기준 줄을 붙이고 structuredContent 에 basis 를 더한다. */
function toolResult(result: unknown, snap: Snapshot | null): Record<string, unknown> {
  if (!snap) return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  return { content: [{ type: 'text', text: `${snap.line}\n${JSON.stringify(result)}` }], structuredContent: { ...(result as object), basis: snap.basis } }
}

function errorResult(body: { error: string; message: string }): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
}

/** 지금 답할 색인과 그 시점. 고정 묶음이면 시점이 없다(null). */
function current(src: IndexInput): { index: WikiIndex | null; snap: Snapshot | null } {
  if (src instanceof WikiIndex) return { index: src, snap: null }
  const snap = src.snapshot()
  return { index: snap.index, snap }
}

function initializeInfo(src: IndexInput, scope: ToolScope): string {
  const index = src instanceof WikiIndex ? src : src.snapshot().index
  const head = index ? `묶음 ${index.manifest.name} ${index.manifest.version}(기준 커밋 ${index.manifest.commit ?? '없음'}). 등급 상한 ${scope.cap}.` : `색인을 만드는 중이다. 등급 상한 ${scope.cap}.`
  return src instanceof WikiIndex ? head : `${head} 도구 결과의 첫 줄이 기준이다(기준 커밋 · 미커밋 수 · 다시 만들기 상태).`
}

/** 요청 하나를 처리한다. 알림(id 없음)이면 null. 시험이 이 함수를 직접 부른다. */
export function handleRpc(src: IndexInput, scope: ToolScope, req: RpcRequest): unknown {
  const isNotification = req.id === undefined
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: req.id, result })
  const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: '2.0', id: req.id ?? null, error: { code, message } })
  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: initializeInfo(src, scope),
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: WIKI_TOOLS })
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      const { index, snap } = current(src)
      if (!index) return ok(errorResult(BUILDING))
      try {
        return ok(toolResult(callWikiTool(index, name, req.params?.arguments, scope), snap))
      } catch (e) {
        if (e instanceof ToolInputError) return ok(errorResult({ error: e.code, message: e.message }))
        return fail(-32603, `도구 실행 오류: ${(e as Error).message}`)
      }
    }
    default:
      return fail(-32601, `지원하지 않는 메서드: ${req.method}`)
  }
}

/** 표준 입출력에서 줄마다 요청을 읽어 응답을 쓴다. */
export function serveStdio(src: IndexInput, scope: ToolScope, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 을 읽을 수 없다' } }) + '\n')
      return
    }
    const res = handleRpc(src, scope, req)
    if (res) output.write(JSON.stringify(res) + '\n')
  })
  return new Promise((resolve) => rl.on('close', () => resolve()))
}
