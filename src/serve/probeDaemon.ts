import { API_VERSION, expectedSchemaVersion, type HealthSnapshot } from "./health.js";
import { clearDaemonMeta, listDaemonMeta } from "./daemonMeta.js";

/**
 * Find out whether a usable ai2nao daemon is reachable, and if not, why not.
 *
 * ## Why this returns a union and not a boolean
 *
 * "Cannot use the daemon" has at least six causes, and a client has to say
 * something different for each one. Collapsing them produces the exact failure
 * this was designed to avoid: showing "daemon not running, run `ai2nao serve`"
 * while a daemon IS running and the real problem is a port conflict or a version
 * skew. The user then runs the command, sees the same message, and is stuck.
 *
 * The shape follows the convention already in this codebase — see
 * `parseListQuery` in `./listQuery.ts`, consumed with `"error" in parsed` in
 * `./app.ts`.
 *
 * ## Why the daemon record cannot be trusted
 *
 * `~/.ai2nao/run/` records survive `kill -9` and power loss. They tell you which
 * port to TRY; only a real request to `/api/health` tells you whether anyone is
 * there. A record that fails to answer is stale by definition, so we delete it on
 * the way past — otherwise it misleads every future probe.
 *
 * ## Why `version` never rejects and `apiVersion` does
 *
 * The shell installs from a .dmg, the daemon from npm; they upgrade on separate
 * schedules, so differing release versions is the ordinary steady state. Refusing
 * to connect on `version !== version` would be a self-inflicted outage. The
 * contract version is what matters, and it moves only when something actually
 * breaks.
 */

/**
 * The oldest contract this build can talk to. A daemon below it (including one
 * with no `/api/health` at all, which reads as 0) is reported `incompatible`.
 */
export const MIN_SUPPORTED_API_VERSION = 1;

/** Default port, matching `ai2nao serve --port`. */
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 2_000;

export type ProbeResult =
  /** A daemon is there and we can talk to it. */
  | { kind: "attached"; url: string; health: HealthSnapshot }
  /** Nothing is listening. */
  | { kind: "not-running" }
  /** Something is listening, but it is not an ai2nao we recognise. */
  | { kind: "port-taken"; host: string; port: number }
  /** It IS ai2nao, but the HTTP contract does not line up. `theirs: 0` = pre-/api/health. */
  | { kind: "incompatible"; host: string; port: number; theirs: number; ours: number }
  /** Contract is fine; the database schema is not the one we expect. */
  | { kind: "schema-mismatch"; host: string; port: number; theirs: number; ours: number }
  /** Listening but not answering in time — wedged, not absent. */
  | { kind: "timeout"; host: string; port: number };

export type ProbeOptions = {
  host?: string;
  /** Skip record lookup and probe this port directly. */
  port?: number;
  timeoutMs?: number;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
};

function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    typeof v.apiVersion === "number" &&
    typeof v.schemaVersion === "number" &&
    typeof v.pid === "number" &&
    typeof v.startedAt === "string" &&
    typeof v.port === "number" &&
    typeof v.dbPath === "string"
  );
}

/** The `/api/status` payload, used only to recognise an ai2nao too old for `/api/health`. */
function looksLikeStatusPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.repos === "number" && typeof v.manifests === "number" && "lastJob" in v;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; reason: "unreachable" | "timeout" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      body = undefined; // Non-JSON is fine; the caller decides what that means.
    }
    return { ok: true, status: res.status, body };
  } catch (e) {
    const aborted = controller.signal.aborted || (e as Error).name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one port. When no port is given, the newest daemon record supplies the
 * candidate, falling back to 8787.
 */
export async function probeDaemon(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A record narrows the search; it never decides the outcome.
  const records = opts.port === undefined ? listDaemonMeta() : [];
  const candidate = records
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  const host = opts.host ?? candidate?.host ?? "127.0.0.1";
  const port = opts.port ?? candidate?.port ?? DEFAULT_PORT;
  const base = `http://${host}:${port}`;

  const forgetStaleRecord = (): void => {
    // Only ever removes the record we followed here, and only after it failed to
    // answer. A live daemon's record is never touched.
    if (candidate !== undefined) {
      clearDaemonMeta({ dbPath: candidate.dbPath, port: candidate.port, pid: candidate.pid });
    }
  };

  const health = await getJson(fetchImpl, `${base}/api/health`, timeoutMs);

  if (!health.ok) {
    if (health.reason === "timeout") return { kind: "timeout", host, port };
    forgetStaleRecord();
    return { kind: "not-running" };
  }

  if (health.status === 200 && isHealthSnapshot(health.body)) {
    const theirs = health.body.apiVersion;
    if (theirs < MIN_SUPPORTED_API_VERSION || theirs > API_VERSION) {
      return { kind: "incompatible", host, port, theirs, ours: API_VERSION };
    }
    const ourSchema = expectedSchemaVersion();
    if (health.body.schemaVersion !== ourSchema) {
      return {
        kind: "schema-mismatch",
        host,
        port,
        theirs: health.body.schemaVersion,
        ours: ourSchema,
      };
    }
    return { kind: "attached", url: base, health: health.body };
  }

  // Something answered but it was not a health payload. Before calling it a
  // foreign process, check whether it is an ai2nao released before /api/health
  // existed — otherwise every older daemon looks like a port squatter and the
  // user gets told to kill their own service.
  const status = await getJson(fetchImpl, `${base}/api/status`, timeoutMs);
  if (status.ok && status.status === 200 && looksLikeStatusPayload(status.body)) {
    return { kind: "incompatible", host, port, theirs: 0, ours: API_VERSION };
  }

  return { kind: "port-taken", host, port };
}
