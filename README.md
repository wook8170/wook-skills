# wook-skills

English | [한국어](README.ko.md)

Eleven Claude Code skills for day-to-day engineering work, packaged as one plugin. Most skill bodies are written in Korean.

- Version: **0.1.2**
- License: MIT · Author: 장욱 (Wook Jang)

## Skills

Claude loads a skill on its own when your request matches the skill's description. You can also call one directly with `/wook-skills:<name>`.

| Skill | What it does | How to call it |
|---|---|---|
| `handoff` | Commits work in progress, moves finished history to `docs/progress-archive/`, rewrites `progress.md` as a short current-state file with exact resume commands, then stops | 「핸드오프」, "handoff", or `/wook-skills:handoff` |
| `pickup` | Reads the latest `progress.md` handoff, checks git, worktree and server state, flags stale items, and summarizes before doing anything | 「이어받아」, "pickup", or `/wook-skills:pickup` |
| `work-status` | Read-only status view: main and tags, gate stamp, worktrees, unmerged branches, open PRs, running servers, heavy background jobs | 「현황」, "status", or `/wook-skills:work-status` |
| `code-structure-guard` | Size and complexity limits for new code, readability rules (separate decision from action, split by feature, names and comments, a first-time-reader check), layer direction, no new cycles or empty `catch`, and how to set up a ratchet check | While writing code, or `/wook-skills:code-structure-guard` |
| `project-wiki` | Builds a section-level wiki index of a repo's docs, design notes, decision records and runbooks (`init` → `build`), then answers doc questions from that index first (`search` → `read` → `backlinks`). Docs whose evidence files changed get a stale mark. Ships a zero-dependency indexer (`bin/wiki-index.mjs`) and an MCP server | 「위키 만들어」, "what does the design doc say", "why did we do this", or `/wook-skills:project-wiki` |
| `readable-korean` | Finds and fixes four patterns that make Korean text hard to read | 「문장 다듬어」, "proofread", or `/wook-skills:readable-korean` |
| `design-deliverables` | Builds and keeps current a set of design documents: generated chapters, requirement IDs, traceability, screen design specs | 「설계 산출물」, 「현행화」, or `/wook-skills:design-deliverables` |
| `pdf-typeset` | Typesets Markdown or HTML into A4 PDF with table of contents, links and bookmarks, figure scaling, landscape pages, and diagrams | 「PDF 만들기」, "make a PDF", or `/wook-skills:pdf-typeset` |
| `glossary` | Sets up a term dictionary with a term check and ratchet for UI copy, manuals and docs | 「용어 사전」, 「금지어 검사」, or `/wook-skills:glossary` |
| `retina-capture` | Takes screen captures at 2x: offscreen AppKit recipe, headless Chrome and CDP options | 「캡처」, "screenshot", or `/wook-skills:retina-capture` |
| `ui-stability-harness` | A browser harness that walks every screen and checks layout, layering, focus, contrast and stale-serve invariants, with templates | 「UI 안정성」, or `/wook-skills:ui-stability-harness` |

## Install

```bash
claude plugin marketplace add wook8170/claude-plugins
claude plugin install wook-skills@wook8170-plugins
```

If the same skills already exist in `~/.claude/skills/`, remove or rename the personal copies first. Otherwise both copies are loaded.

## Using project-wiki

The indexer is one file, `skills/project-wiki/bin/wiki-index.mjs`. It needs Node 22 or later and nothing else. Run it from anywhere inside a repo:

```bash
node <skill folder>/bin/wiki-index.mjs init     # find doc folders, write .wiki/config.json, add .wiki/index/ to .gitignore
node <skill folder>/bin/wiki-index.mjs build    # build the index into .wiki/index/ (do not commit it)
node <skill folder>/bin/wiki-index.mjs search "cache decision"
node <skill folder>/bin/wiki-index.mjs read docs-adr:0001-cache#decision
node <skill folder>/bin/wiki-index.mjs backlinks docs-adr:0001-cache
node <skill folder>/bin/wiki-index.mjs stale    # exit 1 if a current decision or policy doc has changed evidence
```

`search`, `read` and `backlinks` re-chunk only the changed docs before answering when the sources changed since the last build. Docs that contain secrets are left out of the index (`security.onSecret: "quarantine"`), and only their paths go to `.wiki/index/quarantine.txt`. To use the wiki as MCP tools (`wiki_search`, `wiki_read`, `wiki_backlinks`), add `serve-mcp --root ${CLAUDE_PROJECT_DIR}` to `.mcp.json`; see `skills/project-wiki/SKILL.md`. Settings are described in `skills/project-wiki/reference/config.md`.

The TypeScript source is in `skills/project-wiki/src/`. Rebuild the bundled file with `node skills/project-wiki/scripts/build-wiki-index.mjs` and run the tests with `node --test skills/project-wiki/test/*.test.ts`.

## Project settings

Some skills need values that differ per project, such as the gate stamp name, the structure check command, the numbering of a document set, or the map of PDF builders. Put them in a file named after the skill:

```
<project>/.claude/skills-config/<skill name>.md
```

Every `SKILL.md` starts with a line that tells Claude to read this file first. If the file does not exist, the skill uses its built-in defaults and general procedure.

| Skill | Values that usually go in the settings file |
|---|---|
| `work-status` | `gate-stamp` (stamp file name inside the git common dir, default `gate-pass`) and `ports` (server ports to check, default `3000 4173 5173 5174 8000 8080`). The script reads lines in the form ``- `gate-stamp`: `name` `` |
| `code-structure-guard` | Ratchet commands, paths in scope, exception folders, baseline counts, logger location |
| `project-wiki` | Wiki location, commands, MCP server name, sources, level and area options, how to treat stale marks. `init` writes it for you; repos with their own indexer list their own commands |
| `design-deliverables` | Document set location, volume numbering, generator commands, known pitfalls |
| `pdf-typeset` | Builder map (builder, input, output, method), commands, checks, storage rules, landscape table support |
| `ui-stability-harness` | Adapter values (selectors, storage keys, ID prefixes) and the project's own case notes |

The other skills read the file too when it exists. Settings files are plain Markdown, so a project can keep them in version control next to its code.

## Layout

```
.claude-plugin/plugin.json
skills/<skill name>/SKILL.md      # plus reference/, references/, templates/, scripts/ where needed
skills/project-wiki/bin/          # bundled indexer (generated from src/, do not edit by hand)
skills/project-wiki/src/ · test/  # indexer source and tests
```

Scripts are referenced relative to the skill folder, which Claude Code shows as the base directory when it loads a skill.
