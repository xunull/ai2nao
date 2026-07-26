/**
 * Shared plumbing for the two SUBSCRIPTION-QUOTA providers that read THIS
 * machine's login state instead of a user-pasted key (Claude Code, Codex CLI).
 *
 * Read-only by design: we never refresh a token and never write back to the
 * Keychain or auth.json. Overwriting the credentials that Claude Code / Codex
 * themselves depend on is a much worse failure than showing "please log in
 * again" — those CLIs refresh their own tokens the moment you use them.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** Where a credential came from — surfaced in `detail` for debugging. */
export type CredentialOrigin = "scoped-keychain" | "legacy-keychain" | "credentials-file" | "auth-file";

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/**
 * Reset timestamp → ISO. Accepts an ISO string (Claude sends microseconds) and
 * an epoch number (Codex sends SECONDS). Same <1e12 second/millisecond split
 * the Kimi provider uses, so the two read consistently.
 */
export function normalizeResetToIso(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return null;
}

/**
 * Both endpoints report USED percent; `ProviderSnapshotItem.remainingPercent`
 * stores REMAINING. Kimi's API natively returns `remaining`, so copying that
 * provider's mapping would silently invert the bars — hence this one helper
 * that every used→remaining conversion goes through.
 */
export function remainingFromUsedPercent(used: unknown): number | null {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, Math.round(100 - used)));
}

/** Window length in minutes → stable item key + zh label (300 → 5h / 5 小时用量). */
export function windowKeyAndLabel(minutes: number | null, index: number): { key: string; label: string } {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) {
    return { key: `w${index}`, label: `用量 ${index + 1}` };
  }
  const m = Math.round(minutes);
  if (m % 1440 === 0) return { key: `${m / 1440}d`, label: `${m / 1440} 天用量` };
  if (m % 60 === 0) return { key: `${m / 60}h`, label: `${m / 60} 小时用量` };
  return { key: `${m}m`, label: `${m} 分钟用量` };
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

/**
 * Keys scrubbed before a raw response is persisted. Codex's /wham/usage returns
 * `email` / `user_id` / `account_id` at the top level, and `ProviderSnapshot.raw`
 * goes into SQLite verbatim — so redaction is mandatory, not cosmetic. ai2nao is
 * a public repo: a raw blob pasted into an issue must not carry an inbox.
 */
const PII_KEYS = new Set(["email", "user_id", "userid", "account_id", "accountid", "phone", "name"]);

/** Deep copy with PII keys replaced by a marker. Non-plain values pass through. */
export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEYS.has(k.toLowerCase()) ? (v == null ? v : "[redacted]") : redactPii(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Claude Code credentials
// ---------------------------------------------------------------------------

export type ClaudeCredential = { token: string; origin: CredentialOrigin };

/** Claude Code 2.1+ scopes its Keychain item by sha256(CLAUDE_CONFIG_DIR)[0..8). */
function scopedKeychainService(configDir: string): string {
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

async function readKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS }
    );
    const raw = stdout.trim();
    return raw || null;
  } catch {
    // Item absent, Keychain locked, or `security` unavailable — all "no token
    // here", never fatal: the caller still has the credentials-file fallback.
    return null;
  }
}

/** `{claudeAiOauth:{accessToken}}` → the token. Never logs or returns the blob. */
function tokenFromClaudeJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const t = parsed?.claudeAiOauth?.accessToken;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code's OAuth access token: scoped Keychain item → legacy Keychain item
 * → `<configDir>/.credentials.json`.
 *
 * Deliberately ignores the credential's local `expiresAt`: Anthropic's usage
 * endpoint still authenticates tokens that look expired locally, so letting the
 * server decide avoids refusing to sync on a stale local clock/field.
 */
export async function readClaudeCredential(opts?: {
  configDir?: string;
  /** Test seam. */
  readKeychainService?: (service: string) => Promise<string | null>;
}): Promise<ClaudeCredential | null> {
  const readSvc = opts?.readKeychainService ?? readKeychain;
  const configDir = opts?.configDir ?? process.env.CLAUDE_CONFIG_DIR;

  if (configDir) {
    const scoped = tokenFromClaudeJson((await readSvc(scopedKeychainService(configDir))) ?? "");
    if (scoped) return { token: scoped, origin: "scoped-keychain" };
  }
  const legacy = tokenFromClaudeJson((await readSvc(CLAUDE_KEYCHAIN_SERVICE)) ?? "");
  if (legacy) return { token: legacy, origin: "legacy-keychain" };

  const dir = configDir ?? path.join(homedir(), ".claude");
  try {
    const fileToken = tokenFromClaudeJson(await readFile(path.join(dir, ".credentials.json"), "utf-8"));
    if (fileToken) return { token: fileToken, origin: "credentials-file" };
  } catch {
    /* absent → no credential */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex CLI credentials
// ---------------------------------------------------------------------------

export type CodexCredential = { accessToken: string; accountId: string | null; origin: CredentialOrigin };

/** `$CODEX_HOME/auth.json` (default `~/.codex`) → tokens.access_token / account_id. */
export async function readCodexCredential(opts?: { codexHome?: string }): Promise<CodexCredential | null> {
  const home = opts?.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  try {
    const parsed = JSON.parse(await readFile(path.join(home, "auth.json"), "utf-8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const token = parsed?.tokens?.access_token;
    if (typeof token !== "string" || !token.trim()) return null;
    const accountId = parsed?.tokens?.account_id;
    return {
      accessToken: token.trim(),
      accountId: typeof accountId === "string" && accountId.trim() ? accountId.trim() : null,
      origin: "auth-file",
    };
  } catch {
    return null;
  }
}
