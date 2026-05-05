# Changelog

## 0.3.11 — 2026-05-04

### Changed

- Move the Chrome domain time matrix into its own page tab so visit filtering and timeline analysis no longer compete in the same workspace.
- Use a consistent PC-wide workspace width across the Web UI so switching pages no longer jumps between narrow and wide layouts.
- Reshape the Chrome domain page into a desktop workbench with a light toolbar, left domain index, right current-domain workspace, and global stats folded into secondary details.
- Treat the highest-ranked domain as the default working object without rewriting the URL, while keeping explicit all-domain scope addressable with `scope=all`.
- Add a desktop workbench design guide and align the next GitHub radar design plan with the same left-index/right-workspace structure.
- Reshape GitHub radar into the same desktop workbench pattern with a left clue/queue index and a right-side current clue or review queue workspace.
- Add `.gstack/` to local ignores so ship/design artifacts stay out of the repository.

### Fixed

- Fix Chrome domain ranking clicks so each clicked domain replaces the active visit filter instead of appending behind the first selected domain.
- Add regression coverage for repeatedly selecting different Chrome domain ranking rows.

## 0.3.10 — 2026-05-04

### Added

- Add Chrome History domain search controls for filtering visits by domain and URL or title keyword.
- Add a one-click WeChat article filter for `mp.weixin.qq.com` visits, including literal `__biz` query matching.
- Add regression coverage for domain URL state, WeChat filtering, literal LIKE matching, manual domain entry, and visit row rendering.

### Changed

- Rework `/chrome-history/domains` into a PC-focused workbench with search and visit results first, and domain ranking plus the time matrix as supporting analysis.
- Document that this project only targets PC desktop usage, so UI layout decisions should optimize desktop information density rather than mobile access.

## 0.3.9 — 2026-05-04

### Added

- Add an insight-first GitHub radar that connects starred repositories to indexed local project context, including TODOs, docs, README files, manifests, current git branch, and recent commits.
- Add local radar insight snapshots, safe evidence payloads, and feedback controls so users can refresh clues, inspect matched terms, and tune useful, wrong, later, or ignored recommendations.
- Add bounded project context indexing for `ai2nao scan`, including root TODO files and markdown docs under `docs/`, while keeping refreshes fast and local-index based.
- Add regression coverage for radar insight generation, refresh failure behavior, indexed project context, feedback suppression, API routes, and the insight-first Web UI.
- Document the new radar sensemaking workflow and explain that global project context comes from `ai2nao scan --root <workspace>`.

### Changed

- Rework `/github/radar` around current clues, evidence drawers, rediscovered repositories, retire candidates, and a compact legacy radar queue instead of making note maintenance the primary workflow.
- Upgrade radar freshness fingerprints to track indexed project context separately from current git context.
- Keep radar evidence safe by returning labels and matched terms instead of raw local document excerpts or absolute filesystem paths.

## 0.3.8 — 2026-05-02

### Added

- Add the GitHub open-source radar so users can turn starred repositories into local review queues grouped by topic, freshness, and action status.
- Add local-only star notes with collection reason, review status, and last-reviewed timestamps without writing anything back to GitHub.
- Add `/api/github/radar`, `/api/github/radar/notes/:repo_id`, and the `/github/radar` Web UI for radar metrics, clusters, queues, and note editing.
- Add regression coverage for radar schema migration, note validation, queue signals, API errors, and Web save behavior.
- Document the radar design, data model, signals, API, UI, and v1 boundaries in `docs/github-open-source-radar.md`.

### Changed

- Store GitHub star archive and push timestamps during sync so stale and recently-active signals can be derived locally.

### Removed

- Remove the superseded Claude Code brainstorm and local-history plan documents from `docs/brainstorms` and `docs/plans`.

## 0.3.7 — 2026-04-30

### Added

- Add an LM Studio local model inventory that resolves the active downloads folder from LM Studio settings, scans `publisher/model` directories, records model formats, sizes, warnings, and key model files.
- Add `ai2nao lmstudio sync` plus `/api/lmstudio/status`, `/api/lmstudio/models`, and `/api/lmstudio/sync` for explicit local model refreshes.
- Add the `/lmstudio-models` Web UI with root override, search, format filtering, missing-model visibility, pagination, sync status, warnings, and top-file summaries.
- Add regression coverage for LM Studio root resolution, filesystem scanning, sync persistence, API behavior, and the Web UI.

### Changed

- Extend local inventory sync tracking so LM Studio sync runs share the same status history as macOS apps, Homebrew packages, and Hugging Face models.

## 0.3.6 — 2026-04-29

### Changed

- Split Web UI pages into lazy-loaded route chunks so the initial JavaScript bundle is much smaller and Vite no longer emits the large chunk warning.
- Add App-level route coverage for lazy-loaded root redirects and the Atuin directory page.

## 0.3.5 — 2026-04-29

### Added

- Add rebuildable Atuin directory activity analytics with raw and filtered command counts, freshness state, strict configuration parsing, and failure-safe derived tables.
- Add `ai2nao atuin directories status` and `ai2nao atuin directories rebuild` plus `/api/atuin/directories/*` routes for status, rebuild, top directories, search, and per-directory command drilldown.
- Add the `/atuin/directories` Web UI with raw/filtered mode switching, directory search, selected-directory command summaries, sync status, and stale-data messaging.
- Add regression coverage for Atuin directory filtering, rebuild behavior, API validation, config parsing, and the Web UI.

### Changed

- Document Atuin directory analytics usage, freshness behavior, and low-information command filtering in the README.
- Track follow-up work for stronger repo attribution and daily-summary evidence integration in `TODOS.md`.

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
