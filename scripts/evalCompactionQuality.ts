/**
 * 压缩摘要的**内容质量**评测(设计文档《压缩协议》评审 10A)。手动触发,不进 CI。
 *
 * 做什么:几段真实风格的长对话,交给真模型走一遍真实的摘要器(`summarizeForCompaction`),
 * 然后逐条检查 —— 决定、约束、文件路径是否还在摘要里,已执行的动作是否还在后端生成的清单里。
 * 格式正确与否由单测管;这里管「压完之后要紧的东西丢没丢」,这件事只有真模型答得了。
 *
 * **会发真实请求、会花钱**(每段对话几千输入 token + 每块最多 2048 输出 token)。
 * 不带 `--yes` 只打印计划与估算,一个请求都不发。
 *
 * 运行:
 *   npx tsx scripts/evalCompactionQuality.ts                 # 只看计划
 *   npx tsx scripts/evalCompactionQuality.ts --yes           # 真跑,默认用配置里的默认模型
 *   npx tsx scripts/evalCompactionQuality.ts --yes --model legacy:deepseek-v4-flash
 *
 * 只读你的模型配置(取 key 与模型);对话写进一个临时库,跑完即删,不碰 ~/.ai2nao/index.db。
 * 有任何一项丢失时退出码为 1,便于脚本化。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { openDatabase } from "../src/store/open.js";
import { readLlmChatDocument } from "../src/llmChat/config.js";
import { selectModelForTurn } from "../src/llmChat/views.js";
import {
  estimateTextTokens,
  executedActionsBefore,
  summarizeForCompaction,
} from "../src/llmChat/copilotRuntime.js";
import {
  ensureLlmChatSession,
  finishChatCall,
  getLlmChatSession,
  insertPendingChatCall,
  listChatCalls,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";

type Fixture = {
  name: string;
  messages: Message[];
  /** 摘要(四段拼起来)里必须还找得到的片段 —— 挑的是改写后也会保留的专有名词、数字、路径。 */
  mustKeep: { kind: "决定" | "约束" | "路径"; text: string }[];
  /** 已执行动作清单里必须还找得到的命令。 */
  mustKeepActions: string[];
};

const shell = (id: string, command: string) =>
  ({
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      { id, type: "function", function: { name: "ai2nao_run_shell", arguments: JSON.stringify({ command }) } },
    ],
  }) as unknown as Message;
const result = (id: string, ok: boolean, stdout: string) =>
  ({
    id: `t-${id}`,
    role: "tool",
    toolCallId: id,
    content: JSON.stringify({ ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? "" : "error" }),
  }) as unknown as Message;
const u = (id: string, content: string) => ({ id, role: "user", content }) as Message;
const a = (id: string, content: string) => ({ id, role: "assistant", content }) as Message;

const FIXTURES: Fixture[] = [
  {
    name: "计价与迁移",
    messages: [
      u("u1", "模型目录要加分段价,是不是得给 model_prices 表加一列?"),
      a("a1", "不建议加列。那张表主键是 (provider, model_id),一模型一行,放不下多档;而且加列就要迁移。我们的约束是 SCHEMA_VERSION 钉死在 60,已经应用过的 applyVNN 一律不许改。决定:分段价放进 config.db 的 config_meta,作为目录缓存 JSON 的一个字段,零迁移。"),
      u("u2", "好。那选档按什么判断?"),
      a("a2", "按这一笔请求的 usage.input 选:取 size 小于 input 的最大那一档,都不小于就用基础价。实现放在 src/cost/modelCatalog.ts 的 tieredPriceOf,计价在 src/llmChat/sessions.ts 的 priceChatCall。"),
      shell("s1", "npx vitest run --no-file-parallelism test/llmChat.pricing.test.ts"),
      result("s1", true, "Test Files 1 passed\nTests 18 passed"),
      u("u3", "cacheWrite 那一项有什么坑?"),
      a("a3", "账本叫 cacheWrite,价格表叫 cacheCreation,只有这一对名字不同,写错不会报错只会静默算错钱。所以单测专门拿一条只有 cacheWrite 的用量钉它:6 × 5 = 30。"),
      shell("s2", "sqlite3 /Users/X/.ai2nao/index.db 'PRAGMA user_version'"),
      result("s2", true, "60"),
      u("u4", "价格快照要不要在价格变了之后重算?"),
      a("a4", "不重算。每笔账落终态时把当时的四个单价写进快照,以后价格表变了也不回头改旧账 —— 趋势页的费用读的就是这个快照。"),
      u("u5", "接下来做什么?"),
      a("a5", "下一步做分项弹层,然后在真实浏览器里走一遍。"),
      u("u6", "好,继续。"),
    ],
    mustKeep: [
      { kind: "约束", text: "60" },
      { kind: "决定", text: "config_meta" },
      { kind: "决定", text: "usage.input" },
      { kind: "约束", text: "cacheWrite" },
      { kind: "路径", text: "src/cost/modelCatalog.ts" },
      { kind: "路径", text: "src/llmChat/sessions.ts" },
    ],
    mustKeepActions: [
      "npx vitest run --no-file-parallelism test/llmChat.pricing.test.ts",
      "PRAGMA user_version",
    ],
  },
  {
    name: "占用条与界面约束",
    messages: [
      u("u1", "上下文占用条放在哪里?"),
      a("a1", "决定挂在 CopilotKit 输入框的 disclaimer 插槽里,一行:上下文用量、短进度条、立即压缩按钮。不另开卡片。"),
      u("u2", "界面有什么硬约束?"),
      a("a2", "两条硬约束:只考虑 PC 桌面端,不做移动端;禁止出现横向滚动条。警示色只用 amber。"),
      shell("s1", "npm run typecheck:web"),
      result("s1", true, "ok"),
      u("u3", "真实浏览器里按钮点不动,为什么?"),
      a("a3", "CopilotKit 把 disclaimer 容器设成 pointer-events-none,一路继承到按钮。决定只给按钮单独加 pointer-events-auto,整条保持可穿透。文件是 web/src/aiChat/ChatContextBar.tsx。"),
      shell("s2", "npm run build:web"),
      result("s2", false, "error TS1005: ')' expected"),
      u("u4", "构建挂了?"),
      a("a4", "是模型标签那里的 JSX 注释放进了三元表达式的括号里。挪进 div 里就好,改完要先跑 typecheck:web 再构建。"),
      u("u5", "那顶栏累计被什么挡住了?"),
      a("a5", "被 CopilotKit 的检查器挡住,它在 localhost 默认开。决定在 <CopilotKit> 上加 enableInspector={false}。"),
      u("u6", "继续。"),
    ],
    mustKeep: [
      { kind: "决定", text: "disclaimer" },
      { kind: "决定", text: "pointer-events-auto" },
      { kind: "约束", text: "横向滚动" },
      { kind: "约束", text: "amber" },
      { kind: "决定", text: "enableInspector" },
      { kind: "路径", text: "web/src/aiChat/ChatContextBar.tsx" },
    ],
    mustKeepActions: ["npm run typecheck:web", "npm run build:web"],
  },
];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const yes = process.argv.includes("--yes");
  const doc = readLlmChatDocument();
  const selection = selectModelForTurn(doc, argValue("--model") ?? null);
  if (!selection.ok) {
    console.error(`模型不可用:${selection.message}`);
    return 2;
  }
  const { snapshot } = selection;
  console.log(`模型:${snapshot.provider} / ${snapshot.model}(${snapshot.modelId})`);
  for (const f of FIXTURES) {
    const chars = f.messages.map((m) => JSON.stringify(m)).join("");
    console.log(`  ${f.name}:${f.messages.length} 条消息,约 ${Math.ceil(estimateTextTokens(chars))} 输入 token`);
  }
  if (!yes) {
    console.log("\n这会向上面的模型发真实请求(每段对话每块最多 2048 输出 token)。确认后加 --yes 再跑。");
    return 0;
  }

  const home = mkdtempSync(join(tmpdir(), "ai2nao-eval-compaction-"));
  const db = openDatabase(join(home, "eval.db"));
  let missing = 0;
  try {
    for (const f of FIXTURES) {
      const sid = `eval-${f.name}`;
      ensureLlmChatSession(db, sid, f.name);
      replaceLlmChatSessionMessages(db, sid, { messages: f.messages });
      // 摘要器按「最后一笔 answer 账」恢复会话在用的模型 —— 种一笔,指向这次要测的模型。
      insertPendingChatCall(db, sid, {
        callId: "c:seed:answer:0:0", runId: "seed", fence: 0, purpose: "answer", stepIndex: 0, attempt: 0,
        model: snapshot,
        sendView: { count: 1, prefixHash: "0".repeat(12), systemHash: "0".repeat(12), toolsHash: "0".repeat(12) },
        maxOutputTokens: 1,
      });
      finishChatCall(db, sid, "c:seed:answer:0:0", "completed", null);

      // 折到最后一个用户轮之前:除了最新一问,全部压掉。
      const rows = getLlmChatSession(db, sid)!.messages.filter((r) => !r.message_id.startsWith("ai2nao:"));
      const lastUser = [...rows].reverse().find((r) => r.role === "user")!;
      const compaction = await summarizeForCompaction({ db }, sid, lastUser.message_index, new AbortController().signal);

      const summaryText = JSON.stringify(compaction.summary).toLowerCase();
      const actions = executedActionsBefore(db, sid, new Set(compaction.excludedMessageIds)).join("\n");
      console.log(`\n【${f.name}】`);
      for (const item of f.mustKeep) {
        const ok = summaryText.includes(item.text.toLowerCase());
        if (!ok) missing += 1;
        console.log(`  ${ok ? "✓" : "✗ 丢了"}  ${item.kind}:${item.text}`);
      }
      for (const cmd of f.mustKeepActions) {
        const ok = actions.includes(cmd);
        if (!ok) missing += 1;
        console.log(`  ${ok ? "✓" : "✗ 丢了"}  已执行动作:${cmd}`);
      }
      const calls = listChatCalls(db, sid).filter((c) => c.purpose === "compact");
      const tokensIn = calls.reduce((s, c) => s + (c.usage?.input ?? 0), 0);
      const tokensOut = calls.reduce((s, c) => s + (c.usage?.output ?? 0), 0);
      const cost = calls.every((c) => c.costState === "priced")
        ? `$${calls.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(4)}`
        : "未定价(目录里没有这个模型的价格)";
      console.log(`  摘要请求 ${calls.length} 笔,输入 ${tokensIn} / 输出 ${tokensOut} token,花费 ${cost}`);
      console.log(`  摘要:${JSON.stringify(compaction.summary, null, 1).replace(/\n/g, "\n  ")}`);
    }
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(missing === 0 ? "\n全部保留。" : `\n丢失 ${missing} 项。`);
  return missing === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
