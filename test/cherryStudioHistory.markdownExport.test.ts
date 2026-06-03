import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  listCherryMarkdownSessions,
  loadCherryMarkdownSession,
} from "../src/cherryStudioHistory/markdownExport.js";

function makeRoot(): string {
  const root = join(tmpdir(), `ai2nao-cherry-md-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("cherryStudioHistory markdown export", () => {
  it("parses Cherry Studio Markdown topic exports", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "topic.md"),
      [
        "# 中文话题",
        "",
        "## 🧑‍💻 User",
        "",
        "帮我读取 Cherry Studio 对话。",
        "---",
        "## 🤖 Assistant | model",
        "",
        "可以从 Markdown 导出目录读取。",
        "",
        "```ts",
        "const ok = true",
        "```",
      ].join("\n"),
      "utf8"
    );

    const listed = await listCherryMarkdownSessions(root);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].title).toBe("中文话题");
    expect(listed.sessions[0].messageCount).toBe(2);

    const detail = await loadCherryMarkdownSession(root, listed.sessions[0].id);
    expect(detail.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.session.messages[1].codeBlocks[0]).toMatchObject({
      language: "ts",
      content: "const ok = true\n",
    });
  });

  it("keeps empty exports visible and warns on oversized files", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "empty.md"), "", "utf8");
    writeFileSync(join(root, "large.md"), "# Big\n\n" + "x".repeat(64), "utf8");

    const listed = await listCherryMarkdownSessions(root, { maxBytes: 16 });
    expect(listed.sessions.map((s) => s.title).sort()).toEqual(["(文件过大)", "empty"]);
    expect(listed.warnings.some((w) => w.includes("large.md"))).toBe(true);
  });
});
