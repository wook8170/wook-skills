// 묶음 tar.gz 쓰기 · 안전하게 풀기. ustar 형식만 쓰고 읽는다. 외부 의존성 없음(node 표준 zlib).
// 부르는 곳: cli/main.ts · core/bundle.ts · index.ts. 먼저 읽을 파일: core/bundle.ts.
// 풀 때 막는 것: 경로 이동(절대 경로 · `..` · 역슬래시 · NUL), 링크 · 장치 항목, 같은 경로 두 번,
// 압축 폭탄(푼 크기 합계 · 항목 수 상한), 머리 검사합 · 크기 속임.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const BLOCK = 512

export type TarErrorCode = 'TOO_LARGE' | 'TOO_MANY_ENTRIES' | 'UNSAFE_PATH' | 'UNSUPPORTED_ENTRY' | 'DUPLICATE_ENTRY' | 'BAD_ARCHIVE'

export class TarError extends Error {
  readonly code: TarErrorCode
  constructor(code: TarErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface TarLimits {
  /** 압축 파일 크기 상한. */
  maxCompressedBytes: number
  /** 푼 파일 크기 합계 상한. */
  maxTotalBytes: number
  maxEntries: number
}

/** 풀기 상한 기본값. */
export const DEFAULT_LIMITS: TarLimits = { maxCompressedBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxEntries: 20000 }

/** tar 안 경로 → 안전한 상대 경로. 위험하면 TarError. */
export function safeEntryPath(raw: string): string {
  if (!raw || raw.includes('\0') || raw.includes('\\')) throw new TarError('UNSAFE_PATH', `허용하지 않는 경로: ${JSON.stringify(raw)}`)
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new TarError('UNSAFE_PATH', `절대 경로는 받지 않는다: ${raw}`)
  const parts = raw.replace(/^\.\/+/, '').split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) throw new TarError('UNSAFE_PATH', `경로 이동 항목: ${raw}`)
  return parts.join('/')
}

function writeStr(h: Buffer, s: string, off: number, len: number): void {
  const b = Buffer.from(s, 'utf8')
  if (b.length > len) throw new TarError('BAD_ARCHIVE', `머리 칸이 넘친다: ${s}`)
  b.copy(h, off)
}

function writeOct(h: Buffer, n: number, off: number, len: number): void {
  writeStr(h, n.toString(8).padStart(len - 1, '0'), off, len - 1)
}

function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  let prefix = ''
  let base = name
  if (Buffer.byteLength(name) > 100) {
    // ustar: 앞 155바이트 접두 + 뒤 100바이트 이름으로 나눈다(`/` 경계).
    const parts = name.split('/')
    for (let i = parts.length - 1; i > 0; i--) {
      const p = parts.slice(0, i).join('/')
      const n = parts.slice(i).join('/')
      if (Buffer.byteLength(p) <= 155 && Buffer.byteLength(n) <= 100) {
        prefix = p
        base = n
        break
      }
    }
    if (!prefix) throw new TarError('BAD_ARCHIVE', `경로가 너무 길다(ustar 255바이트): ${name}`)
  }
  writeStr(h, base, 0, 100)
  writeOct(h, 0o644, 100, 8)
  writeOct(h, 0, 108, 8)
  writeOct(h, 0, 116, 8)
  writeOct(h, size, 124, 12)
  writeOct(h, mtime, 136, 12)
  h.fill(0x20, 148, 156)
  h[156] = 0x30
  writeStr(h, 'ustar', 257, 6)
  writeStr(h, '00', 263, 2)
  writeStr(h, prefix, 345, 155)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  writeStr(h, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return h
}

/** 파일 목록(경로 → 내용)을 tar.gz 로 묶는다. 순서 · 시각이 고정이라 같은 입력이면 같은 바이트다. */
export function packTarGz(entries: Array<[string, Buffer]>, mtimeSec: number): Buffer {
  const parts: Buffer[] = []
  for (const [name, data] of entries) {
    parts.push(header(safeEntryPath(name), data.length, mtimeSec), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 })
}

function cstr(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len)
  const z = s.indexOf(0)
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8')
}

/** gzip 을 푼다. 머리 블록 몫을 더한 크기에서 멈추고, 그 이상 풀리면 폭탄으로 본다. */
function gunzipLimited(gz: Buffer, limits: TarLimits): Buffer {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + (limits.maxEntries + 2) * BLOCK * 2 })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new TarError('TOO_LARGE', '푼 크기가 상한을 넘는다')
    throw new TarError('BAD_ARCHIVE', `gzip 을 풀 수 없다: ${(e as Error).message}`)
  }
}

interface TarHeader {
  type: string
  raw: string
  size: number
}

/** 머리 블록 하나를 읽는다. 검사합이나 크기 칸이 틀리면 TarError. */
function readHeader(h: Buffer): TarHeader {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
  if (parseInt(cstr(h, 148, 8).trim(), 8) !== sum) throw new TarError('BAD_ARCHIVE', '머리 검사합이 맞지 않는다')
  const type = String.fromCharCode(h[156] || 0x30)
  const prefix = cstr(h, 345, 155)
  const raw = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100)
  const size = parseInt(cstr(h, 124, 12).trim() || '0', 8)
  if (!Number.isFinite(size) || size < 0) throw new TarError('BAD_ARCHIVE', `크기 칸이 잘못됐다: ${raw}`)
  return { type, raw, size }
}

/** 일반 파일 항목의 경로를 확인한다. 경로 규칙 · 중복 · 항목 수 상한 순서로 보고, 어기면 TarError. */
function entryName(out: Map<string, Buffer>, raw: string, limits: TarLimits): string {
  const name = safeEntryPath(raw)
  if (out.has(name)) throw new TarError('DUPLICATE_ENTRY', `같은 경로가 두 번 있다: ${name}`)
  if (out.size + 1 > limits.maxEntries) throw new TarError('TOO_MANY_ENTRIES', `항목 수가 상한(${limits.maxEntries})을 넘는다`)
  return name
}

/** tar.gz 를 메모리에서 풀어 (경로 → 내용) 을 돌려준다. 상한 · 경로 규칙을 어기면 TarError. */
export function unpackTarGz(gz: Buffer, limits: TarLimits = DEFAULT_LIMITS): Map<string, Buffer> {
  if (gz.length > limits.maxCompressedBytes) throw new TarError('TOO_LARGE', `압축 파일이 상한(${limits.maxCompressedBytes}바이트)보다 크다`)
  const tar = gunzipLimited(gz, limits)
  const out = new Map<string, Buffer>()
  let off = 0
  let total = 0
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK)
    if (h.every((b) => b === 0)) break
    const { type, raw, size } = readHeader(h)
    off += BLOCK
    if (type === '5') {
      safeEntryPath(raw)
      continue
    }
    if (type !== '0') throw new TarError('UNSUPPORTED_ENTRY', `일반 파일이 아닌 항목(${type}): ${raw}`)
    const name = entryName(out, raw, limits)
    total += size
    if (total > limits.maxTotalBytes) throw new TarError('TOO_LARGE', `푼 크기 합계가 상한(${limits.maxTotalBytes}바이트)을 넘는다`)
    if (off + size > tar.length) throw new TarError('BAD_ARCHIVE', `항목이 잘렸다: ${name}`)
    out.set(name, Buffer.from(tar.subarray(off, off + size)))
    off += Math.ceil(size / BLOCK) * BLOCK
  }
  return out
}

/** tar.gz 파일을 outDir 에 푼다. outDir 은 비어 있어야 한다. */
export function extractTarGzFile(file: string, outDir: string, limits: TarLimits = DEFAULT_LIMITS): string[] {
  const st = fs.statSync(file)
  if (st.size > limits.maxCompressedBytes) throw new TarError('TOO_LARGE', `압축 파일이 상한(${limits.maxCompressedBytes}바이트)보다 크다`)
  const entries = unpackTarGz(fs.readFileSync(file), limits)
  fs.mkdirSync(outDir, { recursive: true })
  if (fs.readdirSync(outDir).length) throw new TarError('BAD_ARCHIVE', `풀 폴더가 비어 있지 않다: ${outDir}`)
  const root = path.resolve(outDir)
  for (const [name, data] of entries) {
    const dest = path.resolve(root, name)
    if (!dest.startsWith(root + path.sep)) throw new TarError('UNSAFE_PATH', `경로 이동 항목: ${name}`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data, { flag: 'wx' })
  }
  return [...entries.keys()]
}
