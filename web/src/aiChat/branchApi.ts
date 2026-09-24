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

/** 每条 user 消息的分支位置。没有兄弟的消息不在这张表里 —— 界面据此不渲染导航。 */
export type BranchMap = Record<string, { branchIndex: number; numberOfBranches: number }>;

export async function applyBranch(
  sessionId: string,
  action: BranchAction,
  messageId: string,
  /** switch 专用:切到 `messageId` 的第 N 个孩子。由服务端解析成具体的兄弟 id —— 
      界面只知道序号(‹1/2› 挂在 user 上、数的是它的回答),不该知道树的形状。 */
  branchIndex?: number
): Promise<BranchResult> {
  return apiPost<BranchResult>(`/api/llm-chat/sessions/${encodeURIComponent(sessionId)}/branch`, {
    action,
    messageId,
    ...(branchIndex == null ? {} : { branchIndex }),
  });
}

export async function fetchBranches(sessionId: string): Promise<BranchMap> {
  const res = await apiGet<{ branches: BranchMap }>(
    `/api/llm-chat/sessions/${encodeURIComponent(sessionId)}/branches`
  );
  return res.branches ?? {};
}

/**
 * 从 CopilotKit 的消息内容里取纯文本,供「编辑重发」填回输入框。
 *
 * content 有两种形状:字符串,或 `{type:"text"|"image_url"}` 的数组(带图的消息)。
 * 图不填回输入框 —— 那需要把 data URL 还原成粘贴态,而编辑的意图是改**字**。
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
