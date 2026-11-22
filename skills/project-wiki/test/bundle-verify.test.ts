import zlib from 'node:zlib'
import { describe, expect, it } from './support/vitest-shim.ts'
import { MANIFEST, finalizeManifest, packBundle, stableJson, verifyBundle, type BundleFiles } from '../src/core/bundle.ts'
import type { Manifest } from '../src/core/model.ts'
import { TarError, packTarGz, unpackTarGz } from '../src/core/tar.ts'

/** 검사합까지 맞춘 ustar 머리를 손으로 만든다(위험한 항목을 일부러 만들기 위해). */
function rawHeader(name: string, size: number, type = '0', link = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0)
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.fill(0x20, 148, 156)
  h.write(type, 156)
  h.write(link, 157)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

function tarOf(entries: Array<{ name: string; data?: Buffer; type?: string; link?: string; size?: number }>): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0)
    parts.push(rawHeader(e.name, e.size ?? data.length, e.type, e.link), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}

function sampleBundle(over: Partial<Manifest> = {}): BundleFiles {
  const files: BundleFiles = new Map([['chunks.jsonl', Buffer.from('{"id":"a"}\n')]])
  const base = { formatVersion: 1, name: 'test-wiki', title: 't', version: '1.0.0', createdAt: '2026-01-01T00:00:00Z' } as unknown as Omit<Manifest, 'files'>
  const m = { ...finalizeManifest(base, files), ...over }
  files.set(MANIFEST, Buffer.from(stableJson(m, 2)))
  return files
}

describe('tar.gz 풀기 거절', () => {
  it('경로 이동(..) 항목', () => {
    expect(() => unpackTarGz(tarOf([{ name: '../evil', data: Buffer.from('x') }]))).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }))
  })
  it('절대 경로 항목', () => {
    expect(() => unpackTarGz(tarOf([{ name: '/etc/passwd', data: Buffer.from('x') }]))).toThrow(TarError)
  })
  it('심볼릭 링크 · 하드 링크 항목', () => {
    expect(() => unpackTarGz(tarOf([{ name: 'link', type: '2', link: '/etc/passwd' }]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ENTRY' }))
    expect(() => unpackTarGz(tarOf([{ name: 'hard', type: '1', link: 'a' }]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ENTRY' }))
  })
  it('같은 경로 두 번', () => {
    expect(() => unpackTarGz(tarOf([{ name: 'a', data: Buffer.from('1') }, { name: 'a', data: Buffer.from('2') }]))).toThrow(expect.objectContaining({ code: 'DUPLICATE_ENTRY' }))
  })
  it('압축 폭탄: 푼 크기 합계 상한', () => {
    const big = Buffer.alloc(2 * 1024 * 1024)
    const gz = tarOf([{ name: 'a', data: big }])
    expect(gz.length).toBeLessThan(64 * 1024)
    expect(() => unpackTarGz(gz, { maxCompressedBytes: 1 << 20, maxTotalBytes: 1 << 20, maxEntries: 10 })).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }))
  })
  it('선언 크기 속임(머리 크기가 실제보다 큼)', () => {
    expect(() => unpackTarGz(tarOf([{ name: 'a', data: Buffer.from('x'), size: 4096 }]))).toThrow(TarError)
  })
  it('항목 수 상한', () => {
    const gz = tarOf(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })))
    expect(() => unpackTarGz(gz, { maxCompressedBytes: 1 << 20, maxTotalBytes: 1 << 20, maxEntries: 3 })).toThrow(expect.objectContaining({ code: 'TOO_MANY_ENTRIES' }))
  })
  it('정상 묶음은 왕복된다(긴 한글 경로 포함)', () => {
    const name = `pages/docs/design/05-data-design/${'테이블-정의'.repeat(4)}.md`
    const gz = packTarGz([[name, Buffer.from('본문')]], 0)
    expect(unpackTarGz(gz).get(name)?.toString()).toBe('본문')
  })
})

describe('묶음 검증', () => {
  it('맞는 묶음은 통과하고 packBundle 은 같은 입력에 같은 바이트', () => {
    const f = sampleBundle()
    expect(verifyBundle(f).ok).toBe(true)
    expect(packBundle(f).equals(packBundle(f))).toBe(true)
  })
  it('formatVersion 이 범위 밖이면 format_unsupported', () => {
    expect(verifyBundle(sampleBundle({ formatVersion: 2 })).issues[0].code).toBe('format_unsupported')
    expect(verifyBundle(sampleBundle({ formatVersion: '1' as unknown as number })).issues[0].code).toBe('format_unsupported')
  })
  it('파일 한 바이트를 바꾸면 hash_mismatch', () => {
    const f = sampleBundle()
    f.set('chunks.jsonl', Buffer.from('{"id":"b"}\n'))
    expect(verifyBundle(f).issues.map((i) => i.code)).toEqual(['hash_mismatch'])
  })
  it('목록에 없는 파일 · 없는 파일 · 이름 · 버전 규칙', () => {
    const f = sampleBundle({ name: 'Bad Name', version: '1.0' })
    f.set('extra.txt', Buffer.from('x'))
    f.delete('chunks.jsonl')
    expect(verifyBundle(f).issues.map((i) => i.code).sort()).toEqual(['file_missing', 'file_unlisted', 'name_invalid', 'version_invalid'])
  })
  it('SIGNATURE 는 해시 목록 밖이라도 허용한다', () => {
    const f = sampleBundle()
    f.set('SIGNATURE', Buffer.from('sig'))
    expect(verifyBundle(f).ok).toBe(true)
  })
})
