// 두 묶음의 조각 비교: 더해짐 · 바뀜(ID 같고 내용 해시 다름) · 빠짐 · 옮김(ID 다르고 내용 해시 같음) · 낡음 변화.
// 부르는 곳: cli/eval.ts · core/build.ts · index.ts. 먼저 읽을 파일: core/model.ts(Chunk).
import type { Chunk } from './model.ts'
import { cmp } from './util.ts'

export interface BundleDiff {
  added: string[]
  changed: string[]
  removed: string[]
  moved: Array<[from: string, to: string]>
  staleChanged: Array<{ id: string; from: string | null; to: string | null }>
}

type Lite = Pick<Chunk, 'id' | 'contentHash' | 'stale'>

export function diffChunks(oldChunks: Lite[], newChunks: Lite[]): BundleDiff {
  const oldById = new Map(oldChunks.map((c) => [c.id, c]))
  const newById = new Map(newChunks.map((c) => [c.id, c]))
  const added: string[] = []
  const changed: string[] = []
  const staleChanged: BundleDiff['staleChanged'] = []
  for (const c of newChunks) {
    const o = oldById.get(c.id)
    if (!o) added.push(c.id)
    else {
      if (o.contentHash !== c.contentHash) changed.push(c.id)
      const a = o.stale?.state ?? null
      const b = c.stale?.state ?? null
      if (a !== b) staleChanged.push({ id: c.id, from: a, to: b })
    }
  }
  const removedAll = oldChunks.filter((c) => !newById.has(c.id))
  // 빠진 조각과 같은 내용 해시를 가진 새 조각은 옮김으로 본다(내용 해시가 유일할 때만).
  const addedByHash = new Map<string, string[]>()
  for (const id of added) {
    const h = newById.get(id)!.contentHash
    addedByHash.set(h, [...(addedByHash.get(h) ?? []), id])
  }
  const moved: BundleDiff['moved'] = []
  const removed: string[] = []
  const movedTo = new Set<string>()
  for (const r of removedAll) {
    const cands = addedByHash.get(r.contentHash) ?? []
    if (cands.length === 1 && !movedTo.has(cands[0])) {
      moved.push([r.id, cands[0]])
      movedTo.add(cands[0])
    } else removed.push(r.id)
  }
  return {
    added: added.filter((id) => !movedTo.has(id)).sort(cmp),
    changed: changed.sort(cmp),
    removed: removed.sort(cmp),
    moved: moved.sort((a, b) => cmp(a[0], b[0])),
    staleChanged,
  }
}
