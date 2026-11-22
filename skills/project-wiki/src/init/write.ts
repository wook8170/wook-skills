// init 실행: 정한 설정을 파일로 쓴다. 이미 있는 파일은 덮어쓰지 않는다.
// 쓰는 것: <위키 폴더>/config.json, (위키 폴더가 저장소 안이면) .gitignore 의 색인 폴더 줄과 .claude/skills-config/project-wiki.md.
// 부르는 곳: cli/init.ts. 먼저 읽을 파일: init/plan.ts · init/project-doc.ts.
import fs from 'node:fs'
import path from 'node:path'
import { stableJson } from '../core/bundle.ts'
import type { InitPlan } from './plan.ts'
import { projectDoc } from './project-doc.ts'

export const PROJECT_DOC = '.claude/skills-config/project-wiki.md'

export interface WriteAction {
  path: string
  action: 'created' | 'kept' | 'appended'
}

/** 없을 때만 쓴다. */
function writeIfMissing(file: string, body: string): WriteAction['action'] {
  if (fs.existsSync(file)) return 'kept'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return 'created'
}

/** .gitignore 에 줄이 없으면 끝에 더한다. 파일이 없으면 만든다. */
function ensureIgnoreLine(file: string, line: string): WriteAction['action'] {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return 'kept'
  const sep = text && !text.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${text}${sep}# project-wiki 색인(다시 만들 수 있는 생성물)\n${line}\n`)
  return text ? 'appended' : 'created'
}

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 위키 폴더가 저장소 밖(예: 스크래치)이면 저장소 파일은 건드리지 않고 설정만 쓴다. */
export function writeInitFiles(root: string, wikiDir: string, plan: InitPlan): WriteAction[] {
  const configPath = path.join(wikiDir, 'config.json')
  const actions: WriteAction[] = [{ path: configPath, action: writeIfMissing(configPath, stableJson(plan.config, 2) + '\n') }]
  if (!isInside(root, wikiDir)) return actions
  const relWiki = path.relative(root, wikiDir).split(path.sep).join('/')
  const gitignore = path.join(root, '.gitignore')
  actions.push({ path: gitignore, action: ensureIgnoreLine(gitignore, `${relWiki}/index/`) })
  const doc = path.join(root, PROJECT_DOC)
  actions.push({ path: doc, action: writeIfMissing(doc, projectDoc(plan, relWiki)) })
  return actions
}
