import { closeSync, existsSync, openSync, readSync } from "node:fs";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { knowledgeCPath, responsibleAppPath } from "./paths.js";
import type { AttentionSourceProbe } from "./types.js";

/**
 * Every SQLite file starts with these 16 bytes: the 15 ASCII characters of
 * "SQLite format 3" followed by a NUL. Compared as bytes rather than as a
 * string so the trailing NUL cannot be mangled by encoding.
 */
const SQLITE_MAGIC = Buffer.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
]);

/**
 * Streams that carry "which app was frontmost, when", best first.
 *
 * Measured on macOS 2026-08-10: this machine has `/app/usage` with 10,343 rows
 * and **no `/app/inFocus` at all**, despite the forensics literature naming
 * inFocus as the macOS foreground stream. CoreDuet promises no compatibility,
 * so the stream is resolved at runtime instead of hard-coded — a machine that
 * has inFocus and not usage still works, and a machine with neither reports
 * `schema_mismatch` rather than silently producing nothing.
 */
export const FOCUS_STREAM_CANDIDATES = ["/app/usage", "/app/inFocus"] as const;

/** Kept for callers that just want a label; prefer {@link resolveFocusStream}. */
export const FOCUS_STREAM = FOCUS_STREAM_CANDIDATES[0];

/**
 * Streams that could close a span if the focus rows carried no end time.
 *
 * Measured on this machine: `/app/usage` rows are self-closing (0 null ZENDDATE
 * out of 10,343, longest 49.7 min), so closing is not needed here. Retained
 * because a machine whose focus stream lacks end times would need it — see
 * `probeAttentionSource().endDate` for the per-machine verdict.
 */
export const CLOSING_STREAMS = ["/device/isLocked", "/display/isBacklit"];

/** First candidate stream actually present, or null. */
export function resolveFocusStream(db: Database.Database): string | null {
  const present = new Set(listStreams(db));
  return FOCUS_STREAM_CANDIDATES.find((s) => present.has(s)) ?? null;
}

/**
 * Classify why the source can or cannot be read, in four escalating steps.
 *
 *   existsSync          -> source_missing   (not macOS, or no such DB)
 *   read 16 raw bytes   -> not_authorized   (TCC denies even one byte)
 *   header != magic     -> open_failed      (truncated / not a SQLite file)
 *   SQLite open throws  -> open_failed      (WAL, lock, corruption)
 *   no /app/inFocus     -> schema_mismatch  (CoreDuet changed shape)
 *
 * Reading the raw header is what separates "TCC said no" from "SQLite said no".
 * Those two need opposite advice: one means go grant access, the other means
 * granting access will not help — and a user who grants Full Disk Access and
 * still sees nothing has paid a real privacy cost for no reason.
 */
export function probeSource(sourcePath = knowledgeCPath()): AttentionSourceProbe {
  if (!existsSync(sourcePath)) {
    return {
      status: "source_missing",
      sourcePath,
      detail:
        "No knowledgeC database at this path. Expected on macOS only; granting Full Disk Access will not create it.",
    };
  }

  let header: Buffer;
  try {
    header = readHeader(sourcePath);
  } catch (e) {
    const app = responsibleAppPath();
    return {
      status: "not_authorized",
      sourcePath,
      detail: app
        ? `The file exists but not a single byte is readable — that is a Full Disk Access denial. Grant it to ${app}, which is the app macOS attributes this process to, then fully quit (Cmd+Q) and reopen it. Granting it to node, or to a different terminal, changes nothing.`
        : "The file exists but not a single byte is readable, which is what a Full Disk Access denial looks like. Grant it to whichever app launched this process, then fully quit and reopen that app.",
      rawError: String(e),
      responsibleApp: app ?? undefined,
    };
  }

  if (!header.equals(SQLITE_MAGIC)) {
    return {
      status: "open_failed",
      sourcePath,
      detail:
        "Readable, but the first 16 bytes are not a SQLite header — the file is truncated or is not a database. Granting Full Disk Access will not help.",
    };
  }

  let db: Database.Database;
  try {
    db = openSource(sourcePath);
  } catch (e) {
    return {
      status: "open_failed",
      sourcePath,
      detail:
        "Bytes are readable and the header is valid, so this is not a permission problem. SQLite still refused to open it — most likely a WAL sidecar this process may not write, or the writer holds a lock.",
      rawError: String(e),
    };
  }

  try {
    const streams = listStreams(db);
    // An empty ZOBJECT is not a schema problem — it is a readable database with
    // nothing in it yet. Conflating the two would report a healthy-but-idle
    // source as broken, and would let a successful empty run look like a run
    // that never happened.
    if (streams.length === 0) {
      return { status: "ok", sourcePath };
    }
    const focus = FOCUS_STREAM_CANDIDATES.find((s) => streams.includes(s));
    if (focus === undefined) {
      return {
        status: "schema_mismatch",
        sourcePath,
        detail: `Opened fine, but ZOBJECT carries none of ${FOCUS_STREAM_CANDIDATES.join(" / ")} (found ${streams.length} other streams). CoreDuet makes no compatibility promise; a macOS update may have moved or renamed them. Run with --json to see what is actually there.`,
      };
    }
    return { status: "ok", sourcePath, focusStream: focus };
  } catch (e) {
    return {
      status: "schema_mismatch",
      sourcePath,
      detail:
        "Opened fine, but querying ZOBJECT/ZSTREAMNAME failed. The table this feature depends on is not shaped as expected.",
      rawError: String(e),
    };
  } finally {
    db.close();
  }
}

/**
 * Open the live source read-only.
 *
 * Deliberately NOT `immutable`. That flag asserts no process will modify the
 * file, and knowledgeC is written continuously by CoreDuet — violating the
 * assertion is undefined behaviour in SQLite, not an error you get told about.
 *
 * This differs from `src/chromeHistory/sync.ts:319-393`, which snapshots
 * Chrome's live `History` (plus `-wal` / `-shm`) into a temp dir before reading.
 * That shape is more defensive; the direct read here was an explicit call. If a
 * WAL sidecar exists and holds recent rows, this path can read stale data, and
 * `probeSource` reports `open_failed` rather than pretending otherwise.
 */
export function openSource(sourcePath = knowledgeCPath()): Database.Database {
  return new DatabaseCtor(sourcePath, { readonly: true, fileMustExist: true });
}

function readHeader(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const bytes = readSync(fd, buf, 0, 16, 0);
    return buf.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Distinct `ZSTREAMNAME` values present in ZOBJECT. */
export function listStreams(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT ZSTREAMNAME AS s FROM ZOBJECT WHERE ZSTREAMNAME IS NOT NULL ORDER BY 1"
    )
    .all() as { s: string }[];
  return rows.map((r) => r.s);
}
