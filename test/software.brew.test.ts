import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { syncBrewPackages } from "../src/software/brew/sync.js";
import { resetSoftwareSource } from "../src/software/reset.js";
import { openDatabase } from "../src/store/open.js";

describe("syncBrewPackages", () => {
  it("parses Homebrew JSON, stores raw_json, and reset only deletes brew rows", async () => {
    const base = join(tmpdir(), `ai2nao-brew-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const brew = join(base, "brew");
    writeFileSync(brew, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(brew, 0o755);
    const db = openDatabase(join(base, "idx.db"));
    try {
      db.prepare(
        `INSERT INTO mac_apps (
          name, path, source_root, first_seen_at, last_seen_at, inserted_at, updated_at
        ) VALUES ('App', '/Applications/App.app', '/Applications', 'now', 'now', 'now', 'now')`
      ).run();

      const result = await syncBrewPackages(db, {
        brewPath: brew,
        allowCustomBrewPath: true,
        commandRunner: async () => ({
          stderr: "",
          stdout: JSON.stringify({
            formulae: [
              {
                name: "ripgrep",
                full_name: "ripgrep",
                desc: "search tool",
                homepage: "https://example.test",
                tap: "homebrew/core",
                versions: { stable: "14.0.0" },
                installed: [
                  {
                    version: "14.0.0",
                    installed_as_dependency: false,
                    installed_on_request: true,
                  },
                ],
                aliases: ["rg"],
                dependencies: ["pcre2"],
              },
            ],
            casks: [
              {
                token: "visual-studio-code",
                full_token: "homebrew/cask/visual-studio-code",
                version: "1.0",
                installed: ["1.0"],
                name: ["Visual Studio Code"],
                tap: "homebrew/cask",
              },
            ],
          }),
        }),
      });

      expect(result.status).toBe("success");
      expect(result.inserted).toBe(2);
      const row = db
        .prepare("SELECT raw_json FROM brew_packages WHERE kind = 'formula' AND name = 'ripgrep'")
        .get() as { raw_json: string };
      expect(JSON.parse(row.raw_json).name).toBe("ripgrep");

      const reset = resetSoftwareSource(db, "brew");
      expect(reset.deletedRows).toBe(2);
      const appCount = db.prepare("SELECT COUNT(*) AS n FROM mac_apps").get() as { n: number };
      expect(appCount.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("falls back to brew list and reports partial metadata", async () => {
    const base = join(tmpdir(), `ai2nao-brew-fallback-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const brew = join(base, "brew");
    writeFileSync(brew, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(brew, 0o755);
    const db = openDatabase(join(base, "idx.db"));
    try {
      const result = await syncBrewPackages(db, {
        brewPath: brew,
        allowCustomBrewPath: true,
        commandRunner: async (_file, args) => {
          if (args[0] === "info") throw new Error("json failed");
          if (args.includes("--formula")) return { stdout: "node\n", stderr: "" };
          return { stdout: "iterm2\n", stderr: "" };
        },
      });
      expect(result.status).toBe("partial");
      expect(result.inserted).toBe(2);
      const raw = db.prepare("SELECT raw_json FROM brew_packages WHERE name = 'node'").get() as {
        raw_json: string | null;
      };
      expect(raw.raw_json).toBeNull();
    } finally {
      db.close();
    }
  });
});
