// node:test 위에 얹은 작은 expect · describe 호환 층. 색인기를 옮겨 올 때 함께 온 시험이 같은 문법으로 돌게 한다.
// 부르는 곳: test/*.test.ts. 쓰는 기능만 둔다(toBe · toEqual · toMatchObject · toContain · toThrow 등).
// 먼저 읽을 파일: test/helpers.ts.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe as nodeDescribe, it as nodeIt } from 'node:test'

type Fn = () => unknown | Promise<unknown>

function formatName(name: string, row: unknown): string {
  const values = Array.isArray(row) ? row : [row]
  let i = 0
  return name.replace(/%[sdj]/g, () => String(values[i++]))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RowFn = (...args: any[]) => unknown

function withEach(base: (name: string, fn: Fn) => void) {
  return (rows: readonly unknown[]) => (name: string, fn: RowFn) => {
    for (const row of rows) base(formatName(name, row), () => fn(...(Array.isArray(row) ? row : [row])))
  }
}

/** 시험 대상이 unref 한 타이머만 남겨도 node:test 가 기다리도록, 시험이 끝날 때까지 빈 타이머 하나를 잡아 둔다. */
async function keepAlive(fn: Fn): Promise<void> {
  const timer = setInterval(() => {}, 1_000)
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
}

const itBase = (name: string, fn: Fn, timeout?: number | { timeout?: number }) => {
  nodeIt(name, { timeout: typeof timeout === 'number' ? timeout : timeout?.timeout }, () => keepAlive(fn))
}
const itSkip = (name: string, _fn?: Fn) => {
  nodeIt(name, { skip: true }, () => {})
}

export const it = Object.assign(itBase, {
  skip: itSkip,
  skipIf: (cond: boolean) => (cond ? itSkip : itBase),
  each: withEach(itBase),
})
export const test = it

const describeBase = (name: string, fn: () => void) => {
  nodeDescribe(name, fn)
}
const describeSkip = (name: string, _fn?: () => void) => {
  nodeDescribe(name, { skip: true }, () => {})
}
export const describe = Object.assign(describeBase, {
  skip: describeSkip,
  skipIf: (cond: boolean) => (cond ? describeSkip : describeBase),
})
export { afterEach, beforeEach }

/** expect.objectContaining 같은 느슨한 기대값. */
class Loose {
  readonly test: (actual: unknown) => boolean
  constructor(test: (actual: unknown) => boolean) {
    this.test = test
  }
}

const isPlainish = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !(v instanceof Loose) && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date) && !(v instanceof RegExp) && !Buffer.isBuffer(v)

/** toEqual 비교용: undefined 칸을 지우고 클래스 객체를 일반 객체로 바꾼다. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (!isPlainish(v)) return v
  const outObj: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (x !== undefined) outObj[k] = normalize(x)
  return outObj
}

/** toMatchObject: expected 의 칸만 견준다(배열은 길이가 같고 칸마다 부분 일치). */
function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Loose) return expected.test(actual)
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesSubset(actual[i], e))
  if (isPlainish(expected)) {
    if (typeof actual !== 'object' || actual === null) return false
    return Object.entries(expected).every(([k, e]) => matchesSubset((actual as Record<string, unknown>)[k], e))
  }
  try {
    assert.deepStrictEqual(normalize(actual), normalize(expected))
    return true
  } catch {
    return false
  }
}

/** toEqual: undefined 칸을 무시한 깊은 같음. 기대값 쪽의 느슨한 값(Loose)은 그 판정을 쓴다. */
function deepEquals(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Loose) return expected.test(actual)
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => deepEquals(actual[i], e))
  if (isPlainish(expected)) {
    if (!isPlainish(actual)) return false
    const keysA = Object.keys(actual).filter((k) => actual[k] !== undefined).sort()
    const keysE = Object.keys(expected).filter((k) => expected[k] !== undefined).sort()
    return keysA.length === keysE.length && keysE.every((k, i) => keysA[i] === k && deepEquals(actual[k], expected[k]))
  }
  try {
    assert.deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function throwsLike(fn: () => unknown, want?: unknown): boolean {
  try {
    fn()
  } catch (e) {
    if (want === undefined) return true
    if (want instanceof Loose) return want.test(e)
    if (typeof want === 'function') return e instanceof (want as new (...a: unknown[]) => unknown)
    const message = (e as Error)?.message ?? String(e)
    return want instanceof RegExp ? want.test(message) : message.includes(String(want))
  }
  return false
}

function hasPath(obj: unknown, key: string): boolean {
  let cur: unknown = obj
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || !Object.prototype.hasOwnProperty.call(Object(cur), part)) return false
    cur = (cur as Record<string, unknown>)[part]
  }
  return true
}

type Check = (actual: unknown, ...args: unknown[]) => [ok: boolean, message: string]

const CHECKS: Record<string, Check> = {
  toBe: (a, e) => [Object.is(a, e), `${String(a)} 는 ${String(e)} 여야 한다`],
  toEqual: (a, e) => [deepEquals(a, e), `같지 않다:\n${JSON.stringify(a)}\n${JSON.stringify(e)}`],
  toMatchObject: (a, e) => [matchesSubset(a, e), `부분 일치하지 않는다:\n${JSON.stringify(a)}\n${JSON.stringify(e)}`],
  toContain: (a, e) => [typeof a === 'string' ? a.includes(String(e)) : (Array.isArray(a) || a instanceof Set) && [...a].some((x) => (e instanceof Loose ? e.test(x) : Object.is(x, e))), `${JSON.stringify(a)} 에 ${JSON.stringify(e)} 가 없다`],
  toContainEqual: (a, e) => [Array.isArray(a) && a.some((x) => deepEquals(x, e)), `${JSON.stringify(a)} 에 ${JSON.stringify(e)} 와 같은 항목이 없다`],
  toMatch: (a, e) => [e instanceof RegExp ? e.test(String(a)) : String(a).includes(String(e)), `${String(a)} 가 ${String(e)} 와 맞지 않는다`],
  toHaveLength: (a, n) => [(a as { length?: number })?.length === n, `길이 ${(a as { length?: number })?.length} 는 ${String(n)} 여야 한다`],
  toHaveProperty: (a, k, v) => [hasPath(a, String(k)) && (v === undefined || matchesSubset(String(k).split('.').reduce((o: unknown, p) => (o as Record<string, unknown>)[p], a), v)), `칸 ${String(k)} 가 없다`],
  toBeUndefined: (a) => [a === undefined, `${String(a)} 는 undefined 여야 한다`],
  toBeDefined: (a) => [a !== undefined, '값이 없다'],
  toBeNull: (a) => [a === null, `${String(a)} 는 null 이어야 한다`],
  toBeTruthy: (a) => [!!a, `${String(a)} 는 참이어야 한다`],
  toBeFalsy: (a) => [!a, `${String(a)} 는 거짓이어야 한다`],
  toBeGreaterThan: (a, n) => [(a as number) > (n as number), `${String(a)} > ${String(n)}`],
  toBeGreaterThanOrEqual: (a, n) => [(a as number) >= (n as number), `${String(a)} >= ${String(n)}`],
  toBeLessThan: (a, n) => [(a as number) < (n as number), `${String(a)} < ${String(n)}`],
  toBeLessThanOrEqual: (a, n) => [(a as number) <= (n as number), `${String(a)} <= ${String(n)}`],
  toBeInstanceOf: (a, c) => [a instanceof (c as new (...x: unknown[]) => unknown), '종류가 다르다'],
  toThrow: (a, want) => [throwsLike(a as () => unknown, want), '오류가 나야 한다'],
}

type Matchers = { [K in keyof typeof CHECKS]: (...args: unknown[]) => void }

function matchers(actual: unknown, negate: boolean): Matchers {
  const m = {} as Matchers
  for (const [name, check] of Object.entries(CHECKS)) {
    m[name] = (...args: unknown[]) => {
      const [ok, message] = check(actual, ...args)
      if (ok === negate) assert.fail(negate ? `뒤집은 ${name} 가 맞았다: ${message}` : message)
    }
  }
  return m
}

function expectBase(actual: unknown): Matchers & { not: Matchers } {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) })
}

export const expect = Object.assign(expectBase, {
  objectContaining: (e: Record<string, unknown>): unknown => new Loose((a) => matchesSubset(a, e)),
  arrayContaining: (e: unknown[]): unknown => new Loose((a) => Array.isArray(a) && e.every((x) => a.some((y) => matchesSubset(y, x)))),
  stringContaining: (e: string): unknown => new Loose((a) => typeof a === 'string' && a.includes(e)),
})
