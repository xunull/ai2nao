import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractKimiMessages } from "../src/kimiHistory/myMessages.js";
import { cleanKimiUserText } from "../src/kimiHistory/normalize.js";
import { defaultKimiCliRoot, defaultKimiDesktopRoot, sandboxDefaultWorkDir }
  from "../src/kimiHistory/paths.js";
import { scanKimiWireFiles } from "../src/kimiHistory/scan.js";

/**
 * 真实机器数据对账。**四家源里只有 kimi 能做这件事** ——
 * `~/.kimi-code/user-history/*.jsonl` 是另一条独立写入路径,记录你敲进去的每一行字。
 * 拿它对账 wire.jsonl 的抽取结果,能证明的是**召回率**,而不只是「代码符合我对格式的理解」。
 * claude / codex / opencode 都没有这种外部对照物。
 *
 * 公开仓库 + 别人的机器上没有 ~/.kimi-code,所以整块用 describe.skipIf 条件跳过,
 * 路径一律 os.homedir() 拼接、不写字面量(gitleaks 会拦真实 home 路径)。
 */
const CLI_ROOT = defaultKimiCliRoot();
const DESKTOP_ROOT = defaultKimiDesktopRoot();
const USER_HISTORY = join(homedir(), ".kimi-code", "user-history");
const hasKimi = existsSync(CLI_ROOT);

describe.skipIf(!hasKimi)("kimi 真实数据对账", () => {
  const scanAll = () => scanKimiWireFiles().files;

  it("user-history 里敲过的字都能在抽取结果里找到(召回率)", () => {
    const extracted = new Set<string>();
    for (const f of scanAll()) {
      for (const m of extractKimiMessages(f).messages) {
        if (m.role === "user" && m.isHuman) extracted.add(m.cleanedText.trim());
      }
    }

    const typed = new Set<string>();
    if (existsSync(USER_HISTORY)) {
      for (const name of readdirSync(USER_HISTORY)) {
        if (!name.endsWith(".jsonl")) continue;
        for (const line of readFileSync(join(USER_HISTORY, name), "utf-8").split("\n")) {
          const s = line.trim();
          if (!s) continue;
          try {
            const c = (JSON.parse(s) as { content?: unknown }).content;
            if (typeof c === "string" && c.trim()) typed.add(c.trim());
          } catch { /* 坏行跳过 */ }
        }
      }
    }
    expect(typed.size).toBeGreaterThan(0);

    // 差集只允许两类:斜杠命令(/model /plugins,不是对话)和 ! 开头的 shell 逃逸。
    // 出现别的,说明抽取口径漏了一类真人输入 —— 那 26 条 origin=null 当初就是这样发现的。
    const missing = [...typed].filter((t) => !extracted.has(t));
    const unexplained = missing.filter((m) => !/^[/!]/.test(m));
    expect(unexplained).toEqual([]);
  });

  it("origin 为 null 的那批真人消息确实进了抽取结果", () => {
    let nullOrigin = 0;
    for (const f of scanAll()) {
      for (const line of readFileSync(f.filePath, "utf-8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const d = JSON.parse(s) as { type?: string; message?: { origin?: unknown; content?: unknown } };
          if (d.type !== "context.append_message" || !d.message) continue;
          if (d.message.origin !== null && d.message.origin !== undefined) continue;
          const text = Array.isArray(d.message.content)
            ? d.message.content.map((p: { text?: unknown }) =>
                typeof p?.text === "string" ? p.text : "").join("")
            : "";
          if (text.trim()) nullOrigin++;
        } catch { /* 坏行跳过 */ }
      }
    }
    // 只在这台机器有这类数据时才断言(它 2026-08-11 之后才出现)
    if (nullOrigin === 0) return;

    let human = 0;
    for (const f of scanAll()) {
      for (const m of extractKimiMessages(f).messages) {
        if (m.role === "user" && m.isHuman) human++;
      }
    }
    expect(human).toBeGreaterThanOrEqual(nullOrigin);
  });

  it("标题生成会话(ctitle-*)被滤掉了", () => {
    const files = scanAll();
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.filePath.includes("/ctitle-"))).toEqual([]);
  });

  it("沙箱默认 workDir 的会话 project 为空,不造出一个叫 workspace 的假项目", () => {
    const sandbox = sandboxDefaultWorkDir();
    let sawSandbox = false;
    for (const f of scanAll()) {
      const ex = extractKimiMessages(f);
      if (ex.projectPath === sandbox) sawSandbox = true;
      expect(ex.projectPath).not.toBe(sandbox);
    }
    expect(sawSandbox).toBe(false);
  });

  describe.skipIf(!existsSync(DESKTOP_ROOT))("桌面版:wire 是 transcripts 的超集(4A 的前提)", () => {
    it("transcripts 抽到的每一条都能在 wire 结果里找到", () => {
      const days = join(homedir(), "Library", "Application Support", "kimi-desktop",
        "daimon-share", "daimon", "agents", "main", "memory", "transcripts", "days");
      if (!existsSync(days)) return;

      const fromTranscripts = new Set<string>();
      for (const day of readdirSync(days)) {
        const dir = join(days, day);
        let names: string[];
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (!name.startsWith("conv-") || !name.endsWith(".jsonl")) continue;
          for (const line of readFileSync(join(dir, name), "utf-8").split("\n")) {
            const s = line.trim();
            if (!s) continue;
            try {
              const d = JSON.parse(s) as { role?: string; content?: unknown };
              if (d.role !== "user" || typeof d.content !== "string") continue;
              // 两层的标签约定不同(wire 带 <meta/>,transcripts 带 <attachment>),
              // 必须用同一个清洗器归一化后再比,否则比的是表示而不是内容。
              const c = cleanKimiUserText(d.content);
              if (c) fromTranscripts.add(c);
            } catch { /* 坏行跳过 */ }
          }
        }
      }
      if (fromTranscripts.size === 0) return;

      const fromWire = new Set<string>();
      for (const f of scanAll()) {
        if (f.rootKind !== "desktop") continue;
        for (const m of extractKimiMessages(f).messages) {
          if (m.role === "user" && m.isHuman) fromWire.add(m.cleanedText.trim());
        }
      }
      // 这一条挂了说明 4A 的「wire 更全」判断在这台机器上不成立,
      // 该退回读两层取并集(评审里的选项 4C)。
      expect([...fromTranscripts].filter((t) => !fromWire.has(t))).toEqual([]);
    });
  });
});
