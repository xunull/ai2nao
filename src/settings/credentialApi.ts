import { existsSync, readFileSync } from "node:fs";
import { CREDENTIAL_SPECS, STRING_SECRET_FIELDS } from "./schema.js";
import {
  CREDENTIAL_NAMES,
  type CredentialName,
  deleteCredential,
  getCredentialRaw,
  setCredentialRaw,
} from "./store.js";

/**
 * The shape the settings API speaks. `values` is the credential with every
 * secret field removed; the plaintext key never leaves the process.
 */
export type CredentialDto = {
  set: boolean;
  source: "env" | "db" | "file" | null;
  label: string;
  /** Non-secret fields only (provider, model, baseURL, hours…). */
  values: unknown;
};

export function isCredentialName(x: string): x is CredentialName {
  return (CREDENTIAL_NAMES as readonly string[]).includes(x);
}

/** Legacy JSON file, parsed — the fallback a reader would still use today. */
function fromLegacyFile(name: CredentialName): unknown | null {
  const spec = CREDENTIAL_SPECS[name];
  if (!spec.legacyPath) return null;
  const path = spec.legacyPath();
  if (!existsSync(path)) return null;
  try {
    return spec.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Report where a credential actually comes from, mirroring each reader's real
 * precedence — env first only for the two that have always been env-first
 * (GITHUB_TOKEN, BRAVE_SEARCH_API_KEY), db-then-file for the rest.
 */
export function credentialDto(name: CredentialName): CredentialDto {
  const spec = CREDENTIAL_SPECS[name];

  if (spec.envVar && (process.env[spec.envVar] ?? "").trim()) {
    return { set: true, source: "env", label: spec.label, values: null };
  }

  const stored = getCredentialRaw(name);
  if (stored) {
    const parsed = spec.parse(stored);
    if (parsed) {
      return {
        set: spec.hasSecret(parsed),
        source: "db",
        label: spec.label,
        values: spec.redact(parsed),
      };
    }
  }

  const fromFile = fromLegacyFile(name);
  if (fromFile) {
    return {
      set: spec.hasSecret(fromFile),
      source: "file",
      label: spec.label,
      values: spec.redact(fromFile),
    };
  }

  return { set: false, source: null, label: spec.label, values: null };
}

export function allCredentialDtos(): Record<string, CredentialDto> {
  const out: Record<string, CredentialDto> = {};
  for (const name of CREDENTIAL_NAMES) out[name] = credentialDto(name);
  return out;
}

export class CredentialPatchError extends Error {}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * A value the UI echoed back from a masked field. Writing it through would
 * replace a real key with a row of asterisks — the single most destructive thing
 * a settings form can do, and it looks like success.
 */
function isMaskPlaceholder(v: unknown): boolean {
  return typeof v === "string" && /^\*+$/.test(v.trim());
}

/**
 * Merge a PATCH body over the stored value:
 *   absent key  → keep the existing value  (so "change only the model" keeps the key)
 *   null        → clear the field
 *   value       → overwrite
 * Nested objects (feishu / daily / weekly) merge one level down by the same rules.
 */
export function mergePatch(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    // **密钥字段的类型闸。** null 已在上面当成「清掉」处理,到这里还不是字符串
    // 就是类型混淆(最常见的来源是把脱敏 DTO 原样回写)。放过去的后果是
    // parse 把它读成 undefined —— 真密钥静默消失,而且返回 200。
    if ((STRING_SECRET_FIELDS as readonly string[]).includes(k) && typeof v !== "string") {
      throw new CredentialPatchError(
        `${k} must be a string (or null to clear); refusing to overwrite a stored secret with ${typeof v}`
      );
    }
    if (isMaskPlaceholder(v)) {
      throw new CredentialPatchError(`${k} looks like a masked placeholder; omit it to keep the current value`);
    }
    if (isPlainObject(v)) {
      out[k] = mergePatch(out[k], v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Apply a partial update. Reads the current value from config.db, or seeds from
 * the legacy file on first write so an edit made before migration runs can't
 * silently drop the fields that only existed in the file.
 */
export function patchCredential(name: CredentialName, patch: Record<string, unknown>): CredentialDto {
  const spec = CREDENTIAL_SPECS[name];
  const storedRaw = getCredentialRaw(name);
  const base = storedRaw ? spec.parse(storedRaw) : fromLegacyFile(name);

  const merged = mergePatch(base, patch);
  const validated = spec.parse(JSON.stringify(merged));
  if (!validated) {
    throw new CredentialPatchError("resulting config is not valid for this credential");
  }
  setCredentialRaw(name, JSON.stringify(validated));
  return credentialDto(name);
}

/**
 * Forget a stored credential. Any legacy file and any env var still apply —
 * `source` in the returned DTO says which, so the UI can tell the user the
 * feature is still on rather than pretending it went away.
 */
export function clearCredential(name: CredentialName): CredentialDto {
  deleteCredential(name);
  return credentialDto(name);
}
