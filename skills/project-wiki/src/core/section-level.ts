// 절 단위 등급 표시. 원고의 절 제목 바로 아래 줄에 `<!-- level: confidential -->` 를 두면 그 절과 하위 절이 그 등급이 된다.
// 부르는 곳: core/build.ts · core/chunk.ts · index.ts. 먼저 읽을 파일: core/chunk.ts.
// HTML 주석이라 조판 · 화면에 보이지 않고, 조각 본문에서도 빠진다(stripComments). 등급은 조각의 `level` 칸에 실려
// 묶음 형식(formatVersion)은 그대로다. 절 등급은 원천 등급보다 올릴 수만 있다(내리면 거부).
import { levelRank, parseLevel, type Level } from './model.ts'

/** 등급 표시 줄. 키는 `level` 또는 `등급`, 값은 `parseLevel` 이 아는 표기(영문 · 한글). */
const MARK = /^\s*<!--\s*(?:level|등급)\s*:\s*([^\s>]+)\s*-->\s*$/
/** 등급 표시처럼 보이는 주석. MARK 에 맞지 않으면 잘못 쓴 것으로 보고 거부한다. */
const LOOKS_LIKE = /<!--\s*(?:level|등급)(?![\w가-힣])/
const FENCE = /^\s*(```|~~~)/

export class SectionLevelError extends Error {}

/** 원문에서 등급 표시 줄을 찾는다. 줄 번호(1부터) → 등급. 코드 울타리 안 줄은 보지 않는다. */
export function levelMarks(markdown: string, path: string): Map<number, Level> {
  const out = new Map<number, Level>()
  let fence = false
  markdown.split('\n').forEach((text, i) => {
    if (FENCE.test(text)) {
      fence = !fence
      return
    }
    // 백틱 안에 적은 표시(규칙 설명 글)는 등급 표시가 아니다.
    if (fence || !LOOKS_LIKE.test(text.replace(/`[^`]*`/g, ''))) return
    const m = MARK.exec(text)
    if (!m) throw new SectionLevelError(`${path}:${i + 1} 등급 표시 형식이 틀렸다. 한 줄에 \`<!-- level: confidential -->\` 꼴로만 쓴다`)
    try {
      out.set(i + 1, parseLevel(m[1]))
    } catch {
      throw new SectionLevelError(`${path}:${i + 1} 알 수 없는 등급: ${m[1]}`)
    }
  })
  return out
}

interface MarkedSection {
  depth: number
  headingLine: number
  lines: { no: number; text: string }[]
}

/**
 * 절마다 등급을 정한다. 표시가 없으면 바깥 절의 등급을 물려받고, 바깥 절도 없으면 원천(페이지) 등급이다.
 * 거부하는 경우: 제목 앞(머리 문단)의 표시 · 한 절에 표시 둘 · 절 본문이 시작된 뒤의 표시 · 물려받은 등급보다 낮은 표시.
 */
export function sectionLevels(sections: readonly MarkedSection[], marks: Map<number, Level>, base: Level, path: string): Level[] {
  const byDepth: (Level | undefined)[] = []
  return sections.map((sec) => {
    const own = sec.lines.filter((l) => marks.has(l.no))
    if (own.length && sec.depth === 0) throw new SectionLevelError(`${path}:${own[0].no} 등급 표시는 절 제목 아래에 둔다. 페이지 전체 등급은 원천 설정이나 머리말 level 로 정한다`)
    if (own.length > 1) throw new SectionLevelError(`${path}:${own[1].no} 한 절에 등급 표시가 둘이다`)
    let inherited = base
    for (let d = 1; d < sec.depth; d++) {
      const l = byDepth[d]
      if (l && levelRank(l) > levelRank(inherited)) inherited = l
    }
    let level = inherited
    if (own.length) {
      const at = own[0].no
      const before = sec.lines.filter((l) => l.no < at)
      if (before.some((l) => l.text.trim())) throw new SectionLevelError(`${path}:${at} 등급 표시는 절 제목 바로 아래(본문 앞)에 둔다`)
      const mark = marks.get(at)!
      if (levelRank(mark) < levelRank(inherited)) throw new SectionLevelError(`${path}:${at} 절 등급(${mark})을 물려받은 등급(${inherited})보다 낮출 수 없다`)
      level = mark
    }
    if (sec.depth > 0) {
      byDepth[sec.depth] = own.length ? level : undefined
      byDepth.length = sec.depth + 1
    }
    return level
  })
}
