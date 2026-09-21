import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";
import { parseGithubRadarSettingJson } from "../github/config.js";
import { parseRagCorpusJson, readRagFileCorpus } from "../rag/config.js";
import { CredentialPatchError, mergePatch } from "./credentialApi.js";
import type { SettingSpec } from "./schema.js";
import {
  getSettingRaw,
  setSettingRaw,
  deleteSetting,
  SETTING_NAMES,
  type SettingName,
} from "./store.js";

/**
 * The non-secret settings API.
 *
 * A setting and a credential are the same storage shape and share `mergePatch`
 * (absent = keep, null = clear, reject a masked placeholder). The difference is
 * only what leaves the server: a setting carries no secret, so its DTO returns
 * `values` verbatim — no redaction.
 *
 * 每个设置的「怎么解析、从哪回退、怎么校验」住在 `SETTING_SPECS` 里,本文件只按名分派。
 * 这里原先是照着「只有 rag-corpus 一个成员」写死的(当时的注释说不值得为一个成员
 * 建注册表);第二个设置出现之后那个前提没了。形状照抄 `CREDENTIAL_SPECS`。
 */

export type SettingDto = {
  set: boolean;
  /** db = stored here; file = still only in rag.json; null = unconfigured. */
  source: "db" | "file" | null;
  label: string;
  /** The full (non-secret) config, or null when unconfigured. */
  values: unknown;
};

export function isSettingName(x: string): x is SettingName {
  return (SETTING_NAMES as readonly string[]).includes(x);
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

export const SETTING_SPECS: Record<SettingName, SettingSpec> = {
  "rag-corpus": {
    label: "RAG 语料",
    parse: parseRagCorpusJson,
    fileFallback: readRagFileCorpus,
    validate: (merged) => {
      if ("corpusRoots" in merged) {
        merged.corpusRoots = validateCorpusRoots(merged.corpusRoots);
      }
      const validated = parseRagCorpusJson(JSON.stringify(merged));
      if (!validated) {
        throw new CredentialPatchError("resulting config is not a valid RAG corpus config");
      }
      // 只存语料字段(version 由读取侧补回),embedding 属于凭据那一侧。
      const { version: _v, embedding: _e, ...corpusOnly } = validated;
      return corpusOnly;
    },
  },
  "github-radar": {
    label: "开源雷达 · 当前工作目录",
    parse: parseGithubRadarSettingJson,
    // 没有回退文件 —— 这个设置是新的,不存在需要迁移的历史 JSON。
    fileFallback: null,
    validate: (merged) => ({ cwd: validateRadarCwd(merged.cwd) }),
  },
};

/**
 * 雷达目录:绝对路径 + 存在 + 是目录。空串合法,表示「不扫当前工作」。
 *
 * **不要求是 git 仓库**:当前工作扫描除了 git 还有 TODO 与文档两类来源,
 * 一个非 git 的笔记目录仍然有用;git 那一路在运行时给 warning 就够。
 *
 * 与 corpusRoots 同口径:保存时就校验存在性。这个设置的唯一作用就是让 git 命令
 * 在那儿跑,路径错了它就是个纯粹的配置错误,越早说越好。
 */
function validateRadarCwd(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") throw new CredentialPatchError("cwd must be a string");
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const p = expandUserPath(trimmed);
  if (!isAbsolute(p)) throw new CredentialPatchError(`${trimmed}: not an absolute path`);
  try {
    if (!statSync(p).isDirectory()) throw new CredentialPatchError(`${trimmed}: not a directory`);
  } catch (e) {
    if (e instanceof CredentialPatchError) throw e;
    throw new CredentialPatchError(`${trimmed}: does not exist`);
  }
  return p;
}

/** Where the config in effect actually comes from: db setting → 该设置的回退文件。 */
export function settingDto(name: SettingName): SettingDto {
  const spec = SETTING_SPECS[name];
  const stored = getSettingRaw(name);
  if (stored) {
    const parsed = spec.parse(stored);
    if (parsed) return { set: true, source: "db", label: spec.label, values: parsed };
  }
  const fromFile = spec.fileFallback?.() ?? null;
  if (fromFile) return { set: true, source: "file", label: spec.label, values: fromFile };
  return { set: false, source: null, label: spec.label, values: null };
}

export function allSettingDtos(): Record<string, SettingDto> {
  return Object.fromEntries(SETTING_NAMES.map((n) => [n, settingDto(n)]));
}

/**
 * Apply a partial update to a setting. Seeds the base from the stored row, or
 * from the setting's fallback file on first write, so editing one field never
 * drops the others. 校验由该设置自己的 `validate` 负责。
 */
export function patchSetting(name: SettingName, patch: Record<string, unknown>): SettingDto {
  const spec = SETTING_SPECS[name];
  const storedRaw = getSettingRaw(name);
  const base = storedRaw ? spec.parse(storedRaw) : (spec.fileFallback?.() ?? null);
  const merged = mergePatch((base as Record<string, unknown>) ?? {}, patch);
  setSettingRaw(name, JSON.stringify(spec.validate(merged)));
  return settingDto(name);
}

/** Forget the stored setting; the reader falls back to that setting's file, if any. */
export function clearSetting(name: SettingName): SettingDto {
  deleteSetting(name);
  return settingDto(name);
}
