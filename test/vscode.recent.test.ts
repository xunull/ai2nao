import { describe, expect, it } from "vitest";
import { parseRecentlyOpenedPathsList } from "../src/vscode/recent.js";

describe("VS Code recent parser", () => {
  it("parses local folders, files, workspaces and redacts remote URIs", () => {
    const result = parseRecentlyOpenedPathsList(
      {
        entries: [
          { folderUri: "file:///tmp/project", label: "project" },
          { fileUri: "file:///tmp/project/src/main.ts" },
          { workspace: { configPath: "file:///tmp/project/app.code-workspace" } },
          {
            folderUri: "vscode-remote://ssh-remote+alice@example.com/home/alice/private",
            remoteAuthority: "ssh-remote+alice@example.com",
            label: "private",
          },
        ],
      },
      "test-salt"
    );

    expect(result.entries).toHaveLength(4);
    expect(result.entries[0]).toMatchObject({
      kind: "folder",
      uriRedacted: "file:///tmp/project",
      path: "/tmp/project",
    });
    expect(result.entries[3].path).toBeNull();
    expect(result.entries[3].uriRedacted).not.toContain("alice");
    expect(result.entries[3].uriRedacted).not.toContain("example.com");
    expect(result.entries[3].remoteAuthorityHash).toMatch(/^[0-9a-f]{24}$/);
    expect(result.warnings).toEqual([]);
  });

  it("treats an empty entries array as an empty snapshot", () => {
    const result = parseRecentlyOpenedPathsList({ entries: [] }, "salt");
    expect(result.emptySnapshot).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("skips unknown entry shapes with a warning", () => {
    const result = parseRecentlyOpenedPathsList({ entries: [{ nope: true }] }, "salt");
    expect(result.entries).toEqual([]);
    expect(result.warnings[0]?.code).toBe("entry_unknown_shape");
  });

  it("keeps VS Code remote authorities intact before hashing when remoteAuthority is absent", () => {
    const result = parseRecentlyOpenedPathsList(
      {
        entries: [
          {
            folderUri: "vscode-remote://ssh-remote+alice@example.com/home/alice/private",
            label: "private",
          },
        ],
      },
      "salt"
    );

    expect(result.entries[0].remoteType).toBe("ssh-remote");
    expect(result.entries[0].uriRedacted).not.toContain("alice");
    expect(result.entries[0].uriRedacted).not.toContain("example.com");
  });
});
