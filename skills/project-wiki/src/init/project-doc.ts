// init 이 만드는 프로젝트 설정 문서(.claude/skills-config/project-wiki.md)의 본문. 스킬이 맨 먼저 이 문서를 읽는다.
// 부르는 곳: init/write.ts. 먼저 읽을 파일: init/plan.ts(원천 목록).
import type { InitPlan } from './plan.ts'

function sourceRows(plan: InitPlan): string {
  return plan.sources
    .map((s) => `| \`${s.name}\` | ${s.include.map((g) => `\`${g}\``).join(' ')} | ${s.area ? `\`${s.area}\`` : '—'} | ${s.files} |`)
    .join('\n')
}

export function projectDoc(plan: InitPlan, relWiki: string): string {
  return `# project-wiki 설정

이 저장소의 문서 위키 설정이다. \`wook-skills:project-wiki\` 스킬이 맨 먼저 이 문서를 읽는다.

## 위치

- 설정: \`${relWiki}/config.json\` (커밋한다)
- 색인: \`${relWiki}/index/\` (생성물이라 \`.gitignore\` 에 넣었다. 커밋하지 않는다)

## 명령

\`<wiki-index>\` 는 스킬 폴더의 \`bin/wiki-index.mjs\` 다(\`node <스킬 폴더>/bin/wiki-index.mjs\`). 저장소 안 어디서 불러도 \`${relWiki}/config.json\` 을 찾아 쓴다.

| 할 일 | 명령 |
|---|---|
| 색인 만들기 | \`node <wiki-index> build\` |
| 찾기 | \`node <wiki-index> search "질의"\` |
| 읽기 | \`node <wiki-index> read <조각 ID>\` |
| 가리키는 곳 | \`node <wiki-index> backlinks <ID>\` |
| 낡음 판정 | \`node <wiki-index> stale\` |

찾기 · 읽기 · 가리키는 곳은 문서가 바뀌었으면 바뀐 문서만 다시 나눠 색인을 새로 만든 뒤 답한다.

## 원천

| 이름공간 | 포함 | 영역 | 문서 수(init 때) |
|---|---|---|---|
${sourceRows(plan)}

원천 · 제외 · 영역 · 등급은 \`${relWiki}/config.json\` 에서 고친다. 기본 등급은 \`internal\`, 묶음 상한은 \`confidential\` 이다.
비밀값이 든 문서는 색인에서 빼고(\`security.onSecret: "quarantine"\`), 경로만 \`${relWiki}/index/quarantine.txt\` 에 남긴다.

## 낡음 표시

결과에 \`[stale]\` · \`[stale-candidate]\` 가 붙으면 문서가 가리키는 근거 파일이 문서보다 나중에 바뀌었다는 뜻이다. 코드와 \`git log\` 로 다시 확인한다.
`
}
