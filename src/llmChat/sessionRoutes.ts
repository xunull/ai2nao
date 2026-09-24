import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { jsonErr, safeJson } from "./http.js";
import {
  applyBranchAction,
  branchPosition,
  createLlmChatSession,
  deleteLlmChatSession,
  getLlmChatSession,
  listLlmChatSessions,
  readSessionCompactionSettings,
  sessionUsage,
  setSessionCompactionAuto,
  LlmChatSessionError,
  siblingIds,
  type BranchAction,
  type LlmChatMessageRow,
  type SessionContextView,
} from "./sessions.js";

const BRANCH_ACTIONS = new Set<string>(["switch", "regenerate", "edit"]);

export type LlmChatSessionRouteDeps = {
  db?: Database.Database;
  /**
   * 上下文占用的计算器,由 `routes.ts` 注入。
   *
   * **本文件不认识 `copilotRuntime.ts`** —— 直接 import 会让 sessionRoutes → copilotRuntime
   * → sessions 这条链多出一个横向依赖,而注入让方向仍然单向。不传时 `context` 为 null,
   * 界面按「窗口未知」处理。
   */
  sessionContext?: (sessionId: string) => SessionContextView | null;
};

export function registerLlmChatSessionRoutes(
  app: Hono,
  deps?: LlmChatSessionRouteDeps
): void {
  app.get("/api/llm-chat/sessions", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const limit = parseInt(c.req.query("limit") ?? "50", 10);
      return c.json({ sessions: listLlmChatSessions(deps.db, limit) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/llm-chat/sessions", async (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const body = await safeJson(c);
      const title =
        body && typeof body === "object"
          ? (body as { title?: unknown }).title
          : undefined;
      return c.json({
        session: createLlmChatSession(
          deps.db,
          typeof title === "string" ? title : undefined
        ),
      });
    } catch (e) {
      return sessionErr(e);
    }
  });

  app.get("/api/llm-chat/sessions/:id", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const session = getLlmChatSession(deps.db, c.req.param("id"));
      if (!session) return jsonErr(404, "session not found");
      return c.json({ session });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/llm-chat/sessions/:id/usage", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const id = c.req.param("id");
      // 会话不存在与「会话在但没有任何账目」是两回事:前者 404,后者是合法的空聚合。
      if (!getLlmChatSession(deps.db, id)) return jsonErr(404, "session not found");
      // 计算器自己失败不该让整个用量接口 500 —— 那会连账目一起看不到。
      let context: SessionContextView | null = null;
      try {
        context = deps.sessionContext?.(id) ?? null;
      } catch {
        context = null;
      }
      return c.json({ usage: sessionUsage(deps.db, id, context) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * 分页读取原文(含被压缩的轮次),供 Sheet 查看。
   *
   * **只返回展示字段。** `raw_json` 里带着 `ai2naoProtocol` 协议原文与账目,
   * 那些不该进这条给界面看的接口;`ai2nao:` 前缀的服务端专有行整行不返回。
   *
   * 游标用 `message_index` 单游标,不学 `agentUserMessages` 的 `before`+`beforeId`
   * 复合游标 —— 那是因为时间戳会重复才要配对,而 `message_index` 在会话内单调唯一。
   * 最新在前,`before` 取「上一页最后一条的 message_index」。
   */
  app.get("/api/llm-chat/sessions/:id/messages", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    const beforeRaw = c.req.query("before")?.trim() || undefined;
    const limitRaw = c.req.query("limit")?.trim();
    let before: number | undefined;
    if (beforeRaw !== undefined) {
      before = Number(beforeRaw);
      if (!Number.isInteger(before)) {
        return jsonErr(400, `invalid before parameter: ${JSON.stringify(beforeRaw)}`);
      }
    }
    let limit = 50;
    if (limitRaw) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n <= 0) {
        return jsonErr(400, `invalid limit parameter: ${JSON.stringify(limitRaw)}`);
      }
      limit = Math.min(200, n);
    }
    try {
      const id = c.req.param("id");
      const detail = getLlmChatSession(deps.db, id);
      if (!detail) return jsonErr(404, "session not found");
      const matched = detail.messages
        .filter((r) => !r.message_id.startsWith("ai2nao:"))
        .filter((r) => before === undefined || r.message_index < before)
        .sort((a, b) => b.message_index - a.message_index);
      // **多取一条来判断有没有下一页。** 用「返回条数 === limit」推断的话,
      // 总数正好是 limit 的整数倍时会给出一个非 null 游标,前端白跑一页空结果。
      const rows = matched.slice(0, limit);
      const hasMore = matched.length > limit;
      return c.json({
        messages: rows.map(displayRowOf),
        nextBefore: hasMore ? rows[rows.length - 1]!.message_index : null,
      });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * 会话级自动压缩开关(规格:默认关闭)。
   *
   * 放在会话路由这组,而不是 copilotkit 那组:它只写 `metadata_json` 里的一个键,
   * 不调模型、不占运行位,与会话元数据同类。
   */
  app.patch("/api/llm-chat/sessions/:id/compaction-settings", async (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    const body = await safeJson(c);
    const auto = body && typeof body === "object" ? (body as { auto?: unknown }).auto : undefined;
    // 只收布尔。字符串 "false" 若被当成真值,就成了一个关不掉的开关 —— 比没有开关更糟。
    if (typeof auto !== "boolean") return jsonErr(400, "auto must be a boolean");
    try {
      const id = c.req.param("id");
      if (!getLlmChatSession(deps.db, id)) return jsonErr(404, "session not found");
      setSessionCompactionAuto(deps.db, id, auto);
      return c.json({ settings: readSessionCompactionSettings(deps.db, id) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
  
  /**
   * 分支操作。三种意图的区别只有一个:把激活叶子移到哪 ——
   * 语义在服务端(applyBranchAction),客户端只说意图。
   *
   * 重新生成与编辑重发**不在这里发起模型调用**:移动叶子之后由客户端正常发一轮,
   * 新消息自然挂在新叶子下面。两者因此复用了完全相同的那条发送路径。
   */
  app.post("/api/llm-chat/sessions/:id/branch", async (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    const body = await safeJson(c);
    const action = (body as { action?: unknown })?.action;
    const messageId = (body as { messageId?: unknown })?.messageId;
    if (typeof action !== "string" || !BRANCH_ACTIONS.has(action)) {
      return jsonErr(400, "action must be one of switch | regenerate | edit");
    }
    if (typeof messageId !== "string" || !messageId.trim()) {
      return jsonErr(400, "messageId is required");
    }
    const rawIndex = (body as { branchIndex?: unknown })?.branchIndex;
    const branchIndex =
      typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : null;
    try {
      const result = applyBranchAction(
        deps.db,
        c.req.param("id"),
        action as BranchAction,
        messageId,
        branchIndex
      );
      return c.json(result);
    } catch (e) {
      if (e instanceof LlmChatSessionError) return jsonErr(e.status, e.message);
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * 激活路径上每条消息的分支位置,供界面渲染 `‹ 1/2 ›`。
   *
   * 导航挂在 **user** 消息上(CopilotKit 的分支导航只有 UserMessage 有),
   * 但数的是**它的孩子**里当前激活的那个 —— 也就是「这个问题有几个回答」。
   */
  app.get("/api/llm-chat/sessions/:id/branches", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const id = c.req.param("id");
      const detail = getLlmChatSession(deps.db, id);
      if (!detail) return jsonErr(404, "session not found");
      const path = detail.messages.filter((m) => m.message_index < 1_000_000);
      const out: Record<string, { branchIndex: number; numberOfBranches: number }> = {};
      for (let i = 0; i < path.length; i += 1) {
        const row = path[i]!;
        if (row.role !== "user") continue;
        // 这条 user 的孩子里,当前激活的是路径上的下一条。
        const activeChild = path[i + 1]?.message_id;
        if (!activeChild) {
          // 末尾的提问还没有回答 —— 但它自己可能有兄弟(编辑重发过)。
          const self = branchPosition(deps.db, id, row.message_id);
          if (self.numberOfBranches > 1) out[row.message_id] = self;
          continue;
        }
        const kids = siblingIds(deps.db, id, row.message_id);
        if (kids.length > 1) {
          out[row.message_id] = {
            branchIndex: Math.max(0, kids.indexOf(activeChild)),
            numberOfBranches: kids.length,
          };
        }
      }
      return c.json({ branches: out });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.delete("/api/llm-chat/sessions/:id", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const deleted = deleteLlmChatSession(deps.db, c.req.param("id"));
      if (!deleted) return jsonErr(404, "session not found");
      return c.json({ ok: true });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}

/** 只挑展示字段。**不透出 `raw_json`** —— 协议原文与 `ai2nao*` 字段都在里面。 */
function displayRowOf(row: LlmChatMessageRow) {
  return {
    messageId: row.message_id,
    messageIndex: row.message_index,
    role: row.role,
    text: row.plain_text,
    preview: row.preview,
    createdAt: row.created_at,
  };
}

function sessionErr(e: unknown) {
  if (e instanceof LlmChatSessionError) {
    return jsonErr(e.status, e.message);
  }
  return jsonErr(500, e instanceof Error ? e.message : String(e));
}
