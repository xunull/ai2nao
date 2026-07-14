import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

/**
 * Point every credential path at a throwaway directory, once per test file.
 *
 * The credential store and the config readers are process-level singletons that
 * default to `~/.ai2nao/` — the developer's REAL config. This is not a
 * hypothetical: the first run of the settings-route suite wrote a fake GitHub
 * token straight into the real config.db. A test that read instead of wrote
 * would have picked up a live API key, and the credential migration RENAMES the
 * files it finds, so it could have moved real ones out from under the user.
 *
 * Redirecting all of them here — rather than asking each test to remember —
 * makes touching the real files structurally impossible. `store.ts` additionally
 * refuses the default config.db path under VITEST, so if this file ever stops
 * running the suite fails loudly instead of quietly reaching for the real one.
 *
 * Deliberately imports nothing from src/: setting env vars is enough (each test
 * file gets a fresh module graph, so no singleton is open yet), and pulling
 * better-sqlite3 into every React test file would tax hundreds of files that
 * never touch credentials.
 *
 * A test that wants a config file simply writes to one of these paths; nothing
 * exists here by default, which is the "not configured" state features expect.
 */
const dir = mkdtempSync(join(tmpdir(), "ai2nao-cfg-"));

process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
// config.json holds the topic taxonomy — the thing a user hand-tunes for hours.
// Without this, the taxonomy routes read the developer's real one.
process.env.AI2NAO_CONFIG = join(dir, "config.json");
process.env.AI2NAO_GITHUB_CONFIG = join(dir, "github.json");
process.env.AI2NAO_LLM_CHAT_CONFIG = join(dir, "llm-chat.json");
process.env.AI2NAO_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
process.env.AI2NAO_RAG_CONFIG = join(dir, "rag.json");
process.env.AI2NAO_NOTIFY_CONFIG = join(dir, "notify.json");

/**
 * …and a fresh config.db per TEST, not just per file.
 *
 * The store is a process-level singleton, so without this a key written by one
 * case is still there in the next one — which is exactly how `providers.test.ts`
 * started seeing "enabled but no key" pass with a key. The store re-opens when
 * this path changes, so swapping the env var is all it takes; no import from
 * src/ (and so no better-sqlite3) is needed here.
 */
let n = 0;
beforeEach(() => {
  process.env.AI2NAO_CONFIG_DB = join(dir, `config-${++n}.db`);
});
