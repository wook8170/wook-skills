// 나누기 결과 캐시. 문서 하나의 내용 · 속성이 그대로면 지난 빌드의 조각을 다시 쓴다.
// 부르는 곳: core/build.ts collectSources(작업 트리 모드의 자식 빌드가 --chunk-cache 로 파일을 준다).
// 먼저 읽을 파일: core/chunk.ts(chunkUnit). 링크 · 낱말 색인은 캐시하지 않고 매번 전체를 다시 만든다.
import fs from 'node:fs'
import path from 'node:path'
import { stableJson } from './bundle.ts'
import type { Chunk, SourceUnit } from './model.ts'
import { sha256Hex } from './util.ts'

const CACHE_FORMAT = 1

export interface ChunkCache {
  get(u: SourceUnit): Chunk[] | undefined
  set(u: SourceUnit, chunks: Chunk[]): void
  /** 이번 빌드에서 쓴 항목만 남겨 파일에 쓴다. 파일을 주지 않았으면 아무것도 하지 않는다. */
  save(): void
  /** 캐시에서 꺼낸 문서 수와 새로 나눈 문서 수. */
  stats(): { reused: number; chunked: number }
}

interface CacheFile {
  format: number
  rules: string
  entries: Record<string, Chunk[]>
}

/** 캐시 열쇠: 나누기 규칙과 문서 속성 전체(원문 포함)의 해시. 무엇이든 바뀌면 다시 나눈다. */
function unitKey(u: SourceUnit, rules: string): string {
  return sha256Hex(`${rules}\n${stableJson(u)}`).slice(0, 32)
}

function readCacheFile(file: string, rules: string): Record<string, Chunk[]> {
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheFile
    return raw.format === CACHE_FORMAT && raw.rules === rules ? raw.entries : {}
  } catch (e) {
    if (e instanceof SyntaxError) return {}
    throw e
  }
}

/** 뒤 단계(낡음 표시 · 수정일)가 조각을 고치므로 꺼낼 때와 넣을 때 모두 사본을 쓴다. */
const copyOf = (chunks: Chunk[]): Chunk[] => structuredClone(chunks)

export function openChunkCache(file: string | undefined, rules: string): ChunkCache {
  const old = file ? readCacheFile(file, rules) : {}
  const used: Record<string, Chunk[]> = {}
  let reused = 0
  let chunked = 0
  return {
    get(u) {
      const key = unitKey(u, rules)
      const hit = old[key]
      if (!hit) return undefined
      used[key] = hit
      reused++
      return copyOf(hit)
    },
    set(u, chunks) {
      used[unitKey(u, rules)] = copyOf(chunks)
      chunked++
    },
    save() {
      if (!file) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body: CacheFile = { format: CACHE_FORMAT, rules, entries: used }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(body))
      fs.renameSync(`${file}.tmp`, file)
    },
    stats: () => ({ reused, chunked }),
  }
}
