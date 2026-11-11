# wook-skills

English | [한국어](README.ko.md)

Ten Claude Code skills for day-to-day engineering work, packaged as one plugin. Most skill bodies are written in Korean.

- Version: **0.1.0**
- License: MIT · Author: 장욱 (Wook Jang)

## Skills

Claude loads a skill on its own when your request matches the skill's description. You can also call one directly with `/wook-skills:<name>`.

| Skill | What it does | How to call it |
|---|---|---|
| `handoff` | Commits work in progress, moves finished history to `docs/progress-archive/`, rewrites `progress.md` as a short current-state file with exact resume commands, then stops | 「핸드오프」, "handoff", or `/wook-skills:handoff` |
| `pickup` | Reads the latest `progress.md` handoff, checks git, worktree and server state, flags stale items, and summarizes before doing anything | 「이어받아」, "pickup", or `/wook-skills:pickup` |
| `work-status` | Read-only status view: main and tags, gate stamp, worktrees, unmerged branches, open PRs, running servers, heavy background jobs | 「현황」, "status", or `/wook-skills:work-status` |
| `code-structure-guard` | Size and complexity limits for new code, layer direction, no new cycles or empty `catch`, and how to set up a ratchet check | While writing code, or `/wook-skills:code-structure-guard` |
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
| `design-deliverables` | Document set location, volume numbering, generator commands, known pitfalls |
| `pdf-typeset` | Builder map (builder, input, output, method), commands, checks, storage rules, landscape table support |
| `ui-stability-harness` | Adapter values (selectors, storage keys, ID prefixes) and the project's own case notes |

The other skills read the file too when it exists. Settings files are plain Markdown, so a project can keep them in version control next to its code.

## Layout

```
.claude-plugin/plugin.json
skills/<skill name>/SKILL.md      # plus reference/, references/, templates/, scripts/ where needed
```

Scripts are referenced relative to the skill folder, which Claude Code shows as the base directory when it loads a skill.
