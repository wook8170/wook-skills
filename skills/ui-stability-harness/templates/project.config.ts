// 프로젝트 어댑터 설정 로더 — 값은 project.config.json. 범용 판정 코드는 프로젝트 고유 값을 이 객체로만 받는다.
import fs from 'node:fs'
import path from 'node:path'

export type ProjectConfig = {
  termsFile: string
  errorBoundarySelectors: string[]
  idPrefixes: string[]
  popoverSelectors: string[]
  modalOverlaySelectors: string[]
  tooltipSelectors: string[]
  choiceGroupSelectors: string[]
  textSkipSelectors: string[]
}
export const PROJECT_CONFIG: ProjectConfig = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'project.config.json'), 'utf8'))
