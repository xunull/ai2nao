import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAiTools } from "../src/aiTools/queries.js";
import { scanAiTools } from "../src/aiTools/scan.js";
import type { AiToolFingerprint } from "../src/aiTools/types.js";
import { openDatabase } from "../src/store/open.js";

// 测试专用指纹库(不依赖真 registry 内容)。
const REG: AiToolFingerprint[] = [
  {
    toolKey: "claude-desktop",
    name: "Claude",
    kind: "desktop-app",
    vendor: "Anthropic",
    macBundleIdPrefix: "com.anthropic.",
    binaries: ["claude"],
  },
  {
    toolKey: "ollama",
    name: "Ollama",
    kind: "local-runtime",
    vendor: "Ollama",
    brewFormula: "ollama",
    brewCask: "ollama",
    binaries: ["ollama"],
  },
  {
    toolKey: "lm-studio",
    name: "LM Studio",
    kind: "local-runtime",
    macNameExact: "LM Studio",
    brewCask: "lm-studio",
  },
  { toolKey: "codex-cli", name: "Codex CLI", kind: "cli", binaries: ["codex"] },
];

const T0 = "2026-07-21T00:00:00.000Z";

describe("scanAiTools + listAiTools", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-aitools-"));
    db = openDatabase(join(dir, "index.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertMacApp(a: {
    bundleId?: string | null;
    name: string;
    path: string;
    version?: string | null;
  }) {
    db.prepare(
      `INSERT INTO mac_apps (bundle_id, name, path, version, source_root,
         first_seen_at, last_seen_at, inserted_at, updated_at)
       VALUES (@bundleId, @name, @path, @version, '/Applications', @now, @now, @now, @now)`
    ).run({
      bundleId: a.bundleId ?? null,
      name: a.name,
      path: a.path,
      version: a.version ?? null,
      now: T0,
    });
  }
  function insertBrew(b: { kind: "formula" | "cask"; name: string; version?: string | null }) {
    db.prepare(
      `INSERT INTO brew_packages (kind, name, installed_version,
         first_seen_at, last_seen_at, inserted_at, updated_at)
       VALUES (@kind, @name, @version, @now, @now, @now, @now)`
    ).run({ kind: b.kind, name: b.name, version: b.version ?? null, now: T0 });
  }
  const scan = (pathDirs: string[] = [], at = "2026-07-21T02:00:00.000Z") =>
    scanAiTools(db, { registry: REG, pathDirs, now: () => new Date(at) });
  const count = (where = "") =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ai_tools ${where}`).get() as { n: number }).n;

  it("匹配指纹:命中产出证据行,非 AI 工具忽略(负例)", () => {
    insertMacApp({ bundleId: "com.anthropic.claudefordesktop", name: "Claude", path: "/Applications/Claude.app" });
    insertMacApp({ bundleId: "com.apple.Safari", name: "Safari", path: "/Applications/Safari.app" });
    insertMacApp({ name: "SomeAI Thing", path: "/Applications/SomeAI.app" }); // 名带 AI 但不在库
    const r = scan();
    expect(r.ok).toBe(true);
    expect(listAiTools(db).map((t) => t.toolKey)).toEqual(["claude-desktop"]);
  });

  it("重扫幂等:两次扫描 ai_tools 行数不变,第二次全是 update", () => {
    insertMacApp({ bundleId: "com.anthropic.claudefordesktop", name: "Claude", path: "/Applications/Claude.app" });
    insertBrew({ kind: "formula", name: "ollama", version: "0.1.0" });
    scan();
    const n1 = count();
    const r2 = scan();
    expect(count()).toBe(n1);
    expect(r2.inserted).toBe(0);
  });

  it("软删除:源里工具消失 → ai_tools 行标 missing_since,不硬删", () => {
    insertMacApp({ bundleId: "com.anthropic.claudefordesktop", name: "Claude", path: "/Applications/Claude.app" });
    scan();
    expect(listAiTools(db).some((t) => t.toolKey === "claude-desktop")).toBe(true);

    db.prepare("UPDATE mac_apps SET missing_since = ? WHERE bundle_id = ?").run(
      "2026-07-21T01:00:00.000Z",
      "com.anthropic.claudefordesktop"
    );
    const r = scan([], "2026-07-21T04:00:00.000Z");
    expect(r.markedMissing).toBe(1);
    expect(listAiTools(db)).toHaveLength(0); // 默认不含 missing
    expect(count()).toBe(1); // 行还在(不硬删)
    const withMissing = listAiTools(db, { includeMissing: true });
    expect(withMissing.find((t) => t.toolKey === "claude-desktop")?.missingSince).not.toBeNull();
  });

  it("跨源折叠(F2):mac_apps + brew cask 双检测 → 视图一行、来源合并", () => {
    insertMacApp({ name: "LM Studio", path: "/Applications/LM Studio.app" });
    insertBrew({ kind: "cask", name: "lm-studio" });
    scan();
    expect(count("WHERE tool_key = 'lm-studio'")).toBe(2); // 底表两条证据

    const lm = listAiTools(db).filter((t) => t.toolKey === "lm-studio");
    expect(lm).toHaveLength(1);
    expect([...lm[0]!.detectSources].sort()).toEqual(["brew", "mac_apps"]);
  });

  it("盲区探测器:假 PATH 目录放二进制 → 探到为 path 源;移走 → 软删除", () => {
    const bin = join(dir, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    const r = scan([bin]);
    expect(r.ok).toBe(true);
    const codex = listAiTools(db).find((t) => t.toolKey === "codex-cli");
    expect(codex?.detectSources).toEqual(["path"]);

    const empty = join(dir, "emptybin");
    mkdirSync(empty, { recursive: true });
    scan([empty], "2026-07-21T05:00:00.000Z");
    expect(listAiTools(db).find((t) => t.toolKey === "codex-cli")).toBeUndefined();
  });

  it("evidence 稳定性(F3):app 换安装路径 → 不多出行、不被误标 missing", () => {
    insertMacApp({ bundleId: "com.anthropic.claudefordesktop", name: "Claude", path: "/Applications/Claude.app" });
    scan();
    expect(count("WHERE tool_key='claude-desktop' AND detect_source='mac_apps'")).toBe(1);

    // app 挪目录,bundle_id 不变(用 /tmp 占位,避真实家目录)。
    db.prepare("UPDATE mac_apps SET path = ? WHERE bundle_id = ?").run(
      "/tmp/moved/Claude.app",
      "com.anthropic.claudefordesktop"
    );
    scan([], "2026-07-21T06:00:00.000Z");

    const rows = db
      .prepare(
        "SELECT install_path, missing_since FROM ai_tools WHERE tool_key='claude-desktop' AND detect_source='mac_apps'"
      )
      .all() as { install_path: string; missing_since: string | null }[];
    expect(rows).toHaveLength(1); // evidence=bundle_id 不变 → 无新行
    expect(rows[0]!.missing_since).toBeNull(); // 没被误标 missing
    expect(rows[0]!.install_path).toBe("/tmp/moved/Claude.app"); // 路径更新到可变列
  });
});
