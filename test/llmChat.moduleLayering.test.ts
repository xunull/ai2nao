import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守住 llmChat 三个模块的依赖方向:**config → views → document**,单向。
 *
 * 为什么值得一条专门的测试:`document.ts` 里的 `LLM_CHAT_PROVIDERS` 是模块顶层
 * `Object.keys(...)` 求值。一旦 document 或 views 反向 import 了 `config.ts`,
 * 成环之后是**模块加载期 TDZ** —— 报错点离病根很远,而且未必每条测试都触发,
 * 可能只在某个 import 顺序下炸。tsc 完全不管这件事。
 *
 * `config.ts` 末尾对 document/views 的 re-export **不是**环:re-export 是
 * config 依赖它们,方向仍然向下。
 */
const SRC = join(process.cwd(), "src", "llmChat");

/**
 * 直接扫 `from "./x.js"`,不去匹配 import/export 前缀,且**先剥掉注释**。
 *
 * 两个坑都踩过:注释里写了 `from "./config.js"` 这句话,会被当成真的自引用;
 * 而第一版写成 `(?:import|export)[\s\S]*?from "\./…"`,惰性通配会跨语句回溯 ——
 * `from "../config.js"` 那行匹配失败后,引擎把 `from` 挪到后面的
 * `from "./document.js"` 上仍然算一次匹配,结果凭空多出条目。
 * 同目录 import 的形状就是 `"./x.js"`,不需要前缀参与判断。
 */
/** 去掉块注释与行注释 —— 否则注释里提到的模块路径会被当成真的 import。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

function importedLocalModules(file: string): string[] {
  const text = stripComments(readFileSync(join(SRC, file), "utf8"));
  const out = new Set<string>();
  const re = /from\s+"\.\/([A-Za-z0-9_-]+)\.js"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

describe("llmChat 模块分层", () => {
  it("document.ts 不 import 任何 llmChat 内部模块 —— 它是最底层", () => {
    // 解析需要地址表,读取管道需要解析。地址表若留在 config.ts 就必然成环,
    // 所以它住在 document.ts。这条断言守的就是「别把它搬回去」。
    expect(importedLocalModules("document.ts")).toEqual([]);
  });

  it("views.ts 只向下依赖 document / apiKeySource", () => {
    expect(importedLocalModules("views.ts").sort()).toEqual(["apiKeySource", "document"]);
  });

  it("views.ts 不反向 import config", () => {
    expect(importedLocalModules("views.ts")).not.toContain("config");
  });

  it("apiKeySource.ts 的类型来自 document 而不是 config", () => {
    // config 会 import apiKeySource(运行期真依赖)。apiKeySource 若回指 config,
    // 即便是 type-only 也容易在后续改动里被误升级成值 import。
    const imports = importedLocalModules("apiKeySource.ts");
    expect(imports).not.toContain("config");
    expect(imports).toContain("document");
  });

  it("config.ts 的 re-export 只向下 —— 它可以依赖那两个,但那两个不认识它", () => {
    const cfg = importedLocalModules("config.ts").sort();
    // 只有这三个同目录依赖(log 是日志)。"config" 不该出现 —— 那是自引用。
    expect(cfg).toEqual(["document", "log", "views"]);
  });
});
