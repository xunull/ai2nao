import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeSubscriptionProvider,
  parseClaudeOAuthUsage,
} from "../src/providers/claudeSubscription.js";
import {
  createCodexSubscriptionProvider,
  parseCodexWhamUsage,
} from "../src/providers/codexSubscription.js";
import {
  normalizeResetToIso,
  readClaudeCredential,
  readCodexCredential,
  redactPii,
  remainingFromUsedPercent,
  windowKeyAndLabel,
} from "../src/providers/localCredentials.js";
import { listProviderSources } from "../src/providers/registry.js";

/**
 * Shapes captured from the real endpoints on 2026-07-26. All identifiers are
 * placeholders — this repo is public and gitleaks blocks real values.
 */
const CLAUDE_BODY = {
  five_hour: { utilization: 52.0, resets_at: "2026-07-26T06:30:00.069698+00:00" },
  seven_day: { utilization: 3.0, resets_at: "2026-08-02T03:00:00.069723+00:00" },
  seven_day_opus: null,
  tangelo: null,
  iguana_necktie: null,
  nimbus_quill: null,
  extra_usage: { is_enabled: false, monthly_limit: null },
  limits: [
    { kind: "session", group: "session", percent: 52, is_active: true, resets_at: "2026-07-26T06:30:00.069698+00:00" },
    { kind: "weekly_all", group: "weekly", percent: 3, is_active: false, resets_at: "2026-08-02T03:00:00.069723+00:00" },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      is_active: false,
      resets_at: null,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
  spend: { used: { amount_minor: 0, currency: "USD" }, percent: 0 },
  member_dashboard_available: false,
};

const CODEX_BODY = {
  user_id: "user-placeholder",
  account_id: "acct-placeholder",
  email: "someone@example.com",
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    // Verified reality: the PRIMARY window is 7 days here, not 5 hours.
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 604800,
      reset_at: 1785645160,
    },
    secondary_window: null,
  },
  credits: { balance: 0 },
  spend_control: { enabled: false },
};

describe("localCredentials — value normalization", () => {
  it("used percent → remaining percent (the direction Kimi's payload inverts)", () => {
    expect(remainingFromUsedPercent(52)).toBe(48);
    expect(remainingFromUsedPercent(0)).toBe(100);
    expect(remainingFromUsedPercent(100)).toBe(0);
    // Clamped, never negative or >100.
    expect(remainingFromUsedPercent(140)).toBe(0);
    expect(remainingFromUsedPercent(-5)).toBe(100);
    expect(remainingFromUsedPercent("52")).toBeNull();
    expect(remainingFromUsedPercent(undefined)).toBeNull();
  });

  it("reset timestamp: ISO with microseconds AND epoch seconds both normalize", () => {
    expect(normalizeResetToIso("2026-07-26T06:30:00.069698+00:00")).toBe("2026-07-26T06:30:00.069Z");
    // Codex sends epoch SECONDS.
    expect(normalizeResetToIso(1785645160)).toBe(new Date(1785645160 * 1000).toISOString());
    // Millisecond epochs still work.
    expect(normalizeResetToIso(1785645160000)).toBe(new Date(1785645160000).toISOString());
    expect(normalizeResetToIso(null)).toBeNull();
    expect(normalizeResetToIso("not-a-date")).toBeNull();
  });

  it("window minutes → key/label", () => {
    expect(windowKeyAndLabel(300, 0)).toEqual({ key: "5h", label: "5 小时用量" });
    expect(windowKeyAndLabel(10080, 1)).toEqual({ key: "7d", label: "7 天用量" });
    expect(windowKeyAndLabel(90, 0)).toEqual({ key: "90m", label: "90 分钟用量" });
    expect(windowKeyAndLabel(null, 2)).toEqual({ key: "w2", label: "用量 3" });
  });

  it("redactPii scrubs identifiers at any depth, keeps everything else", () => {
    const out = redactPii({
      email: "someone@example.com",
      nested: { account_id: "acct-x", keep: 1 },
      list: [{ user_id: "u-1" }],
      plan_type: "plus",
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("someone@example.com");
    expect(JSON.stringify(out)).not.toContain("acct-x");
    expect(JSON.stringify(out)).not.toContain("u-1");
    expect(out.plan_type).toBe("plus");
    expect((out.nested as Record<string, unknown>).keep).toBe(1);
  });
});

describe("parseClaudeOAuthUsage", () => {
  it("maps the 5h + 7d windows as REMAINING percent with normalized resets", () => {
    const snap = parseClaudeOAuthUsage(CLAUDE_BODY);
    const five = snap.items.find((i) => i.key === "5h")!;
    const seven = snap.items.find((i) => i.key === "7d")!;
    // 52% used → 48% remaining. Getting this backwards is the easy mistake.
    expect(five.remainingPercent).toBe(48);
    expect(five.label).toBe("5 小时用量");
    expect(five.resetAt).toBe("2026-07-26T06:30:00.069Z");
    expect(five.detail.usedPercent).toBe(52);
    expect(five.detail.windowMinutes).toBe(300);
    expect(seven.remainingPercent).toBe(97);
    expect(seven.label).toBe("7 天用量");
  });

  it("surfaces the scoped per-model limit even when is_active is false", () => {
    const fable = parseClaudeOAuthUsage(CLAUDE_BODY).items.find((i) => i.key === "7d-fable")!;
    expect(fable.label).toBe("7 天用量 · Fable");
    expect(fable.remainingPercent).toBe(100);
    expect(fable.detail.isActive).toBe(false);
  });

  it("ignores the null internal codename fields and the credit/spend blocks", () => {
    const keys = parseClaudeOAuthUsage(CLAUDE_BODY).items.map((i) => i.key);
    expect(keys).toEqual(["5h", "7d", "7d-fable"]);
    expect(keys.some((k) => /tangelo|iguana|nimbus|spend|extra/.test(k))).toBe(false);
  });

  it("junk / empty body → 0 items, never a throw", () => {
    expect(parseClaudeOAuthUsage(null).items).toHaveLength(0);
    expect(parseClaudeOAuthUsage({}).items).toHaveLength(0);
    expect(parseClaudeOAuthUsage({ five_hour: {} }).items).toHaveLength(0);
  });
});

describe("parseCodexWhamUsage", () => {
  it("derives window length from limit_window_seconds, NOT from field position", () => {
    const snap = parseCodexWhamUsage(CODEX_BODY);
    const win = snap.items.find((i) => i.detail.kind === "window")!;
    // 604800s = 7 days. Assuming primary_window == 5h would mislabel this.
    expect(win.key).toBe("7d");
    expect(win.label).toBe("7 天用量");
    expect(win.detail.windowMinutes).toBe(10080);
    expect(win.remainingPercent).toBe(100);
    expect(win.resetAt).toBe(new Date(1785645160 * 1000).toISOString());
  });

  it("a null secondary_window produces NO row (an empty bar would read as 0% left)", () => {
    const windows = parseCodexWhamUsage(CODEX_BODY).items.filter((i) => i.detail.kind === "window");
    expect(windows).toHaveLength(1);
  });

  it("plan_type becomes a membership item", () => {
    const plan = parseCodexWhamUsage(CODEX_BODY).items.find((i) => i.key === "plan")!;
    expect(plan.detail.planType).toBe("plus");
    expect(plan.remainingPercent).toBeNull();
  });

  it("PII never survives into the raw blob that gets persisted", () => {
    const raw = JSON.stringify(parseCodexWhamUsage(CODEX_BODY).raw);
    expect(raw).not.toContain("someone@example.com");
    expect(raw).not.toContain("acct-placeholder");
    expect(raw).not.toContain("user-placeholder");
    // Non-PII payload is preserved for debugging.
    expect(raw).toContain("plus");
  });

  it("junk body → 0 items, never a throw", () => {
    expect(parseCodexWhamUsage(null).items).toHaveLength(0);
    expect(parseCodexWhamUsage({ rate_limit: {} }).items).toHaveLength(0);
  });
});

describe("subscription providers — sync behaviour (no network, no machine state)", () => {
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("claude: no credential → a 'please log in' error, not a crash", async () => {
    const src = createClaudeSubscriptionProvider({ readCredential: async () => null });
    await expect(src.sync({ apiKey: null })).rejects.toThrow(/登录/);
  });

  it("claude: 401 → re-login hint, and the token is never in the message", async () => {
    const src = createClaudeSubscriptionProvider({
      readCredential: async () => ({ token: "tok-secret", origin: "legacy-keychain" }),
      fetchUsage: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    await expect(src.sync({ apiKey: null })).rejects.toThrow(
      /重新登录(?![\s\S]*tok-secret)/
    );
    await src.sync({ apiKey: null }).catch((e: Error) => {
      expect(e.message).not.toContain("tok-secret");
    });
  });

  it("claude: happy path sends the OAuth headers and tags the credential origin", async () => {
    let sentToken: string | null = null;
    const src = createClaudeSubscriptionProvider({
      readCredential: async () => ({ token: "tok-secret", origin: "scoped-keychain" }),
      fetchUsage: async (_url, token) => {
        sentToken = token;
        return okResponse(CLAUDE_BODY);
      },
    });
    const snap = await src.sync({ apiKey: null });
    expect(sentToken).toBe("tok-secret");
    expect(snap.items[0].detail.credentialOrigin).toBe("scoped-keychain");
  });

  it("codex: no credential → a 'codex login' error", async () => {
    const src = createCodexSubscriptionProvider({ readCredential: async () => null });
    await expect(src.sync({ apiKey: null })).rejects.toThrow(/codex login/);
  });

  it("codex: account id is forwarded when present", async () => {
    let seenAccount: string | null = null;
    const src = createCodexSubscriptionProvider({
      readCredential: async () => ({ accessToken: "t", accountId: "acct-1", origin: "auth-file" }),
      fetchUsage: async (_url, cred) => {
        seenAccount = cred.accountId;
        return okResponse(CODEX_BODY);
      },
    });
    await src.sync({ apiKey: null });
    expect(seenAccount).toBe("acct-1");
  });

  it("both are registered as keyless sources", () => {
    for (const id of ["claude", "codex"]) {
      expect(listProviderSources().find((s) => s.id === id)!.requiresApiKey).toBe(false);
    }
  });
});

describe("credential readers — absent files never throw", () => {
  it("readCodexCredential returns null for a missing / malformed auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-codex-"));
    expect(await readCodexCredential({ codexHome: dir })).toBeNull();
    writeFileSync(join(dir, "auth.json"), "{ not json");
    expect(await readCodexCredential({ codexHome: dir })).toBeNull();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "" } }));
    expect(await readCodexCredential({ codexHome: dir })).toBeNull();
  });

  it("readCodexCredential reads token + optional account id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-codex-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "t-1" } }));
    expect(await readCodexCredential({ codexHome: dir })).toEqual({
      accessToken: "t-1",
      accountId: null,
      origin: "auth-file",
    });
  });

  it("readClaudeCredential falls back to .credentials.json when the Keychain has nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-"));
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } })
    );
    const cred = await readClaudeCredential({ configDir: dir, readKeychainService: async () => null });
    expect(cred).toEqual({ token: "file-token", origin: "credentials-file" });
  });

  it("readClaudeCredential prefers the config-dir-scoped Keychain item", async () => {
    const seen: string[] = [];
    const cred = await readClaudeCredential({
      configDir: "/tmp/some-config-dir",
      readKeychainService: async (service) => {
        seen.push(service);
        // Only the scoped (suffixed) service holds a token here.
        return service === "Claude Code-credentials"
          ? null
          : JSON.stringify({ claudeAiOauth: { accessToken: "scoped-token" } });
      },
    });
    expect(cred).toEqual({ token: "scoped-token", origin: "scoped-keychain" });
    expect(seen[0]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it("readClaudeCredential returns null when nothing is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-"));
    expect(await readClaudeCredential({ configDir: dir, readKeychainService: async () => null })).toBeNull();
  });
});
