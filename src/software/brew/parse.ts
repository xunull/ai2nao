export type BrewPackageKind = "formula" | "cask";

export type BrewPackageRecord = {
  kind: BrewPackageKind;
  name: string;
  full_name: string | null;
  installed_version: string | null;
  current_version: string | null;
  desc: string | null;
  homepage: string | null;
  tap: string | null;
  installed_as_dependency: number | null;
  installed_on_request: number | null;
  outdated: number;
  caveats: string | null;
  aliases_json: string;
  dependencies_json: string;
  raw_json: string | null;
};

type BrewInfoV2 = {
  formulae?: unknown[];
  casks?: unknown[];
};

export function parseBrewInfoJson(raw: string): BrewPackageRecord[] {
  const parsed = JSON.parse(raw) as BrewInfoV2;
  const out: BrewPackageRecord[] = [];
  for (const f of parsed.formulae ?? []) {
    if (!isRecord(f)) continue;
    const name = stringValue(f.name);
    if (!name) continue;
    const installed = Array.isArray(f.installed) ? f.installed.filter(isRecord) : [];
    const latestInstalled = installed[installed.length - 1];
    out.push({
      kind: "formula",
      name,
      full_name: stringValue(f.full_name),
      installed_version: stringValue(latestInstalled?.version),
      current_version: stringValue(f.versions && isRecord(f.versions) ? f.versions.stable : null),
      desc: stringValue(f.desc),
      homepage: stringValue(f.homepage),
      tap: stringValue(f.tap),
      installed_as_dependency: boolInt(latestInstalled?.installed_as_dependency),
      installed_on_request: boolInt(latestInstalled?.installed_on_request),
      outdated: 0,
      caveats: stringValue(f.caveats),
      aliases_json: JSON.stringify(arrayStrings(f.aliases)),
      dependencies_json: JSON.stringify(arrayStrings(f.dependencies)),
      raw_json: JSON.stringify(f),
    });
  }
  for (const c of parsed.casks ?? []) {
    if (!isRecord(c)) continue;
    const names = arrayStrings(c.name);
    const token = stringValue(c.token) ?? names[0];
    if (!token) continue;
    const installed = arrayStrings(c.installed);
    const version = installed[installed.length - 1] ?? stringValue(c.version);
    out.push({
      kind: "cask",
      name: token,
      full_name: stringValue(c.full_token),
      installed_version: version,
      current_version: stringValue(c.version),
      desc: stringValue(c.desc),
      homepage: stringValue(c.homepage),
      tap: stringValue(c.tap),
      installed_as_dependency: null,
      installed_on_request: null,
      outdated: 0,
      caveats: stringValue(c.caveats),
      aliases_json: JSON.stringify(names.filter((n) => n !== token)),
      dependencies_json: JSON.stringify([]),
      raw_json: JSON.stringify(c),
    });
  }
  return out;
}

export function parseBrewListOutput(
  raw: string,
  kind: BrewPackageKind
): BrewPackageRecord[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({
      kind,
      name,
      full_name: null,
      installed_version: null,
      current_version: null,
      desc: null,
      homepage: null,
      tap: null,
      installed_as_dependency: null,
      installed_on_request: null,
      outdated: 0,
      caveats: null,
      aliases_json: "[]",
      dependencies_json: "[]",
      raw_json: null,
    }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function stringValue(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function boolInt(v: unknown): number | null {
  return typeof v === "boolean" ? (v ? 1 : 0) : null;
}

function arrayStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
