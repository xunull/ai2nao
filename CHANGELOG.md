# Changelog

## 0.3.4 — 2026-04-29

### Added

- Add a Hugging Face local model inventory that scans the local Hub cache, records downloaded model snapshots, refs, revision file counts, warning states, and deduplicated blob sizes.
- Add `ai2nao huggingface sync` plus `/api/huggingface/status`, `/api/huggingface/models`, and `/api/huggingface/sync` so the inventory can be refreshed explicitly without background filesystem scans.
- Add the `/huggingface-models` Web UI with cache-root filtering, model search, missing-model visibility, pagination, revision chips, modified dates, sync status, warning display, and local disk-usage summaries.
- Add regression coverage for Hugging Face cache root resolution, cache scanning, sync state, API behavior, and the Web UI.

### Changed

- Generalize local inventory sync state and sync-run tracking so macOS apps, Homebrew packages, and Hugging Face models share the same run history infrastructure.

## 0.3.3 — 2026-04-26

### Added

- Add `/codex-history` so users can browse local Codex threads from `~/.codex/state_5.sqlite` and open the matching rollout JSONL transcripts.
- Add Codex conversation detail replay with message timelines, compact tool rows, failed command highlighting, and summary counts for tools, commands, failures, and touched files.
- Add Codex filters for cwd, branch, model, and archived threads, with archived threads hidden by default.
- Add diagnostics for degraded Codex metadata, including SQLite fallback state, missing transcripts, schema mismatch, scan truncation, and safe error kinds.
- Add backend, API, and React regression tests for Codex history loading, fallback behavior, diagnostics, filters, archived toggles, and failed tool display.

### Changed

- Share local JSONL parsing between Claude Code and Codex readers so corrupt-line handling stays consistent across local AI transcript sources.
- Extend the shared chat DTO with `source: "codex"` and source-specific metadata while keeping Cursor and Claude Code fields stable.

## 0.3.2 — 2026-04-26

### Added

- Add `/cursor-projects` so users can view Cursor recently opened projects with Cursor-specific status, filters, sync, and empty-state copy.
- Add `ai2nao cursor projects status`, `ai2nao cursor projects sync`, and `ai2nao cursor projects reset` so Cursor users do not need to know the internal VS Code app flag.
- Add app-isolation coverage for Cursor project queries, routes, sync failures, destructive reset, and CLI wrappers.

### Changed

- Reuse the VS Code recent-project UI through a shared editor recent page so VS Code and Cursor stay behaviorally aligned.
- Make VS Code-family reset app-scoped and preserve the shared remote privacy salt, preventing Cursor cleanup from disturbing Code remote identifiers.
- Use editor-aware labels in recent-list sync warnings and route errors so Cursor failures no longer speak in VS Code copy.

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
