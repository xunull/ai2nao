import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";
import { parseRagCorpusJson, readRagFileCorpus } from "../rag/config.js";
import { CredentialPatchError, mergePatch } from "./credentialApi.js";
import { getSettingRaw, setSettingRaw, deleteSetting, type SettingName } from "./store.js";

/**
 * The non-secret settings API.
 *
 * A setting and a credential are the same storage shape and share `mergePatch`
 * (absent = keep, null = clear, reject a masked placeholder). The difference is
 * only what leaves the server: a setting carries no secret, so its DTO returns
 * `values` verbatim — no redaction. Today the sole setting is `rag-corpus`, so
 * this is written for that one member directly rather than behind a one-entry
 * spec registry.
 */

export type SettingDto = {
  set: boolean;
  /** db = stored here; file = still only in rag.json; null = unconfigured. */
  source: "db" | "file" | null;
  label: string;
  /** The full (non-secret) config, or null when unconfigured. */
  values: unknown;
};

const SETTING_LABELS: Record<SettingName, string> = { "rag-corpus": "RAG 语料" };

export function isSettingName(x: string): x is SettingName {
  return x === "rag-corpus";
}

/**
 * Validate corpus roots the way `setScanRoots` does — absolute, existing,
 * directory, deduped — with ONE deliberate difference: NO canonicalization.
 *
 * RAG manifests are keyed by `source_root`, and ingest uses the same
 * `expandUserPath`-resolved (not realpath'd) root. Canonicalizing here would
 * rewrite a symlinked root (macOS `/tmp` → `/private/tmp`) to a value that no
 * longer matches any manifest row, so every file would read as "missing" and
 * the whole corpus would be deleted and re-embedded — a full paid re-index
 * triggered by a settings save. So we resolve `~` and relative segments but
 * never follow symlinks.
 */
function validateCorpusRoots(roots: unknown): string[] {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new CredentialPatchError("corpusRoots must be a non-empty array");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const errors: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || !raw.trim()) {
      errors.push("empty or non-string path");
      continue;
    }
    const p = expandUserPath(raw.trim()); // ~ + resolve, NOT realpath
    if (!isAbsolute(p)) {
      errors.push(`${raw}: not an absolute path`);
      continue;
    }
    try {
      if (!statSync(p).isDirectory()) {
        errors.push(`${raw}: not a directory`);
        continue;
      }
    } catch {
      errors.push(`${raw}: does not exist`);
      continue;
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (errors.length > 0) throw new CredentialPatchError(`invalid corpus roots: ${errors.join("; ")}`);
  return out;
}

/** Where the corpus config in effect actually comes from. Mirrors readRagConfig's
 * precedence: db setting → rag.json. */
export function settingDto(name: SettingName): SettingDto {
  const label = SETTING_LABELS[name];
  const stored = getSettingRaw(name);
  if (stored) {
    const parsed = parseRagCorpusJson(stored);
    if (parsed) return { set: true, source: "db", label, values: parsed };
  }
  const fromFile = readRagFileCorpus();
  if (fromFile) return { set: true, source: "file", label, values: fromFile };
  return { set: false, source: null, label, values: null };
}

export function allSettingDtos(): Record<string, SettingDto> {
  return { "rag-corpus": settingDto("rag-corpus") };
}

/**
 * Apply a partial update to a setting. Seeds the base from the stored row, or
 * from rag.json on first write, so editing one field never drops the others.
 * corpusRoots are existence-validated on the way in.
 */
export function patchSetting(name: SettingName, patch: Record<string, unknown>): SettingDto {
  const storedRaw = getSettingRaw(name);
  const base = storedRaw ? parseRagCorpusJson(storedRaw) : readRagFileCorpus();

  const merged = mergePatch(base ?? {}, patch);
  if ("corpusRoots" in merged) {
    merged.corpusRoots = validateCorpusRoots(merged.corpusRoots);
  }
  const validated = parseRagCorpusJson(JSON.stringify(merged));
  if (!validated) {
    throw new CredentialPatchError("resulting config is not a valid RAG corpus config");
  }
  // Store the corpus fields only (version is implied); parseRagCorpusJson
  // re-adds version on read.
  const { version: _v, embedding: _e, ...corpusOnly } = validated;
  setSettingRaw(name, JSON.stringify(corpusOnly));
  return settingDto(name);
}

/** Forget the stored setting; the reader falls back to rag.json. */
export function clearSetting(name: SettingName): SettingDto {
  deleteSetting(name);
  return settingDto(name);
}
