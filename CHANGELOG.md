# Changelog

## 0.3.25 — 2026-06-26

### Added

- Add a VitePress documentation site that publishes the `docs/` design and architecture notes to GitHub Pages, with a frontmatter-driven grouped sidebar, local search, and an automated build/deploy workflow (`.github/workflows/docs.yml`). New scripts: `docs:dev` (port 5180, avoids the app's 5173), `docs:build`, `docs:preview`.

### Changed

- Add `title` / `category` / `order` frontmatter to the 42 design-note markdown files under `docs/` to drive the documentation site's grouped navigation. Files stay in place; no `docs/` paths moved.
- Require Node.js >= 22 (`engines`) and drop Node 20 from CI. The Pyodide-based `ai2nao_run_code` sandbox does not initialize on Node 20 (`result.ok === false`); Node 22+ works.

### Fixed

- Scrub local absolute paths (`/Users/<username>/…`, `~/.gstack/projects/<user>-…`) and a personal email address out of `docs/` notes before public publishing.

## 0.3.24 — 2026-06-08

### Added

- Add a work token ranking page that aggregates indexed Claude Code and Codex token usage by project.
- Add reusable project-open actions for VS Code, Cursor, Warp, and iTerm2, including backend openers that launch terminal apps inside the project directory.
- Add a Motion-powered hover treatment so project open actions stay visually quiet until the user focuses the card controls.
- Add a work active-duration index that derives project activity from Claude Code and Codex JSONL timestamps with a 10-minute idle cap.

### Changed

- Refresh the combined work project statistics task so it rebuilds token totals and inferred active time together.
- Show inferred active time beside token totals on ranking cards while keeping token ranking sorted by token volume.

## 0.3.23 — 2026-06-06

### Added

- Add a local scheduler runtime that registers sync, scan, and derived rebuild tasks in SQLite with interval scheduling, leases, run history, and a CLI for status/run-now workflows.
- Add a `/scheduler` Web console for enabling tasks, changing intervals, manually running tasks, and inspecting recent task runs.
- Add scheduler documentation, including the current sync-task inventory and V1 design notes.

### Changed

- Start the scheduler loop from `serve`, so `npm run dev:ui` runs the API, Web UI, and scheduler runtime together while keeping every scheduled task disabled by default.

## 0.3.22 — 2026-06-03

### Added

- Add a 2026-style left workspace shell with a fixed app rail, command-style search, icon-led work domains, remembered collapse state, and narrow-desktop default collapse.
- Add Cherry Studio history browsing with read-only session lists, detail views, search, status diagnostics, and support for IndexedDB, agent database, and Markdown export sources.
- Add Cherry Studio results to the AI Chat session memory tool so local conversation evidence can include Cherry Studio alongside ai2nao, Codex, Claude Code, and Cursor history.

### Changed

- Promote AI 对话 to a first-level workspace entry while keeping AI history sources grouped under AI 记录.
- Replace the old top navigation and footer with the left shell while preserving the existing main content width and page-level toolbars.

### Fixed

- Allow workspace-domain buttons to switch panels even when the current route is the first-level AI 对话 entry.
- Remove implementation taxonomy wording from the visible sidebar panel labels.

## 0.3.21 — 2026-05-25

### Added

- Add an AI Chat Shell switch with a controlled `ai2nao_run_shell` backend tool for local inspection, test, build, and verification commands.
- Add interactive Shell approvals with suggested “execute and remember” rules, directory-scoped allow/ask/deny persistence, permission debug details, and management pages for saved rules.
- Add optional Shell sandbox settings backed by `@anthropic-ai/sandbox-runtime`, including filesystem and network policy configuration plus runtime dependency diagnostics.
- Add technical documentation for the Bash tool trust boundary, permission rule matching, and LLM-facing Shell tool behavior.

### Changed

- Extend the ai2nao-owned server-side tool registry so Shell execution follows the same backend-controlled CopilotKit transport boundary as RAG, Web Search, Memory, and Code.

### Fixed

- Keep AI Chat Shell tool cards stable across renderer remounts and protect the chat workbench with a local render boundary.
- Allow local API `PATCH` preflights so editable Shell permission rules can be saved from the management page.

## 0.3.20 — 2026-05-20

### Added

- Add an AI Chat Code switch with a Python execution tool for deterministic calculations, small data transforms, and local verification.
- Add a Pyodide/WASM Python runtime with bounded input files, output previews, blocked host/JS bridge imports, and timeout enforcement.
- Add an optional Docker Python runtime V2 that coexists with the Pyodide runner and is enabled only when Docker plus the expected image are available.
- Add `/api/code-runner/status` diagnostics and documentation for the code execution trust boundary, limits, and Docker setup.

### Changed

- Extend the ai2nao-owned server-side tool registry so code execution follows the same backend-controlled CopilotKit transport boundary as RAG, Web Search, and Session Memory.

## 0.3.19 — 2026-05-19

### Added

- Add an AI Chat Memory switch that lets the backend search local ai2nao, Codex, Claude Code, and Cursor session history for short evidence snippets.
- Add the `ai2nao_search_session_memory` server-side tool with local-only evidence results, source-level warnings, bounded snippets, and regression coverage.
- Add a technical document describing how AI Chat tools are implemented, what each memory source searches, and how the model triggers the tool.

### Changed

- Move AI-callable tool adapters into `src/llmTools/` so RAG, Web Search, and Session Memory tools share one registry and evidence envelope.
- Show the LLM config path on the disabled AI Chat screen and document the local LLM config file in the README.

## 0.3.18 — 2026-05-19

### Added

- Add configured AI SDK chat providers for DeepSeek, Moonshot/Kimi, Alibaba/Qwen, OpenAI, and OpenAI-compatible endpoints.
- Add provider-specific `llm-chat.config` examples and README guidance for selecting the matching provider and API key environment variable.
- Add regression coverage for provider config parsing, model factory selection, API key fallback order, and RAG embedding endpoint inheritance.

### Changed

- Keep RAG embedding fallback limited to OpenAI and OpenAI-compatible LLM configs so DeepSeek, Moonshot, and Alibaba chat endpoints are not reused as embedding endpoints.

## 0.3.17 — 2026-05-18

### Changed

- Use CopilotKit runtime only as the thin AI Chat transport adapter while keeping model calls, server-side tools, Web Search final answers, and persistence inside ai2nao.
- Document the allowed CopilotKit runtime boundary in the project architecture rules and AI Chat/Web Search docs.

### Fixed

- Reject CopilotKit client tools, page context, and shared state before model execution so frontend UI state cannot alter backend AI behavior.
- Add direct CopilotKit multi-route coverage for run/connect/info/stop and keep Web Search answers visible in the same turn after tool results.
- Let Playwright e2e run on an alternate `E2E_PORT` so tests do not accidentally reuse another local app on port 5173.

## 0.3.16 — 2026-05-18

### Added

- Add server-side AI Chat Web Search with Brave Search configuration, status diagnostics, sensitive query blocking, in-memory caching, and structured local/web evidence results.
- Add ai2nao-owned AI chat tools for RAG and Web Search, with CopilotKit kept as the UI transport only.
- Add regression coverage for AI SDK tool-result schema, DeepSeek DSML text tool calls, final-answer fallback, web search service behavior, and AI Chat e2e rendering.

### Changed

- Replace the CopilotKit backend runtime dependency with an ai2nao-owned CopilotKit-compatible SSE runtime for `/api/copilotkit`.
- Persist AG-UI assistant tool calls and `role: tool` evidence messages so search/RAG results survive session reloads and can be used in later turns.
- Route web-search and RAG tool results through a final answer synthesis step so the page receives a readable answer with result titles and URLs/paths.

### Fixed

- Prevent DeepSeek-style `<｜｜DSML｜｜tool_calls>` markup from appearing in the chat UI by parsing it server-side and executing the matching ai2nao tool.
- Fix `Invalid prompt: The messages do not match the ModelMessage[] schema` by restoring tool results with AI SDK v6 `{ type, value }` output objects.
- Add a deterministic evidence fallback when a model stops after tool results or keeps trying to call tools during final-answer generation.

## 0.3.15 — 2026-05-17

### Added

- Add true hybrid RAG retrieval with separate FTS and LanceDB vector branches, RRF fusion, detailed evidence scores, and `/rag-debug` for comparing FTS, vector, and fused results.
- Add RAG eval cases and `ai2nao rag eval` so retrieval changes can be checked against a small golden set.
- Add incremental RAG ingest with a `rag_files` manifest, unchanged-file skipping, missing-file tombstones, `--dry-run`, `--force`, `--repair`, manual `rag optimize`, and tombstone cleanup.
- Add a standalone `/rag-status` page that shows manifest health, chunk counts, vector sync state, config paths, and corpus roots.
- Add technical docs for hybrid FTS/vector retrieval, rerankers, RRF fusion, and vector-store tradeoffs.

### Changed

- Expand `/api/rag/status` and RAG evidence payloads with manifest counts, vector-store status, per-hit ranks, scores, and matched retrieval branches.
- Replace the old synchronous test ingest helper with the async production ingest path.

### Fixed

- Remove deleted files from SQLite chunks/FTS and LanceDB during RAG ingest so stale evidence no longer appears in search results.
- Preserve partial/error status when vector delete or upsert fails, so index health is visible instead of silently claiming freshness.

## 0.3.14 — 2026-05-07

### Added

- Add a CopilotKit runtime endpoint for `/ai-chat` with SQLite-backed AG-UI conversation sessions.
- Add regression coverage for CopilotKit single-endpoint routing, session isolation, and fixed-height AI Chat layout.

### Changed

- Replace the assistant-ui AI Chat implementation with CopilotKit while keeping local session history in ai2nao's SQLite database.
- Run the development API server in watch mode so backend route changes reload during local UI work.

### Fixed

- Fix AI Chat message sending by matching the React client to the backend's single `/api/copilotkit` endpoint.
- Surface CopilotKit runtime and model errors in the chat workbench instead of failing silently.

## 0.3.13 — 2026-05-06

### Added

- Add local AI chat session storage and session APIs so `/ai-chat` conversations can be saved, restored, continued, and deleted from SQLite.
- Add protocol-level UIMessage validation, frontend/backend message codecs, and Playwright coverage for AI chat history isolation.

### Changed

- Rework `/ai-chat` into a fixed-height desktop AI studio with a history rail, active session identity, persistence status, and restored-history context bridging.

### Fixed

- Prevent long assistant answers from pushing the AI chat composer down the page.
- Prevent switched AI chat sessions from leaking messages into each other, and reject malformed messages before they reach AI SDK/model calls.

## 0.3.12 — 2026-05-05

### Changed

- Keep the AI chat composer anchored inside a fixed-height desktop workbench so long assistant answers scroll in the conversation pane instead of pushing the input box down the page.
- Reshape AI chat into a left-context/right-thread workspace with model state, RAG corpus boundaries, quick prompts, and local forwarding trust signals visible beside the conversation.
- Compact the global desktop navigation into a single toolbar so page content starts higher and route changes feel less jumpy.
- Reshape repos, downloads, Mac apps, Homebrew, Hugging Face models, and LM Studio models into denser desktop inventory workbenches with compact headers, toolbars, and table-first content.
- Reshape Chrome domain analysis and GitHub radar into desktop workbenches with left-side indexes and right-side current-object workspaces.
- Add a desktop workbench design guide and align the next GitHub radar design plan with the same left-index/right-workspace structure.

### Fixed

- Clear the GitHub radar clue highlight when switching the left index into a review queue, so the selected row matches the right workspace.
- Add route-level regression coverage for the AI chat fixed-height workbench layout.

## 0.3.11 — 2026-05-04

### Changed

- Move the Chrome domain time matrix into its own page tab so visit filtering and timeline analysis no longer compete in the same workspace.
- Use a consistent PC-wide workspace width across the Web UI so switching pages no longer jumps between narrow and wide layouts.
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
