<!-- 语言 / Language --> [中文](README.md) · **English**

# ai2nao

**A local-first cockpit for your own developer activity.** It pulls the things scattered across your machine — AI coding-tool history, token / cost, external-provider usage, local software and model inventory, browser / shell / Git / GitHub activity — into **one local SQLite database**, then layers a web UI, RAG, web search, an AI chat, and an MCP server on top. The result: you (and your AI tools) can see and query your own development activity in one place.

Data lives in `~/.ai2nao/index.db` by default (override with `--db`). Everything stays on your machine; the server binds `127.0.0.1` only.

## Features

- **AI usage & cost** — aggregates Claude Code / Codex token usage, split by project / date / model, with an equivalent API cost (prices can be synced on a schedule from [models.dev](https://models.dev)). Pages: `/dashboard/tokens` (ranking), `/dashboard/tokens-trend` (trend + cost).
- **Recent work** — `/dashboard` rolls up local Claude Code / Codex sessions into "what I've been working on"; `/work-recap` strings it into a recap.
- **Conversation cosmos** — `/dashboard/cosmos` embeds every AI conversation into a 2D semantic space and renders it as a scatter plot (see Showcase below).
- **External-provider usage** — `/providers` syncs the remaining quota of external AI providers (e.g. MiniMax) as pluggable sources you can enable / disable one by one. API keys are written locally only and never returned over the API.
- **Local inventory** — Git repo index with FTS5 full-text search, macOS apps, Homebrew packages, Hugging Face / LM Studio local models, the downloads folder, VS Code / Cursor recent projects.
- **AI chat history** — read-only browse, filter, and search over local Claude Code, Codex, Cursor, and Cherry Studio conversations.
- **Browser / shell** — Chrome history, Chrome domain analytics, Chrome downloads, Atuin shell history and directory activity.
- **GitHub / open-source radar** — GitHub repos & stars; `/github/radar` links your stars back to the TODOs/docs/README of locally indexed projects.
- **AI chat + RAG** — `/ai-chat` keeps model-call orchestration in the ai2nao backend, with an optional local RAG (FTS + vector hybrid retrieval).
- **MCP "memory organ"** — `serve` exposes a read-only MCP server at `/mcp` so agents like Claude Code / Codex can query your dev data inline (see [MCP memory organ](#mcp-memory-organ)).
- **Scheduler** — `serve` ships a built-in local scheduler for sync / scan / derived-rebuild tasks (all disabled by default).

## Showcase

### Conversation cosmos `/dashboard/cosmos`

Embed all local AI conversation sessions (Claude Code + Codex) into a 2D semantic space and render them as a scatter plot: **color = source** (Claude blue / Codex orange), **size = token volume**. See, at a glance, what a year of talking to AI looks like in semantic space, and export a PNG with one click.

<!-- Screenshot TODO: start serve → open /dashboard/cosmos → click "refresh" → export PNG → put it at docs/assets/cosmos.png and embed ![](docs/assets/cosmos.png) here -->

- Embedding reuses the RAG provider config (`~/.ai2nao/rag.json`); it goes through a remote service by default, and the page labels the embedding model honestly. For a fully local-only path see TODOS (local embedding fallback).
- Session content is not uploaded wholesale: each session contributes only a snippet of "first real prompt + last real reply" (≤2K chars, with CLI control tags / ANSI stripped). Data boundary: [Cosmos embedding data boundary](local-docs/2026-06-14-cosmos-embedding-data-boundary/README.md).
- Engineering details (data flow, schema, UMAP projection, API, Phase 2 roadmap): [Activity Cosmos technical doc](docs/activity-cosmos.md).

## Requirements

- Node.js **20+**
- Depends on the native module **better-sqlite3** (compiled for your platform at install time; CI covers Linux / macOS)

## Install & build

```bash
npm install
npm run build
```

What every `scripts` entry in `package.json` does: [package.json scripts reference](docs/package-scripts.md).

During development you can run directly:

```bash
npm run dev -- scan --root .
```

## Quick start

```bash
# 1. Scan Git repos
node dist/cli.js scan --root ~/projects

# 2. Sync local software (optional)
node dist/cli.js apps sync       # macOS apps
node dist/cli.js brew sync       # Homebrew packages

# 3. Start the web UI (default http://127.0.0.1:8787)
node dist/cli.js serve
```

## Command overview

### Repo index

```bash
node dist/cli.js scan --root ~/projects --root ~/work   # scan multiple roots
node dist/cli.js status                                 # stats
node dist/cli.js search "package.json"                  # FTS5 full-text search
```

### Software inventory

```bash
node dist/cli.js apps sync          # sync installed macOS apps
node dist/cli.js apps reset --yes   # clear the inventory
node dist/cli.js brew sync          # sync Homebrew formula / cask
node dist/cli.js brew reset --yes   # clear the inventory
```

### Other syncs

```bash
# VS Code / Cursor opened projects
node dist/cli.js vscode sync
node dist/cli.js cursor projects sync

# Chrome browser history
node dist/cli.js chrome-history sync
node dist/cli.js chrome-history watch --interval 30
node dist/cli.js chrome-history domains rebuild

# Atuin directory activity
node dist/cli.js atuin directories rebuild

# GitHub repos & tags
node dist/cli.js github sync
node dist/cli.js github sync --full

# Hugging Face / LM Studio local models
node dist/cli.js huggingface sync
node dist/cli.js lmstudio sync
```

## Scheduler

`serve` ships a built-in local scheduler for sync, scan, and derived-rebuild tasks. Registered tasks are **disabled by default** and do not run on startup.

```bash
node dist/cli.js scheduler status              # registered tasks and recent runs
node dist/cli.js scheduler run downloads.scan  # run a task manually
node dist/cli.js serve                         # start the web console
```

Open `/scheduler` to enable / disable tasks, adjust intervals, Run now, and view history. Registered tasks include `downloads.scan`, `mac_apps.sync`, `brew.sync`, `huggingface.models.sync`, `lmstudio.models.sync`, `vscode.recent.sync`, `cursor.projects.sync`, `chrome.history.sync`, `chrome.domains.rebuild`, `atuin.directories.rebuild`, plus token / price sync tasks. More: [Scheduler design](docs/scheduler-design.md).

## MCP memory organ

While `serve` is running it exposes a local MCP server at `/mcp` (read-only, bound to `127.0.0.1`) that hands ai2nao's data to agents like Claude Code / Codex as tools. Register it once in Claude Code:

```bash
claude mcp add --transport http ai2nao http://127.0.0.1:8787/mcp
```

Then ask directly in chat, e.g. "how many tokens did this repo burn this week" or "which project did I spend the most time on". v1 tools:

- `project_tokens` — Claude Code token usage per project (filter by project / since-date)
- `time_spent` — honest active coding time per project
- `external_usage` — remaining quota for external providers (e.g. MiniMax); never returns API keys

Read-only: the MCP server opens the index DB with a separate read-only handle, so no tool can write. A connection failure when `serve` isn't running is expected.

## Local LLM config for AI chat

Model calls for `/ai-chat` are handled by the ai2nao backend (CopilotKit is transport/UI only). It never guesses your model service; it reads a single JSON config file. Copy an example and edit it:

```bash
cp llm-chat.config.example.json ~/.ai2nao/llm-chat.json
# Or override the path with an env var:
AI2NAO_LLM_CHAT_CONFIG=/path/to/llm-chat.json node dist/cli.js serve
```

DeepSeek official API:

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-reasoner",
  "apiKey": "sk-..."
}
```

Ollama / LM Studio / other OpenAI-compatible local services:

```json
{
  "provider": "openai-compatible",
  "baseURL": "http://127.0.0.1:11434/v1",
  "model": "qwen2.5-coder:7b",
  "apiKey": "local-no-key"
}
```

Fields: `provider` (`deepseek` or `openai-compatible`), `baseURL` (local services usually include `/v1`), `model`, `apiKey` (optional; falls back to `AI2NAO_LLM_API_KEY` / `OPENAI_API_KEY`).

More examples: [Moonshot/Kimi](llm-chat.config.moonshotai.example.json) · [Alibaba DashScope/Qwen](llm-chat.config.alibaba.example.json) · [OpenAI-compatible](llm-chat.config.openai-compatible.example.json). Per-provider env fallbacks: DeepSeek `DEEPSEEK_API_KEY`, Moonshot `MOONSHOT_API_KEY`, Alibaba `ALIBABA_API_KEY`, OpenAI `OPENAI_API_KEY`, all falling back to `AI2NAO_LLM_API_KEY`.

> If the page says "configure a local LLM first", check `/api/llm-chat/status` for the `configPath` / `configured` / `model` the backend actually read, and verify the path and field format.

## RAG (local notes / plain text)

Optional local retrieval for AI chat: chunk `.md` / `.txt` files into **`~/.ai2nao/rag.db`** (SQLite FTS5), and optionally enable embedding + a LanceDB vector store in `rag.json` for FTS + vector hybrid retrieval with RRF fusion.

```bash
cp rag.config.example.json ~/.ai2nao/rag.json   # edit, set corpusRoots; for vector recall enable embedding + vectorStore
node dist/cli.js rag ingest --root /path/to/notes  # incremental (unchanged skipped, deleted removed)
node dist/cli.js rag ingest --dry-run              # print the plan only
node dist/cli.js rag ingest --repair               # repair partial/error files
node dist/cli.js rag ingest --force                # full rebuild of the current corpus
node dist/cli.js rag eval --cases docs/rag-eval-cases.json  # fixed-question eval
```

Web pages: `/rag-status` (manifest / chunk / vector sync / config path) and `/rag-debug` (compare FTS / Vector / Hybrid results and ranks for one query). Config example: [OpenAI](rag.config.example.json). RAG embedding env fallback: `OPENAI_API_KEY` / `AI2NAO_LLM_API_KEY`. A DeepSeek chat config is not auto-treated as an embedding endpoint; configure the embedding provider explicitly in the `embedding` block of `rag.json`.

## Web UI

Open the address printed in the terminal (default `http://127.0.0.1:8787`, local only). For development, run two processes (Vite proxies the API):

```bash
npm run dev:ui
```

Navigation groups:

- **AI chat** — `/ai-chat`
- **Workbench** — Recent work `/dashboard`, Token ranking `/dashboard/tokens`, Token trend + cost `/dashboard/tokens-trend`, Work recap `/work-recap`, Conversation cosmos `/dashboard/cosmos`, External providers `/providers`
- **Local inventory** — repos, scheduler, downloads, Mac apps, VS Code, Cursor projects, Homebrew, HF models, LM Studio, Atuin, Atuin directories
- **Browser** — Chrome history `/chrome-history`, Chrome domains `/chrome-history/domains`, Chrome downloads
- **AI records** — Cherry / Cursor / Claude / Codex local conversations
- **AI tools** — Shell permissions / sandbox, RAG status / debug
- **GitHub / open source** — GitHub, open-source radar `/github/radar`, Star tags

A few pages have data boundaries worth noting:

- **Codex conversations** `/codex-history`: reads `~/.codex/sqlite/state_5.sqlite` (legacy fallback: top-level `state_5.sqlite`) as the thread list, then the matching `~/.codex/sessions/**/rollout-*.jsonl` for detail; when SQLite is unavailable it degrades to scanning JSONL and shows a diagnostic. Archived threads are hidden by default; filter by cwd / branch / model.
- **Chrome domain analytics** `/chrome-history/domains`: builds a rebuildable domain pivot from the local Chrome History mirror (Top domains, day/week/month matrix, visit drill-down, keyword search, WeChat-article filter). Raw browsing records stay in local SQLite; a domain-layer failure does not roll back synced raw data.
- **Atuin directory activity** `/atuin/directories`: scans the read-only Atuin `history.db` in full and builds a rebuildable directory/command aggregate layer in the ai2nao DB (the Atuin source is never written). Supports `raw` / `filtered` modes; low-info command filtering can be overridden in `~/.ai2nao/config.json`:

  ```json
  {
    "atuin": {
      "directoryActivity": {
        "includeLowInfoCommands": false,
        "lowInfoCommands": [
          { "kind": "exact", "value": "pwd" },
          { "kind": "prefix", "value": "git status" }
        ]
      }
    }
  }
  ```

  Config parsing is strict: unknown fields / invalid JSON / invalid rules fail the rebuild and show `config_error` in the status area, while the previous aggregate is kept.

## Tests

```bash
npm test
```

## Documentation

Cost & tokens:

- [Token field reference for session files](docs/session-token-fields.md) — a complete enumeration of **every** token field in Claude Code and Codex session files
- [Token computation pipeline](docs/token-usage-pipeline.md) — how ai2nao parses, aggregates, and stores tokens
- [Cost billing logic](docs/cost-billing.md) — per-segment pricing for input / cache / output and how the equivalent API cost is computed

Visualization:

- [Activity Cosmos technical doc](docs/activity-cosmos.md) — data flow, schema, UMAP, and API behind the conversation cosmos

## License

MIT (see `LICENSE` in the repo).
