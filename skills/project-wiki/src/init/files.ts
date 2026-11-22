// init 이 훑을 저장소 파일 목록. git 저장소면 추적 파일과 무시하지 않은 새 파일, 아니면 폴더를 직접 훑는다.
// 부르는 곳: cli/init.ts. 먼저 읽을 파일: init/plan.ts.
import { execFileSync } from 'node:child_process'
import { walkFiles } from '../core/util.ts'

/** git ls-files 결과(NUL 구분). git 이 없거나 저장소가 아니면 null. */
function gitFiles(root: string): string[] | null {
  try {
    const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
    return raw.split('\0').filter(Boolean)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as { status?: number }).status !== undefined) return null
    throw e
  }
}

export function listRepoFiles(root: string): string[] {
  return gitFiles(root) ?? walkFiles(root, '')
}
