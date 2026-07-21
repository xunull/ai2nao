/**
 * ai_tools 读侧。设计 F2:**按 `tool_key` 折叠**,一个工具一行,把多条
 * detect_source/evidence 合成一个来源列表 —— 否则 cask+app 双检测的工具会重复列出。
 */
import type Database from "better-sqlite3";
import type { AiToolDetectSource, AiToolKind, AiToolRow, AiToolView } from "./types.js";

export type ListAiToolsOptions = {
  /** 含卸载了(全部证据行都 missing)的工具,默认 false。 */
  includeMissing?: boolean;
};

/** 折叠后的清单,按 kind → name 排序。 */
export function listAiTools(
  db: Database.Database,
  opts: ListAiToolsOptions = {}
): AiToolView[] {
  const rows = db
    .prepare(
      `SELECT id, tool_key, name, kind, vendor, detect_source, evidence, version,
              install_path, first_seen_at, last_seen_at, missing_since
       FROM ai_tools
       ORDER BY tool_key`
    )
    .all() as AiToolRow[];

  const byTool = new Map<string, AiToolRow[]>();
  for (const row of rows) {
    const list = byTool.get(row.tool_key);
    if (list) list.push(row);
    else byTool.set(row.tool_key, [row]);
  }

  const views: AiToolView[] = [];
  for (const [toolKey, evidence] of byTool) {
    const present = evidence.filter((r) => r.missing_since == null);
    const active = present.length > 0 ? present : evidence;
    if (present.length === 0 && !opts.includeMissing) continue;

    // 展示字段从「在场」证据里挑(全 missing 时从全部里挑)。
    const first = active[0]!;
    const withVersion = active.find((r) => r.version != null);
    const withPath = active.find((r) => r.install_path != null);
    const sources = [
      ...new Set(active.map((r) => r.detect_source as AiToolDetectSource)),
    ];

    views.push({
      toolKey,
      name: first.name,
      kind: first.kind as AiToolKind,
      vendor: first.vendor,
      detectSources: sources,
      version: withVersion?.version ?? null,
      installPath: withPath?.install_path ?? null,
      firstSeenAt: active.reduce(
        (min, r) => (r.first_seen_at < min ? r.first_seen_at : min),
        first.first_seen_at
      ),
      lastSeenAt: active.reduce(
        (max, r) => (r.last_seen_at > max ? r.last_seen_at : max),
        first.last_seen_at
      ),
      missingSince:
        present.length > 0
          ? null
          : active.reduce<string | null>(
              (max, r) =>
                r.missing_since != null && (max == null || r.missing_since > max)
                  ? r.missing_since
                  : max,
              null
            ),
    });
  }

  const KIND_ORDER: AiToolKind[] = [
    "desktop-app",
    "cli",
    "local-runtime",
    "ide-extension",
  ];
  return views.sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return k !== 0 ? k : a.name.localeCompare(b.name);
  });
}

export type AiToolsStatus = {
  total: number;
  present: number;
  lastSyncAt: string | null;
};

export function getAiToolsStatus(db: Database.Database): AiToolsStatus {
  const tools = listAiTools(db, { includeMissing: true });
  const present = tools.filter((t) => t.missingSince == null).length;
  const lastSyncAt =
    (
      db
        .prepare(
          "SELECT value FROM local_inventory_sync_state WHERE key = 'ai_tools.last_sync_at'"
        )
        .get() as { value: string } | undefined
    )?.value ?? null;
  return { total: tools.length, present, lastSyncAt };
}
