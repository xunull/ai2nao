import { apiGet, apiPost } from "../api";

/**
 * 分支操作的客户端封装。**语义在服务端** —— 这里只说意图,不自己算树。
 *
 * 三种动作的区别只有一个:把激活叶子移到哪。后两种移完之后还要**真的跑一轮**
 * (`needsRun`),那一轮走的是平常那条发送路径,所以重新生成与编辑重发复用了
 * 完全相同的运行时,没有第二套。
 */

export type BranchAction = "switch" | "regenerate" | "edit";

export type BranchResult = {
  activeLeafMessageId: string;
  activePathIds: string[];
  needsRun: boolean;
};

/** 消息 id → 它在兄弟里的位置。没有兄弟的消息不在表里 —— 界面据此不渲染导航。 */
export type BranchMap = Record<string, { branchIndex: number; numberOfBranches: number }>;

/**
 * 两种导航,两张表。
 *  - `questions` 挂在 user 消息上:这个问题的几个版本(编辑重发出来的)
 *  - `answers` 挂在 assistant 消息上:同一个问题的几个回答(重新生成出来的)
 *
 * 合成一张的话,一个 ‹1/2› 要同时表示两种意思 —— 编辑过的问题一旦有了回答,
 * 那个控件就改口去数回答,原版提问再也切不回来(数据还在,界面上没有入口)。
 */
export type BranchMaps = { questions: BranchMap; answers: BranchMap };

export async function applyBranch(
  sessionId: string,
  action: BranchAction,
  messageId: string,
  /** switch 专用:切到 `messageId` 的第 N 个**兄弟**。由服务端解析成具体的 id ——
      界面只知道序号,不该知道树的形状。user 与 assistant 两种导航同一条规则。 */
  branchIndex?: number
): Promise<BranchResult> {
  return apiPost<BranchResult>(`/api/llm-chat/sessions/${encodeURIComponent(sessionId)}/branch`, {
    action,
    messageId,
    ...(branchIndex == null ? {} : { branchIndex }),
  });
}

export async function fetchBranches(sessionId: string): Promise<BranchMaps> {
  const res = await apiGet<Partial<BranchMaps>>(
    `/api/llm-chat/sessions/${encodeURIComponent(sessionId)}/branches`
  );
  return { questions: res.questions ?? {}, answers: res.answers ?? {} };
}

/**
 * 从 CopilotKit 的消息内容里取纯文本,交给 `EditResendBar` 当编辑的初始内容。
 *
 * content 有两种形状:字符串,或 `{type:"text"|"image_url"}` 的数组(带图的消息)。
 * 图不带进编辑框 —— 那需要把 data URL 还原成粘贴态,而编辑的意图是改**字**。
 */
export function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text") {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}
