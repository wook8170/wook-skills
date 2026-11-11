#!/bin/bash
# 읽기 전용 현황 수집. 인자: 저장소 경로(기본 현재 디렉터리)
R=${1:-$PWD}
cd "$R" 2>/dev/null || { echo "저장소 없음: $R"; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "git 저장소 아님: $R"; exit 0; }
# 프로젝트 설정(.claude/skills-config/work-status.md)의 `키: 값` 줄을 읽는다. 없으면 기본값을 쓴다.
CFG="$R/.claude/skills-config/work-status.md"
cfg() { [ -f "$CFG" ] && sed -n "s/^[-* ]*\`*$1\`*: *//p" "$CFG" | head -1 | tr -d '`'; }
STAMP_NAME=$(cfg gate-stamp); STAMP_NAME=${STAMP_NAME:-gate-pass}
PORTS=$(cfg ports); PORTS=${PORTS:-3000 4173 5173 5174 8000 8080}
echo "## 머신"; uptime | sed 's/.*load averages*: /부하(1·5·15분): /'
echo; echo "## main"
git fetch -q origin 2>/dev/null
echo "origin/main: $(git log -1 --format='%h %s (%cr)' origin/main 2>/dev/null)"
for t in $(git tag --sort=-creatordate | head -2); do echo "태그 $t → $(git rev-list -n1 --abbrev-commit $t)"; done
stamp="$(git rev-parse --git-common-dir)/$STAMP_NAME"
[ -f "$stamp" ] && echo "게이트 표식: $(head -1 "$stamp" | cut -c1-9)" || echo "게이트 표식: 없음"
echo; echo "## 워크트리 (브랜치 · main 대비 앞/뒤 · 미커밋 · 최근 커밋)"
git worktree list --porcelain | awk '/^worktree /{p=$2}/^branch /{b=$2; sub("refs/heads/","",b); print p"\t"b}/^detached/{print p"\t(detached)"}' | while IFS=$'\t' read -r p b; do
  ab=$(git rev-list --left-right --count origin/main...$b 2>/dev/null | awk '{print "+"$2"/-"$1}')
  d=$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  l=$(git -C "$p" log -1 --format='%h %cr' 2>/dev/null)
  echo "- ${p/#$HOME/~} [$b] ${ab:-?} 미커밋 ${d} · $l"
done
echo; echo "## main 에 안 들어간 로컬 브랜치"
git branch --no-merged origin/main --format='%(refname:short) %(committerdate:relative)' | sed 's/^/- /'
echo; echo "## 열린 PR"; (gh pr list --state open --limit 20 2>/dev/null || echo "(gh 사용 불가)") | sed 's/^/- /'
echo; echo "## 서버 (포트 · PID · 실행 위치)"
for port in $PORTS; do
  pid=$(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)
  [ -z "$pid" ] && continue
  cwd=$(lsof -a -p $pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/ 2>/dev/null)
  echo "- :$port pid $pid HTTP $code · ${cwd/#$HOME/~}"
done
echo; echo "## 무거운 백그라운드 프로세스 (vitest·tsc·vite build·docker build·node --test·pnpm deploy)"
ps -eo pid,etime,pcpu,command | grep -E 'vitest|tsc( |$)|vite build|docker build|buildx|node --test|pnpm deploy|rehearsal|pack-offline' | grep -v grep | awk '{c=$0; sub(/^ *[0-9]+ +[^ ]+ +[^ ]+ +/,"",c); printf "- pid %s · %s · cpu %s%% · %s\n",$1,$2,$3,substr(c,1,110)}' | head -15
echo; echo "## 게이트·웨이브 기록"
for f in $(ls -t /private/tmp/claude-*/*/*/scratchpad/gate*/summary.txt 2>/dev/null | head -2); do echo "- $f"; tail -4 "$f" | sed 's/^/    /'; done
if [ -d .harness/waves ]; then for j in .harness/waves/*/*.json; do [ -f "$j" ] && echo "- $j: $(jq -r '.status+" · "+(.branch//"")' "$j" 2>/dev/null)"; done; fi
echo; echo "## progress.md 최근 절"
[ -f progress.md ] && awk '/^## /{n++} n==1' progress.md | head -25
