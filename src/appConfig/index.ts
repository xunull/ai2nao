/**
 * App-level config (settings page) — NON-secret preferences only. Secrets live in
 * `~/.ai2nao/config.db` (see src/settings/store.ts), never here.
 *
 * The split is deliberate and load-bearing: config.db is a few KB of credentials
 * so it can be excluded from Time Machine / Dropbox wholesale. Settings like the
 * topic taxonomy are NOT secrets and MUST ride along with your data — putting
 * them in config.db would mean excluding it from backups also threw away the
 * taxonomy you spent hours tuning.
 *
 * Accessors are KEY-SPECIFIC and runtime-validated, NOT a generic getConfig<T>:
 * `JSON.parse() as T` gives no runtime guarantee, so a corrupt/hand-edited row
 * could smuggle `scan.roots: "oops"` into business logic. Each key gets its own
 * validating accessor; malformed/wrong-shape rows resolve to a safe default.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { canonicalizePath } from "../path/canonical.js";
import {
  OTHER_CATEGORY,
  TAXONOMY_RULE_KINDS,
  type TaxonomyRule,
  type TopicCategory,
} from "../topicStream/classify.js";

const KEY_SCAN_ROOTS = "scan.roots";
const MAX_ROOTS = 100;
const MAX_PATH_LEN = 4096;

const KEY_SCAN_MAX_DEPTH = "scan.maxDepth";
/** Default depth brake for repo discovery (levels below a scan root). */
export const DEFAULT_SCAN_MAX_DEPTH = 8;
const MAX_SCAN_DEPTH = 64;

const KEY_SCAN_MAX_DOCS = "scan.maxDocsPerRepo";
/** Default cap on markdown docs indexed per repo (docs/ folder). */
export const DEFAULT_SCAN_MAX_DOCS = 100;
const MAX_SCAN_DOCS = 5000;

const KEY_SCAN_CONCURRENCY = "scan.concurrency";
/** Default parallel I/O concurrency for repo scanning. */
export const DEFAULT_SCAN_CONCURRENCY = 16;
const MAX_SCAN_CONCURRENCY = 64;

/** Read + JSON.parse a config row; undefined when absent or unparseable. */
function readRaw(db: Database.Database, key: string): unknown {
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    // json_valid CHECK should prevent this, but stay defensive.
    console.warn(`app_config: unparseable value for ${key}; using default`);
    return undefined;
  }
}

function writeRaw(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function deleteKey(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
}

/**
 * Default scan roots. Returns [] for unconfigured OR any wrong-shape stored value
 * (corruption-tolerant). Stored values are already canonical (validated on write),
 * but we still shape-check to never leak a bad value into the scanner.
 */
export function getScanRoots(db: Database.Database): string[] {
  const raw = readRaw(db, KEY_SCAN_ROOTS);
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) {
    if (raw !== undefined) console.warn("app_config: scan.roots wrong shape; using []");
    return [];
  }
  return raw as string[];
}

/**
 * Validate + store scan roots. Each root must be an absolute, existing directory;
 * paths are canonicalized (symlinks resolved) and deduped. An empty array DELETES
 * the key (unconfigured), so an explicit `[]` never carries special meaning.
 * Throws (caller -> 400) with per-root reasons on any invalid input.
 *
 * NOTE: validation here is UX, not a security boundary — the scanner MUST re-check
 * each root at scan time (a stored dir can be deleted/swapped later).
 */
export function setScanRoots(db: Database.Database, roots: string[]): string[] {
  if (!Array.isArray(roots)) throw new Error("scan roots must be an array");
  if (roots.length === 0) {
    deleteKey(db, KEY_SCAN_ROOTS);
    return [];
  }
  if (roots.length > MAX_ROOTS) throw new Error(`too many roots (max ${MAX_ROOTS})`);

  const canonical: string[] = [];
  const errors: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.trim() === "") {
      errors.push("empty or non-string path");
      continue;
    }
    const p = raw.trim();
    if (p.includes(String.fromCharCode(0))) {
      errors.push(`${p}: contains NUL`);
      continue;
    }
    if (p.length > MAX_PATH_LEN) {
      errors.push(`path too long (max ${MAX_PATH_LEN})`);
      continue;
    }
    if (!isAbsolute(p)) {
      errors.push(`${p}: not an absolute path`);
      continue;
    }
    const canon = canonicalizePath(p); // realpathSync -> null if it doesn't exist
    if (!canon) {
      errors.push(`${p}: does not exist`);
      continue;
    }
    try {
      if (!statSync(canon).isDirectory()) {
        errors.push(`${p}: not a directory`);
        continue;
      }
    } catch {
      errors.push(`${p}: not accessible`);
      continue;
    }
    canonical.push(canon);
  }

  if (errors.length > 0) throw new Error(`invalid scan roots: ${errors.join("; ")}`);

  const deduped = [...new Set(canonical)];
  writeRaw(db, KEY_SCAN_ROOTS, deduped);
  return deduped;
}

/**
 * Repo-discovery depth brake (levels below a scan root). Returns the configured
 * value or {@link DEFAULT_SCAN_MAX_DEPTH}; a missing / corrupt / out-of-range row
 * resolves to the default (corruption-tolerant).
 */
export function getScanMaxDepth(db: Database.Database): number {
  const raw = readRaw(db, KEY_SCAN_MAX_DEPTH);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_SCAN_DEPTH) {
    if (raw !== undefined) console.warn("app_config: scan.maxDepth out of range; using default");
    return DEFAULT_SCAN_MAX_DEPTH;
  }
  return raw;
}

/** Validate + store the depth brake. Throws (caller -> 400) on a non-integer or out-of-range value. */
export function setScanMaxDepth(db: Database.Database, depth: number): number {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > MAX_SCAN_DEPTH) {
    throw new Error(`scan depth must be an integer 0..${MAX_SCAN_DEPTH}`);
  }
  writeRaw(db, KEY_SCAN_MAX_DEPTH, depth);
  return depth;
}

/**
 * Cap on markdown docs indexed per repo (the repo's docs/ folder). Returns the
 * configured value or {@link DEFAULT_SCAN_MAX_DOCS}; a missing / corrupt /
 * out-of-range row resolves to the default (corruption-tolerant).
 */
export function getScanMaxDocs(db: Database.Database): number {
  const raw = readRaw(db, KEY_SCAN_MAX_DOCS);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_SCAN_DOCS) {
    if (raw !== undefined) console.warn("app_config: scan.maxDocsPerRepo out of range; using default");
    return DEFAULT_SCAN_MAX_DOCS;
  }
  return raw;
}

/** Validate + store the per-repo doc cap. Throws (caller -> 400) on a non-integer or out-of-range value. */
export function setScanMaxDocs(db: Database.Database, maxDocs: number): number {
  if (typeof maxDocs !== "number" || !Number.isInteger(maxDocs) || maxDocs < 1 || maxDocs > MAX_SCAN_DOCS) {
    throw new Error(`scan maxDocs must be an integer 1..${MAX_SCAN_DOCS}`);
  }
  writeRaw(db, KEY_SCAN_MAX_DOCS, maxDocs);
  return maxDocs;
}

/**
 * Parallel I/O concurrency for repo scanning. Returns the configured value or
 * {@link DEFAULT_SCAN_CONCURRENCY}; a missing / corrupt / out-of-range row
 * resolves to the default (corruption-tolerant).
 */
export function getScanConcurrency(db: Database.Database): number {
  const raw = readRaw(db, KEY_SCAN_CONCURRENCY);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_SCAN_CONCURRENCY) {
    if (raw !== undefined) console.warn("app_config: scan.concurrency out of range; using default");
    return DEFAULT_SCAN_CONCURRENCY;
  }
  return raw;
}

/** Validate + store the scan concurrency. Throws (caller -> 400) on a non-integer or out-of-range value. */
export function setScanConcurrency(db: Database.Database, concurrency: number): number {
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_SCAN_CONCURRENCY
  ) {
    throw new Error(`scan concurrency must be an integer 1..${MAX_SCAN_CONCURRENCY}`);
  }
  writeRaw(db, KEY_SCAN_CONCURRENCY, concurrency);
  return concurrency;
}

// ---------- Topic taxonomy (the categories behind 主题河流) ----------

const KEY_TOPIC_CATEGORIES = "topicStream.categories";
const KEY_TOPIC_GAP = "topicStream.sessionGapMinutes";

/** Matches the file parser's default in src/topicStream/config.ts. */
export const DEFAULT_SESSION_GAP_MINUTES = 30;
const MAX_TOPIC_CATEGORIES = 64;
const MAX_RULES_PER_CATEGORY = 200;

/**
 * Only the user's OWN categories are stored — never the merged list.
 *
 * The taxonomy's merge rule is "your categories first, then every built-in whose
 * name you did not reuse". If the settings page saved the merged result, those
 * built-ins would be frozen into your config and a future ai2nao release could
 * never update or extend them. So the UI edits and saves additions/overrides
 * only, exactly like the hand-written config.json did.
 */
export type StoredTaxonomy = { categories: TopicCategory[]; gapMinutes: number };

function parseRule(raw: unknown): TaxonomyRule {
  if (typeof raw !== "object" || raw === null) throw new Error("rule must be an object");
  const { kind, value } = raw as { kind?: unknown; value?: unknown };
  if (typeof kind !== "string" || !(TAXONOMY_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`rule kind must be one of ${TAXONOMY_RULE_KINDS.join(", ")}`);
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("rule value must be non-empty");
  return { kind, value: value.trim() } as TaxonomyRule;
}

function parseCategory(raw: unknown): TopicCategory {
  if (typeof raw !== "object" || raw === null) throw new Error("category must be an object");
  const { name, color, rules } = raw as { name?: unknown; color?: unknown; rules?: unknown };
  if (typeof name !== "string" || !name.trim()) throw new Error("category name is required");
  // Reserved: 「其他」 is the bucket for everything that matches nothing. A user
  // category by that name would shadow it and make the leftovers unreachable.
  if (name.trim() === OTHER_CATEGORY) throw new Error(`「${OTHER_CATEGORY}」是保留名，不能用作分类名`);
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    throw new Error(`category "${name}" needs a #rrggbb color`);
  }
  if (!Array.isArray(rules)) throw new Error(`category "${name}" needs a rules array`);
  if (rules.length > MAX_RULES_PER_CATEGORY) {
    throw new Error(`category "${name}" has too many rules (max ${MAX_RULES_PER_CATEGORY})`);
  }
  // An empty rules list is allowed on purpose: it is how you neutralise a
  // built-in category (override its name, give it no rules → it matches nothing).
  return { name: name.trim(), color: color.trim(), rules: rules.map(parseRule) };
}

/** null when the user has never saved a taxonomy — caller then falls back to config.json. */
export function getTopicTaxonomy(db: Database.Database): StoredTaxonomy | null {
  const raw = readRaw(db, KEY_TOPIC_CATEGORIES);
  if (!Array.isArray(raw)) return null;
  let categories: TopicCategory[];
  try {
    categories = raw.map(parseCategory);
  } catch {
    // Corrupt row → behave as if unset, so a bad hand-edit degrades to the file
    // rather than taking the topic river down.
    console.warn("app_config: topicStream.categories is malformed; falling back to config.json");
    return null;
  }
  const gap = readRaw(db, KEY_TOPIC_GAP);
  const gapMinutes =
    typeof gap === "number" && Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_SESSION_GAP_MINUTES;
  return { categories, gapMinutes };
}

/** Validate + store. Throws (caller -> 400) on any malformed category or rule. */
export function setTopicTaxonomy(
  db: Database.Database,
  categories: unknown,
  gapMinutes: unknown
): StoredTaxonomy {
  if (!Array.isArray(categories)) throw new Error("categories must be an array");
  if (categories.length > MAX_TOPIC_CATEGORIES) {
    throw new Error(`too many categories (max ${MAX_TOPIC_CATEGORIES})`);
  }
  const parsed = categories.map(parseCategory);
  const seen = new Set<string>();
  for (const c of parsed) {
    if (seen.has(c.name)) throw new Error(`duplicate category name: ${c.name}`);
    seen.add(c.name);
  }
  if (
    typeof gapMinutes !== "number" ||
    !Number.isFinite(gapMinutes) ||
    gapMinutes <= 0 ||
    gapMinutes > 24 * 60
  ) {
    throw new Error("sessionGapMinutes must be a positive number of minutes (<= 1440)");
  }
  writeRaw(db, KEY_TOPIC_CATEGORIES, parsed);
  writeRaw(db, KEY_TOPIC_GAP, gapMinutes);
  return { categories: parsed, gapMinutes };
}

/** Forget the stored taxonomy; the reader falls back to config.json (or the built-ins). */
export function clearTopicTaxonomy(db: Database.Database): void {
  db.prepare("DELETE FROM app_config WHERE key IN (?, ?)").run(KEY_TOPIC_CATEGORIES, KEY_TOPIC_GAP);
}
