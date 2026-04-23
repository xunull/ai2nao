import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listProjects, listSessionJsonlFiles } from "../src/claudeCodeHistory/discover.js";

describe("claudeCodeHistory discover", () => {
  it("lists projects and jsonl sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccproj-"));
    const p1 = join(root, "project-a");
    await mkdir(p1);
    await writeFile(join(p1, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "{}\n", "utf8");
    await writeFile(
      join(p1, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.wakatime"),
      "x",
      "utf8"
    );

    const projects = await listProjects(root);
    expect(projects).toHaveLength(1);
    expect(projects[0].sessionCount).toBe(1);

    const files = await listSessionJsonlFiles(p1);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
