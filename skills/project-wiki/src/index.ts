// 라이브러리 공개 진입점. 시험과 다른 도구가 이 파일만 import 한다. CLI 는 cli/main.ts 다.
// 부르는 곳: cli/build.ts. 먼저 읽을 파일: core/model.ts.
// 핵심(core)은 Node 표준 모듈만 쓴다. 먼저 읽을 파일: core/build.ts(만들기) · core/search.ts(찾기).
import { markdownAdapter, type AdapterPack } from './core/adapter.ts'
import { readBundle } from './core/bundle.ts'
import { WikiIndex } from './core/search.ts'
import type { TarLimits } from './core/tar.ts'

export * from './core/model.ts'
export { markdownAdapter, fileAnchor, type Adapter, type AdapterContext, type AdapterOutput, type AdapterPack } from './core/adapter.ts'
export { buildBundle, loadConfig, normalizeConfig, readSources, ConfigError, DirtyError, SecurityError, type WikiConfig, type BuildOptions, type BuildIdentity, type BuildResult } from './core/build.ts'
export { openChunkCache, type ChunkCache } from './core/chunk-cache.ts'
export { hasSecret, splitQuarantined } from './core/quarantine.ts'
export { planWiki, bundleNameOf, DEFAULT_EXCLUDES, type InitPlan, type PlannedSource } from './init/plan.ts'
export {
  MANIFEST,
  SIGNATURE,
  BUNDLE_NAME_RE,
  BUNDLE_VERSION_RE,
  finalizeManifest,
  packBundle,
  readBundle,
  readBundleDir,
  stableJson,
  verifyBundle,
  writeBundleDir,
  type BundleFiles,
  type VerifyIssue,
} from './core/bundle.ts'
export { chunkUnit, DEFAULT_RULES, type ChunkRules, type FigureReader } from './core/chunk.ts'
export { levelMarks, sectionLevels, SectionLevelError } from './core/section-level.ts'
export { diffChunks, type BundleDiff } from './core/diff.ts'
export { buildLinks, codeNode, definitionText, type IdRule } from './core/links.ts'
export { WikiIndex, isReadError, GENERATED_WEIGHT, AREA_WEIGHT, type SearchOptions, type SearchHit, type SearchResult, type ReadResult, type ReadError, type Catalog } from './core/search.ts'
export { scanText, SECURITY_RULES_VERSION, type SecurityConfig, type AllowEntry } from './core/security.ts'
export { DEFAULT_LIMITS, TarError, extractTarGzFile, packTarGz, safeEntryPath, unpackTarGz, type TarLimits } from './core/tar.ts'
export { TOKENIZER, tokenize, type Token, type TokenType } from './core/tokenize.ts'
export { extractLinkTerms, LINK_TERM_TYPES, LexicalIndex } from './core/lexical.ts'
export { decodeId, encodeId, parseFrontmatter, sha256Hex, slugify } from './core/util.ts'
export { WIKI_TOOLS, ToolInputError, callWikiTool, validateArgs, type ToolDef, type ToolScope } from './mcp/tools.ts'
export { handleRpc, serveStdio, SERVER_INFO } from './mcp/server.ts'
export { evaluate, judge, resolveGold, GoldUnresolvedError, type QuestionFile, type EvalSummary } from './eval/retrieval.ts'

/** 핵심 어댑터만 든 묶음(일반 Markdown 저장소용). */
export const corePack: AdapterPack = { adapters: [markdownAdapter], idRules: [], idTypes: [] }

/** 폴더 또는 tar.gz 묶음을 열어 검색 색인을 만든다. 형식 · 해시 검증을 통과해야 열린다. */
export function openBundle(p: string, limits?: TarLimits): WikiIndex {
  return new WikiIndex(readBundle(p, limits))
}
