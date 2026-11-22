#!/usr/bin/env node
// project-wiki 색인기(wiki-index). src/ 원본을 scripts/build-wiki-index.mjs 로 묶은 파일이다. 직접 고치지 않는다.
// 묶은 도구: esbuild 0.28.1. 실행: Node 22 이상, 런타임 의존성 없음. 사용권: MIT.

// src/core/stale-baseline.ts
import fs2 from "node:fs";
import path3 from "node:path";

// src/core/stale.ts
import { spawnSync } from "node:child_process";
import path2 from "node:path";

// src/core/git-out.ts
var LOG_FORMAT = "--format=%x00%x01C %H %P";
var HEADER = /^\n?\x01C ([0-9a-f]+)((?: [0-9a-f]+)*) ?$/;
function splitZ(out2) {
  return out2.split("\0").filter(Boolean);
}
function parseLogZ(out2) {
  const commits = [];
  let fresh = false;
  for (const tok of out2.split("\0")) {
    const h = HEADER.exec(tok);
    if (h) {
      commits.push({ hash: h[1], files: /* @__PURE__ */ new Set(), merge: h[2].trim().split(" ").filter(Boolean).length > 1 });
      fresh = true;
    } else if (tok && commits.length) {
      commits[commits.length - 1].files.add(fresh && tok.startsWith("\n") ? tok.slice(1) : tok);
      fresh = false;
    }
  }
  return commits;
}

// src/core/git-spelling.ts
var nfc = (p) => p.normalize("NFC");
var folded = (p) => nfc(p).toLowerCase();
function index(paths, key) {
  const m = /* @__PURE__ */ new Map();
  for (const p of paths) m.set(key(p), [...m.get(key(p)) ?? [], p]);
  return m;
}
function spellingOf(tracked) {
  const exact = new Set(tracked);
  const byNfc = index(tracked, nfc);
  const byFold = index(tracked, folded);
  const only = (list2) => list2?.length === 1 ? list2[0] : null;
  return {
    resolve(p) {
      if (exact.has(p)) return p;
      return only(byNfc.get(nfc(p))) ?? only(byFold.get(folded(p)));
    }
  };
}

// src/core/util.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function shortHash(text) {
  return sha256Hex(text.replace(/\s+/g, " ").trim()).slice(0, 16);
}
function slugify(heading) {
  const s = heading.normalize("NFC").replace(/`/g, "").replace(/[#/~@]/g, " ").replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return ([...s].length > 80 ? [...s].slice(0, 80).join("").replace(/-$/, "") : s) || "절";
}
var FENCE = /^(```|~~~)/;
var CLOSE = /^---[ \t]*\r?$/;
function frontmatterClose(lines) {
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  let fence = false;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fence = !fence;
    else if (!fence && CLOSE.test(lines[i])) return i;
  }
  return -1;
}
function parseFrontmatter(src) {
  const md = src.replace(/^\ufeff/, "");
  const lines = md.split("\n");
  const end = frontmatterClose(lines);
  if (end === null) return { data: {}, body: md, bodyStartLine: 1 };
  if (end < 0) return { data: {}, body: md, bodyStartLine: 1, unclosed: true };
  const data = frontmatterData(lines.slice(1, end));
  return { data, body: lines.slice(end + 1).join("\n"), bodyStartLine: end + 2 };
}
function frontmatterData(lines) {
  const data = {};
  let listKey = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      ;
      data[listKey].push(scalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rest === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    const arr = /^\[(.*)\]$/.exec(rest.trim());
    data[key] = arr ? arr[1].trim() ? splitInline(arr[1]).map(scalar) : [] : scalar(rest);
  }
  return data;
}
function splitInline(s) {
  const out2 = [];
  let cur = "";
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out2.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out2.push(cur);
  return out2;
}
function scalar(v) {
  const t = v.trim().replace(/\s+#.*$/, "");
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function matchesAny(rel, globs) {
  return !!globs?.some((g) => globToRegExp(g).test(rel));
}
function walkFiles(repoRoot, rel, links) {
  const out2 = [];
  const abs = path.join(repoRoot, rel);
  const self = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!self) return out2;
  const rec = (dirRel) => {
    const entries = fs.readdirSync(path.join(repoRoot, dirRel), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(r);
      else if (e.isFile()) out2.push(r);
      else if (e.isSymbolicLink()) links?.push(r);
    }
  };
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) rec(rel.replace(/\/$/, ""));
  else if (self.isSymbolicLink()) links?.push(rel);
  else out2.push(rel);
  return out2;
}
var FILLERS = ["x", "q"];
function fillSegs(segs, f) {
  let outs = [""];
  for (const s of segs) {
    const opts = s === "**" ? ["", f, `${f}/${f}`] : (s.includes("**") ? [f, `${f}/${f}`] : [f]).map((r) => s.replace(/\*\*/g, r).replace(/[*?]/g, f));
    outs = outs.flatMap((o) => opts.map((p) => !p ? o : o ? `${o}/${p}` : p));
  }
  return outs;
}
function samplesUnder(link, glob) {
  const gs = glob.split("/");
  const out2 = /* @__PURE__ */ new Set();
  for (let gi = 0; gi <= gs.length; gi++) {
    for (const f of FILLERS) for (const rest of fillSegs(gs.slice(gi), f)) out2.add(`${link}/${rest || f}`);
  }
  return [...out2];
}
function globFiles(repoRoot, include, exclude = [], links) {
  const set = /* @__PURE__ */ new Set();
  const linkSet = /* @__PURE__ */ new Set();
  const hit = (re, f) => re.test(f) && !matchesAny(f, exclude);
  const dirLink = (f) => fs.statSync(path.join(repoRoot, f), { throwIfNoEntry: false })?.isDirectory() === true;
  for (const g of include) {
    const fixed = g.split("/").filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?]/.test(s)));
    const base = fixed.join("/");
    const re = globToRegExp(g);
    const found = [];
    for (const f of walkFiles(repoRoot, base, found)) if (hit(re, f)) set.add(f);
    for (const f of found) if (hit(re, f) || dirLink(f) && samplesUnder(f, g).some((s) => hit(re, s))) linkSet.add(f);
  }
  links?.push(...[...linkSet].sort(cmp));
  return [...set].sort(cmp);
}
function editKeepingEol(src, edit) {
  const bom = src.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = src.slice(bom.length);
  if (!text.includes("\r\n")) return bom + edit(text);
  return bom + edit(text.replace(/\r\n/g, "\n")).replace(/\n/g, "\r\n");
}
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/core/stale-pending.ts
function isJudgeable(a) {
  return a.kind === "file" && a.hash !== null && !a.link;
}
function groupByCommit(items, commitOf, pathsOf) {
  const out2 = /* @__PURE__ */ new Map();
  for (const it of items) {
    const g = out2.get(commitOf(it)) ?? { items: [], paths: [] };
    g.items.push(it);
    for (const p of pathsOf(it)) if (!g.paths.includes(p)) g.paths.push(p);
    out2.set(commitOf(it), g);
  }
  for (const g of out2.values()) g.paths.sort(cmp);
  return out2;
}
var folded2 = (p) => p.normalize("NFC").toLowerCase();
function caseOnlyOf(w, s) {
  return !!s && s.normalize("NFC") !== w.normalize("NFC") && folded2(s) === folded2(w);
}
function toPending(u, sp) {
  const written = /* @__PURE__ */ new Map();
  const missing = [];
  const caseOnly = [];
  for (const a of u.anchors) {
    if (a.kind !== "file" || a.link) continue;
    const s = isJudgeable(a) ? sp?.resolve(a.path) : null;
    if (s) {
      if (!written.has(s)) written.set(s, a.path);
      continue;
    }
    if (!missing.includes(a.path)) missing.push(a.path);
    const c = sp?.resolve(a.path);
    if (caseOnlyOf(a.path, c) && !caseOnly.includes(c)) caseOnly.push(c);
  }
  return { u, anchors: [...written.keys()], written, missing, caseOnly, ...sp ? {} : { failed: true } };
}
function resolveMissing(pending, treeAt, addedSince) {
  for (const p of pending) {
    if (!p.missing.length) continue;
    const commit = p.u.baseCommit;
    const tree = treeAt(commit);
    const rest = tree ? p.missing.filter((m) => !take(p, m, tree.resolve(m))) : [];
    const added = rest.length ? addedSince(commit) : null;
    if (!tree || rest.length && !added) {
      p.failed = true;
      continue;
    }
    for (const m of rest) take(p, m, added.resolve(m));
    p.missing = p.anchors.filter((a) => p.missing.some((m) => p.written.get(a) === m));
  }
}
function take(p, m, s) {
  if (!s) return false;
  if (!p.anchors.includes(s)) {
    p.anchors.push(s);
    p.written.set(s, m);
  }
  return true;
}
function unjudged(u, judged) {
  return (u.skippedAnchors ?? 0) + u.anchors.length - judged;
}

// src/core/stale-status.ts
var isDecisionOrPolicy = (area) => area === "decision" || area === "policy";
var noFrontmatter = (u) => frontmatterClose(u.markdown.replace(/^﻿/, "").split("\n")) === null;
function countNoStatus(units, report) {
  for (const u of units) {
    const known = isDecisionOrPolicy(u.area);
    if (u.headMisshapen) addNoStatus(u, report, "misshapen", "머리말 모양이 어긋나 영역 · status 를 읽지 못함(결정 · 정책 문서라면 출하 차단 대상에서 빠짐)");
    else if (u.headMisspelled) addNoStatus(u, report, "misshapen", "머리말의 area · category · status 표기가 어긋나 차단 대상으로 읽지 못함(대소문자 · 공백 · area 와 category · 값이 정한 낱말인지 확인)");
    else if (known && u.status === void 0) addNoStatus(u, report, noFrontmatter(u) ? "no-frontmatter" : "no-status", "결정 · 정책 문서인데 status 를 읽지 못함(출하 차단 대상에서 빠짐)");
    else if (known) noteStatusSpelling(u, report);
  }
}
function countLinks(paths, report) {
  for (const p of paths) {
    report.noStatusDocs++;
    report.noStatusList.push({ path: p, id: p, title: p, kind: "link" });
    report.warnings.push(`${p}: 문서가 심볼릭 링크라 영역 · status 를 읽지 못함(링크를 실제 파일로 바꾸세요)`);
  }
}
function addNoStatus(u, report, kind, why) {
  report.noStatusDocs++;
  report.noStatusList.push({ path: u.path, id: u.page, title: u.title, kind });
  report.warnings.push(`${u.path}: ${why}`);
}
function noteStatusSpelling(u, report) {
  const s = u.status;
  if (s !== s.toLowerCase()) report.warnings.push(`${u.path}: status 값 「${s}」에 대문자가 있음(대소문자를 가려 판정하므로 차단 대상은 소문자 「current」만이다)`);
}

// src/core/stale.ts
var SAME_COMMIT_FOR_BLOCKING = false;
var BLOCK_REASON = {
  noCommit: "출하 차단 — 기준 커밋 없음",
  badCommit: "출하 차단 — 기준 커밋을 찾을 수 없음",
  shallow: "출하 차단 — 얕은 복제라 기준 커밋을 찾지 못함, 전체 이력으로 받으세요",
  noAnchor: "출하 차단 — 확인할 근거 없음",
  headUnclosed: "출하 차단 — 머리말이 닫히지 않음",
  gitFailed: "출하 차단 — 근거 변경을 확인하지 못함",
  changed: (n) => `출하 차단 — 근거 파일 ${n}개 바뀜`,
  caseMismatch: (n) => `출하 차단 — 근거 경로 ${n}개의 대소문자가 추적 파일과 다름`,
  noStatusNew: "출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록에 없음)",
  noStatusChanged: (was, now) => `출하 차단 — 상태를 읽지 못한 결정 · 정책 문서(기준 목록의 사유 「${was}」과 지금 사유 「${now}」이 다름)`,
  headMisshapen: "출하 차단 — 머리말 모양이 어긋나 상태를 읽지 못함, 머리말 모양(첫 줄 `---`)을 확인하세요",
  link: "출하 차단 — 문서가 심볼릭 링크라 상태를 읽지 못함, 링크를 실제 파일로 바꾸세요",
  anchorLink: "출하 차단 — 근거가 심볼릭 링크라 변경을 확인하지 못함, 근거에 실제 경로를 적으세요"
};
function changedReason(changed, caseOnly) {
  if (!caseOnly) return BLOCK_REASON.changed(changed);
  if (!changed) return BLOCK_REASON.caseMismatch(caseOnly);
  return `${BLOCK_REASON.changed(changed)} · ${BLOCK_REASON.caseMismatch(caseOnly).replace("출하 차단 — ", "")}`;
}
function gitRunner(repoRoot) {
  return (args) => {
    const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? -1, out: r.stdout ?? "" };
  };
}
function expandBraces(v) {
  const m = /^([^{}]*)\{([^{}]*)\}(.*)$/.exec(v);
  if (!m) return [v];
  return m[2].split(",").map((alt) => `${m[1]}${alt.trim()}${m[3]}`);
}
function splitAnchorValues(values) {
  const paths = [];
  let skipped = 0;
  for (const raw of values) {
    for (const v of expandBraces(raw.trim())) {
      const p = v.replace(/\/+$/, "");
      const outside = path2.posix.isAbsolute(p) || path2.posix.normalize(p).startsWith("..");
      if (!p || /[*?[\]{}]/.test(p) || !/[/.]/.test(p) || outside) skipped++;
      else {
        const n = path2.posix.normalize(p).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
        if (!paths.includes(n)) paths.push(n);
      }
    }
  }
  return { paths, skipped };
}
function isStrict(u) {
  return u.reviewInSameCommit === true || u.blockOnStale === true;
}
function appliesSameCommit(u) {
  return u.reviewInSameCommit === true && (u.blockOnStale !== true || SAME_COMMIT_FOR_BLOCKING);
}
function spellingPerCommit(read) {
  const memo = /* @__PURE__ */ new Map();
  return (c) => {
    if (!memo.has(c)) {
      const paths = read(c);
      memo.set(c, paths ? spellingOf(paths) : null);
    }
    return memo.get(c);
  };
}
function gitCache(git2) {
  let headOk;
  let shallow;
  const states = /* @__PURE__ */ new Map();
  let spelling;
  const state = (c) => {
    headOk ??= git2(["rev-parse", "--verify", "--quiet", "HEAD"]).code === 0;
    if (!headOk) return "git-failed";
    if (!/^[0-9a-f]{7,40}$/i.test(c)) return "bad";
    shallow ??= git2(["rev-parse", "--is-shallow-repository"]).out.trim() === "true";
    if (shallow) return "shallow";
    return git2(["merge-base", "--is-ancestor", c, "HEAD"]).code === 0 ? "ok" : "bad";
  };
  return {
    commitState(c) {
      if (!states.has(c)) states.set(c, state(c));
      return states.get(c);
    },
    log(c, paths) {
      const r = git2(["log", "-z", "--no-renames", "--diff-merges=first-parent", LOG_FORMAT, "--name-only", `${c}..HEAD`, "--", ...paths]);
      return r.code === 0 ? parseLogZ(r.out) : null;
    },
    mergeOwn(c, paths) {
      const r = git2(["log", "-z", "--merges", "--no-renames", "--diff-merges=combined", LOG_FORMAT, "--name-only", `${c}..HEAD`, "--", ...paths]);
      return r.code === 0 ? new Map(parseLogZ(r.out).map((m) => [m.hash, m.files])) : null;
    },
    diff(c, paths) {
      const r = git2(["diff", "-z", "--no-renames", "--name-only", c, "HEAD", "--", ...paths]);
      return r.code === 0 ? new Set(splitZ(r.out)) : null;
    },
    spelling() {
      if (spelling === void 0) {
        const r = git2(["ls-files", "-z"]);
        spelling = r.code === 0 ? spellingOf(splitZ(r.out)) : null;
      }
      return spelling;
    },
    // 경로를 좁히지 않고 전체 목록을 받는다. 경로 인자는 철자가 정확히 같아야 맞아서, NFD 로 적은 근거를 놓친다.
    // -z: 따옴표 · 줄바꿈이 든 경로도 감싸지 않고 그대로 받는다.
    treeAt: spellingPerCommit((c) => {
      const r = git2(["ls-tree", "-r", "-z", "--name-only", c]);
      return r.code === 0 ? splitZ(r.out) : null;
    }),
    // 기준 커밋 뒤에 더해진 파일. 곁가지에서 더한 파일도 그 커밋에서 나오고, 병합 커밋은 첫 부모와 비교한다.
    addedSince: spellingPerCommit((c) => {
      const r = git2(["log", "-z", "--no-renames", "--diff-filter=A", "--diff-merges=first-parent", LOG_FORMAT, "--name-only", `${c}..HEAD`]);
      return r.code === 0 ? parseLogZ(r.out).flatMap((m) => [...m.files]) : null;
    })
  };
}
function emptyReport() {
  return { block: [], warn: 0, unverifiable: 0, noAnchorDocs: 0, unverifiableAnchors: 0, noStatusDocs: 0, noStatusList: [], warnings: [] };
}
function judgeLegacy(units, g, verdicts, report) {
  const own = (u) => u.anchors.filter((a) => !a.link);
  for (const u of units) report.unverifiableAnchors += u.anchors.length - own(u).length;
  const todo = units.filter((u) => u.baseCommit && own(u).length);
  const sp = todo.length ? g.spelling() : null;
  const spell = (a) => isJudgeable(a) && sp?.resolve(a.path) || a.path;
  const groups = groupByCommit(todo, (u) => u.baseCommit, (u) => own(u).map(spell));
  for (const [commit, { items, paths }] of groups) {
    const changed = g.diff(commit, paths);
    if (!changed) {
      report.unverifiable += items.length;
      report.warnings.push(`기준 커밋 ${commit} 과 HEAD 를 비교하지 못함(단위 ${items.length}개)`);
      continue;
    }
    for (const u of items) {
      if (!own(u).some((a) => hitsPath(spell(a), changed, true))) continue;
      const shown = /* @__PURE__ */ new Set([...changed, ...own(u).filter((a) => changed.has(spell(a))).map((a) => a.path)]);
      verdicts.set(u.path, { kind: "candidate", commit, changed: shown, prefix: true });
      report.warn++;
    }
  }
}
function hitsPath(anchor, changed, prefix) {
  return changed.has(anchor) || prefix && [...changed].some((f) => f.startsWith(`${anchor}/`));
}
function precheck(u, g) {
  const block = u.blockOnStale === true;
  if (!u.baseCommit) return block ? { block: BLOCK_REASON.noCommit } : { count: "unverifiable" };
  const st = g.commitState(u.baseCommit);
  if (st === "git-failed") return gitFailed(u, `${u.path}: git 을 실행하지 못해 근거 변경을 확인하지 못함`);
  if (st !== "ok") {
    const reason = st === "shallow" ? BLOCK_REASON.shallow : BLOCK_REASON.badCommit;
    return block ? { block: reason } : { count: "unverifiable", warning: `${u.path}: 기준 커밋 ${u.baseCommit} 을 찾을 수 없음${st === "shallow" ? "(얕은 복제)" : ""}` };
  }
  return null;
}
function linkedAnchor(u) {
  return u.blockOnStale && u.anchors.some((a) => a.link) ? { block: BLOCK_REASON.anchorLink } : null;
}
function gitFailed(u, warning) {
  return u.blockOnStale ? { block: BLOCK_REASON.gitFailed } : { count: "unverifiable", warning };
}
function settle(u, e, verdicts, report) {
  if ("block" in e) {
    verdicts.set(u.path, { kind: "block", reason: e.block });
    report.block.push({ id: u.page, title: u.title, reason: e.block });
    return;
  }
  report[e.count]++;
  if (e.warning) report.warnings.push(e.warning);
}
function staleAnchors(u, anchors, commits, mergeOwn) {
  const same = appliesSameCommit(u);
  const hit = /* @__PURE__ */ new Set();
  for (const c of commits) {
    for (const a of anchors) if (c.files.has(a) && !(same && reviewedTogether(u.path, a, c, commits, mergeOwn))) hit.add(a);
  }
  return [...hit].sort(cmp);
}
function reviewedTogether(doc, a, c, commits, mergeOwn) {
  if (!c.files.has(doc)) return false;
  if (!c.merge) return true;
  const own = mergeOwn();
  if (!own || own.get(c.hash)?.has(a)) return false;
  return commits.some((o) => !o.merge && o.files.has(a) && o.files.has(doc));
}
function strictPending(units, g, verdicts, report) {
  const pending = [];
  for (const u of units) {
    const anchors = u.anchors.filter(isJudgeable).map((a) => a.path);
    const early = precheck(u, g) ?? linkedAnchor(u);
    if (!early) {
      pending.push(toPending(u, g.spelling()));
      continue;
    }
    report.unverifiableAnchors += unjudged(u, anchors.length);
    settle(u, early, verdicts, report);
  }
  resolveMissing(pending, g.treeAt, g.addedSince);
  return pending.filter((p) => {
    report.unverifiableAnchors += unjudged(p.u, p.anchors.length);
    const early = afterResolve(p);
    if (early) settle(p.u, early, verdicts, report);
    return !early;
  });
}
function afterResolve(p) {
  if (p.failed) return gitFailed(p.u, `${p.u.path}: 추적 파일 목록이나 기준 커밋 ${p.u.baseCommit} 의 파일 목록을 읽지 못함`);
  if (p.anchors.length) return null;
  return p.u.blockOnStale ? { block: BLOCK_REASON.noAnchor } : { count: "noAnchorDocs" };
}
function withNetChanges(u, hit, o) {
  const unseen = o.anchors.filter((a) => o.net.has(a) && !o.commits.some((c) => c.files.has(a)));
  const gone = appliesSameCommit(u) ? [] : o.missing.filter((m) => o.anchors.includes(m));
  return [.../* @__PURE__ */ new Set([...hit, ...unseen, ...gone])].sort(cmp);
}
function judgeOne(p, h, verdicts, report) {
  const { u, anchors, missing, written } = p;
  const real = withNetChanges(u, staleAnchors(u, anchors, h.commits, h.mergeOwn), { anchors, missing: [], commits: h.commits, net: h.net });
  const hit = withNetChanges(u, real, { anchors, missing, commits: h.commits, net: h.net });
  report.unverifiableAnchors += missing.filter((m) => anchors.includes(m) && !hit.includes(m)).length;
  if (!hit.length) return;
  if (u.blockOnStale) {
    const caseOnly = hit.filter((a) => !real.includes(a) && p.caseOnly.includes(a)).length;
    settle(u, { block: changedReason(hit.length - caseOnly, caseOnly) }, verdicts, report);
    return;
  }
  verdicts.set(u.path, { kind: "candidate", commit: h.commit, changed: new Set(hit.map((x) => written.get(x) ?? x)), prefix: false });
  report.warn++;
}
function judgeStrict(units, g, verdicts, report) {
  const pending = strictPending(units, g, verdicts, report);
  const groups = groupByCommit(pending, (p) => p.u.baseCommit, (p) => [...p.anchors, p.u.path]);
  for (const [commit, { items, paths }] of groups) {
    const commits = g.log(commit, paths);
    const net = commits && g.diff(commit, paths);
    let own;
    const mergeOwn = () => own === void 0 ? own = g.mergeOwn(commit, paths) : own;
    for (const p of items) {
      if (commits && net) judgeOne(p, { commit, commits, net, mergeOwn }, verdicts, report);
      else settle(p.u, p.u.blockOnStale ? { block: BLOCK_REASON.gitFailed } : { count: "unverifiable", warning: `${p.u.path}: 기준 커밋 ${commit} 뒤 이력을 읽지 못함` }, verdicts, report);
    }
  }
}
function judgeStale(units, git2) {
  const g = gitCache(git2);
  const verdicts = /* @__PURE__ */ new Map();
  const report = emptyReport();
  for (const u of units.filter((x) => x.headUnclosed)) settle(u, { block: BLOCK_REASON.headUnclosed }, verdicts, report);
  const readable = units.filter((u) => !u.headUnclosed);
  judgeLegacy(readable.filter((u) => !isStrict(u)), g, verdicts, report);
  judgeStrict(readable.filter(isStrict), g, verdicts, report);
  countNoStatus(readable, report);
  report.block.sort((a, b) => cmp(a.id, b.id));
  return { verdicts, report };
}
function applyStale(chunks, verdicts) {
  for (const c of chunks) {
    const v = verdicts.get(c.source.path);
    if (!v) continue;
    if (v.kind === "block") {
      c.stale = { state: "stale", reason: v.reason };
      continue;
    }
    const hit = c.anchors.filter((a) => hitsPath(a.path, v.changed, v.prefix)).map((a) => a.path);
    if (hit.length) c.stale = { state: "stale-candidate", reason: `근거 파일이 기준 커밋 ${v.commit} 뒤 바뀜: ${hit.join(", ")}` };
  }
}
function markStale(units, chunks, git2) {
  const { verdicts, report } = judgeStale(units, git2);
  applyStale(chunks, verdicts);
  return report;
}
function staleJson(r) {
  return { block: r.block, warn: r.warn, unverifiable: r.unverifiable, noAnchorDocs: r.noAnchorDocs, unverifiableAnchors: r.unverifiableAnchors, noStatusDocs: r.noStatusDocs, ...r.noStatusGone !== void 0 ? { noStatusGone: r.noStatusGone } : {} };
}

// src/core/stale-baseline.ts
var LISTED = ["no-frontmatter", "no-status"];
var LABEL = { "no-frontmatter": "머리말 없음", "no-status": "status 없음", misshapen: "머리말 모양 어긋남", link: "심볼릭 링크" };
var RELOCK_HINT = "wiki-index stale --config <설정> --update-baseline";
var ACCEPT_HINT = "wiki-index stale --config <설정> --accept-new <경로>";
var BaselineError = class extends Error {
};
var nfc2 = (p) => p.normalize("NFC");
function baselinePath(cfg, cfgPath, required) {
  if (!("noStatusBaseline" in cfg)) {
    if (required) throw new BaselineError("설정에 noStatusBaseline 칸이 없다 — 출하 관문은 상태를 읽지 못한 문서의 기준 목록 없이 돌지 않는다(칸 이름 철자도 확인)");
    return null;
  }
  const v = cfg.noStatusBaseline;
  if (typeof v !== "string" || !v.trim()) throw new BaselineError(`설정의 noStatusBaseline 은 목록 파일 경로(비지 않은 문자열)여야 한다(지금 ${JSON.stringify(v)})`);
  return path3.resolve(path3.dirname(cfgPath), v);
}
function parseJson(file) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch (e) {
    throw new BaselineError(`기준 목록 파일을 JSON 으로 읽지 못했다: ${file} (${e instanceof Error ? e.message : String(e)})`);
  }
}
function toEntry(v, i, file) {
  const e = v ?? {};
  if (typeof e.path !== "string" || !e.path || typeof e.reason !== "string" || !LISTED.includes(e.reason)) {
    throw new BaselineError(`기준 목록 파일의 entries[${i}] 가 { path, reason: no-frontmatter | no-status } 꼴이 아니다: ${file}`);
  }
  return { path: nfc2(e.path), reason: e.reason };
}
function readBaseline(file) {
  if (!fs2.existsSync(file)) throw new BaselineError(`상태를 읽지 못한 문서의 기준 목록 파일이 없다: ${file} — ${RELOCK_HINT} 로 만든다`);
  const raw = parseJson(file);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BaselineError(`기준 목록 파일의 꼴이 틀렸다(객체가 아님): ${file}`);
  const o = raw;
  if ("paths" in o || o.schema !== 2) {
    throw new BaselineError(`기준 목록 파일이 옛 형식(경로만 적은 목록)이거나 schema 가 2 가 아니다: ${file} — 항목마다 path 와 reason(no-frontmatter · no-status)을 적은 schema 2 로 옮긴다`);
  }
  if (!Array.isArray(o.entries)) throw new BaselineError(`기준 목록 파일의 entries 가 목록이 아니다: ${file}`);
  const entries = o.entries.map((v, i) => toEntry(v, i, file));
  const dup = entries.find((e, i) => entries.findIndex((x) => x.path === e.path) !== i);
  if (dup) throw new BaselineError(`기준 목록 파일에 같은 경로가 두 번 있다: ${dup.path}`);
  return entries;
}
function writeBaseline(file, entries) {
  const sorted = [...entries].sort((a, b) => cmp(a.path, b.path));
  const note = `상태(status)를 읽지 못한 결정 · 정책 문서의 기준 목록. reason: no-frontmatter(머리말 없음) · no-status(status 없음). 빠진 경로 지우기: ${RELOCK_HINT} · 새 경로 더하기: ${ACCEPT_HINT}`;
  fs2.writeFileSync(file, JSON.stringify({ schema: 2, note, entries: sorted }, null, 2) + "\n");
}
function acceptable(raw, now) {
  const p = nfc2(raw.replace(/^\.\//, ""));
  const kind = now.get(p);
  if (!kind) throw new BaselineError(`--accept-new ${raw}: 지금 상태를 읽지 못한 결정 · 정책 문서가 아니다 — 목록에 더하지 않는다`);
  if (kind === "misshapen") throw new BaselineError(`--accept-new ${raw}: 머리말 모양이 어긋난 문서는 목록에 더하지 않는다 — 머리말 모양(첫 줄 \`---\`)을 고친다`);
  if (kind === "link") throw new BaselineError(`--accept-new ${raw}: 심볼릭 링크 문서는 목록에 더하지 않는다 — 링크를 실제 파일로 바꾼다`);
  return { path: p, reason: kind };
}
function updateBaseline(file, report, acceptNew, log) {
  const now = new Map(report.noStatusList.map((d) => [nfc2(d.path), d.kind]));
  const added = acceptNew.map((raw) => acceptable(raw, now));
  const old = fs2.existsSync(file) ? readBaseline(file) : [];
  const kept = old.filter((e) => now.has(e.path));
  for (const e of old) if (!now.has(e.path)) log(`기준 목록에서 지움: ${e.path}`);
  const byPath = new Map(kept.map((e) => [e.path, e]));
  for (const e of added) {
    const was = byPath.get(e.path)?.reason;
    byPath.set(e.path, e);
    if (!was) log(`기준 목록에 더함: ${e.path} (${LABEL[e.reason]})`);
    else if (was !== e.reason) log(`기준 목록의 사유를 바꿈: ${e.path} (${LABEL[was]} → ${LABEL[e.reason]})`);
    else log(`기준 목록에 이미 같은 사유로 있음: ${e.path} (${LABEL[e.reason]})`);
  }
  const entries = [...byPath.values()];
  writeBaseline(file, entries);
  return entries;
}
function blockReason(kind, listed) {
  if (kind === "misshapen") return BLOCK_REASON.headMisshapen;
  if (kind === "link") return BLOCK_REASON.link;
  if (!listed) return BLOCK_REASON.noStatusNew;
  return listed === kind ? null : BLOCK_REASON.noStatusChanged(LABEL[listed], LABEL[kind]);
}
function addBlock(report, d, reason) {
  const hit = report.block.find((b) => b.id === d.id);
  if (hit) hit.reason = `${hit.reason} · ${reason.replace("출하 차단 — ", "")}`;
  else report.block.push({ id: d.id, title: d.title, reason });
}
function lockNoStatus(report, baseline) {
  const listed = new Map(baseline.map((e) => [nfc2(e.path), e.reason]));
  const now = new Set(report.noStatusList.map((d) => nfc2(d.path)));
  for (const d of report.noStatusList) {
    const reason = blockReason(d.kind, listed.get(nfc2(d.path)));
    if (reason) addBlock(report, d, reason);
  }
  report.block.sort((a, b) => cmp(a.id, b.id));
  report.noStatusGone = baseline.filter((e) => !now.has(nfc2(e.path))).length;
  if (report.noStatusGone) report.warnings.push(`상태를 읽지 못한 문서의 기준 목록에서 ${report.noStatusGone}편이 빠짐 — 기준을 다시 잠그세요(${RELOCK_HINT})`);
}

// src/core/build.ts
import { execFileSync } from "node:child_process";
import fs5 from "node:fs";
import path7 from "node:path";

// src/core/bundle.ts
import fs3 from "node:fs";
import path4 from "node:path";

// src/core/model.ts
var FORMAT_VERSION = 1;
var FORMAT_MIN = 1;
var FORMAT_MAX = 1;
var LEVELS = ["public", "internal", "confidential"];
var LEVEL_ALIASES = {
  public: "public",
  공개: "public",
  internal: "internal",
  사내: "internal",
  confidential: "confidential",
  대외비: "confidential"
};
function parseLevel(v) {
  const l = typeof v === "string" ? LEVEL_ALIASES[v.trim()] : void 0;
  if (!l) throw new Error(`알 수 없는 보안 등급: ${String(v)}`);
  return l;
}
function levelRank(l) {
  return LEVELS.indexOf(l);
}
function levelAllowed(l, cap) {
  return levelRank(l) <= levelRank(cap);
}
function maxLevel(a, b) {
  return levelRank(a) >= levelRank(b) ? a : b;
}

// src/core/tar.ts
import zlib from "node:zlib";
var BLOCK = 512;
var TarError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var DEFAULT_LIMITS = { maxCompressedBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxEntries: 2e4 };
function safeEntryPath(raw) {
  if (!raw || raw.includes("\0") || raw.includes("\\")) throw new TarError("UNSAFE_PATH", `허용하지 않는 경로: ${JSON.stringify(raw)}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new TarError("UNSAFE_PATH", `절대 경로는 받지 않는다: ${raw}`);
  const parts = raw.replace(/^\.\/+/, "").split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) throw new TarError("UNSAFE_PATH", `경로 이동 항목: ${raw}`);
  return parts.join("/");
}
function writeStr(h, s, off, len) {
  const b = Buffer.from(s, "utf8");
  if (b.length > len) throw new TarError("BAD_ARCHIVE", `머리 칸이 넘친다: ${s}`);
  b.copy(h, off);
}
function writeOct(h, n, off, len) {
  writeStr(h, n.toString(8).padStart(len - 1, "0"), off, len - 1);
}
function header(name, size, mtime) {
  const h = Buffer.alloc(BLOCK);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const p = parts.slice(0, i).join("/");
      const n = parts.slice(i).join("/");
      if (Buffer.byteLength(p) <= 155 && Buffer.byteLength(n) <= 100) {
        prefix = p;
        base = n;
        break;
      }
    }
    if (!prefix) throw new TarError("BAD_ARCHIVE", `경로가 너무 길다(ustar 255바이트): ${name}`);
  }
  writeStr(h, base, 0, 100);
  writeOct(h, 420, 100, 8);
  writeOct(h, 0, 108, 8);
  writeOct(h, 0, 116, 8);
  writeOct(h, size, 124, 12);
  writeOct(h, mtime, 136, 12);
  h.fill(32, 148, 156);
  h[156] = 48;
  writeStr(h, "ustar", 257, 6);
  writeStr(h, "00", 263, 2);
  writeStr(h, prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  writeStr(h, sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
function packTarGz(entries, mtimeSec) {
  const parts = [];
  for (const [name, data] of entries) {
    parts.push(header(safeEntryPath(name), data.length, mtimeSec), data);
    const pad = (BLOCK - data.length % BLOCK) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}
function cstr(b, off, len) {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString("utf8");
}
function gunzipLimited(gz, limits) {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + (limits.maxEntries + 2) * BLOCK * 2 });
  } catch (e) {
    const code = e.code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new TarError("TOO_LARGE", "푼 크기가 상한을 넘는다");
    throw new TarError("BAD_ARCHIVE", `gzip 을 풀 수 없다: ${e.message}`);
  }
}
function readHeader(h) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  if (parseInt(cstr(h, 148, 8).trim(), 8) !== sum) throw new TarError("BAD_ARCHIVE", "머리 검사합이 맞지 않는다");
  const type = String.fromCharCode(h[156] || 48);
  const prefix = cstr(h, 345, 155);
  const raw = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
  const size = parseInt(cstr(h, 124, 12).trim() || "0", 8);
  if (!Number.isFinite(size) || size < 0) throw new TarError("BAD_ARCHIVE", `크기 칸이 잘못됐다: ${raw}`);
  return { type, raw, size };
}
function entryName(out2, raw, limits) {
  const name = safeEntryPath(raw);
  if (out2.has(name)) throw new TarError("DUPLICATE_ENTRY", `같은 경로가 두 번 있다: ${name}`);
  if (out2.size + 1 > limits.maxEntries) throw new TarError("TOO_MANY_ENTRIES", `항목 수가 상한(${limits.maxEntries})을 넘는다`);
  return name;
}
function unpackTarGz(gz, limits = DEFAULT_LIMITS) {
  if (gz.length > limits.maxCompressedBytes) throw new TarError("TOO_LARGE", `압축 파일이 상한(${limits.maxCompressedBytes}바이트)보다 크다`);
  const tar = gunzipLimited(gz, limits);
  const out2 = /* @__PURE__ */ new Map();
  let off = 0;
  let total = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const { type, raw, size } = readHeader(h);
    off += BLOCK;
    if (type === "5") {
      safeEntryPath(raw);
      continue;
    }
    if (type !== "0") throw new TarError("UNSUPPORTED_ENTRY", `일반 파일이 아닌 항목(${type}): ${raw}`);
    const name = entryName(out2, raw, limits);
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError("TOO_LARGE", `푼 크기 합계가 상한(${limits.maxTotalBytes}바이트)을 넘는다`);
    if (off + size > tar.length) throw new TarError("BAD_ARCHIVE", `항목이 잘렸다: ${name}`);
    out2.set(name, Buffer.from(tar.subarray(off, off + size)));
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out2;
}

// src/core/bundle.ts
var MANIFEST = "manifest.json";
var SIGNATURE = "SIGNATURE";
var BUNDLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
var BUNDLE_VERSION_RE = /^\d+\.\d+\.\d+(\+[0-9a-f]{8})?$/;
function stableJson(v, indent = 0) {
  const norm2 = (x) => {
    if (Array.isArray(x)) return x.map(norm2);
    if (x && typeof x === "object") {
      const o = {};
      for (const k of Object.keys(x).sort(cmp)) {
        const val = x[k];
        if (val !== void 0) o[k] = norm2(val);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm2(v), null, indent);
}
function finalizeManifest(base, files) {
  const hashes = {};
  for (const name of [...files.keys()].sort(cmp)) {
    if (name === MANIFEST || name === SIGNATURE) continue;
    hashes[name] = `sha256:${sha256Hex(files.get(name))}`;
  }
  return { ...base, files: hashes };
}
function writeBundleDir(outDir, files, manifest) {
  if (fs3.existsSync(outDir)) {
    const entries = fs3.readdirSync(outDir);
    if (entries.length && !entries.includes(MANIFEST)) throw new Error(`묶음 폴더가 아닌 곳에는 쓰지 않는다: ${outDir}`);
    fs3.rmSync(outDir, { recursive: true, force: true });
  }
  for (const [name, data] of files) {
    const dest = path4.join(outDir, safeEntryPath(name));
    fs3.mkdirSync(path4.dirname(dest), { recursive: true });
    fs3.writeFileSync(dest, data);
  }
  fs3.writeFileSync(path4.join(outDir, MANIFEST), stableJson(manifest, 2) + "\n");
}
function readBundleDir(dir) {
  const out2 = /* @__PURE__ */ new Map();
  const rec = (rel) => {
    for (const e of fs3.readdirSync(path4.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new TarError("UNSUPPORTED_ENTRY", `링크는 받지 않는다: ${r}`);
      if (e.isDirectory()) rec(r);
      else if (e.isFile()) out2.set(r, fs3.readFileSync(path4.join(dir, r)));
      else throw new TarError("UNSUPPORTED_ENTRY", `일반 파일이 아니다: ${r}`);
    }
  };
  rec("");
  return out2;
}
function readBundle(p, limits = DEFAULT_LIMITS) {
  return fs3.statSync(p).isDirectory() ? readBundleDir(p) : unpackTarGz(fs3.readFileSync(p), limits);
}
function packBundle(files) {
  const manifest = JSON.parse(files.get(MANIFEST).toString("utf8"));
  const names = [...files.keys()].sort((a, b) => {
    const rank = (n) => n === MANIFEST ? 0 : n === SIGNATURE ? 1 : 2;
    return rank(a) - rank(b) || cmp(a, b);
  });
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1e3) || 0;
  return packTarGz(names.map((n) => [n, files.get(n)]), mtime);
}
function verifyBundle(files, opts = {}) {
  const issues = [];
  const raw = files.get(MANIFEST);
  if (!raw) return { ok: false, manifest: null, issues: [{ code: "manifest_missing", message: "manifest.json 이 없다" }] };
  const parsed = parseManifest(raw);
  if ("issue" in parsed) return { ok: false, manifest: null, issues: [parsed.issue] };
  const m = parsed.manifest;
  const min = opts.formatMin ?? FORMAT_MIN;
  const max = opts.formatMax ?? FORMAT_MAX;
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < min || m.formatVersion > max) {
    issues.push({ code: "format_unsupported", message: `formatVersion ${String(m.formatVersion)} 은 지원 범위(${min} ~ ${max}) 밖이다` });
    return { ok: false, manifest: m, issues };
  }
  checkNameVersion(m, issues);
  if (!m.files || typeof m.files !== "object") {
    issues.push({ code: "manifest_invalid", message: "manifest.files 가 없다" });
    return { ok: false, manifest: m, issues };
  }
  checkListedFiles(m.files, files, issues);
  checkUnlistedFiles(m.files, files, issues);
  return { ok: issues.length === 0, manifest: m, issues };
}
function parseManifest(raw) {
  try {
    return { manifest: JSON.parse(raw.toString("utf8")) };
  } catch (e) {
    return { issue: { code: "manifest_invalid", message: `manifest.json 을 읽을 수 없다: ${e.message}` } };
  }
}
function checkNameVersion(m, issues) {
  if (typeof m.name !== "string" || !BUNDLE_NAME_RE.test(m.name)) issues.push({ code: "name_invalid", message: `묶음 이름 규칙에 맞지 않는다: ${String(m.name)}` });
  if (typeof m.version !== "string" || !BUNDLE_VERSION_RE.test(m.version)) issues.push({ code: "version_invalid", message: `버전 규칙에 맞지 않는다: ${String(m.version)}` });
}
function isNormalizedEntry(name) {
  try {
    return safeEntryPath(name) === name;
  } catch {
    return false;
  }
}
function checkListedFiles(listed, files, issues) {
  for (const [name, want] of Object.entries(listed)) {
    if (!isNormalizedEntry(name)) {
      issues.push({ code: "unsafe_path", message: `안전하지 않은 경로: ${name}` });
      continue;
    }
    const data = files.get(name);
    if (!data) issues.push({ code: "file_missing", message: `목록의 파일이 없다: ${name}` });
    else if (`sha256:${sha256Hex(data)}` !== want) issues.push({ code: "hash_mismatch", message: `해시가 다르다: ${name}` });
  }
}
function checkUnlistedFiles(listed, files, issues) {
  for (const name of files.keys()) {
    if (name === MANIFEST || name === SIGNATURE) continue;
    if (!(name in listed)) issues.push({ code: "file_unlisted", message: `목록에 없는 파일: ${name}` });
  }
}

// src/core/section-level.ts
var MARK = /^\s*<!--\s*(?:level|등급)\s*:\s*([^\s>]+)\s*-->\s*$/;
var LOOKS_LIKE = /<!--\s*(?:level|등급)(?![\w가-힣])/;
var FENCE2 = /^\s*(```|~~~)/;
var SectionLevelError = class extends Error {
};
function levelMarks(markdown, path19) {
  const out2 = /* @__PURE__ */ new Map();
  let fence = false;
  markdown.split("\n").forEach((text, i) => {
    if (FENCE2.test(text)) {
      fence = !fence;
      return;
    }
    if (fence || !LOOKS_LIKE.test(text.replace(/`[^`]*`/g, ""))) return;
    const m = MARK.exec(text);
    if (!m) throw new SectionLevelError(`${path19}:${i + 1} 등급 표시 형식이 틀렸다. 한 줄에 \`<!-- level: confidential -->\` 꼴로만 쓴다`);
    try {
      out2.set(i + 1, parseLevel(m[1]));
    } catch {
      throw new SectionLevelError(`${path19}:${i + 1} 알 수 없는 등급: ${m[1]}`);
    }
  });
  return out2;
}
function sectionLevels(sections, marks, base, path19) {
  const byDepth = [];
  return sections.map((sec) => {
    const own = sec.lines.filter((l) => marks.has(l.no));
    if (own.length && sec.depth === 0) throw new SectionLevelError(`${path19}:${own[0].no} 등급 표시는 절 제목 아래에 둔다. 페이지 전체 등급은 원천 설정이나 머리말 level 로 정한다`);
    if (own.length > 1) throw new SectionLevelError(`${path19}:${own[1].no} 한 절에 등급 표시가 둘이다`);
    let inherited = base;
    for (let d = 1; d < sec.depth; d++) {
      const l = byDepth[d];
      if (l && levelRank(l) > levelRank(inherited)) inherited = l;
    }
    let level = inherited;
    if (own.length) {
      const at = own[0].no;
      const before = sec.lines.filter((l) => l.no < at);
      if (before.some((l) => l.text.trim())) throw new SectionLevelError(`${path19}:${at} 등급 표시는 절 제목 바로 아래(본문 앞)에 둔다`);
      const mark = marks.get(at);
      if (levelRank(mark) < levelRank(inherited)) throw new SectionLevelError(`${path19}:${at} 절 등급(${mark})을 물려받은 등급(${inherited})보다 낮출 수 없다`);
      level = mark;
    }
    if (sec.depth > 0) {
      byDepth[sec.depth] = own.length ? level : void 0;
      byDepth.length = sec.depth + 1;
    }
    return level;
  });
}

// src/core/chunk.ts
var DEFAULT_RULES = { maxChars: 1800, overlapChars: 150, tableRowsPerChunk: 30 };
function rulesLabel(r) {
  return `section/1 maxChars=${r.maxChars} overlap=${r.overlapChars} rows=${r.tableRowsPerChunk}`;
}
var FENCE3 = /^\s*(```|~~~)/;
function stripComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}
function stripFrontmatter(md) {
  if (!/^---\r?\n/.test(md)) return md;
  const lines = md.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return md;
  return lines.map((l, i) => i <= end ? "" : l).join("\n");
}
function splitSections(lines) {
  const out2 = [];
  let cur = { depth: 0, heading: "", parentHeading: null, lines: [], headingLine: lines[0]?.no ?? 1 };
  let fence = false;
  let h2 = null;
  for (const l of lines) {
    if (FENCE3.test(l.text)) fence = !fence;
    const m = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l.text);
    if (m && !FENCE3.test(l.text)) {
      out2.push(cur);
      const depth = m[1].length;
      if (depth <= 2) h2 = m[2];
      cur = { depth, heading: m[2].trim(), parentHeading: depth === 3 ? h2 : null, lines: [], headingLine: l.no };
      continue;
    }
    cur.lines.push(l);
  }
  out2.push(cur);
  return out2;
}
function isBodylessParent(sections, si, hasContent, pageTitle) {
  return !hasContent && sections[si].depth === 2 && sections[si].heading !== pageTitle && sections[si + 1]?.depth === 3;
}
function isTableLine(t) {
  return /^\s*\|/.test(t);
}
function isListLine(t) {
  return /^\s*([-*+]|\d+[.)])\s+/.test(t);
}
function toBlocks(lines, rules) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].text;
    if (!t.trim()) {
      i++;
      continue;
    }
    if (FENCE3.test(t)) {
      const start2 = i;
      i++;
      while (i < lines.length && !FENCE3.test(lines[i].text)) i++;
      i++;
      blocks.push({ kind: "code", lines: lines.slice(start2, i) });
      continue;
    }
    if (isTableLine(t)) {
      const start2 = i;
      while (i < lines.length && isTableLine(lines[i].text)) i++;
      blocks.push(...splitTable(lines.slice(start2, i), rules));
      continue;
    }
    const start = i;
    const list2 = isListLine(t);
    i++;
    while (i < lines.length && lines[i].text.trim() && !FENCE3.test(lines[i].text) && !isTableLine(lines[i].text)) {
      i++;
    }
    blocks.push({ kind: list2 ? "list" : "para", lines: lines.slice(start, i) });
  }
  return blocks;
}
function splitTable(rows, rules) {
  const chars = rows.reduce((n, r) => n + r.text.length + 1, 0);
  const hasHead = rows.length >= 2 && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1].text);
  const head = hasHead ? rows.slice(0, 2) : [];
  const body = hasHead ? rows.slice(2) : rows;
  if (body.length <= rules.tableRowsPerChunk && chars <= rules.maxChars) return [{ kind: "table", lines: rows }];
  const headChars = head.reduce((n, r) => n + r.text.length + 1, 0);
  const out2 = [];
  let cur = [];
  let curChars = headChars;
  for (const r of body) {
    if (cur.length && (cur.length >= rules.tableRowsPerChunk || curChars + r.text.length + 1 > rules.maxChars)) {
      out2.push({ kind: "table", lines: [...head, ...cur], standalone: true });
      cur = [];
      curChars = headChars;
    }
    cur.push(r);
    curChars += r.text.length + 1;
  }
  if (cur.length) out2.push({ kind: "table", lines: [...head, ...cur], standalone: true });
  return out2;
}
function blockText(b) {
  return b.lines.map((l) => l.text).join("\n");
}
function splitLongBlock(b, rules) {
  if (blockText(b).length <= rules.maxChars) return [b];
  const packed = packLineGroups(groupAtItemBoundaries(b.lines), b.kind, rules.maxChars);
  const out2 = [];
  for (const p of packed) {
    if (blockText(p).length <= rules.maxChars) out2.push(p);
    else splitByChars(p, rules, out2);
  }
  return out2;
}
function groupAtItemBoundaries(lines) {
  const groups = [];
  let cur = [];
  for (const l of lines) {
    if (cur.length && (isListLine(l.text) && !/^\s{2,}/.test(l.text) || /^####/.test(l.text))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) groups.push(cur);
  return groups;
}
function packLineGroups(groups, kind, maxChars) {
  const packed = [];
  let acc = [];
  for (const g of groups) {
    const len = (ls) => ls.reduce((n, l) => n + l.text.length + 1, 0);
    if (acc.length && len(acc) + len(g) > maxChars) {
      packed.push({ kind, lines: acc });
      acc = [];
    }
    acc = acc.concat(g);
  }
  if (acc.length) packed.push({ kind, lines: acc });
  return packed;
}
function splitByChars(p, rules, out2) {
  const text = blockText(p);
  const step = rules.maxChars - rules.overlapChars;
  for (let s = 0; s < text.length; s += step) {
    const piece = text.slice(s, s + rules.maxChars);
    const before = text.slice(0, s).split("\n").length - 1;
    const no = p.lines[Math.min(before, p.lines.length - 1)].no;
    out2.push({ kind: p.kind, lines: [{ no, text: piece }], standalone: true });
    if (s + rules.maxChars >= text.length) break;
  }
}
function packParts(blocks, rules) {
  const parts = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) parts.push(cur);
    cur = [];
    curLen = 0;
  };
  for (const b0 of blocks) {
    for (const b of splitLongBlock(b0, rules)) {
      const len = blockText(b).length + 2;
      if (b.standalone) {
        flush();
        parts.push([b]);
        continue;
      }
      if (cur.length && curLen + len > rules.maxChars) flush();
      cur.push(b);
      curLen += len;
    }
  }
  flush();
  return parts;
}
function leadSentence(text) {
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || isTableLine(t) || FENCE3.test(t) || /^[>#[]/.test(t) || isListLine(t)) continue;
    const m = /^(.+?(?:다|요|음)\.)(\s|$)/.exec(t) ?? /^(.+?[.!?])(\s|$)/.exec(t);
    const s = (m ? m[1] : t).replace(/\*\*/g, "");
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  }
  return "";
}
function makeChunk(unit, place, seq) {
  const { heading, titlePath, text, lines, id, kind, level } = place;
  return {
    id,
    page: unit.page,
    contentHash: shortHash(text),
    kind,
    part: unit.part,
    titlePath,
    heading,
    text,
    summary: "",
    source: { adapter: unit.adapter, path: unit.path, lines },
    anchors: unit.anchors,
    level,
    ...unit.area ? { area: unit.area } : {},
    ...unit.status ? { status: unit.status } : {},
    ...unit.since ? { since: unit.since } : {},
    ...unit.verifiedAt ? { verifiedAt: unit.verifiedAt } : {},
    generated: unit.generated,
    stale: null,
    seq,
    ...unit.book ? { book: unit.book } : {},
    ...unit.chapter ? { chapter: unit.chapter } : {}
  };
}
function splitFigureLines(lines, unit, figures) {
  if (!figures) return { body: lines, figs: [] };
  const body = [];
  const figs = [];
  for (const l of lines) (figures.match(l.text, unit) ? figs : body).push(l);
  return { body, figs };
}
function titlePathOf(unit, sec, heading) {
  const path19 = [...unit.titlePrefix, unit.title];
  if (sec.parentHeading && sec.parentHeading !== unit.title) path19.push(sec.parentHeading);
  if (sec.depth > 0 && heading !== path19[path19.length - 1]) path19.push(heading);
  return path19;
}
function slugCounter() {
  const used = /* @__PURE__ */ new Map();
  return (slug) => {
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    return n === 1 ? slug : `${slug}~${n}`;
  };
}
function sectionPlaces(o) {
  const { unit, sections, si, level, rules, figures, uniq } = o;
  const sec = sections[si];
  const { body, figs } = splitFigureLines(sec.lines, unit, figures);
  const heading = sec.depth === 0 ? unit.title : sec.heading;
  const titlePath = titlePathOf(unit, sec, heading);
  const hasBody = body.some((l) => l.text.trim());
  const parentOnly = isBodylessParent(sections, si, hasBody || figs.length > 0, unit.title);
  if (!hasBody && !figs.length && !parentOnly) return [];
  const sectionId = `${unit.page}#${uniq(slugify(heading))}`;
  const places = [];
  if (parentOnly) places.push({ heading, titlePath, text: "", lines: [sec.headingLine, sec.headingLine], id: sectionId, kind: "section", level });
  if (hasBody) {
    packParts(toBlocks(body, rules), rules).forEach((part, i) => {
      const all = part.flatMap((b) => b.lines);
      const lines = [i === 0 ? sec.headingLine : all[0].no, all[all.length - 1].no];
      const text = part.map(blockText).join("\n\n").trim();
      places.push({ heading, titlePath, text, lines, id: i === 0 ? sectionId : `${sectionId}@${i + 1}`, kind: "section", level });
    });
  }
  for (const fl of figs) {
    const f = figures.match(fl.text, unit);
    const id = `${unit.page}#${uniq(slugify(`그림-${f.num}`))}`;
    places.push({ heading: `그림 ${f.num} ${f.caption}`, titlePath: [...titlePath, `그림 ${f.num}`], text: f.text, lines: [fl.no, fl.no], id, kind: "figure", level });
  }
  return places;
}
function chunkUnit(unit, rules = DEFAULT_RULES, figures) {
  const lines = stripFrontmatter(stripComments(unit.markdown)).split("\n").map((text, i) => ({ no: i + 1, text: text.replace(/\r$/, "") }));
  const sections = splitSections(lines);
  const levels = sectionLevels(sections, levelMarks(stripFrontmatter(unit.markdown), unit.path), unit.level, unit.path);
  const uniq = slugCounter();
  const places = sections.flatMap((_, si) => sectionPlaces({ unit, sections, si, level: levels[si], rules, figures, uniq }));
  const chunks = places.map((place, seq) => makeChunk(unit, place, seq));
  chunks.forEach((c, i) => {
    c.summary = i === 0 && unit.summary ? unit.summary : leadSentence(c.text);
  });
  return chunks;
}

// src/core/chunk-cache.ts
import fs4 from "node:fs";
import path5 from "node:path";
var CACHE_FORMAT = 1;
function unitKey(u, rules) {
  return sha256Hex(`${rules}
${stableJson(u)}`).slice(0, 32);
}
function readCacheFile(file, rules) {
  if (!fs4.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs4.readFileSync(file, "utf8"));
    return raw.format === CACHE_FORMAT && raw.rules === rules ? raw.entries : {};
  } catch (e) {
    if (e instanceof SyntaxError) return {};
    throw e;
  }
}
var copyOf = (chunks) => structuredClone(chunks);
function openChunkCache(file, rules) {
  const old = file ? readCacheFile(file, rules) : {};
  const used = {};
  let reused = 0;
  let chunked = 0;
  return {
    get(u) {
      const key = unitKey(u, rules);
      const hit = old[key];
      if (!hit) return void 0;
      used[key] = hit;
      reused++;
      return copyOf(hit);
    },
    set(u, chunks) {
      used[unitKey(u, rules)] = copyOf(chunks);
      chunked++;
    },
    save() {
      if (!file) return;
      fs4.mkdirSync(path5.dirname(file), { recursive: true });
      const body = { format: CACHE_FORMAT, rules, entries: used };
      fs4.writeFileSync(`${file}.tmp`, JSON.stringify(body));
      fs4.renameSync(`${file}.tmp`, file);
    },
    stats: () => ({ reused, chunked })
  };
}

// src/core/diff.ts
function diffChunks(oldChunks, newChunks) {
  const oldById = new Map(oldChunks.map((c) => [c.id, c]));
  const newById = new Map(newChunks.map((c) => [c.id, c]));
  const added = [];
  const changed = [];
  const staleChanged = [];
  for (const c of newChunks) {
    const o = oldById.get(c.id);
    if (!o) added.push(c.id);
    else {
      if (o.contentHash !== c.contentHash) changed.push(c.id);
      const a = o.stale?.state ?? null;
      const b = c.stale?.state ?? null;
      if (a !== b) staleChanged.push({ id: c.id, from: a, to: b });
    }
  }
  const removedAll = oldChunks.filter((c) => !newById.has(c.id));
  const addedByHash = /* @__PURE__ */ new Map();
  for (const id of added) {
    const h = newById.get(id).contentHash;
    addedByHash.set(h, [...addedByHash.get(h) ?? [], id]);
  }
  const moved = [];
  const removed = [];
  const movedTo = /* @__PURE__ */ new Set();
  for (const r of removedAll) {
    const cands = addedByHash.get(r.contentHash) ?? [];
    if (cands.length === 1 && !movedTo.has(cands[0])) {
      moved.push([r.id, cands[0]]);
      movedTo.add(cands[0]);
    } else removed.push(r.id);
  }
  return {
    added: added.filter((id) => !movedTo.has(id)).sort(cmp),
    changed: changed.sort(cmp),
    removed: removed.sort(cmp),
    moved: moved.sort((a, b) => cmp(a[0], b[0])),
    staleChanged
  };
}

// src/core/tokenize.ts
var TOKENIZER = "ko-bigram-ident/1";
var TYPE_PRIORITY = ["id", "version", "path", "ident", "piece", "word", "bigram"];
var HANGUL = /[가-힣ㄱ-ㆎ]/;
var PATH_RE = /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/g;
var ID_RE = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;
var VERSION_RE = /\b\d+\.\d+(?:\.\d+)+\b/g;
var WORD_RE = /[A-Za-z0-9_$]+|[가-힣ㄱ-ㆎ]+/g;
function pushIdent(out2, whole, pieces, type) {
  out2.push({ term: whole, ident: true, type });
  for (const p of pieces) if (p && p !== whole) out2.push({ term: p, ident: true, type: "piece" });
}
function identPieces(w) {
  const parts = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_$]+/).filter(Boolean).map((p) => p.toLowerCase());
  return parts.length > 1 ? parts : [];
}
function hangulBigrams(run, out2) {
  if (run.length === 1) {
    out2.push({ term: run, ident: false, type: "bigram" });
    return;
  }
  for (let i = 0; i + 1 < run.length; i++) out2.push({ term: run.slice(i, i + 2), ident: false, type: "bigram" });
}
function tokenize(input) {
  const out2 = [];
  let text = input.normalize("NFC");
  text = text.replace(PATH_RE, (p) => {
    const whole = p.toLowerCase().replace(/^\.\/+/, "");
    const last = whole.split("/").pop() ?? whole;
    const stem = last.replace(/\.[a-z0-9]+$/, "");
    pushIdent(out2, whole, [last, stem], "path");
    return " ";
  });
  text = text.replace(VERSION_RE, (v) => {
    out2.push({ term: v, ident: true, type: "version" });
    out2.push({ term: v.split(".").slice(0, 2).join("."), ident: true, type: "piece" });
    return " ";
  });
  text = text.replace(ID_RE, (id) => {
    const lower = id.toLowerCase();
    const segs = lower.split("-");
    const prefixes = segs.slice(1, -1).map((_, i) => segs.slice(0, i + 2).join("-"));
    pushIdent(out2, lower, [...prefixes, ...segs], /\d/.test(lower) ? "id" : "ident");
    return " ";
  });
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    if (HANGUL.test(w)) {
      hangulBigrams(w, out2);
      continue;
    }
    const pieces = identPieces(w);
    if (pieces.length) pushIdent(out2, w.toLowerCase(), pieces, "ident");
    else out2.push({ term: w.toLowerCase(), ident: false, type: "word" });
  }
  return out2;
}
function queryTerms(q) {
  return [...new Set(tokenize(q).map((t) => t.term))];
}
function queryPhrases(q) {
  const set = /* @__PURE__ */ new Set();
  for (const w of q.normalize("NFC").toLowerCase().split(/\s+/)) {
    const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (t.length >= 2) set.add(t);
  }
  for (const m of q.normalize("NFC").matchAll(/[가-힣]{3,}/g)) set.add(m[0]);
  return [...set];
}

// src/core/lexical.ts
var BM25 = { k1: 1.2, b: 0.75 };
var FIELD_WEIGHTS = { heading: 3, path: 1, body: 1, ident: 2 };
function strongerType(a, b) {
  return a === void 0 || TYPE_PRIORITY.indexOf(b) < TYPE_PRIORITY.indexOf(a) ? b : a;
}
function chunkTermWeights(c, types) {
  const m = /* @__PURE__ */ new Map();
  const add = (term, w, type) => {
    m.set(term, (m.get(term) ?? 0) + w);
    types.set(term, strongerType(types.get(term), type));
  };
  for (const t of tokenize(c.heading)) add(t.term, FIELD_WEIGHTS.heading, t.type);
  const pathTokens = new Map(c.titlePath.slice(0, -1).flatMap((p) => tokenize(p).map((t) => [t.term, t.type])));
  for (const [term, type] of pathTokens) add(term, FIELD_WEIGHTS.path, type);
  for (const t of tokenize(c.text)) add(t.term, t.ident ? FIELD_WEIGHTS.ident : FIELD_WEIGHTS.body, t.type);
  return m;
}
function writeVarint(out2, v) {
  while (v >= 128) {
    out2.push(v & 127 | 128);
    v >>>= 7;
  }
  out2.push(v);
}
function buildLexical(chunks) {
  const postings = /* @__PURE__ */ new Map();
  const types = /* @__PURE__ */ new Map();
  const dl = [];
  chunks.forEach((c, doc) => {
    let len = 0;
    for (const [term, w] of chunkTermWeights(c, types)) {
      let p = postings.get(term);
      if (!p) postings.set(term, p = []);
      p.push([doc, w]);
      len += w;
    }
    dl.push(len);
  });
  const terms = [...postings.keys()].sort(cmp);
  const bytes = [];
  const rows = [];
  for (const term of terms) {
    const list2 = postings.get(term);
    const off = bytes.length;
    let prev = 0;
    for (const [doc, w] of list2) {
      writeVarint(bytes, doc - prev);
      writeVarint(bytes, w);
      prev = doc;
    }
    rows.push(`${term}	${list2.length}	${off}	${bytes.length - off}	${types.get(term)}`);
  }
  const docs = { tokenizer: TOKENIZER, k1: BM25.k1, b: BM25.b, fieldWeights: FIELD_WEIGHTS, n: chunks.length, dl };
  return {
    "lexical/terms.tsv": Buffer.from(rows.join("\n") + "\n"),
    "lexical/postings.bin": Buffer.from(bytes),
    "lexical/docs.json": Buffer.from(JSON.stringify(docs))
  };
}
var LexicalIndex = class {
  docs;
  terms = /* @__PURE__ */ new Map();
  postings;
  constructor(files) {
    this.docs = JSON.parse(files["lexical/docs.json"].toString("utf8"));
    this.postings = files["lexical/postings.bin"];
    for (const line of files["lexical/terms.tsv"].toString("utf8").split("\n")) {
      if (!line) continue;
      const [term, , off, len, type] = line.split("	");
      this.terms.set(term, { off: Number(off), len: Number(len), type: type ?? "word" });
    }
  }
  get termCount() {
    return this.terms.size;
  }
  /** 낱말 사전의 종류. 사전에 없으면 undefined. */
  termType(term) {
    return this.terms.get(term)?.type;
  }
  /** 낱말의 (조각 번호, 가중 빈도) 목록. */
  postingsOf(term) {
    const t = this.terms.get(term);
    if (!t) return [];
    const out2 = [];
    const end = t.off + t.len;
    let i = t.off;
    let doc = 0;
    const read = () => {
      let v = 0;
      let shift = 0;
      for (; ; ) {
        const b = this.postings[i++];
        v += (b & 127) * 2 ** shift;
        if (b < 128) return v;
        shift += 7;
      }
    };
    while (i < end) {
      doc += read();
      out2.push([doc, read()]);
    }
    return out2;
  }
  /**
   * BM25 점수. allowed 가 주어지면 그 조각만 문서 수 · 문서 빈도 · 평균 길이 계산에 넣는다.
   * 그래서 볼 수 없는 조각은 점수 계산에 아무 영향도 주지 않는다. excluded 는 거른 조각 가운데 낱말이 맞은 수다.
   */
  score(terms, allowed) {
    const { k1, b, dl } = this.docs;
    let n = 0;
    let total = 0;
    for (let d = 0; d < dl.length; d++) {
      if (allowed && !allowed[d]) continue;
      n++;
      total += dl[d];
    }
    const avgdl = n ? total / n : 1;
    const scores = /* @__PURE__ */ new Map();
    const excludedDocs = /* @__PURE__ */ new Set();
    for (const term of terms) {
      const all = this.postingsOf(term);
      const list2 = allowed ? all.filter(([d]) => allowed[d] || (excludedDocs.add(d), false)) : all;
      if (!list2.length) continue;
      const idf = Math.log(1 + (n - list2.length + 0.5) / (list2.length + 0.5));
      for (const [d, tf] of list2) {
        const s = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl[d] / avgdl));
        scores.set(d, (scores.get(d) ?? 0) + s);
      }
    }
    return { scores, excluded: excludedDocs.size };
  }
};
var LINK_TERM_TYPES = ["ident", "id", "version"];
function extractLinkTerms(text, index2) {
  const out2 = /* @__PURE__ */ new Set();
  for (const t of tokenize(text)) {
    if (!LINK_TERM_TYPES.includes(t.type)) continue;
    const known = index2.termType(t.term);
    if (known && LINK_TERM_TYPES.includes(known)) out2.add(t.term);
  }
  return [...out2].sort();
}

// src/core/links.ts
import path6 from "node:path";
var CODE_EXT = /\.(ts|tsx|mts|mjs|js|cjs|vue|py|sql|json|ya?ml|sh|css|md|toml|go|rs|java)$/;
var BACKTICK = /`([^`\n]+)`/g;
var MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
var WIKI_LINK = /\[\[([^\]|]+)\]\]/g;
function codeNode(raw) {
  const t = raw.trim();
  if (/\s/.test(t) || !t.includes("/") || /^[a-z]+:\/\//i.test(t) || t.startsWith("/")) return null;
  const m = /^([A-Za-z0-9_.@/-]+?)(?::\d+(?:-\d+)?)?(?:#([A-Za-z_$][\w$]*))?$/.exec(t);
  if (!m || !CODE_EXT.test(m[1])) return null;
  return `code:${m[1].replace(/^\.\//, "")}${m[2] ? `#${m[2]}` : ""}`;
}
function addEdge(g, e) {
  if (e[0] === e[1]) return;
  const k = e.join("\0");
  if (g.edgeKeys.has(k)) return;
  g.edgeKeys.add(k);
  g.edges.push(e);
}
function touch(g, id, type, level = "public") {
  if (!g.nodes[id]) g.nodes[id] = { type, level };
  return g.nodes[id];
}
function addUnits(g, units) {
  for (const u of units) {
    touch(g, u.page, "page", u.level).title = u.title;
    for (const [id, n] of Object.entries(u.extraNodes ?? {})) g.nodes[id] = { ...g.nodes[id], ...n };
    for (const e of u.extraEdges ?? []) addEdge(g, e);
  }
}
function ruleNodeId(r, match, c) {
  return r.node ? r.node(match, c) : `${r.type}:${match}`;
}
function linkRuleRefs(g, c, r) {
  for (const m of c.text.matchAll(r.re)) {
    const id = ruleNodeId(r, m[0], c);
    if (!id) continue;
    touch(g, id, r.type);
    addEdge(g, [c.id, id, "ref"]);
  }
}
function linkRuleDefinitions(g, c, r) {
  const defineFrom = [c.heading, ...[...c.text.matchAll(/^#{4,6}\s+(.+)$/gm)].map((m) => m[1])];
  for (const h of defineFrom) {
    r.re.lastIndex = 0;
    const m = r.re.exec(h);
    r.re.lastIndex = 0;
    const id = m && m.index === 0 ? ruleNodeId(r, m[0], c) : null;
    if (!m || !id) continue;
    const n = touch(g, id, r.type);
    if (n.defined) continue;
    n.defined = c.id;
    n.level = c.level;
    n.title = h.slice(m[0].length).trim() || n.title;
  }
}
function linkCodeSpans(g, c) {
  for (const m of c.text.matchAll(BACKTICK)) {
    const id = codeNode(m[1]);
    if (!id) continue;
    touch(g, id, "code");
    addEdge(g, [c.id, id, "ref"]);
  }
}
function linkMarkdownHref(g, c, dir, href) {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return;
  const [p, frag] = href.split("#");
  if (!p.endsWith(".md")) return;
  const target = path6.posix.normalize(path6.posix.join(dir, decodeURIComponent(p)));
  const page = g.pageByPath.get(target);
  if (!page) {
    if (g.fileExists?.(target)) {
      touch(g, `code:${target}`, "code");
      addEdge(g, [c.id, `code:${target}`, "ref"]);
    } else g.broken.push([c.id, `file:${target}`, "ref"]);
    return;
  }
  const cid = frag ? `${page}#${slugify(decodeURIComponent(frag))}` : page;
  addEdge(g, [c.id, g.chunkById.has(cid) ? cid : page, "ref"]);
}
function linkWikiLinks(g, c) {
  for (const m of c.text.matchAll(WIKI_LINK)) {
    const t = m[1].trim();
    if (/^그림\s/.test(t)) continue;
    if (g.chunkById.has(t) || g.nodes[t]?.type === "page") addEdge(g, [c.id, t, "ref"]);
    else g.broken.push([c.id, t, "ref"]);
  }
}
function linkChunk(g, c, rules) {
  addEdge(g, [c.page, c.id, "contains"]);
  for (const a of c.anchors) {
    const id = codeNode(a.path) ?? `code:${a.path}`;
    touch(g, id, "code");
    addEdge(g, [c.id, id, "evidence"]);
  }
  for (const r of rules) {
    linkRuleRefs(g, c, r);
    linkRuleDefinitions(g, c, r);
  }
  linkCodeSpans(g, c);
  const dir = path6.posix.dirname(c.source.path);
  for (const m of c.text.matchAll(MD_LINK)) linkMarkdownHref(g, c, dir, m[1]);
  linkWikiLinks(g, c);
}
function markUndefinedRefs(g, brokenTypes) {
  const definedTypes = new Set(Object.values(g.nodes).filter((n) => n.defined).map((n) => n.type));
  for (const e of g.edges) {
    if (e[2] !== "ref") continue;
    const n = g.nodes[e[1]];
    if (!n || n.defined || n.type === "page" || n.type === "code" || !definedTypes.has(n.type)) continue;
    if (brokenTypes && !brokenTypes.includes(n.type)) continue;
    if (e[1].startsWith(`${n.type}:`)) g.broken.push(e);
  }
}
function sortedRecord(rec) {
  const out2 = {};
  for (const k of Object.keys(rec).sort(cmp)) out2[k] = rec[k];
  return out2;
}
function backlinksAndCounts(edges) {
  const backlinks = {};
  const counts = {};
  const cnt = (id) => counts[id] ??= { in: 0, out: 0 };
  for (const [from, to, kind] of edges) {
    ;
    ((backlinks[to] ??= {})[kind] ??= []).push(from);
    cnt(from).out++;
    cnt(to).in++;
  }
  const sortedBack = {};
  for (const k of Object.keys(backlinks).sort(cmp)) {
    const byKind = backlinks[k];
    const o = {};
    for (const kind of Object.keys(byKind).sort(cmp)) o[kind] = byKind[kind].sort(cmp);
    sortedBack[k] = o;
  }
  return { backlinks: sortedBack, counts: sortedRecord(counts) };
}
function buildLinks({ chunks, units, rules, brokenTypes, fileExists }) {
  const g = {
    nodes: {},
    edges: [],
    edgeKeys: /* @__PURE__ */ new Set(),
    broken: [],
    chunkById: new Map(chunks.map((c) => [c.id, c])),
    pageByPath: new Map(units.map((u) => [u.path, u.page])),
    fileExists
  };
  addUnits(g, units);
  for (const c of chunks) linkChunk(g, c, rules);
  markUndefinedRefs(g, brokenTypes);
  const { edges, broken } = g;
  edges.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
  broken.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const { backlinks, counts } = backlinksAndCounts(edges);
  return { nodes: sortedRecord(g.nodes), edges, backlinks, counts, broken };
}
function buildIds(links, types, trace = []) {
  const ids = {};
  for (const [node, n] of Object.entries(links.nodes)) {
    if (!types.includes(n.type)) continue;
    const raw = node.slice(node.indexOf(":") + 1);
    const chunks = links.backlinks[node]?.ref ?? [];
    ids[raw] = { type: n.type, ...n.title ? { title: n.title } : {}, ...n.defined ? { defined: n.defined } : {}, chunks };
  }
  return { ids, trace };
}

// src/core/modified.ts
var SEP = "\0";
function parseLastDates(out2) {
  const plain = /* @__PURE__ */ new Map();
  const merged = /* @__PURE__ */ new Map();
  for (const block of out2.split(SEP)) {
    const [head, ...names] = block.split("\n");
    const [date, ...parents] = head.trim().split(" ");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const into = parents.length > 1 ? merged : plain;
    for (const n of names) if (n && !into.has(n)) into.set(n, date);
  }
  for (const [n, d] of merged) if (!plain.has(n)) plain.set(n, d);
  return plain;
}
var DIFF_MERGES_MIN = [2, 31];
function parseGitVersion(out2) {
  const m = /git version (\d+)\.(\d+)/.exec(out2 ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}
var atLeast = (v, min) => v[0] > min[0] || v[0] === min[0] && v[1] >= min[1];
function lastCommitDates(run, commit, units) {
  if (!commit || !units.length) return { dates: null, warnings: [] };
  const warnings = [];
  const version = parseGitVersion(run(["version"]));
  const merges = !!version && atLeast(version, DIFF_MERGES_MIN);
  if (!merges) {
    const want = DIFF_MERGES_MIN.join(".");
    warnings.push(`수정일: git ${version ? version.join(".") : "버전 확인 실패"} — ${want} 이상이 필요하다. 병합으로만 들어온 파일은 수정일이 빠진다(「—」).`);
  }
  const roots = [...new Set(units.map((u) => u.path.split("/").slice(0, 2).join("/")))].sort();
  const args = ["-c", "core.quotePath=false", "log", commit, "--format=%x00%ad %p", "--date=format:%Y-%m-%d", "--name-only", "--no-renames", ...merges ? ["--diff-merges=first-parent"] : [], "--", ...roots];
  const out2 = run(args);
  if (out2 === null) {
    warnings.push("수정일: git log 가 실패해 수정일 없이 만들었다. 모든 쪽의 「확인」이 「—」로 보인다(머리말 verified_at 이 있는 쪽 제외).");
    return { dates: null, warnings };
  }
  return { dates: parseLastDates(out2), warnings };
}
function annotateModified(chunks, units, dates, dirtyPaths) {
  if (!dates) return;
  const dirty = new Set(dirtyPaths);
  const generated = new Set(units.filter((u) => u.generated).map((u) => u.path));
  for (const c of chunks) {
    const p = c.source.path;
    const d = dates.get(p);
    if (d && !generated.has(p) && !dirty.has(p)) c.modifiedAt = d;
  }
}

// src/core/security.ts
var SECURITY_RULES_VERSION = "builtin/1";
var PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\{\{.*\}\}|\*+|x{3,}|\.{3}|…|changeme|change-me|example\w*|your[-_].*|dummy\w*|sample\w*|placeholder|redacted|masked|none|null|undefined|true|false|secret|password|token|test\w*|demo\w*|dev|local|admin|\.\.\.|-+)$/i;
function isPlaceholder(v) {
  const t = v.replace(/^["'`]|["'`;,]$/g, "");
  return !t || PLACEHOLDER.test(t) || /[가-힣]/.test(t) || /^process\.env/.test(t) || /^env\./.test(t) || t.length < 8;
}
function entropy(s) {
  const f = /* @__PURE__ */ new Map();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= n / s.length * Math.log2(n / s.length);
  return h;
}
var SECRET_RULES = [
  {
    name: "private-key",
    category: "secret",
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    mask: true,
    accept: (_m, _l, next) => /^[A-Za-z0-9+/=]{40,}$/.test(next.trim())
  },
  { name: "github-token", category: "secret", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/, mask: true },
  { name: "slack-token", category: "secret", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, mask: true },
  { name: "aws-access-key", category: "secret", re: /\bAKIA[0-9A-Z]{16}\b/, mask: true },
  { name: "llm-api-key", category: "secret", re: /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})/, mask: true },
  { name: "jwt", category: "secret", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/, mask: true },
  {
    name: "url-credential",
    category: "secret",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@`'"]+:([^\s@/`'"]+)@/i,
    valueGroup: 1,
    mask: true
  },
  {
    name: "assigned-secret",
    category: "secret",
    re: /\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[=:]\s*["']?([^\s"'`,;)]+)/,
    valueGroup: 1,
    mask: true,
    accept: (m) => entropy(m[1]) >= 3.5 && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])
  }
];
var PATH_RULES = [
  { name: "personal-path-volumes", category: "personal-path", re: /\/Volumes\/(?![<{$])[A-Za-z0-9._-]+\/[^\s`'")\]]*/, mask: false },
  {
    name: "personal-path-home",
    category: "personal-path",
    re: /\/home\/(?![<{$]|이름|name\b|username\b|user\b)[A-Za-z0-9._-]+\/[^\s`'")\]]*/,
    mask: false
  },
  {
    name: "personal-path-users",
    category: "personal-path",
    re: /\/Users\/(?![<{$]|이름|name\b|username\b|user\b|me\b|you\b|Shared\b)[A-Za-z0-9._-]+[^\s`'")\]]*/,
    mask: false
  }
];
function customerRules(cfg) {
  const domains = ["example.com", "example.org", "example.net", "example", "test", "localhost", "invalid", ...cfg.emailDomains ?? []];
  const rules = [
    {
      name: "email",
      category: "customer-data",
      re: /(?<![\w@/])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/,
      mask: true,
      // `git@github.com:조직/저장소` 같은 SSH 주소는 메일 주소가 아니다.
      accept: (m) => !m[0].startsWith("git@") && !domains.some((d) => m[1].toLowerCase() === d || m[1].toLowerCase().endsWith(`.${d}`))
    },
    {
      name: "phone-kr",
      category: "customer-data",
      re: /\b01[016789]-?\d{3,4}-?\d{4}\b/,
      mask: true,
      accept: (m) => !/(0000|1234|5678|xxxx)$/i.test(m[0]) && !/^010-?0000/.test(m[0])
    },
    { name: "business-no", category: "customer-data", re: /\b\d{3}-\d{2}-\d{5}\b/, mask: true, accept: (m) => !/^(000|123)-/.test(m[0]) }
  ];
  for (const [i, p] of (cfg.customer ?? []).entries()) rules.push({ name: `customer-${i + 1}`, category: "customer-data", re: new RegExp(p), mask: true });
  for (const [i, p] of (cfg.ownerDb ?? []).entries()) rules.push({ name: `owner-db-${i + 1}`, category: "owner-db", re: new RegExp(p), mask: false });
  return rules;
}
function maskValue(v) {
  return v.length <= 6 ? "***" : `${v.slice(0, 4)}…(${v.length}자)`;
}
function shouldReport(r, mm, line, next, file, allow) {
  if (r.valueGroup && isPlaceholder(mm[r.valueGroup] ?? "")) return false;
  if (r.accept && !r.accept(mm, line, next)) return false;
  return !allow.some((a) => a.rule === r.name && (!a.re || a.re.test(file)) && (!a.match || line.includes(a.match)));
}
function findingOf(r, mm, line, lineNo, file, profile) {
  const hit = mm[0];
  const severity = r.category === "secret" || profile === "server" ? "fail" : "warn";
  const shown = r.mask ? maskValue(hit) : hit;
  const start = Math.max(0, (mm.index ?? 0) - 30);
  const excerpt = (line.slice(start, mm.index) + shown + line.slice((mm.index ?? 0) + hit.length, (mm.index ?? 0) + hit.length + 30)).trim();
  return { rule: r.name, category: r.category, severity, path: file, line: lineNo, excerpt };
}
function scanText(text, file, profile, cfg = {}) {
  const allow = (cfg.allow ?? []).map((a) => ({ ...a, re: a.path ? globToRegExp(a.path) : null }));
  return scanRules([...SECRET_RULES, ...PATH_RULES, ...customerRules(cfg)], allow, text, file, profile);
}
var ASSIGNED_SECRET_ANYCASE = {
  ...SECRET_RULES.find((r) => r.name === "assigned-secret"),
  name: "assigned-secret-anycase",
  re: /\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|private_?key)\s*[=:]\s*["']?([^\s"'`,;)]+)/i
};
function scanSecretsStrict(text, file) {
  return scanRules([...SECRET_RULES, ASSIGNED_SECRET_ANYCASE], [], text, file, "local");
}
function scanRules(rules, allow, text, file, profile) {
  const out2 = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const r of rules) {
      const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : `${r.re.flags}g`);
      for (const m of line.matchAll(re)) {
        const mm = m;
        if (!shouldReport(r, mm, line, lines[i + 1] ?? "", file, allow)) continue;
        out2.push(findingOf(r, mm, line, i + 1, file, profile));
      }
    }
  });
  return out2;
}

// src/core/quarantine.ts
function hasSecret(u, profile, security = {}) {
  if (scanSecretsStrict(u.markdown, u.path).length) return true;
  return scanText(u.markdown, u.path, profile, security).some((f) => f.category === "secret");
}
function splitQuarantined(units, profile, security = {}) {
  const kept = [];
  const quarantined = [];
  for (const u of units) {
    if (hasSecret(u, profile, security)) quarantined.push(u.path);
    else kept.push(u);
  }
  return { kept, quarantined: quarantined.sort(cmp) };
}

// src/core/build.ts
function loadConfig(file) {
  const raw = JSON.parse(fs5.readFileSync(file, "utf8"));
  return normalizeConfig(raw);
}
function normalizeConfig(raw) {
  if (raw.schema !== 1) throw new ConfigError(`설정 schema 는 1 이어야 한다(지금 ${String(raw.schema)})`);
  if (!raw.bundle?.name) throw new ConfigError("bundle.name 이 없다");
  if (!Array.isArray(raw.sources) || !raw.sources.length) throw new ConfigError("sources 가 비었다");
  assertOnSecret(raw.security?.onSecret);
  return { ...raw, sources: raw.sources.map((s) => ({ ...s, level: parseLevel(s.level) })) };
}
var ConfigError = class extends Error {
};
function assertOnSecret(v) {
  if (v !== void 0 && v !== "fail" && v !== "quarantine") throw new ConfigError(`security.onSecret 은 "fail" 또는 "quarantine" 이다(지금 ${String(v)})`);
}
var SecurityError = class extends Error {
  findings;
  constructor(findings) {
    super(`보안 검사 실패 ${findings.length}건`);
    this.findings = findings;
  }
};
var DirtyError = class extends Error {
  paths;
  constructor(paths) {
    super(`원천 폴더에 커밋하지 않은 변경이 있다(${paths.length}건). 커밋한 뒤 다시 만들거나 --allow-dirty 로 허용한다`);
    this.paths = paths;
  }
};
function fileExistsIn(repoRoot, mounts) {
  return (rel) => {
    const m = mounts.find((x) => rel.startsWith(`${x.prefix}/`));
    return m ? fs5.existsSync(path7.join(m.dir, rel.slice(m.prefix.length + 1))) : fs5.existsSync(path7.join(repoRoot, rel));
  };
}
function git(repoRoot, args, raw = false) {
  try {
    const out2 = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return raw ? out2 : out2.trim();
  } catch {
    return null;
  }
}
function chunkUnitChecked(u, rules, figures, maxLevel2) {
  let out2;
  try {
    out2 = chunkUnit(u, rules, figures);
  } catch (e) {
    if (e instanceof SectionLevelError) throw new ConfigError(e.message);
    throw e;
  }
  assertUnderCap(out2, maxLevel2);
  return out2;
}
function assertUnderCap(out2, maxLevel2) {
  const over = out2.find((c) => !levelAllowed(c.level, maxLevel2));
  if (over) throw new ConfigError(`절 등급(${over.level})이 묶음 상한(${maxLevel2})보다 높다: ${over.id}`);
}
function chunkWithCache(u, rules, figures, maxLevel2, cache) {
  if (figures) return chunkUnitChecked(u, rules, figures, maxLevel2);
  const hit = cache.get(u);
  if (hit) return hit;
  const out2 = chunkUnitChecked(u, rules, void 0, maxLevel2);
  cache.set(u, out2);
  return out2;
}
function bundleMaxLevel(cfg) {
  return cfg.security?.maxLevel ? parseLevel(cfg.security.maxLevel) : "confidential";
}
function readSources(cfg, repoRoot, pack, profile) {
  const maxLevel2 = bundleMaxLevel(cfg);
  const adapters = new Map(pack.adapters.map((a) => [a.name, a]));
  return cfg.sources.map((spec) => {
    const a = adapters.get(spec.adapter);
    if (!a) throw new ConfigError(`알 수 없는 어댑터: ${spec.adapter}`);
    if (!levelAllowed(spec.level, maxLevel2)) throw new ConfigError(`원천 등급(${spec.level})이 묶음 상한(${maxLevel2})보다 높다: ${spec.adapter}`);
    const out2 = a.read({ repoRoot, spec, ...profile ? { profile } : {}, ...cfg.security ? { security: cfg.security } : {} });
    const units = out2.units.filter((u) => !matchesAny(u.path, cfg.security?.excludePaths));
    const over = units.find((u) => !levelAllowed(u.level, maxLevel2));
    if (over) throw new ConfigError(`페이지 등급(${over.level})이 묶음 상한(${maxLevel2})보다 높다: ${over.path}`);
    return { out: out2, units };
  });
}
function addAdapterOutput(acc, out2, units, step) {
  for (const u of units) {
    acc.units.push(u);
    acc.chunks.push(...chunkWithCache(u, step.rules, out2.figures, step.maxLevel, step.cache));
  }
  if (out2.catalog) {
    acc.catalog.categories.push(...out2.catalog.categories.filter((c) => !acc.catalog.categories.includes(c)));
    acc.catalog.books.push(...out2.catalog.books);
  }
  Object.assign(acc.manuscripts, out2.manuscripts ?? {});
  acc.trace.push(...out2.trace ?? []);
  if (out2.mount) acc.mounts.push(out2.mount);
}
function collectSources(cfg, o, rules, maxLevel2) {
  const acc = { units: [], chunks: [], catalog: { categories: [], books: [] }, manuscripts: {}, trace: [], mounts: [], quarantined: [], chunking: { reused: 0, chunked: 0 } };
  const step = { rules, maxLevel: maxLevel2, cache: openChunkCache(o.chunkCacheFile, rulesLabel(rules)) };
  const quarantine = cfg.security?.onSecret === "quarantine";
  for (const { out: out2, units } of readSources(cfg, o.repoRoot, o.pack, o.profile)) {
    const split = quarantine ? splitQuarantined(units, o.profile, cfg.security) : { kept: units, quarantined: [] };
    acc.quarantined.push(...split.quarantined);
    addAdapterOutput(acc, out2, split.kept, step);
  }
  step.cache.save();
  acc.chunking = step.cache.stats();
  return acc;
}
function assertUniqueChunkIds(chunks) {
  const seen = /* @__PURE__ */ new Map();
  for (const c of chunks) {
    const prev = seen.get(c.id);
    if (prev) throw new ConfigError(`같은 조각 ID 가 두 원천에서 나온다: ${c.id} (${prev}, ${c.source.path})`);
    seen.set(c.id, c.source.path);
  }
}
function parsePorcelainZ(out2) {
  const parts = out2.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return paths;
}
function dirtyPathsOf(repoRoot, commit, units) {
  const roots = [...new Set(units.map((u) => u.path.split("/").slice(0, 2).join("/")))];
  return commit ? parsePorcelainZ(git(repoRoot, ["status", "--porcelain", "-z", "--", ...roots], true) ?? "") : [];
}
function createdAtOf(o, commit) {
  let createdAt = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (o.identity?.reproducible) {
    const epoch = process.env.SOURCE_DATE_EPOCH;
    const ct = commit ? git(o.repoRoot, ["show", "-s", "--format=%ct", "HEAD"]) : null;
    const sec = Number(epoch ?? ct ?? 0);
    createdAt = new Date(sec * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return createdAt;
}
function bundleIdentity(o, units) {
  const commit = git(o.repoRoot, ["rev-parse", "--short=10", "HEAD"]);
  const dirtyPaths = dirtyPathsOf(o.repoRoot, commit, units);
  const dirty = dirtyPaths.length > 0;
  if (dirty && !o.identity?.allowDirty) throw new DirtyError(dirtyPaths);
  const createdAt = createdAtOf(o, commit);
  const version = o.identity?.version ?? (commit ? `0.0.0+${commit.slice(0, 8)}` : "0.0.0");
  return { commit, dirty, dirtyPaths, createdAt, version };
}
function applyPrevDiff(prev, chunks, aliases, log, createdAt, commit) {
  const prevChunks = prev.get("chunks.jsonl").toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const prevAliases = prev.has("aliases.json") ? JSON.parse(prev.get("aliases.json").toString("utf8")) : {};
  const d = diffChunks(prevChunks, chunks);
  const ids = new Set(chunks.map((c) => c.id));
  for (const [from, to] of d.moved) aliases[from] = to;
  for (const [from, to] of Object.entries(prevAliases)) {
    const target = aliases[to] ?? to;
    if (!ids.has(from) && ids.has(target)) aliases[from] = target;
  }
  for (const id of d.added) log.push({ ts: createdAt, op: "add", id, commit });
  for (const id of d.changed) log.push({ ts: createdAt, op: "change", id, commit });
  for (const id of d.removed) log.push({ ts: createdAt, op: "remove", id, commit });
  for (const [from, to] of d.moved) log.push({ ts: createdAt, op: "move", from, to, commit });
  for (const s of d.staleChanged) log.push({ ts: createdAt, op: s.to ? "stale" : "fresh", id: s.id, from: s.from, to: s.to, commit });
}
function buildHistory(o, src, id) {
  const { chunks, units } = src;
  const aliases = {};
  const log = [{ ts: id.createdAt, op: "build", commit: id.commit, version: id.version, counts: { chunks: chunks.length } }];
  if (o.prev) applyPrevDiff(o.prev, chunks, aliases, log, id.createdAt, id.commit);
  const chunkIds = new Set(chunks.map((c) => c.id));
  for (const u of units) for (const a of u.aliases ?? []) if (!chunkIds.has(a)) aliases[a] = u.page;
  return { aliases, log };
}
function bundleFiles(src, links, ids, history, lexical) {
  const files = /* @__PURE__ */ new Map();
  files.set("chunks.jsonl", Buffer.from(src.chunks.map((c) => stableJson(c)).join("\n") + "\n"));
  files.set("links.json", Buffer.from(stableJson(links)));
  files.set("ids.json", Buffer.from(stableJson(ids)));
  files.set("catalog.json", Buffer.from(stableJson(src.catalog, 1)));
  files.set("aliases.json", Buffer.from(stableJson(history.aliases, 1)));
  files.set("log.jsonl", Buffer.from(history.log.map((l) => stableJson(l)).join("\n") + "\n"));
  for (const [k, v] of Object.entries(lexical)) files.set(k, v);
  for (const u of src.units) files.set(`pages/${u.path}`, Buffer.from(u.markdown));
  return files;
}
function addPackExtras(files, o) {
  for (const [name, data] of o.pack.bundleExtras?.(o.repoRoot) ?? []) {
    if (files.has(name) || name === MANIFEST || name === SIGNATURE) throw new Error(`묶음에 싣는 파일 이름이 겹친다: ${name}`);
    files.set(name, data);
  }
}
function countByLevelPart(chunks) {
  const byLevel = {};
  const byPart = {};
  for (const c of chunks) {
    byLevel[c.level] = (byLevel[c.level] ?? 0) + 1;
    byPart[c.part] = (byPart[c.part] ?? 0) + 1;
  }
  return { byLevel, byPart };
}
function manifestSecurity(sec) {
  return {
    ...sec?.allow ? { allow: sec.allow } : {},
    ...sec?.ownerDb ? { ownerDb: sec.ownerDb } : {},
    ...sec?.customer ? { customer: sec.customer } : {},
    ...sec?.emailDomains ? { emailDomains: sec.emailDomains } : {}
  };
}
function manifestBase({ cfg, o, rules, src, links, id, findings }) {
  const { chunks, units } = src;
  const maxLevel2 = bundleMaxLevel(cfg);
  const { byLevel, byPart } = countByLevelPart(chunks);
  return {
    formatVersion: FORMAT_VERSION,
    name: cfg.bundle.name,
    title: cfg.bundle.title,
    version: id.version,
    createdAt: id.createdAt,
    commit: id.commit,
    dirty: id.dirty,
    profile: o.profile,
    rules: { chunker: rulesLabel(rules), tokenizer: TOKENIZER, anchors: "sha256-16/1", security: SECURITY_RULES_VERSION },
    maxLevel: maxLevel2,
    levels: Object.keys(byLevel).sort((a, b) => cmp(a, b)),
    counts: {
      chunks: chunks.length,
      pages: units.length,
      edges: links.edges.length,
      broken: links.broken.length,
      stale: chunks.filter((c) => c.stale?.state === "stale").length,
      staleCandidates: chunks.filter((c) => c.stale?.state === "stale-candidate").length,
      byLevel,
      byPart
    },
    sources: cfg.sources.map((s) => ({ ...s })),
    manuscripts: src.manuscripts,
    securityWarnings: findings.length,
    security: manifestSecurity(cfg.security),
    vectors: null,
    ...cfg.security?.onSecret === "quarantine" ? { quarantined: src.quarantined.length } : {}
  };
}
function buildBundle(cfg, o) {
  const t0 = Date.now();
  const timings = {};
  const lap = (k, from) => timings[k] = Date.now() - from;
  const rules = { ...DEFAULT_RULES, ...cfg.chunk };
  const maxLevel2 = bundleMaxLevel(cfg);
  let t = Date.now();
  const src = collectSources(cfg, o, rules, maxLevel2);
  const { units, chunks } = src;
  lap("read+chunk", t);
  assertUniqueChunkIds(chunks);
  t = Date.now();
  const findings = units.flatMap((u) => scanText(u.markdown, u.path, o.profile, cfg.security));
  lap("security", t);
  const fails = findings.filter((f) => f.severity === "fail");
  if (fails.length) throw new SecurityError(fails);
  t = Date.now();
  const stale = o.staleCheck !== false ? markStale(units, chunks, gitRunner(o.repoRoot)) : void 0;
  lap("stale", t);
  t = Date.now();
  const links = buildLinks({
    chunks,
    units,
    rules: o.pack.idRules,
    brokenTypes: o.pack.brokenTypes,
    fileExists: fileExistsIn(o.repoRoot, src.mounts)
  });
  const ids = buildIds(links, o.pack.idTypes, src.trace);
  lap("links", t);
  t = Date.now();
  const lexical = buildLexical(chunks);
  lap("lexical", t);
  const id = bundleIdentity(o, units);
  t = Date.now();
  const modified = lastCommitDates((args) => git(o.repoRoot, args, true), id.commit, units);
  annotateModified(chunks, units, modified.dates, id.dirtyPaths);
  lap("modified", t);
  const history = buildHistory(o, src, id);
  const files = bundleFiles(src, links, ids, history, lexical);
  addPackExtras(files, o);
  const manifest = finalizeManifest(manifestBase({ cfg, o, rules, src, links, id, findings }), files);
  files.set("manifest.json", Buffer.from(stableJson(manifest, 2) + "\n"));
  timings.total = Date.now() - t0;
  return { files, manifest, findings, timings, warnings: modified.warnings, quarantined: src.quarantined, chunking: src.chunking, ...stale ? { stale } : {} };
}

// src/core/mark-synced.ts
import fs6 from "node:fs";
import path8 from "node:path";
var MarkSyncedError = class extends Error {
};
function setFrontmatterField(markdown, key, value) {
  return editKeepingEol(markdown, (md) => setFrontmatterFieldLf(md, key, value));
}
function setFrontmatterFieldLf(markdown, key, value) {
  const line = `${key}: "${value}"`;
  const lines = markdown.split("\n");
  const end = frontmatterClose(lines);
  if (end === null) return `---
${line}
---
${markdown}`;
  if (end < 0) throw new MarkSyncedError("머리말이 닫히지 않았다(코드 블록 밖에 닫는 --- 줄이 없다)");
  const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}\\s*:`).test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(end, 0, line);
  return lines.join("\n");
}
function writeBaseCommit(u, markdown, sha, pack) {
  const custom = pack.writeBaseCommit?.(u, markdown, sha);
  if (custom !== void 0) return custom;
  return u.part === "dd" ? null : setFrontmatterField(markdown, "base_commit", sha);
}
function markSynced(i) {
  const byPath = new Map(i.units.map((u) => [u.path, u]));
  const plan = [];
  for (const p of i.paths) {
    const abs = path8.resolve(i.repoRoot, p);
    const rel = path8.relative(i.repoRoot, abs).split(path8.sep).join("/");
    const u = byPath.get(rel);
    if (!u) throw new MarkSyncedError(`설정 원천에 없는 문서: ${rel}`);
    if (u.headMisshapen || u.headMisspelled) throw new MarkSyncedError(`머리말 모양이 어긋난 문서: ${rel} — 머리말 모양(첫 줄 \`---\`)을 먼저 고친다`);
    const text = writeBaseCommit(u, fs6.readFileSync(abs, "utf8"), i.head, i.pack);
    if (text === null) throw new MarkSyncedError(`기준 커밋을 쓸 수 없는 원천: ${rel}`);
    plan.push({ abs, rel, text });
  }
  for (const w of plan) fs6.writeFileSync(w.abs, w.text);
  return plan.map((w) => w.rel);
}

// src/dev/serve-root.ts
import os3 from "node:os";
import path13 from "node:path";

// src/core/scope.ts
function areaAllowed(area, s) {
  if (s.areas?.length && !s.areas.includes(area ?? "")) return false;
  return !(area && s.excludeAreas?.includes(area));
}
function areaUnscoped(s) {
  return !s.areas?.length && !s.excludeAreas?.length;
}

// src/core/search.ts
var GENERATED_WEIGHT = 0.8;
var AREA_WEIGHT = { testing: 0.95 };
var PHRASE_BONUS = 0.6;
var DEFINE_BONUS = 4;
var RERANK_TOP = 300;
function chunkWeight(c) {
  return (c.generated ? GENERATED_WEIGHT : 1) * (AREA_WEIGHT[c.area ?? ""] ?? 1);
}
function isError(v) {
  return "error" in v;
}
function outOfKindScope(c, o) {
  if (o.kinds?.length && !o.kinds.includes(c.kind)) return true;
  if (!areaAllowed(c.area, o)) return true;
  return !!(o.parts?.length && !o.parts.includes(c.part));
}
function outOfScope(c, o, bookCat) {
  if (outOfKindScope(c, o)) return true;
  if (o.book && c.book !== o.book) return true;
  if (o.category && bookCat.get(c.book ?? "") !== o.category) return true;
  return !!(o.excludeStale && c.stale?.state === "stale");
}
function pageDateFields(c) {
  const out2 = {};
  if (c.since) out2.since = c.since;
  if (c.verifiedAt) out2.verifiedAt = c.verifiedAt;
  if (c.modifiedAt) out2.modifiedAt = c.modifiedAt;
  return out2;
}
var WikiIndex = class {
  manifest;
  chunks;
  links;
  catalog;
  ids;
  aliases;
  lexical;
  byId = /* @__PURE__ */ new Map();
  pages = /* @__PURE__ */ new Map();
  definedBy = /* @__PURE__ */ new Map();
  files;
  constructor(files, opts = {}) {
    if (!opts.skipVerify) {
      const v = verifyBundle(files);
      if (!v.ok) throw new Error(`묶음 검증 실패: ${v.issues.map((i) => `${i.code} ${i.message}`).join("; ")}`);
    }
    this.files = files;
    const json = (name, fallback) => files.has(name) ? JSON.parse(files.get(name).toString("utf8")) : fallback;
    this.manifest = json("manifest.json", {});
    this.chunks = files.get("chunks.jsonl").toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    this.links = json("links.json", { nodes: {}, edges: [], backlinks: {}, counts: {}, broken: [] });
    this.catalog = json("catalog.json", { categories: [], books: [] });
    this.ids = json("ids.json", { ids: {}, trace: [] });
    this.aliases = json("aliases.json", {});
    this.chunks.forEach((c, i) => {
      this.byId.set(c.id, i);
      const p = this.pages.get(c.page);
      if (p) p.push(i);
      else this.pages.set(c.page, [i]);
    });
    for (const [node, n] of Object.entries(this.links.nodes)) {
      if (!n.defined) continue;
      const i = this.byId.get(n.defined);
      if (i === void 0) continue;
      const key = node.slice(node.indexOf(":") + 1).toLowerCase();
      const list2 = this.definedBy.get(key) ?? [];
      list2.push(i);
      this.definedBy.set(key, list2);
    }
    const docs = files.get("lexical/docs.json");
    const sameTokenizer = docs && JSON.parse(docs.toString("utf8")).tokenizer === TOKENIZER;
    this.lexical = new LexicalIndex(sameTokenizer ? Object.fromEntries([...files].filter(([k]) => k.startsWith("lexical/"))) : buildLexical(this.chunks));
  }
  /** 묶음 안 원본 Markdown 사본. */
  pageSource(path19) {
    return this.files.get(`pages/${path19}`)?.toString("utf8") ?? null;
  }
  /** 고객 보고 글에서 자동 연결 낱말(식별자 · ID · 버전 꼴이면서 이 묶음 사전에 있는 낱말)을 뽑는다. */
  linkTerms(text) {
    return extractLinkTerms(text, this.lexical);
  }
  resolve(id) {
    let cur = id;
    for (let i = 0; i < 8 && this.aliases[cur]; i++) cur = this.aliases[cur];
    return cur;
  }
  allowedMask(cap) {
    const m = new Uint8Array(this.chunks.length);
    this.chunks.forEach((c, i) => {
      m[i] = levelAllowed(c.level, cap) ? 1 : 0;
    });
    return m;
  }
  nodeLevel(id) {
    const i = this.byId.get(id);
    if (i !== void 0) return this.chunks[i].level;
    return this.links.nodes[id]?.level ?? "public";
  }
  /**
   * 페이지 등급 = 원천(페이지) 등급. 절 단위 등급 표시는 올릴 수만 있어서, 페이지 안 조각 등급의 가장 낮은 값과 같다.
   * 페이지는 이 등급으로 열리고, 상한보다 높은 절만 빠진다.
   */
  pageLevel(pageId) {
    const node = this.links.nodes[pageId];
    if (node?.type === "page") return node.level;
    const list2 = this.pages.get(pageId);
    if (!list2?.length) return null;
    const levels = list2.map((j) => this.chunks[j].level);
    return levels.reduce((a, b) => levelAllowed(a, b) ? a : b, levels[0]);
  }
  /** 조각 · 페이지 ID 가 영역 범위 밖이면 true. 범위가 없거나 없는 ID 면 false. */
  outOfArea(id, scope) {
    if (areaUnscoped(scope) || !this.byId.has(id) && !this.pages.has(id)) return false;
    return !areaAllowed(this.nodeArea(id), scope);
  }
  /** 조각 · 페이지 ID 의 영역. 조각이 아닌 노드(추적 데이터 등)는 영역이 없다. */
  nodeArea(id) {
    const i = this.byId.get(id) ?? this.pages.get(id)?.[0];
    return i === void 0 ? void 0 : this.chunks[i].area;
  }
  nodeTitle(id) {
    const i = this.byId.get(id);
    if (i !== void 0) return this.chunks[i].titlePath.join(" › ");
    return this.links.nodes[id]?.title ?? id;
  }
  snippet(c, phrases, terms) {
    const text = c.text.replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    const keys = [...phrases, ...terms].sort((a, b) => b.length - a.length);
    let at = -1;
    for (const k of keys) {
      at = lower.indexOf(k.toLowerCase());
      if (at >= 0) break;
    }
    if (at < 0) return text.slice(0, 200);
    const start = Math.max(0, at - 80);
    return (start > 0 ? "…" : "") + text.slice(start, start + 200) + (start + 200 < text.length ? "…" : "");
  }
  search(o) {
    const terms = queryTerms(o.q);
    const phrases = queryPhrases(o.q);
    const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
    const offset = Math.max(o.offset ?? 0, 0);
    const allowed = this.allowedMask(o.cap);
    const bookCat = new Map(this.catalog.books.map((b) => [b.id, b.category]));
    this.chunks.forEach((c, i) => {
      if (allowed[i] && outOfScope(c, o, bookCat)) allowed[i] = 2;
    });
    const levelOnly = Uint8Array.from(allowed, (v) => v === 0 ? 0 : 1);
    const { excluded } = this.lexical.score(terms, levelOnly);
    const scopeMask = Uint8Array.from(allowed, (v) => v === 1 ? 1 : 0);
    const { scores } = this.lexical.score(terms, scopeMask);
    let ranked = [...scores].map(([d, s]) => [d, s * chunkWeight(this.chunks[d])]);
    ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = ranked.slice(0, RERANK_TOP).map(([d, s]) => {
      const c = this.chunks[d];
      const hay = `${c.heading} ${c.text}`.toLowerCase();
      let bonus = 0;
      for (const p of phrases) if (hay.includes(p)) bonus += PHRASE_BONUS * Math.min(p.length, 8);
      for (const t of terms) if (this.definedBy.get(t)?.includes(d)) bonus += DEFINE_BONUS * 2;
      return [d, s + bonus];
    });
    for (const t of terms) {
      for (const d of this.definedBy.get(t) ?? []) {
        if (scopeMask[d] && !top.some(([x]) => x === d)) top.push([d, DEFINE_BONUS * 2]);
      }
    }
    top.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const inTop = new Set(top.map(([d]) => d));
    ranked = [...top, ...ranked.slice(RERANK_TOP).filter(([d]) => !inTop.has(d))];
    const commit = this.manifest.commit;
    const hits = ranked.slice(offset, offset + limit).map(([d, score]) => {
      const c = this.chunks[d];
      return {
        id: c.id,
        bundle: this.manifest.name,
        kind: c.kind,
        part: c.part,
        titlePath: c.titlePath,
        heading: c.heading,
        summary: c.summary,
        snippet: this.snippet(c, phrases, terms),
        score: Math.round(score * 1e3) / 1e3,
        source: { path: c.source.path, lines: c.source.lines, commit },
        stale: c.stale,
        level: c.level,
        ...c.area ? { area: c.area } : {},
        ...c.book ? { book: c.book } : {},
        ...c.chapter ? { chapter: c.chapter } : {}
      };
    });
    return { hits, total: ranked.length, filteredCount: excluded };
  }
  /** 역링크 요약. 등급 상한 밖과 영역 범위 밖의 가리키는 곳은 제목 · ID 를 내지 않고 건수(filteredCount)에만 넣는다. */
  backlinkSummary(target, cap, kinds, limit, scope = {}) {
    const visible2 = (id) => levelAllowed(this.nodeLevel(id), cap) && (areaUnscoped(scope) || areaAllowed(this.nodeArea(id), scope));
    const byKind = this.links.backlinks[target] ?? {};
    const out2 = {};
    let filtered = 0;
    for (const [kind, list2] of Object.entries(byKind)) {
      if (kinds?.length && !kinds.includes(kind)) continue;
      if (kind === "contains") continue;
      const ok = list2.filter(visible2);
      filtered += list2.length - ok.length;
      if (!ok.length) continue;
      out2[kind] = { count: ok.length, top: ok.slice(0, limit).map((id) => ({ id, title: this.nodeTitle(id), level: this.nodeLevel(id) })) };
    }
    return { backlinks: out2, filteredCount: filtered };
  }
  /** 조각 · 페이지 읽기. 영역 범위 밖이면 등급과 관계없이 찾지 못한 것과 같게 돌려준다(있는지도 알리지 않는다). */
  read(id, o) {
    const rid = this.resolve(id);
    const from = rid !== id ? { resolvedFrom: id } : {};
    if (this.outOfArea(rid, o)) return { error: "not_found", id: rid };
    const i = this.byId.get(rid);
    if (i !== void 0) return this.readChunk(i, from, o);
    const page = this.pages.get(rid);
    if (!page) return { error: "not_found", id: rid };
    return this.readPage(rid, page, from, o);
  }
  readChunk(i, from, o) {
    const c = this.chunks[i];
    if (!levelAllowed(c.level, o.cap)) return { error: "wiki_level_required", id: c.id };
    const { backlinks, filteredCount } = this.backlinkSummary(c.id, o.cap, void 0, 5, o);
    const r = {
      id: c.id,
      ...from,
      kind: "chunk",
      part: c.part,
      title: c.heading,
      titlePath: c.titlePath,
      text: c.text,
      source: { path: c.source.path, lines: c.source.lines, commit: this.manifest.commit },
      evidence: c.anchors.map((a) => a.path),
      stale: c.stale,
      level: c.level,
      backlinks,
      filteredCount
    };
    if (o.context) r.context = this.neighbors(i, o.cap);
    return r;
  }
  /** 같은 페이지의 앞뒤 조각. 볼 수 없는 등급이면 null. */
  neighbors(i, cap) {
    const sib = this.pages.get(this.chunks[i].page) ?? [];
    const pos = sib.indexOf(i);
    const pick = (j) => {
      if (j === void 0) return null;
      const s = this.chunks[j];
      return levelAllowed(s.level, cap) ? { id: s.id, heading: s.heading, text: s.text } : null;
    };
    return { prev: pick(sib[pos - 1]), next: pick(sib[pos + 1]) };
  }
  readPage(rid, page, from, o) {
    const level = this.pageLevel(rid);
    if (!levelAllowed(level, o.cap)) return { error: "wiki_level_required", id: rid };
    const parts = page.map((j) => this.chunks[j]).filter((c) => levelAllowed(c.level, o.cap));
    const head = this.chunks[page[0]];
    const first = levelAllowed(head.level, o.cap) ? head : parts[0] ?? head;
    const links = this.backlinkSummary(rid, o.cap, void 0, 5, o);
    return {
      id: rid,
      ...from,
      kind: "page",
      part: first.part,
      title: this.links.nodes[rid]?.title ?? first.titlePath[first.titlePath.length - 1],
      titlePath: first.titlePath.slice(0, -1),
      text: parts.map((c) => c.kind === "figure" ? `[${c.heading}]` : `## ${c.heading}

${c.text}`).join("\n\n"),
      source: { path: first.source.path, lines: [1, Math.max(1, ...parts.map((c) => c.source.lines[1]))], commit: this.manifest.commit },
      evidence: first.anchors.map((a) => a.path),
      stale: parts.find((c) => c.stale)?.stale ?? null,
      level,
      ...pageDateFields(first),
      chunks: parts.map((c) => ({ id: c.id, heading: c.heading })),
      backlinks: links.backlinks,
      filteredCount: links.filteredCount + (page.length - parts.length)
    };
  }
  backlinks(target, o) {
    const t = this.resolve(target);
    const exists = this.byId.has(t) || !!this.links.nodes[t] || !!this.links.backlinks[t];
    const { backlinks, filteredCount } = this.backlinkSummary(t, o.cap, o.kinds, Math.min(o.limit ?? 20, 100), o);
    const broken = this.links.broken.filter((e) => e[1] === t).length;
    return { target: t, exists, backlinks, filteredCount, ...exists ? {} : { note: "대상 없음" }, ...broken ? { brokenRefs: broken } : {} };
  }
};

// src/mcp/server.ts
import readline from "node:readline";

// src/mcp/tools.ts
var STALE_NOTE = "결과에 낡음(stale) 표시가 있으면 답에 그 사실을 적는다.";
var WIKI_TOOLS = [
  {
    name: "wiki_search",
    description: `프로젝트 문서(설계 · 결정 · 운영 · 산출물)를 절 단위로 찾는다. 결과 한 줄 = 조각 하나(ID · 부분 · 경로 · 일치 문장 · 낡음 · 근거 위치 · 등급). ${STALE_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, maxLength: 200 },
        kinds: { type: "array", items: { type: "string", enum: ["section", "figure"] } },
        areas: { type: "array", items: { type: "string" } },
        exclude_stale: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      required: ["q"],
      additionalProperties: false
    }
  },
  {
    name: "wiki_read",
    description: `조각 · 페이지 ID 로 본문을 읽는다. 제목 경로 · 근거 · 낡음 · 이 조각을 가리키는 곳(종류별 상위 5)을 함께 돌려준다. context=1 이면 앞뒤 조각도 준다. ${STALE_NOTE}`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 300 }, context: { type: "integer", enum: [0, 1] } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "wiki_backlinks",
    description: "대상(조각 · 페이지 · 요구사항 등 ID 또는 code:경로[#심볼])을 가리키는 조각을 종류별로 돌려준다. 볼 수 없는 등급은 건수만 센다.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1, maxLength: 300 },
        kinds: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["target"],
      additionalProperties: false
    }
  }
];
var ToolInputError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function validateArgs(def, args) {
  if (args === void 0 || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("invalid_arguments", "인자는 객체여야 한다");
  const a = args;
  const props = def.inputSchema.properties;
  rejectUnknownArgs(a, props);
  for (const k of def.inputSchema.required ?? []) {
    if (a[k] === void 0 || a[k] === "") throw new ToolInputError("invalid_arguments", `${k} 가 필요하다`);
  }
  for (const [k, v] of Object.entries(a)) checkArg(k, v, props[k]);
  return a;
}
function rejectUnknownArgs(a, props) {
  for (const k of Object.keys(a)) {
    if (!(k in props)) {
      throw new ToolInputError("scope_override_rejected", `알 수 없는 인자 ${k}: 범위(묶음 · 등급 · 영역)는 도구 인자로 바꿀 수 없다`);
    }
  }
}
function badArg(k, msg) {
  return new ToolInputError("invalid_arguments", `${k}: ${msg}`);
}
function checkArg(k, v, s) {
  if (s.type === "string") checkStringArg(k, v, s);
  else if (s.type === "integer") checkIntegerArg(k, v, s);
  else if (s.type === "boolean") {
    if (typeof v !== "boolean") throw badArg(k, "참 · 거짓이어야 한다");
  } else if (s.type === "array") checkArrayArg(k, v, s);
}
function checkStringArg(k, v, s) {
  if (typeof v !== "string") throw badArg(k, "문자열이어야 한다");
  if (typeof s.maxLength === "number" && v.length > s.maxLength) throw badArg(k, `${s.maxLength}자 이하여야 한다`);
  if (typeof s.minLength === "number" && v.length < s.minLength) throw badArg(k, "비어 있다");
  if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) throw badArg(k, "형식이 맞지 않는다");
  if (Array.isArray(s.enum) && !s.enum.includes(v)) throw badArg(k, `허용 값: ${s.enum.join(", ")}`);
  if (/[\u0000-\u001f]/.test(v)) throw badArg(k, "제어 문자는 쓸 수 없다");
}
function checkIntegerArg(k, v, s) {
  if (!Number.isInteger(v)) throw badArg(k, "정수여야 한다");
  if (typeof s.minimum === "number" && v < s.minimum) throw badArg(k, `${s.minimum} 이상이어야 한다`);
  if (typeof s.maximum === "number" && v > s.maximum) throw badArg(k, `${s.maximum} 이하여야 한다`);
  if (Array.isArray(s.enum) && !s.enum.includes(v)) throw badArg(k, `허용 값: ${s.enum.join(", ")}`);
}
function checkArrayArg(k, v, s) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw badArg(k, "문자열 목록이어야 한다");
  const en = s.items.enum;
  if (Array.isArray(en) && v.some((x) => !en.includes(x))) throw badArg(k, `허용 값: ${en.join(", ")}`);
}
function narrowAreas(scope, req) {
  if (!scope.areas) return req;
  if (!req?.length) return scope.areas;
  const ok = req.filter((r) => scope.areas.includes(r));
  return ok.length ? ok : ["\0none"];
}
function runSearch(index2, a, scope) {
  const r = index2.search({
    q: a.q,
    cap: scope.cap,
    kinds: a.kinds,
    areas: narrowAreas(scope, a.areas),
    excludeAreas: scope.excludeAreas,
    excludeStale: a.exclude_stale,
    limit: a.limit ?? 10
  });
  return {
    results: r.hits.map((h) => ({
      id: h.id,
      part: h.part,
      path: h.titlePath.join(" › "),
      match: h.snippet,
      stale: h.stale,
      source: `${h.source.path}:${h.source.lines[0]}-${h.source.lines[1]}`,
      level: h.level
    })),
    total: r.total,
    filtered_count: r.filteredCount
  };
}
function runRead(index2, a, scope) {
  const r = index2.read(a.id, { cap: scope.cap, context: a.context === 1, areas: scope.areas, excludeAreas: scope.excludeAreas });
  if (isError(r)) throw new ToolInputError(r.error, r.error === "not_found" ? `찾지 못했다: ${r.id}` : `이 조각을 볼 등급이 아니다: ${r.id}`);
  return r;
}
function callWikiTool(index2, name, rawArgs, scope) {
  const def = WIKI_TOOLS.find((t) => t.name === name);
  if (!def) throw new ToolInputError("unknown_tool", `알 수 없는 도구: ${name}`);
  const a = validateArgs(def, rawArgs);
  switch (def.name) {
    case "wiki_search":
      return runSearch(index2, a, scope);
    case "wiki_read":
      return runRead(index2, a, scope);
    case "wiki_backlinks":
      return index2.backlinks(a.target, { cap: scope.cap, kinds: a.kinds, limit: a.limit ?? 20, areas: scope.areas, excludeAreas: scope.excludeAreas });
  }
}

// src/mcp/server.ts
var SERVER_INFO = { name: "wiki-indexer", version: "0.1.0" };
var DEFAULT_PROTOCOL = "2025-06-18";
var BUILDING = { error: "index_building", message: "색인을 만드는 중이다 · rg -a 로 찾으세요" };
function toolResult(result, snap) {
  if (!snap) return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  return { content: [{ type: "text", text: `${snap.line}
${JSON.stringify(result)}` }], structuredContent: { ...result, basis: snap.basis } };
}
function errorResult(body) {
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}
function current(src) {
  if (src instanceof WikiIndex) return { index: src, snap: null };
  const snap = src.snapshot();
  return { index: snap.index, snap };
}
function initializeInfo(src, scope) {
  const index2 = src instanceof WikiIndex ? src : src.snapshot().index;
  const head = index2 ? `묶음 ${index2.manifest.name} ${index2.manifest.version}(기준 커밋 ${index2.manifest.commit ?? "없음"}). 등급 상한 ${scope.cap}.` : `색인을 만드는 중이다. 등급 상한 ${scope.cap}.`;
  return src instanceof WikiIndex ? head : `${head} 도구 결과의 첫 줄이 기준이다(기준 커밋 · 미커밋 수 · 다시 만들기 상태).`;
}
function handleRpc(src, scope, req) {
  const isNotification = req.id === void 0;
  const ok = (result) => isNotification ? null : { jsonrpc: "2.0", id: req.id, result };
  const fail = (code, message) => isNotification ? null : { jsonrpc: "2.0", id: req.id ?? null, error: { code, message } };
  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: initializeInfo(src, scope)
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: WIKI_TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const { index: index2, snap } = current(src);
      if (!index2) return ok(errorResult(BUILDING));
      try {
        return ok(toolResult(callWikiTool(index2, name, req.params?.arguments, scope), snap));
      } catch (e) {
        if (e instanceof ToolInputError) return ok(errorResult({ error: e.code, message: e.message }));
        return fail(-32603, `도구 실행 오류: ${e.message}`);
      }
    }
    default:
      return fail(-32601, `지원하지 않는 메서드: ${req.method}`);
  }
}
function serveStdio(src, scope, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 을 읽을 수 없다" } }) + "\n");
      return;
    }
    const res = handleRpc(src, scope, req);
    if (res) output.write(JSON.stringify(res) + "\n");
  });
  return new Promise((resolve) => rl.on("close", () => resolve()));
}

// src/dev/basis.ts
var STATE_TEXT = { building: "다시 만드는 중", failed: "다시 만들기 실패" };
function basisLine(b) {
  const parts = [`기준 ${b.commit ? b.commit.slice(0, 10) : "커밋 없음"}`];
  if (b.dirtyFiles > 0) parts.push(`미커밋 ${b.dirtyFiles}편`);
  if (b.quarantined) parts.push(`격리 ${b.quarantined}편`);
  if (b.state === "deferred") parts.push(`부하로 ${b.deferredMin ?? 0}분 미룸`);
  else if (b.state !== "ready") parts.push(STATE_TEXT[b.state]);
  return parts.join(" · ");
}
function headMismatchWarning(bundleCommit, head) {
  if (!head || bundleCommit && head.startsWith(bundleCommit)) return null;
  return `경고 색인 기준 ${bundleCommit ? bundleCommit.slice(0, 10) : "커밋 없음"} · 지금 HEAD ${head.slice(0, 10)} · 서버가 다시 만들면 맞춰진다`;
}

// src/dev/cache.ts
import { createHash } from "node:crypto";
import fs7 from "node:fs";
import os from "node:os";
import path9 from "node:path";
var CACHE_DIR_ENV = "WIKI_INDEX_CACHE_DIR";
function cacheRoot(env = process.env, home = os.homedir()) {
  const v = env[CACHE_DIR_ENV];
  return v ? path9.resolve(v) : path9.join(home, ".cache", "project-wiki");
}
function cacheKey(worktree) {
  return createHash("sha256").update(path9.resolve(worktree)).digest("hex").slice(0, 12);
}
function cacheDirFor(worktree, configPath, env = process.env) {
  const v = env[CACHE_DIR_ENV];
  return v ? path9.join(path9.resolve(v), cacheKey(worktree)) : path9.join(path9.dirname(path9.resolve(configPath)), "index");
}
var bundleDir = (dir) => path9.join(dir, "bundle");
var nextBundleDir = (dir) => path9.join(dir, "bundle.next");
var quarantinePath = (dir) => path9.join(dir, "quarantine.txt");
var chunkCachePath = (dir) => path9.join(dir, "chunks-cache.json");
var statePath = (dir) => path9.join(dir, "state.json");
function prepareCacheDir(dir, worktree) {
  fs7.mkdirSync(dir, { recursive: true });
  fs7.writeFileSync(path9.join(dir, "worktree.txt"), path9.resolve(worktree) + "\n");
}
function readState(dir) {
  const p = statePath(dir);
  if (!fs7.existsSync(p)) return { lastBuildEnd: 0 };
  let raw;
  try {
    raw = JSON.parse(fs7.readFileSync(p, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) return { lastBuildEnd: 0 };
    throw e;
  }
  return { ...raw, lastBuildEnd: typeof raw?.lastBuildEnd === "number" ? raw.lastBuildEnd : 0 };
}
function writeState(dir, st) {
  const p = statePath(dir);
  fs7.writeFileSync(p + ".tmp", JSON.stringify(st) + "\n");
  fs7.renameSync(p + ".tmp", p);
}
function hasBundle(dir) {
  return fs7.existsSync(path9.join(bundleDir(dir), "manifest.json"));
}

// src/dev/lock.ts
import fs8 from "node:fs";
import path10 from "node:path";
var LOCK_EXPIRE_MS = 30 * 6e4;
var QUEUE_EXPIRE_MS = 10 * 6e4;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
var lockPath = (root) => path10.join(root, "build.lock");
var queueDir = (root) => path10.join(root, "queue");
var queuePath = (root, key) => path10.join(queueDir(root), `${key}.json`);
function readJson(p) {
  try {
    return JSON.parse(fs8.readFileSync(p, "utf8"));
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || e instanceof SyntaxError) return null;
    throw e;
  }
}
function enqueue(root, key, e) {
  fs8.mkdirSync(queueDir(root), { recursive: true });
  const prev = readJson(queuePath(root, key));
  const entry = { pid: e.pid, lastBuildEnd: e.lastBuildEnd, requestedAt: prev?.requestedAt ?? e.now, updatedAt: e.now };
  fs8.writeFileSync(queuePath(root, key), JSON.stringify(entry) + "\n");
}
function dequeue(root, key) {
  fs8.rmSync(queuePath(root, key), { force: true });
}
function nextInQueue(root, d) {
  const alive = d.alive ?? pidAlive;
  if (!fs8.existsSync(queueDir(root))) return void 0;
  const live = [];
  for (const f of fs8.readdirSync(queueDir(root))) {
    if (!f.endsWith(".json")) continue;
    const e = readJson(path10.join(queueDir(root), f));
    if (e && alive(e.pid) && d.now - e.updatedAt <= QUEUE_EXPIRE_MS) live.push([f.slice(0, -5), e]);
  }
  live.sort((a, b) => a[1].lastBuildEnd - b[1].lastBuildEnd || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return live[0]?.[0];
}
function clearBroken(root, d) {
  const info = readJson(lockPath(root));
  const alive = d.alive ?? pidAlive;
  if (info && alive(info.pid) && d.now - info.startedAt < LOCK_EXPIRE_MS) return false;
  fs8.rmSync(lockPath(root), { force: true });
  return true;
}
function createLock(root, info) {
  try {
    fs8.writeFileSync(lockPath(root), JSON.stringify(info) + "\n", { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}
function tryAcquire(root, key, d) {
  fs8.mkdirSync(root, { recursive: true });
  const turn = nextInQueue(root, d);
  if (turn !== void 0 && turn !== key) return { acquired: false, brokenCleared: 0, reason: "queued" };
  const info = { pid: d.pid, startedAt: d.now, key };
  if (createLock(root, info)) return { acquired: true, brokenCleared: 0 };
  if (!clearBroken(root, d)) return { acquired: false, brokenCleared: 0, reason: "busy" };
  const ok = createLock(root, info);
  return ok ? { acquired: true, brokenCleared: 1 } : { acquired: false, brokenCleared: 1, reason: "busy" };
}
function release(root, key, pid) {
  const info = readJson(lockPath(root));
  if (info && info.key === key && info.pid === pid) fs8.rmSync(lockPath(root), { force: true });
  dequeue(root, key);
}

// src/dev/rebuild.ts
import { spawn } from "node:child_process";
import fs9 from "node:fs";
import os2 from "node:os";
import path11 from "node:path";
var BUILD_TIMEOUT_MS = 10 * 6e4;
var CHILD_PRIORITY = 10;
var ENTRY_ENV = "WIKI_INDEX_ENTRY";
function entryScript(env = process.env) {
  return path11.resolve(env[ENTRY_ENV] ?? process.argv[1] ?? "");
}
function buildArgs(job) {
  const { cacheDir } = job;
  return [
    "build",
    "--config",
    job.configPath,
    "--root",
    job.worktree,
    "--out",
    nextBundleDir(cacheDir),
    "--profile",
    "local",
    "--allow-dirty",
    "--quiet",
    "--quarantine-out",
    quarantinePath(cacheDir),
    "--chunk-cache",
    chunkCachePath(cacheDir)
  ];
}
var defaultSpawn = (args) => spawn(process.execPath, [...process.execArgv, entryScript(), ...args], { stdio: "ignore" });
function lowerPriority(child, log) {
  if (child.pid === void 0) return;
  try {
    os2.setPriority(child.pid, CHILD_PRIORITY);
  } catch (e) {
    log(`우선순위를 낮추지 못함(${e.code ?? "unknown"}) · 그대로 돌림`);
  }
}
function runChildBuild(job) {
  const log = job.log ?? (() => {
  });
  fs9.rmSync(nextBundleDir(job.cacheDir), { recursive: true, force: true });
  const child = (job.spawnChild ?? defaultSpawn)(buildArgs(job));
  lowerPriority(child, log);
  return new Promise((resolve) => {
    let done = false;
    const finish = (o) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "timeout" });
    }, job.timeoutMs ?? BUILD_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish({ ok: false, reason: "spawn" }));
    child.on("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code ?? "signal"}` }));
  });
}
function swapBundle(cacheDir) {
  const cur = bundleDir(cacheDir);
  const old = path11.join(cacheDir, "bundle.old");
  fs9.rmSync(old, { recursive: true, force: true });
  if (fs9.existsSync(cur)) fs9.renameSync(cur, old);
  fs9.renameSync(nextBundleDir(cacheDir), cur);
  fs9.rmSync(old, { recursive: true, force: true });
}
async function rebuild(job) {
  const r = await runChildBuild(job);
  if (r.ok && fs9.existsSync(path11.join(nextBundleDir(job.cacheDir), "manifest.json"))) {
    swapBundle(job.cacheDir);
    return r;
  }
  fs9.rmSync(nextBundleDir(job.cacheDir), { recursive: true, force: true });
  return r.ok ? { ok: false, reason: "no-bundle" } : r;
}

// src/dev/schedule.ts
var MIN = 6e4;
var CHECK_INTERVAL_MS = 3e4;
var STABLE_MS = 3e4;
var STABLE_CAP_MS = 10 * MIN;
var TREE_GAP_MS = 2 * MIN;
var OUTSIDE_GAP_MS = 10 * MIN;
var DEFER_CAP_MS = 30 * MIN;
var LOAD_FACTOR = 1.5;
var sameSignal = (a, b) => !!a && a.tree === b.tree && a.outside === b.outside;
function observe(w, signal, now) {
  if (sameSignal(w.lastSeen, signal)) return w;
  return { lastSeen: signal, lastChangeAt: now, pendingSince: w.pendingSince ?? now };
}
function loadGate(i, watch) {
  const since = i.state.deferredSince;
  if (i.load <= i.cores * LOAD_FACTOR) return { action: "start", watch, deferredSince: void 0 };
  const first = since ?? i.now;
  if (i.now - first >= DEFER_CAP_MS) return { action: "start", watch, deferredSince: void 0 };
  return { action: "defer", watch, deferredSince: first, deferredMin: Math.floor((i.now - first) / MIN) };
}
function decide(i) {
  if (!i.hasCache) {
    const retryWait = i.state.failed && i.now - i.state.lastBuildEnd < TREE_GAP_MS;
    return { action: retryWait ? "wait" : "start", watch: i.watch, deferredSince: void 0 };
  }
  if (sameSignal(i.state.builtSignal, i.signal)) return { action: "idle", watch: {}, deferredSince: void 0 };
  const watch = observe(i.watch, i.signal, i.now);
  const treeChanged = i.state.builtSignal?.tree !== i.signal.tree;
  const gap = treeChanged ? TREE_GAP_MS : OUTSIDE_GAP_MS;
  if (i.now - i.state.lastBuildEnd < gap) return { action: "wait", watch, deferredSince: i.state.deferredSince };
  const quiet = i.now - (watch.lastChangeAt ?? i.now) >= STABLE_MS;
  const capped = i.now - (watch.pendingSince ?? i.now) >= STABLE_CAP_MS;
  if (!quiet && !capped) return { action: "wait", watch, deferredSince: i.state.deferredSince };
  return loadGate(i, watch);
}

// src/dev/signals.ts
import { createHash as createHash2 } from "node:crypto";
import fs10 from "node:fs";
import path12 from "node:path";
var SKIPPED_DIRS = /* @__PURE__ */ new Set(["node_modules", "tmp", "temp"]);
var isSkippedDirName = (name) => name.startsWith(".") || SKIPPED_DIRS.has(name);
function readTree(git2, roots) {
  const h = git2(["rev-parse", "HEAD"]);
  const head = h.code === 0 ? h.out.trim() || null : null;
  const st = git2(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...roots.length ? roots : ["."]]);
  const status = st.code === 0 ? st.out : "";
  const dirtyFiles = status.split("\0").filter((e) => e.length > 3).length;
  const tree = createHash2("sha256").update(`${head ?? ""}
${status}`).digest("hex").slice(0, 16);
  return { head, dirtyFiles, tree };
}
function latestMtime(dirs) {
  let max = 0;
  const walk = (dir) => {
    for (const ent of fs10.readdirSync(dir, { withFileTypes: true })) {
      const p = path12.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!isSkippedDirName(ent.name)) walk(p);
      } else if (ent.isFile()) max = Math.max(max, fs10.statSync(p).mtimeMs);
    }
  };
  for (const d of dirs) if (fs10.existsSync(d)) walk(d);
  return Math.floor(max);
}
function readSignal(git2, roots, outsideDirs) {
  const tree = readTree(git2, roots);
  return { signal: { tree: tree.tree, outside: latestMtime(outsideDirs) }, tree };
}

// src/dev/live-index.ts
var openCached = (cacheDir) => new WikiIndex(readBundle(bundleDir(cacheDir)));
var LiveIndex = class {
  index = null;
  state = "ready";
  watch = {};
  lastCheck = Number.NEGATIVE_INFINITY;
  tree = null;
  deferredMin;
  building = null;
  d;
  constructor(d) {
    this.d = d;
    prepareCacheDir(d.cacheDir, d.worktree);
    this.index = this.load();
    const st = readState(d.cacheDir);
    if (st.failed) this.state = "failed";
  }
  /** 지금 답할 색인과 기준. 부를 때마다 바뀜을 확인한다(30초에 한 번까지). */
  snapshot() {
    this.check();
    const b = { commit: this.index?.manifest.commit ?? null, dirtyFiles: this.tree?.dirtyFiles ?? 0, state: this.state };
    if (this.state === "deferred") b.deferredMin = this.deferredMin;
    const quarantined = this.index?.manifest.quarantined;
    if (quarantined) b.quarantined = quarantined;
    return { index: this.index, basis: b, line: basisLine(b) };
  }
  /** 진행 중인 빌드가 끝날 때까지 기다린다(시험 · CLI 용). */
  async idle() {
    await this.building;
  }
  /** 바뀜을 확인하고 필요하면 빌드를 시작한다. 빌드 중이면 확인하지 않는다. */
  check() {
    const now = this.d.now();
    if (this.building || now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    const { signal, tree } = readSignal(this.d.git, this.d.roots, this.d.outsideDirs);
    this.tree = tree;
    const st = readState(this.d.cacheDir);
    const r = decide({ now, load: this.d.load(), cores: this.d.cores, signal, hasCache: this.index !== null, state: st, watch: this.watch });
    this.watch = r.watch;
    if (r.deferredSince !== st.deferredSince) writeState(this.d.cacheDir, { ...st, deferredSince: r.deferredSince });
    if (r.action === "defer") {
      this.state = "deferred";
      this.deferredMin = r.deferredMin;
    } else if (this.state === "deferred") this.state = st.failed ? "failed" : "ready";
    if (r.action === "start") this.start(signal, st, now);
  }
  load() {
    if (!hasBundle(this.d.cacheDir)) return null;
    try {
      return (this.d.open ?? openCached)(this.d.cacheDir);
    } catch (e) {
      this.d.log(`캐시 묶음을 열지 못함 · 다시 만든다(${e.message.slice(0, 80)})`);
      return null;
    }
  }
  /** 대기 목록에 오르고 잠금을 잡으면 빌드한다. 잡지 못하면 이전 색인으로 답하고 다음 확인 때 다시 시도한다. */
  start(signal, st, now) {
    const { lockRoot, key, pid } = this.d;
    enqueue(lockRoot, key, { pid, lastBuildEnd: st.lastBuildEnd, now });
    const got = tryAcquire(lockRoot, key, { now, pid, alive: this.d.alive });
    if (got.brokenCleared) this.d.log(`깨진 잠금 정리 ${got.brokenCleared}`);
    if (!got.acquired) return;
    this.state = "building";
    this.building = this.run(signal, st).catch((e) => {
      this.state = "failed";
      this.d.log(`다시 만들기 오류(${e.message.slice(0, 80)})`);
    }).finally(() => {
      release(lockRoot, key, pid);
      this.building = null;
    });
  }
  async run(signal, st) {
    const job = { worktree: this.d.worktree, configPath: this.d.configPath, cacheDir: this.d.cacheDir, log: this.d.log };
    const r = await (this.d.build ?? rebuild)(job);
    const next = r.ok ? this.load() : null;
    const ok = next !== null;
    const done = { lastBuildEnd: this.d.now(), builtSignal: ok ? signal : st.builtSignal, failed: !ok };
    if (ok) this.index = next;
    writeState(this.d.cacheDir, done);
    this.state = ok ? "ready" : "failed";
    const quarantined = next?.manifest.quarantined;
    this.d.log(ok ? `다시 만들기 끝 · 조각 ${next?.chunks.length ?? 0}${quarantined ? ` · 격리 ${quarantined}` : ""}` : `다시 만들기 실패(${r.reason ?? "open"})`);
  }
};

// src/dev/serve-root.ts
var CLI_WAIT_MS = 6e4;
var CLI_POLL_MS = 2e3;
var IndexNotReadyError = class extends Error {
  exitCode = 3;
  constructor() {
    super("색인 중 · rg -a 로 찾으세요");
  }
};
function rootContext(root, config, env = process.env) {
  const worktree = path13.resolve(root);
  const configPath = path13.resolve(config);
  const cfg = loadConfig(configPath);
  const roots = [...new Set(cfg.sources.map((s) => s.root).filter((r) => !!r))].sort(cmp);
  return { worktree, configPath, cfg, cacheDir: cacheDirFor(worktree, configPath, env), lockRoot: cacheRoot(env), key: cacheKey(worktree), roots, outsideDirs: [] };
}
function rootCap(ctx, level) {
  return level ? parseLevel(level) : parseLevel(ctx.cfg.security?.maxLevel ?? "confidential");
}
async function serveRoot(o) {
  const ctx = rootContext(o.root, o.config);
  const cap = rootCap(ctx, o.level);
  const live = new LiveIndex({
    ...ctx,
    git: gitRunner(ctx.worktree),
    now: Date.now,
    load: () => os3.loadavg()[0],
    cores: os3.availableParallelism(),
    pid: process.pid,
    log: o.log
  });
  const scope = o.excludeAreas?.length ? ` · 뺀 영역 ${o.excludeAreas.join(",")}` : "";
  o.log(`wiki-index MCP: 작업 트리 ${ctx.key} · 등급 상한 ${cap}${o.areas ? ` · 영역 ${o.areas.join(",")}` : ""}${scope}`);
  await serveStdio(live, { cap, areas: o.areas, excludeAreas: o.excludeAreas });
}
var realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function buildOrWait(ctx, d) {
  const now = d.now ?? Date.now;
  const pid = d.pid ?? process.pid;
  const until = now() + (d.waitMs ?? CLI_WAIT_MS);
  const st = readState(ctx.cacheDir);
  while (!hasBundle(ctx.cacheDir)) {
    enqueue(ctx.lockRoot, ctx.key, { pid, lastBuildEnd: st.lastBuildEnd, now: now() });
    if (tryAcquire(ctx.lockRoot, ctx.key, { now: now(), pid, alive: d.alive }).acquired) {
      try {
        const { signal } = readSignal(d.git ?? gitRunner(ctx.worktree), ctx.roots, ctx.outsideDirs);
        const r = await (d.build ?? rebuild)({ worktree: ctx.worktree, configPath: ctx.configPath, cacheDir: ctx.cacheDir });
        writeState(ctx.cacheDir, r.ok ? { lastBuildEnd: now(), builtSignal: signal } : { lastBuildEnd: now(), failed: true });
      } finally {
        release(ctx.lockRoot, ctx.key, pid);
      }
      if (!hasBundle(ctx.cacheDir)) throw new IndexNotReadyError();
      return;
    }
    if (now() >= until) break;
    await (d.sleep ?? realSleep)(CLI_POLL_MS);
  }
  if (!hasBundle(ctx.cacheDir)) {
    release(ctx.lockRoot, ctx.key, pid);
    throw new IndexNotReadyError();
  }
}
async function openRoot(root, config, warn, d = {}) {
  const ctx = rootContext(root, config);
  prepareCacheDir(ctx.cacheDir, ctx.worktree);
  if (!hasBundle(ctx.cacheDir)) await buildOrWait(ctx, d);
  const index2 = new WikiIndex(readBundle(bundleDir(ctx.cacheDir)));
  const w = headMismatchWarning(index2.manifest.commit, readTree(d.git ?? gitRunner(ctx.worktree), ctx.roots).head);
  if (w) warn(w);
  return { index: index2, ctx };
}

// src/cli/args.ts
var UsageError = class extends Error {
};
var FLAGS = /* @__PURE__ */ new Set(["reproducible", "no-stale", "allow-dirty", "strict", "exclude-stale", "json", "context", "update-baseline", "require-baseline", "help", "quiet", "no-refresh", "force", "if-changed"]);
var REPEATABLE = /* @__PURE__ */ new Set(["accept-new"]);
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      pos.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (FLAGS.has(key)) {
      opt[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === void 0) throw new UsageError(`--${key} 에 값이 없다`);
    opt[key] = REPEATABLE.has(key) && typeof opt[key] === "string" ? `${opt[key]}\0${value}` : value;
  }
  return { pos, opt };
}
var str = (v) => typeof v === "string" ? v : void 0;
var list = (v) => str(v)?.split(",").map((s) => s.trim()).filter(Boolean);
var many = (v) => str(v)?.split("\0") ?? [];
var out = (line) => {
  process.stdout.write(line + "\n");
};
var err = (line) => {
  process.stderr.write(line + "\n");
};
function areaScope(opt) {
  if (opt.area !== void 0 && opt["exclude-area"] !== void 0) throw new UsageError("--area 와 --exclude-area 는 함께 줄 수 없다");
  return { areas: list(opt.area), excludeAreas: list(opt["exclude-area"]) };
}
function buildProfile(opt) {
  const profile = str(opt.profile) ?? "local";
  if (profile !== "server" && profile !== "local") throw new UsageError("--profile 은 server 또는 local");
  return profile;
}

// src/cli/build.ts
import fs13 from "node:fs";
import path16 from "node:path";

// src/dev/refresh.ts
function isIndexCurrent(hasCache, built, now) {
  return hasCache && built !== void 0 && built.tree === now.tree && built.outside === now.outside;
}
var realSleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
async function acquireWaiting(ctx, d) {
  const now = d.now ?? Date.now;
  const pid = d.pid ?? process.pid;
  const until = now() + (d.waitMs ?? CLI_WAIT_MS);
  const st = readState(ctx.cacheDir);
  for (; ; ) {
    enqueue(ctx.lockRoot, ctx.key, { pid, lastBuildEnd: st.lastBuildEnd, now: now() });
    if (tryAcquire(ctx.lockRoot, ctx.key, { now: now(), pid, alive: d.alive }).acquired) return true;
    if (now() >= until) return false;
    await (d.sleep ?? realSleep2)(2e3);
  }
}
async function refreshIndex(ctx, build, o = {}) {
  prepareCacheDir(ctx.cacheDir, ctx.worktree);
  const { signal } = readSignal(o.git ?? gitRunner(ctx.worktree), ctx.roots, ctx.outsideDirs);
  if (!o.force && isIndexCurrent(hasBundle(ctx.cacheDir), readState(ctx.cacheDir).builtSignal, signal)) return false;
  if (!await acquireWaiting(ctx, o)) {
    if (hasBundle(ctx.cacheDir)) return false;
    throw new IndexNotReadyError();
  }
  const now = o.now ?? Date.now;
  try {
    build();
    swapBundle(ctx.cacheDir);
    writeState(ctx.cacheDir, { lastBuildEnd: now(), builtSignal: signal });
  } catch (e) {
    writeState(ctx.cacheDir, { ...readState(ctx.cacheDir), lastBuildEnd: now(), failed: true });
    throw e;
  } finally {
    release(ctx.lockRoot, ctx.key, o.pid ?? process.pid);
  }
  return true;
}

// src/core/adapter.ts
import fs11 from "node:fs";
import path14 from "node:path";

// src/core/head-words.ts
var BLOCK_AREAS = /* @__PURE__ */ new Set(["decision", "policy"]);
var AREA_WORDS = /* @__PURE__ */ new Set([
  ...BLOCK_AREAS,
  "wiki",
  "guide",
  "feature",
  "design",
  "design-system",
  "testing",
  "roadmap",
  "history",
  "ops",
  "dev-doc",
  "deliverable",
  "architecture",
  "pattern",
  "debugging",
  "environment",
  "session-log",
  "reference",
  "convention"
]);
var STATUS_WORDS = /* @__PURE__ */ new Set(["current", "draft", "proposed", "accepted", "rejected", "superseded", "deprecated", "archived"]);

// src/core/head-shape.ts
var INVISIBLE = /[\p{Cf}\s]/gu;
var visible = (line) => line.replace(INVISIBLE, "");
function firstMeaningfulLine(lines) {
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const t = visible(lines[i]);
    if (comment || t.startsWith("<!--")) comment = !t.endsWith("-->");
    else if (t) return i;
  }
  return -1;
}
function hasIndentedRule(head) {
  return head.some((l) => /^\s+---\s*$/.test(l));
}
function misshapenHead(src) {
  const lines = src.replace(/^﻿/, "").split("\n");
  const close = frontmatterClose(lines);
  if (close !== null) return close > 0 && hasIndentedRule(lines.slice(1, close));
  const i = firstMeaningfulLine(lines);
  if (i < 0) return false;
  return visible(lines[i]).startsWith("---");
}
var HIDDEN = /[\p{Cf}\p{Mn}\p{Z}\sᅟᅠㅤﾠ⠀]/gu;
var KEY_LIKE = /^[^\p{L}\p{N}`]*(area|category|status)[^\p{L}\p{N}`]{0,2}?[:=]/iu;
var EXACT_KEY = /^(area|category|status)[ \t]*:(.*)$/;
var READ_KEY = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
var LIST_ITEM = /^\s*-\s+/;
var BLOCK_VALUE = /^[|>][+-]?\d*[+-]?(\s+#.*)?$/;
var PLAIN_VALUE = /^[A-Za-z][\w-]*$/;
var FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
var LIST_OPEN = /^ *(?:[-*+]|\d{1,9}[.)])(?: +|$)/;
var MIXABLE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
function keyLike(line) {
  const m = KEY_LIKE.exec(line.normalize("NFKC").replace(HIDDEN, ""));
  if (!m) return null;
  return m[1].toLowerCase() === "status" ? "status" : "area";
}
function plainValue(rest) {
  const t = rest.trim().replace(/\s+#.*$/, "");
  const q = /^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t);
  return PLAIN_VALUE.test(q ? q[1] : t);
}
function headLikeWord(value) {
  const v = value.normalize("NFKD").replace(/[\p{Cf}\p{M}ᅟᅠㅤﾠ⠀]/gu, "").trim();
  const core = v.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const first = [...core.split(/\s/)[0]];
  const foreign = first.some((c) => new RegExp("\\p{L}", "u").test(c) && !/[A-Za-z]/.test(c) && !MIXABLE.test(c));
  return PLAIN_VALUE.test(core) || foreign && first.some((c) => /[A-Za-z]/.test(c));
}
function plainBodyValue(line) {
  const t = line.normalize("NFKC");
  return headLikeWord(t.slice(t.search(/[:=]/) + 1).replace(/\s+#.*$/, ""));
}
var blockContent = (line) => line.startsWith(" ") && !(/^ \S/.test(line) && keyLike(line));
var continued = (line) => /^ +\S/.test(line) && !keyLike(line);
function skipHeadLine(line, st) {
  if (!line.trim()) return true;
  if (st.block && blockContent(line) || (st.cont || st.list) && continued(line)) return true;
  st.block = false;
  st.cont = false;
  return line.trim().startsWith("#") || st.list && LIST_ITEM.test(line) && !keyLike(line);
}
function markKeyLine(line, seen, out2) {
  const k = keyLike(line);
  if (!k) return;
  const m = EXACT_KEY.exec(line);
  if (!m || !plainValue(m[2]) || seen.has(m[1])) out2.add(k);
  if (m) seen.add(m[1]);
}
function scanHead(head, out2) {
  const seen = /* @__PURE__ */ new Set();
  const st = { block: false, list: false, cont: false };
  for (const raw of head) {
    const line = raw.replace(/\r$/, "");
    if (skipHeadLine(line, st)) continue;
    const kv = READ_KEY.exec(line);
    if (!kv) out2.add("line");
    st.list = kv?.[2] === "";
    st.block = !!kv && BLOCK_VALUE.test(kv[2].trim());
    st.cont = !!kv && kv[2] !== "" && !st.block;
    markKeyLine(line, seen, out2);
  }
}
function bodyMark(line, read, inBlock) {
  const k = keyLike(line);
  if (k === "area") return !read.area && (inBlock || plainBodyValue(line)) ? "area" : null;
  return k === "status" && !read.status ? "status" : null;
}
function indentOf(line) {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "	") n += 4 - n % 4;
    else break;
  }
  return n;
}
function fenceStep(line, atHeadSlot, st) {
  const f = FENCE_OPEN.exec(line)?.[1];
  if (!f) return false;
  if (!st.fence) {
    st.fence = f;
    st.checkFence = atHeadSlot;
    return true;
  }
  if (f[0] !== st.fence[0] || f.length < st.fence.length || line.trim().slice(f.length)) return false;
  st.fence = null;
  return true;
}
function codeStep(lines, i, from, st) {
  const line = lines[i];
  const prevBlank = i === from || !lines[i - 1].trim();
  st.code = !!line.trim() && indentOf(line) >= (st.list ?? 0) + 4 && (st.code || prevBlank);
  if (st.code || !line.trim()) return;
  const m = LIST_OPEN.exec(line);
  if (m) st.list = m[0].length;
  else if (prevBlank && st.list !== null && indentOf(line) < st.list) st.list = null;
}
function dashKind(line) {
  const t = visible(line);
  return /^-{3,}$/.test(t) ? "open" : t === "..." ? "close" : null;
}
function scanBody(lines, from, headSlot, read, out2) {
  const st = { fence: null, checkFence: false, code: false, list: null };
  const keys = [];
  let open = Infinity;
  let close = -1;
  for (let i = from; i < lines.length; i++) {
    if (fenceStep(lines[i], i === headSlot, st) || st.fence && !st.checkFence) continue;
    codeStep(lines, i, from, st);
    if (st.code) continue;
    const kind = dashKind(lines[i]);
    if (kind === "open") open = Math.min(open, i);
    if (kind) close = i;
    else keys.push(i);
  }
  for (const i of keys) out2.add(bodyMark(lines[i], read, open < i && i < close));
}
function unreadStateLine(src, area, read = { area: false, status: false }) {
  const lines = src.replace(/^﻿/, "").split("\n");
  const close = frontmatterClose(lines);
  const out2 = /* @__PURE__ */ new Set();
  if (close !== null && close > 0) {
    scanHead(lines.slice(1, close), out2);
    scanBody(lines, close + 1, -1, read, out2);
  } else scanBody(lines, 0, firstMeaningfulLine(lines), read, out2);
  return out2.has("area") || out2.has("line") || out2.has("status") && BLOCK_AREAS.has(area ?? "");
}
var norm = (v) => typeof v === "string" ? v.trim().toLowerCase() : "";
var offWord = (v, words, extra) => typeof v === "string" && !words.has(norm(v)) && norm(v) !== norm(extra);
function misspelledHead(data, specArea) {
  const keys = Object.keys(data);
  const areaKeys = keys.filter((k) => /^(area|category)$/i.test(k));
  if (areaKeys.some((k) => offWord(data[k], AREA_WORDS, specArea))) return true;
  const intendsBlock = areaKeys.some((k) => BLOCK_AREAS.has(norm(data[k])));
  const area = typeof data.area === "string" ? data.area : typeof data.category === "string" ? data.category : specArea;
  if (!BLOCK_AREAS.has(area ?? "")) return intendsBlock;
  if (keys.some((k) => /^status$/i.test(k) && k !== "status")) return true;
  const s = data.status;
  if (typeof s !== "string" || s === "current") return false;
  return norm(s) === "current" || offWord(s, STATUS_WORDS);
}
function headFlags(markdown, data, specArea, area, status) {
  const read = { area: typeof data.area === "string" || typeof data.category === "string", status: status !== void 0 };
  return {
    ...misshapenHead(markdown) || unreadStateLine(markdown, area, read) ? { headMisshapen: true } : {},
    ...misspelledHead(data, specArea) ? { headMisspelled: true } : {}
  };
}

// src/core/adapter.ts
function throughLink(repoRoot, rel) {
  const parts = rel.split("/");
  return parts.some((_, i) => fs11.lstatSync(path14.join(repoRoot, ...parts.slice(0, i + 1)), { throwIfNoEntry: false })?.isSymbolicLink() === true);
}
function fileAnchor(repoRoot, rel) {
  const abs = path14.join(repoRoot, rel);
  let hash = null;
  try {
    if (fs11.statSync(abs).isFile()) hash = shortHash(fs11.readFileSync(abs, "utf8"));
  } catch {
    hash = null;
  }
  return { kind: "file", path: rel, hash, ...throughLink(repoRoot, rel) ? { link: true } : {} };
}
function asList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}
var FENCE_LINE = /^\s*(```|~~~)/;
function linesOutsideFences(markdown) {
  const out2 = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE_LINE.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) out2.push(line);
  }
  return out2;
}
function firstHeading(markdown) {
  for (const line of linesOutsideFences(markdown)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}
function firstParagraph(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  for (const line of linesOutsideFences(body)) {
    const t = line.trim();
    if (!t || /^[>|#<-]/.test(t) || /^([*+]|\d+[.)])\s/.test(t)) continue;
    const plain = t.replace(/[*_`]/g, "").trim();
    if (plain) return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
  }
  return null;
}
function markdownKey(spec, rel, data) {
  const base = spec.root && rel.startsWith(`${spec.root}/`) ? rel.slice(spec.root.length + 1) : rel;
  return typeof data.id === "string" && data.id ? data.id : base.replace(/\.md$/, "");
}
function markdownTitle(data, markdown, rel) {
  return typeof data.title === "string" && data.title || firstHeading(markdown) || firstParagraph(markdown) || path14.posix.basename(rel, ".md");
}
function markdownLevel(spec, data) {
  return data.level !== void 0 ? maxLevel(spec.level, parseLevel(data.level)) : spec.level;
}
function markdownEdges(page, ns, data) {
  const edges = [];
  for (const t of asList(data.supersedes)) edges.push([page, t.includes(":") ? t : `${ns}:${t}`, "reverts"]);
  for (const t of asList(data.implements)) edges.push([page, t, "implements"]);
  return edges;
}
function pageDates(data) {
  const text = (v) => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  const since = text(data.since);
  const verifiedAt = text(data.verified_at);
  return { ...since ? { since } : {}, ...verifiedAt ? { verifiedAt } : {} };
}
function isBlockingPage(area, status) {
  return (area === "decision" || area === "policy") && status === "current";
}
function wikiStaleFields(repoRoot, data, specArea) {
  const area = typeof data.area === "string" ? data.area : typeof data.category === "string" ? data.category : specArea;
  const status = typeof data.status === "string" ? data.status : void 0;
  const base = data.base_commit === void 0 || data.base_commit === "" ? void 0 : String(data.base_commit);
  const { paths, skipped } = splitAnchorValues(asList(data.sources).map((s) => s.split("#")[0].split(":")[0]));
  const block = isBlockingPage(area, status);
  return {
    ...area !== void 0 ? { area } : {},
    ...status !== void 0 ? { status } : {},
    anchors: paths.map((p) => fileAnchor(repoRoot, p)),
    ...skipped ? { skippedAnchors: skipped } : {},
    ...base ? { baseCommit: base } : {},
    ...block ? { blockOnStale: true } : {},
    ...block || base || data.sources !== void 0 ? { reviewInSameCommit: true } : {}
  };
}
var markdownAdapter = {
  name: "markdown",
  read({ repoRoot, spec }) {
    const include = spec.include ?? (spec.root ? [`${spec.root}/**/*.md`] : []);
    const ns = spec.idNamespace ?? "wiki";
    const part = spec.part ?? "wiki";
    const units = [];
    const links = [];
    for (const rel of globFiles(repoRoot, include, spec.exclude, links)) {
      const markdown = fs11.readFileSync(path14.join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");
      const { data, unclosed } = parseFrontmatter(markdown);
      const page = `${ns}:${markdownKey(spec, rel, data)}`;
      const title = markdownTitle(data, markdown, rel);
      const level = markdownLevel(spec, data);
      const edges = markdownEdges(page, ns, data);
      const stale = wikiStaleFields(repoRoot, data, spec.area);
      units.push({
        adapter: spec.adapter,
        path: rel,
        page,
        part,
        title,
        titlePrefix: spec.titlePrefix ?? [],
        level,
        ...pageDates(data),
        generated: false,
        markdown,
        ...typeof data.summary === "string" ? { summary: data.summary } : {},
        ...stale,
        ...unclosed ? { headUnclosed: true } : {},
        ...headFlags(markdown, data, spec.area, stale.area, stale.status),
        aliases: asList(data.aliases).map((a) => a.includes(":") ? a : `${ns}:${a}`),
        extraEdges: edges
      });
    }
    return { units, links };
  }
};

// src/init/plan.ts
var DOC_DIRS = {
  docs: void 0,
  doc: void 0,
  documentation: void 0,
  wiki: "wiki",
  notes: void 0,
  handbook: void 0,
  design: "design",
  architecture: "design",
  spec: "design",
  specs: "design",
  adr: "decision",
  adrs: "decision",
  decisions: "decision",
  rfc: "decision",
  rfcs: "decision",
  guide: "guide",
  guides: "guide",
  ops: "ops",
  runbooks: "ops",
  reports: void 0,
  deliverables: void 0
};
var AREA_SUBDIRS = {
  adr: "decision",
  adrs: "decision",
  decisions: "decision",
  rfc: "decision",
  rfcs: "decision",
  design: "design",
  architecture: "design",
  ops: "ops",
  runbooks: "ops",
  guides: "guide",
  wiki: "wiki"
};
var DEFAULT_EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**", "**/vendor/**", "**/coverage/**", ".wiki/**"];
var isMarkdown = (p) => /\.md$/i.test(p);
var inHiddenDir = (p) => p.split("/").slice(0, -1).some((s) => s.startsWith("."));
function bundleNameOf(repoName) {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z0-9]/.test(slug) ? slug : "project-wiki";
}
var nsOf = (folder) => folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "docs";
function countMatching(files, include, exclude) {
  return files.filter((f) => matchesAny(f, include) && !matchesAny(f, exclude)).length;
}
function folderSources(top, docs) {
  const subs = [...new Set(docs.filter((f) => f.startsWith(`${top}/`)).map((f) => f.split("/")[1]))].filter((sub) => AREA_SUBDIRS[sub] && docs.some((f) => f.startsWith(`${top}/${sub}/`))).sort();
  const out2 = subs.map((sub) => {
    const root = `${top}/${sub}`;
    const include2 = [`${root}/**/*.md`];
    return { name: nsOf(`${top}-${sub}`), root, include: include2, exclude: DEFAULT_EXCLUDES, area: AREA_SUBDIRS[sub], files: countMatching(docs, include2, DEFAULT_EXCLUDES) };
  });
  const exclude = [...DEFAULT_EXCLUDES, ...subs.map((sub) => `${top}/${sub}/**`)];
  const include = [`${top}/**/*.md`];
  const files = countMatching(docs, include, exclude);
  if (files) out2.unshift({ name: nsOf(top), root: top, include, exclude, ...DOC_DIRS[top] ? { area: DOC_DIRS[top] } : {}, files });
  return out2;
}
function looseSources(docs, docTops) {
  const out2 = [];
  const rootFiles = countMatching(docs, ["*.md"], []);
  if (rootFiles) out2.push({ name: "root", include: ["*.md"], exclude: [], files: rootFiles });
  const exclude = [...DEFAULT_EXCLUDES, "*.md", ...docTops.map((t) => `${t}/**`)];
  const files = countMatching(docs, ["**/*.md"], exclude);
  if (files) out2.push({ name: "other", include: ["**/*.md"], exclude, files });
  return out2;
}
function planWiki(repoName, files) {
  const docs = files.filter((f) => isMarkdown(f) && !inHiddenDir(f) && !matchesAny(f, DEFAULT_EXCLUDES));
  const docTops = Object.keys(DOC_DIRS).filter((top) => docs.some((f) => f.startsWith(`${top}/`))).sort();
  const sources = [...docTops.flatMap((top) => folderSources(top, docs)), ...looseSources(docs, docTops)];
  const config = {
    schema: 1,
    bundle: { name: bundleNameOf(repoName), title: `${repoName} 위키` },
    pack: "core",
    sources: sources.map((s) => ({
      adapter: "markdown",
      ...s.root ? { root: s.root } : {},
      include: s.include,
      ...s.exclude.length ? { exclude: s.exclude } : {},
      level: "internal",
      idNamespace: s.name,
      ...s.area ? { area: s.area } : {}
    })),
    security: { maxLevel: "confidential", excludePaths: ["**/.env*"], onSecret: "quarantine" }
  };
  return { config, sources };
}

// src/eval/retrieval.ts
var GoldUnresolvedError = class extends Error {
  ids;
  constructor(ids) {
    super(`정답 안정 키가 조각으로 풀리지 않는다(gold_unresolved): ${ids.join(", ")}`);
    this.ids = ids;
  }
};
function resolveGold(index2, gold) {
  const out2 = /* @__PURE__ */ new Set();
  for (const g of gold) {
    const src = globToRegExp(g.source);
    const head = g.heading ? new RegExp(g.heading) : null;
    for (const c of index2.chunks) {
      if (!src.test(c.source.path)) continue;
      if (g.book && c.book !== g.book) continue;
      if (head && !head.test(c.heading)) continue;
      out2.add(c.id);
    }
  }
  return [...out2];
}
function evaluate(index2, file, cap = "confidential") {
  const k = file.k ?? 10;
  const results = [];
  const unresolved = [];
  for (const q of file.questions) {
    const inScope = !q.scope;
    const goldIds = inScope ? resolveGold(index2, q.gold) : [];
    if (inScope && !goldIds.length) unresolved.push(q.id);
    const r = index2.search({ q: q.q, cap, limit: k });
    const gold = new Set(goldIds);
    const pos = r.hits.findIndex((h) => gold.has(h.id));
    results.push({ id: q.id, q: q.q, inScope, goldIds, rank: pos >= 0 ? pos + 1 : null, top: r.hits.map((h) => ({ id: h.id, stale: h.stale?.state ?? null })) });
  }
  if (unresolved.length) throw new GoldUnresolvedError(unresolved);
  const scoped = results.filter((r) => r.inScope);
  const n = scoped.length || 1;
  const top5 = scoped.flatMap((r) => r.top.slice(0, 5));
  const summary = {
    questions: results.length,
    inScope: scoped.length,
    recallAt5: scoped.filter((r) => r.rank !== null && r.rank <= 5).length / n,
    recallAt10: scoped.filter((r) => r.rank !== null && r.rank <= 10).length / n,
    mrr: scoped.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
    staleTop5: top5.length ? top5.filter((t) => t.stale === "stale").length / top5.length : 0,
    staleCandidateTop5: top5.length ? top5.filter((t) => t.stale === "stale-candidate").length / top5.length : 0
  };
  return { results, summary };
}
function judge(summary, file, baseline) {
  const reasons = [];
  const t = { recallAt10: 0.8, staleTop5Max: 0.1, regression: 0.1, ...file.threshold };
  if (summary.recallAt10 < t.recallAt10) reasons.push(`재현율@10 ${summary.recallAt10.toFixed(2)} < 기준 ${t.recallAt10}`);
  if (summary.staleTop5 > t.staleTop5Max) reasons.push(`상위 5 안 낡은 조각 비율 ${summary.staleTop5.toFixed(2)} > ${t.staleTop5Max}`);
  if (baseline && baseline.recallAt10 - summary.recallAt10 >= t.regression - 1e-9) {
    reasons.push(`직전 기록 대비 재현율@10 하락 ${(baseline.recallAt10 - summary.recallAt10).toFixed(2)} ≥ ${t.regression}`);
  }
  return { pass: reasons.length === 0, reasons };
}

// src/index.ts
var corePack = { adapters: [markdownAdapter], idRules: [], idTypes: [] };

// src/cli/project.ts
import fs12 from "node:fs";
import path15 from "node:path";
var WIKI_DIR = ".wiki";
var CONFIG_FILE = "config.json";
function findWikiRoot(start) {
  let dir = path15.resolve(start);
  for (; ; ) {
    if (fs12.existsSync(path15.join(dir, WIKI_DIR, CONFIG_FILE))) return dir;
    const up = path15.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function resolveProject(opt, cwd = process.cwd()) {
  const config = str(opt.config);
  const wikiDir = str(opt["wiki-dir"]);
  const root = str(opt.root);
  if (config) return { root: path15.resolve(root ?? cwd), configPath: path15.resolve(config) };
  if (wikiDir) return { root: path15.resolve(root ?? cwd), configPath: path15.resolve(wikiDir, CONFIG_FILE) };
  const found = findWikiRoot(root ?? cwd);
  if (!found) throw new ConfigError(`위키 설정을 찾지 못했다(${path15.join(WIKI_DIR, CONFIG_FILE)}). 먼저 \`wiki-index init\` 을 한다`);
  return { root: found, configPath: path15.join(found, WIKI_DIR, CONFIG_FILE) };
}
function isBundlePath(p) {
  if (!p) return false;
  if (/\.tar\.gz$/.test(p)) return fs12.existsSync(p);
  return fs12.existsSync(path15.join(p, "manifest.json"));
}

// src/cli/build.ts
function packOf(name) {
  if (!name || name === "core") return corePack;
  throw new ConfigError(`알 수 없는 어댑터 묶음: ${name}`);
}
function ruleCounts(label, findings) {
  const n = /* @__PURE__ */ new Map();
  for (const f of findings) n.set(f.rule, (n.get(f.rule) ?? 0) + 1);
  return `${label} ${findings.length}건(${[...n].map(([r, c]) => `${r} ${c}`).join(" · ")})`;
}
var QuietSecurityError = class extends Error {
};
function runBuild(job) {
  const { cfg, repoRoot, outDir, opt, cacheDir } = job;
  const prevPath = str(opt.prev);
  const quiet = opt.quiet === true;
  let r;
  try {
    r = buildBundle(cfg, {
      repoRoot,
      pack: packOf(cfg.pack),
      profile: buildProfile(opt),
      identity: { reproducible: opt.reproducible === true, version: str(opt.version), allowDirty: cacheDir !== void 0 || opt["allow-dirty"] === true },
      prev: prevPath ? readBundle(prevPath) : void 0,
      staleCheck: opt["no-stale"] !== true,
      chunkCacheFile: str(opt["chunk-cache"]) ?? (cacheDir ? chunkCachePath(cacheDir) : void 0)
    });
  } catch (e) {
    if (quiet && e instanceof SecurityError) throw new QuietSecurityError(ruleCounts("보안 실패", e.findings));
    throw e;
  }
  writeBundleDir(outDir, r.files, r.manifest);
  const qOut = str(opt["quarantine-out"]) ?? (cacheDir ? quarantinePath(cacheDir) : void 0);
  if (qOut) writeQuarantineList(qOut, r.quarantined);
  return r;
}
function writeQuarantineList(file, quarantined) {
  fs13.mkdirSync(path16.dirname(file), { recursive: true });
  fs13.writeFileSync(file, quarantined.length ? `${quarantined.map((p) => `격리 ${p}`).join("\n")}
` : "", { mode: 384 });
  fs13.chmodSync(file, 384);
}
function writeTar(tar, files) {
  const gz = packBundle(files);
  fs13.mkdirSync(path16.dirname(path16.resolve(tar)), { recursive: true });
  fs13.writeFileSync(tar, gz);
  out(`  tar.gz ${tar} (${(gz.length / 1048576).toFixed(1)} MB)`);
}
function reportBuild(r, outDir, quiet = false) {
  let size = 0;
  for (const b of r.files.values()) size += b.length;
  const m = r.manifest;
  out(`묶음 ${m.name} ${m.version} → ${outDir}${m.dirty ? " (미커밋 변경 포함 — dirty)" : ""}`);
  out(`  조각 ${m.counts.chunks} · 페이지 ${m.counts.pages} · 간선 ${m.counts.edges} · 끊긴 링크 ${m.counts.broken} · 낡음 후보 ${m.counts.staleCandidates}`);
  out(`  다시 나눈 문서 ${r.chunking.chunked} · 그대로 쓴 문서 ${r.chunking.reused}${r.quarantined.length ? ` · 격리 ${r.quarantined.length}편` : ""}`);
  out(`  파일 ${r.files.size}개 · 합계 ${(size / 1048576).toFixed(1)} MB · 걸린 시간 ${r.timings.total} ms (${Object.entries(r.timings).map(([k, v]) => `${k} ${v}`).join(" · ")})`);
  if (quiet) {
    if (r.findings.length) err(`  ${ruleCounts("경고", r.findings)}`);
    if (r.warnings.length) err(`  경고 줄 ${r.warnings.length}`);
  } else {
    for (const f of r.findings) err(`  경고 ${f.rule} ${f.path}:${f.line} ${f.excerpt}`);
    for (const w of r.warnings) err(`  경고 ${w}`);
  }
  if (r.stale) out(`  낡음 판정: 판정 불가 ${r.stale.unverifiable} · 근거 없는 문서 ${r.stale.noAnchorDocs} · 근거 확인 불가 ${r.stale.unverifiableAnchors}${r.stale.warnings.length ? ` · 경고 줄 ${r.stale.warnings.length}` : ""}`);
}
async function buildProject(opt, force) {
  const project = resolveProject(opt);
  const ctx = rootContext(project.root, project.configPath);
  let result = null;
  const job = { cfg: ctx.cfg, repoRoot: ctx.worktree, outDir: nextBundleDir(ctx.cacheDir), opt, cacheDir: ctx.cacheDir };
  await refreshIndex(ctx, () => result = runBuild(job), { force });
  return { result, bundleDir: path16.join(ctx.cacheDir, "bundle") };
}
async function cmdBuild(_pos, opt) {
  const outDir = str(opt.out);
  if (!outDir) {
    const { result, bundleDir: bundleDir2 } = await buildProject(opt, opt.force === true || !opt["if-changed"]);
    if (result) reportBuild(result, bundleDir2, opt.quiet === true);
    else out(`색인이 최신이다 → ${bundleDir2}`);
    return 0;
  }
  const cfgPath = str(opt.config);
  if (!cfgPath) throw new UsageError("build --out 에는 --config 가 필요하다(프로젝트 색인은 --out 없이 build)");
  const r = runBuild({ cfg: loadConfig(cfgPath), repoRoot: path16.resolve(str(opt.root) ?? process.cwd()), outDir, opt });
  reportBuild(r, outDir, opt.quiet === true);
  const tar = str(opt.tar);
  if (tar) writeTar(tar, r.files);
  return 0;
}
function checkPagesSecurity(files, profile, security) {
  let failed = false;
  for (const [name, data] of files) {
    if (!name.startsWith("pages/")) continue;
    for (const f of scanText(data.toString("utf8"), name.slice(6), profile, security)) {
      if (f.severity === "fail") failed = true;
      err(`보안 ${f.severity === "fail" ? "실패" : "경고"} ${f.rule} ${f.path}:${f.line} ${f.excerpt}`);
    }
  }
  return failed;
}
function cmdCheck(pos, opt) {
  const files = readBundle(pos[0] ?? "");
  const v = verifyBundle(files);
  let failed = !v.ok;
  for (const i of v.issues) err(`형식 ${i.code}: ${i.message}`);
  if (v.ok && v.manifest) {
    const profile = str(opt.profile) ?? v.manifest.profile;
    if (checkPagesSecurity(files, profile, v.manifest.security ?? {})) failed = true;
    const links = JSON.parse(files.get("links.json").toString("utf8"));
    for (const b of links.broken.slice(0, 50)) err(`끊긴 링크 ${b[0]} → ${b[1]}`);
    if (links.broken.length > 50) err(`끊긴 링크 ${links.broken.length - 50}건 더 있음`);
    if (opt.strict === true && links.broken.length) failed = true;
    out(`검사 ${failed ? "실패" : "통과"}: 형식 ${v.ok ? "맞음" : "틀림"} · 끊긴 링크 ${links.broken.length} · 낡음 ${v.manifest.counts.stale} · 낡음 후보 ${v.manifest.counts.staleCandidates}`);
  }
  return failed ? 1 : 0;
}

// src/cli/eval.ts
import fs14 from "node:fs";

// src/cli/query.ts
function openBundleIndex(p) {
  if (!p) throw new UsageError("묶음 경로가 없다");
  return new WikiIndex(readBundle(p));
}
async function openProject(opt) {
  if (opt["no-refresh"] !== true) {
    const { result } = await buildProject({ ...opt, quiet: true }, false);
    if (result) err(`색인 새로 고침 · 다시 나눈 문서 ${result.chunking.chunked} · 그대로 쓴 문서 ${result.chunking.reused}`);
  }
  const project = resolveProject(opt);
  return new WikiIndex(readBundle(bundleDir(rootContext(project.root, project.configPath).cacheDir)));
}
async function queryTarget(pos, opt) {
  const root = str(opt.root);
  if (root !== void 0 && str(opt.config) !== void 0) {
    if (opt.bundle !== void 0) throw new UsageError("--bundle 과 --root 는 함께 줄 수 없다");
    return { index: (await openRoot(root, str(opt.config), err)).index, rest: pos };
  }
  if (isBundlePath(pos[0])) return { index: openBundleIndex(pos[0]), rest: pos.slice(1) };
  return { index: await openProject(opt), rest: pos };
}
function capOf(index2, v) {
  return str(v) ? parseLevel(str(v)) : index2.manifest.maxLevel;
}
async function cmdSearch(pos, opt) {
  const scope = areaScope(opt);
  const { index: index2, rest } = await queryTarget(pos, opt);
  const q = rest.join(" ");
  if (!q) throw new UsageError("질의가 없다");
  const r = index2.search({
    q,
    cap: capOf(index2, opt.level),
    kinds: list(opt.kind),
    ...scope,
    excludeStale: opt["exclude-stale"] === true,
    limit: Number(str(opt.limit) ?? 10)
  });
  if (opt.json === true) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  r.hits.forEach((h, i) => {
    out(`${String(i + 1).padStart(2)}. ${h.id}  (${h.score})${h.stale ? ` [${h.stale.state}]` : ""}`);
    out(`    ${h.titlePath.join(" › ")}`);
    out(`    ${h.snippet}`);
  });
  out(`합계 ${r.total} · 등급으로 뺀 조각 ${r.filteredCount}`);
  return 0;
}
async function cmdRead(pos, opt) {
  const scope = areaScope(opt);
  const { index: index2, rest } = await queryTarget(pos, opt);
  if (!rest[0]) throw new UsageError("ID 가 없다");
  const r = index2.read(rest[0], { cap: capOf(index2, opt.level), context: opt.context === true, ...scope });
  if (isError(r)) {
    err(`${r.error}: ${r.id}`);
    return 1;
  }
  out(JSON.stringify(r, null, 2));
  return 0;
}
async function cmdBacklinks(pos, opt) {
  const scope = areaScope(opt);
  const { index: index2, rest } = await queryTarget(pos, opt);
  if (!rest[0]) throw new UsageError("대상이 없다");
  const kinds = list(opt.kind);
  out(JSON.stringify(index2.backlinks(rest[0], { cap: capOf(index2, opt.level), kinds, limit: Number(str(opt.limit) ?? 20), ...scope }), null, 2));
  return 0;
}

// src/cli/eval.ts
function loadChunks(p) {
  return readBundle(p ?? "").get("chunks.jsonl").toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function cmdDiff(pos, opt) {
  const d = diffChunks(loadChunks(pos[0]), loadChunks(pos[1]));
  if (opt.json === true) out(JSON.stringify(d, null, 2));
  else out(`더해짐 ${d.added.length} · 바뀜 ${d.changed.length} · 빠짐 ${d.removed.length} · 옮김 ${d.moved.length} · 낡음 변화 ${d.staleChanged.length}`);
  return 0;
}
function loadBaseline(basePath) {
  return basePath && fs14.existsSync(basePath) ? JSON.parse(fs14.readFileSync(basePath, "utf8")).summary : null;
}
function evaluateOrReport(index2, qf, cap) {
  try {
    return evaluate(index2, qf, cap);
  } catch (e) {
    if (!(e instanceof GoldUnresolvedError)) throw e;
    err(`gold_unresolved: ${e.ids.join(", ")} — 정답 안정 키(원천 경로 · 절 제목)를 지금 원고에 맞게 고친다`);
    return null;
  }
}
function printEval(res, reasons) {
  for (const r of res.results) out(`${r.id.padEnd(6)} ${r.inScope ? r.rank ? `순위 ${r.rank}` : "놓침" : "범위 밖"}  ${r.q}`);
  const s = res.summary;
  out(`재현율@5 ${s.recallAt5.toFixed(2)} · 재현율@10 ${s.recallAt10.toFixed(2)} · MRR ${s.mrr.toFixed(3)} · 상위 5 낡음 ${s.staleTop5.toFixed(2)} · 낡음 후보 ${s.staleCandidateTop5.toFixed(2)} (대상 ${s.inScope}/${s.questions})`);
  for (const r of reasons) err(`실패 사유: ${r}`);
}
function cmdEval(pos, opt) {
  const index2 = openBundleIndex(pos[0]);
  const qPath = str(opt.questions);
  if (!qPath) throw new UsageError("--questions 가 필요하다");
  const qf = JSON.parse(fs14.readFileSync(qPath, "utf8"));
  const basePath = str(opt.baseline);
  const res = evaluateOrReport(index2, qf, capOf(index2, opt.level));
  if (!res) return 2;
  const verdict = judge(res.summary, qf, loadBaseline(basePath));
  printEval(res, verdict.reasons);
  const record = { bundle: { name: index2.manifest.name, version: index2.manifest.version, commit: index2.manifest.commit }, summary: res.summary, results: res.results };
  const outFile = str(opt.out);
  if (outFile) fs14.writeFileSync(outFile, stableJson(record, 2) + "\n");
  if (opt["update-baseline"] === true) {
    if (!basePath) throw new UsageError("--update-baseline 에는 --baseline 경로가 필요하다");
    fs14.writeFileSync(basePath, stableJson({ bundle: record.bundle, summary: res.summary }, 2) + "\n");
    out(`회귀선 갱신: ${basePath}`);
  }
  return verdict.pass ? 0 : 1;
}

// src/cli/init.ts
import path18 from "node:path";

// src/init/files.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function gitFiles(root) {
  try {
    const raw = execFileSync2("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return raw.split("\0").filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT" || e.status !== void 0) return null;
    throw e;
  }
}
function listRepoFiles(root) {
  return gitFiles(root) ?? walkFiles(root, "");
}

// src/init/write.ts
import fs15 from "node:fs";
import path17 from "node:path";

// src/init/project-doc.ts
function sourceRows(plan) {
  return plan.sources.map((s) => `| \`${s.name}\` | ${s.include.map((g) => `\`${g}\``).join(" ")} | ${s.area ? `\`${s.area}\`` : "—"} | ${s.files} |`).join("\n");
}
function projectDoc(plan, relWiki) {
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
`;
}

// src/init/write.ts
var PROJECT_DOC = ".claude/skills-config/project-wiki.md";
function writeIfMissing(file, body) {
  if (fs15.existsSync(file)) return "kept";
  fs15.mkdirSync(path17.dirname(file), { recursive: true });
  fs15.writeFileSync(file, body);
  return "created";
}
function ensureIgnoreLine(file, line) {
  const text = fs15.existsSync(file) ? fs15.readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return "kept";
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  fs15.writeFileSync(file, `${text}${sep}# project-wiki 색인(다시 만들 수 있는 생성물)
${line}
`);
  return text ? "appended" : "created";
}
var isInside = (root, p) => {
  const rel = path17.relative(root, p);
  return rel === "" || !rel.startsWith("..") && !path17.isAbsolute(rel);
};
function writeInitFiles(root, wikiDir, plan) {
  const configPath = path17.join(wikiDir, "config.json");
  const actions = [{ path: configPath, action: writeIfMissing(configPath, stableJson(plan.config, 2) + "\n") }];
  if (!isInside(root, wikiDir)) return actions;
  const relWiki = path17.relative(root, wikiDir).split(path17.sep).join("/");
  const gitignore = path17.join(root, ".gitignore");
  actions.push({ path: gitignore, action: ensureIgnoreLine(gitignore, `${relWiki}/index/`) });
  const doc = path17.join(root, PROJECT_DOC);
  actions.push({ path: doc, action: writeIfMissing(doc, projectDoc(plan, relWiki)) });
  return actions;
}

// src/cli/init.ts
function cmdInit(_pos, opt) {
  const root = path18.resolve(str(opt.root) ?? process.cwd());
  const wikiDir = path18.resolve(str(opt["wiki-dir"]) ?? path18.join(root, WIKI_DIR));
  const plan = planWiki(path18.basename(root), listRepoFiles(root));
  const actions = writeInitFiles(root, wikiDir, plan);
  if (opt.json === true) {
    out(JSON.stringify({ root, wikiDir, sources: plan.sources, actions }, null, 2));
    return 0;
  }
  out(`위키 ${plan.config.bundle.name} · 저장소 ${root}`);
  for (const s of plan.sources) out(`  원천 ${s.name.padEnd(14)} ${s.include.join(" ")}${s.area ? ` · 영역 ${s.area}` : ""} · 문서 ${s.files}`);
  if (!plan.sources.length) out("  Markdown 문서를 찾지 못했다. config.json 의 sources 를 직접 적는다");
  const label = { created: "만듦", kept: "그대로 둠(이미 있음)", appended: "줄 더함" };
  for (const a of actions) out(`  ${label[a.action]} ${a.path}`);
  out("다음: build 로 색인을 만든다");
  return 0;
}

// src/cli/serve.ts
async function cmdServeMcp(_pos, opt) {
  const scope = areaScope(opt);
  if (opt.bundle !== void 0) {
    if (opt.root !== void 0) throw new UsageError("--bundle 과 --root 는 함께 줄 수 없다");
    const index2 = openBundleIndex(str(opt.bundle));
    const cap = capOf(index2, opt.level);
    const areas = scope.areas ? ` · 영역 ${scope.areas.join(",")}` : "";
    const excluded = scope.excludeAreas ? ` · 뺀 영역 ${scope.excludeAreas.join(",")}` : "";
    err(`wiki-index MCP: ${index2.manifest.name} ${index2.manifest.version} · 등급 상한 ${cap}${areas}${excluded}`);
    await serveStdio(index2, { cap, ...scope });
    return 0;
  }
  const project = resolveProject(opt);
  await serveRoot({ root: project.root, config: project.configPath, level: str(opt.level), ...scope, log: err });
  return 0;
}

// src/cli/stale.ts
function configAndRoot(opt) {
  const project = resolveProject(opt);
  return { cfg: loadConfig(project.configPath), cfgPath: project.configPath, repoRoot: project.root };
}
function readUnitsAndLinks(cfg, repoRoot) {
  const sources = readSources(cfg, repoRoot, packOf(cfg.pack));
  return { units: sources.flatMap((s) => s.units), links: [...new Set(sources.flatMap((s) => s.out.links ?? []))].sort(cmp) };
}
function applyBaseline(cfg, cfgPath, report, opt) {
  const accept = many(opt["accept-new"]);
  const write = opt["update-baseline"] === true || accept.length > 0;
  const file = baselinePath(cfg, cfgPath, opt["require-baseline"] === true);
  if (!file) {
    if (write) throw new UsageError("--update-baseline · --accept-new 에는 설정의 noStatusBaseline 이 필요하다");
    return;
  }
  lockNoStatus(report, write ? updateBaseline(file, report, accept, err) : readBaseline(file));
}
function printStale(report) {
  for (const b of report.block) out(`차단 ${b.id}  ${b.title} — ${b.reason}`);
  const gone = report.noStatusGone ? ` · 기준 목록에서 빠진 문서 ${report.noStatusGone}` : "";
  out(`출하 차단 ${report.block.length} · 경고 ${report.warn} · 판정 불가 ${report.unverifiable} · 근거 없는 문서 ${report.noAnchorDocs} · 근거 확인 불가 ${report.unverifiableAnchors} · 상태를 읽지 못한 결정 · 정책 문서 ${report.noStatusDocs}${gone}`);
}
function cmdStale(_pos, opt) {
  const { cfg, cfgPath, repoRoot } = configAndRoot(opt);
  const { units, links } = readUnitsAndLinks(cfg, repoRoot);
  const { report } = judgeStale(units, gitRunner(repoRoot));
  countLinks(links, report);
  applyBaseline(cfg, cfgPath, report, opt);
  if (opt.json === true) out(JSON.stringify(staleJson(report), null, 2));
  else printStale(report);
  for (const w of report.warnings) err(`경고 ${w}`);
  return report.block.length ? 1 : 0;
}
function cmdMarkSynced(pos, opt) {
  const { cfg, repoRoot } = configAndRoot(opt);
  if (!pos.length) throw new UsageError("mark-synced 에 문서 경로가 없다");
  const head = gitRunner(repoRoot)(["rev-parse", "HEAD"]);
  const sha = head.out.trim();
  if (head.code !== 0 || !sha) throw new ConfigError("HEAD 커밋을 읽지 못했다(git 저장소인지 확인한다)");
  const units = readUnitsAndLinks(cfg, repoRoot).units;
  const written = markSynced({ repoRoot, paths: pos, units, pack: packOf(cfg.pack), head: sha });
  for (const rel of written) out(`기준 커밋 ${sha.slice(0, 10)} → ${rel}`);
  return 0;
}

// src/cli/main.ts
var USAGE = `wiki-index <명령> [옵션]

프로젝트 모드(옵션 없이): 지금 폴더에서 위로 .wiki/config.json 을 찾아 쓴다. --wiki-dir <폴더> 나 --config <파일> 로 바꾼다.

  init       [--root <저장소>] [--wiki-dir <폴더>] [--json]     문서 폴더를 찾아 설정을 만든다(있으면 덮어쓰지 않는다)
  build      [--if-changed] [--quiet]                           프로젝트 색인(.wiki/index/)을 만든다
  build      --config <설정.json> --out <폴더> [--root <저장소>] [--tar <파일.tar.gz>] [--profile server|local]
             [--reproducible] [--version <버전>] [--prev <이전 묶음>] [--no-stale] [--allow-dirty] [--quiet]
             [--quarantine-out <파일>] [--chunk-cache <파일>]
  search     [<묶음>] <질의> [--level <등급>] [--kind section,figure] [--area <영역,…> | --exclude-area <영역,…>] [--exclude-stale] [--limit <n>] [--json] [--no-refresh]
  read       [<묶음>] <ID> [--level <등급>] [--context] [--area … | --exclude-area …] [--no-refresh]
  backlinks  [<묶음>] <대상 ID | code:경로> [--level <등급>] [--kind ref,evidence,…] [--limit <n>] [--area … | --exclude-area …] [--no-refresh]
  stale      [--config <설정.json>] [--root <저장소>] [--json] [--require-baseline] [--update-baseline] [--accept-new <경로>]…
             (종료 코드: 출하 차단 0건 0 · 1건 이상 1)
  mark-synced [--config <설정.json>] <문서 경로…>               문서의 기준 커밋 칸을 HEAD 로 쓴다(커밋하지 않는다)
  serve-mcp  [--bundle <묶음>] [--level <등급>] [--area <영역,…> | --exclude-area <영역,…>]   표준 입출력 MCP 서버
  check      <묶음> [--strict] [--profile server|local]
  diff       <옛 묶음> <새 묶음> [--json]
  eval       <묶음> --questions <파일.json> [--level <등급>] [--baseline <파일.json>] [--update-baseline] [--out <결과.json>]

<묶음> 은 묶음 폴더(manifest.json 이 있는 폴더) 또는 tar.gz 파일이다. --root <작업 트리> --config <설정> 을 주면 작업 트리 모드다.
등급: public · internal · confidential(공개 · 사내 · 대외비). 등급을 주지 않으면 묶음의 상한(manifest.maxLevel)을 쓴다.`;
var COMMANDS = {
  init: cmdInit,
  build: cmdBuild,
  check: cmdCheck,
  search: cmdSearch,
  read: cmdRead,
  backlinks: cmdBacklinks,
  diff: cmdDiff,
  eval: cmdEval,
  "serve-mcp": cmdServeMcp,
  stale: cmdStale,
  "mark-synced": cmdMarkSynced
};
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "help") {
    out(USAGE);
    return cmd ? 0 : 2;
  }
  const { pos, opt } = parseArgs(rest);
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : void 0;
  if (!run) throw new UsageError(`알 수 없는 명령: ${cmd}`);
  return run(pos, opt);
}
var INPUT_ERRORS = [UsageError, ConfigError, BaselineError, MarkSyncedError, TarError, SyntaxError];
function exitCodeOf(e) {
  if (e instanceof IndexNotReadyError) {
    err(e.message);
    return e.exitCode;
  }
  if (e instanceof QuietSecurityError) {
    err(e.message);
    return 1;
  }
  if (e instanceof SecurityError) {
    for (const f of e.findings) err(`보안 실패 ${f.rule} ${f.path}:${f.line} ${f.excerpt}`);
    err(`${e.message}. 비밀값이 든 문서만 빼려면 설정의 security.onSecret 을 "quarantine" 으로 둔다`);
    return 1;
  }
  if (e instanceof DirtyError) {
    for (const p of e.paths.slice(0, 20)) err(`  미커밋 ${p}`);
    err(`오류: ${e.message}`);
    return 2;
  }
  if (INPUT_ERRORS.some((c) => e instanceof c)) {
    err(`오류: ${e.message}`);
    if (e instanceof UsageError) err(USAGE);
    return 2;
  }
  err(`오류: ${e?.stack ?? String(e)}`);
  return 2;
}
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.exitCode = exitCodeOf(e);
  }
);
