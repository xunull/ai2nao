# Changelog

## 0.3.1 — 2026-04-25

### Added

- Mirror VS Code recently opened files, folders, and workspaces from `state.vscdb` into the local index.
- Add the `/vscode` web page with recent project aggregation, raw entry inspection, filters, and guarded sync.
- Add `ai2nao vscode sync`, `ai2nao vscode status`, `ai2nao vscode reset`, and `ai2nao vscode windows` for VS Code work context workflows.
- Add safe remote workspace summaries that hash remote authority and path values before storage or display.
- Document useful `state.vscdb` signals and privacy boundaries for future VS Code work-context features.

### Changed

- Share bounded list query parsing between software inventory routes and the new VS Code routes.
- Extend the local database schema for VS Code recent work entries and sync state.

## 0.3.0 — 2026-04-24

### Added

- Analyze Chrome browsing history by domain with summary counts, top-domain ranking, day/week/month timelines, and drilldown to the exact visited URLs.
- Add a rebuildable Chrome domain pivot table with freshness state, rule version tracking, source/derived row counts, and explicit rebuild errors.
- Add `chrome-history domains rebuild` for manually rebuilding the domain analysis layer.
- Add tests for URL normalization, domain pivot freshness, domain API routes, and URL-backed domain filters.

### Changed

- Rebuild the Chrome domain pivot after Chrome History sync, while keeping raw history sync results even if the derived analysis rebuild fails.
- Move Chrome History and Chrome Downloads API routes into a dedicated route module so the server app stays thinner.

## 0.2.0 — 2026-04-24

### Added

- Mirror installed macOS applications into the local SQLite index, including bundle IDs, names, versions, paths, sync runs, reset support, and Web UI browsing.
- Mirror installed Homebrew formulae and casks into the local SQLite index, preserving `brew info --json=v2 --installed` metadata when available and falling back to `brew list` with partial sync status.
- Add grouped Web navigation for local inventory, browser traces, conversations, and code views.
- Add npm scripts for the new software inventory commands: `apps:sync`, `apps:reset`, `brew:sync`, and `brew:reset`.

### Changed

- Extend the main API server with `/api/apps/*` and `/api/brew/*` endpoints, including pagination and strict query validation.
- Document software inventory usage and the current boundaries around Brewfile export and App/Cask association.

## 0.1.1 — 2026-04-23

### Added

- Browse Claude Code local conversation history: scan `~/.claude/projects`, list projects and sessions, load JSONL transcripts via `/api/claude-code-history/*` and the **Claude 对话** web UI.
- Heuristic decoding of Claude project directory slugs to workspace paths (with tests).
- Upgrade **AI 对话** to `assistant-ui` with markdown rendering, local RAG controls, retry/copy actions, and bottom-anchored message layout.
