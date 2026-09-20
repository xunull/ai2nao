/**
 * 压缩的**分块与三级截断**(粗 T7 第 4a 片)。
 *
 * **纯函数,零依赖** —— 不碰模型、不碰库。放新文件而不是塞进 `copilotRuntime.ts`:
 * 那个文件已经两千多行,而这一块的输入输出都是普通数据,没有任何理由与运行时耦合。
 *
 * 规格(设计文档《压缩协议》)要求按以下顺序收紧,**直到每个分块不超过预算**:
 *   1. 每条消息按头尾截断到固定上限;
 *   2. 以用户轮为最小分块单位,超限时把单条上限逐步降到 2K 字符;
 *   3. 单个用户轮在单条 2K 时仍超限:该轮只保留第一条用户消息与最后一条助手展示
 *      文本,中间的替换为「本轮省略 N 条中间消息」。
 *
 * 这三级的意义是**保证收敛**:任何单轮最终都能进入某个分块,于是摘要要么完成、
 * 要么明确失败,不会卡在「永远塞不下」。
 */

/** 一条要进摘要的消息。思考与协议原文不在其中(规格明写)。 */
export type SummaryMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
};

/** 一个用户轮:从一条 user 消息起,到下一条 user 之前。 */
export type SummaryTurn = {
  /** 轮号,从会话开头数起(1 起)。用于「本轮省略 N 条」之类的文案。 */
  turn: number;
  messages: SummaryMessage[];
};

/** 单条消息的初始上限与下限。下限 2K 是规格写死的。 */
export const MESSAGE_LIMIT_START = 8_000;
export const MESSAGE_LIMIT_FLOOR = 2_000;

/**
 * 头尾截断:留头留尾,省中间。
 *
 * **不是简单 `slice(0, n)`** —— 工具结果与长回答的结尾往往是结论,只留头会把
 * 「所以呢」整段丢掉,而摘要模型看不到结论就只能猜。
 */
export function headTailTruncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const mark = `…[省略 ${text.length - limit} 字]…`;
  if (limit <= mark.length) return text.slice(0, limit);
  const keep = limit - mark.length;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${mark}${text.slice(text.length - (keep - head))}`;
}

function turnChars(turn: SummaryTurn, limit: number): number {
  return turn.messages.reduce((n, m) => n + Math.min(m.text.length, limit), 0);
}

/**
 * 第 3 级:把一轮压成「首条用户消息 + 末条助手文本 + 省略计数」。
 *
 * 保留首尾两条是因为它们承载「问了什么」与「最后结论」;中间的工具往返对摘要
 * 价值最低,但条数信息要留着 —— 否则摘要模型会以为这一轮什么都没发生。
 */
export function collapseTurn(turn: SummaryTurn, limit: number): SummaryTurn {
  const firstUser = turn.messages.find((m) => m.role === "user");
  const lastAssistant = [...turn.messages].reverse().find((m) => m.role === "assistant");
  const kept: SummaryMessage[] = [];
  if (firstUser) kept.push({ role: "user", text: headTailTruncate(firstUser.text, limit) });
  const omitted = turn.messages.length - (firstUser ? 1 : 0) - (lastAssistant ? 1 : 0);
  if (omitted > 0) kept.push({ role: "tool", text: `本轮省略 ${omitted} 条中间消息` });
  if (lastAssistant) {
    kept.push({ role: "assistant", text: headTailTruncate(lastAssistant.text, limit) });
  }
  return { turn: turn.turn, messages: kept };
}

export type SummaryChunk = {
  turns: SummaryTurn[];
  /** 这一块实际用的单条上限 —— 记下来便于排查「为什么这块这么短」。 */
  messageLimit: number;
};

/**
 * 按轮次顺序分块,逐级收紧直到每块都不超过 `budgetChars`。
 *
 * **轮次不跨块拆开** —— 半个轮次进摘要会让「问」和「答」分家。所以最小单位是轮,
 * 单轮塞不下时靠第 2、3 级把它自己缩小,而不是切开它。
 */
export function chunkTurnsForSummary(
  turns: SummaryTurn[],
  budgetChars: number
): SummaryChunk[] {
  if (turns.length === 0 || budgetChars <= 0) return [];

  // 第 1、2 级:逐步降低单条上限,直到**每一轮**自己都能放进预算。
  let limit = MESSAGE_LIMIT_START;
  let prepared = turns;
  while (true) {
    prepared = turns.map((t) => ({
      turn: t.turn,
      messages: t.messages.map((m) => ({ role: m.role, text: headTailTruncate(m.text, limit) })),
    }));
    if (prepared.every((t) => turnChars(t, limit) <= budgetChars)) break;
    if (limit <= MESSAGE_LIMIT_FLOOR) {
      // 第 3 级:降到 2K 仍有塞不下的轮 —— 把**那些轮**折叠,其余保持原样。
      prepared = prepared.map((t) =>
        turnChars(t, limit) > budgetChars ? collapseTurn(t, limit) : t
      );
      break;
    }
    limit = Math.max(MESSAGE_LIMIT_FLOOR, Math.floor(limit / 2));
  }

  // 按顺序装箱:装不下就开新块。单轮仍超预算时**独占一块** —— 收敛的保证。
  const chunks: SummaryChunk[] = [];
  let cur: SummaryTurn[] = [];
  let curChars = 0;
  for (const t of prepared) {
    const c = turnChars(t, limit);
    if (cur.length > 0 && curChars + c > budgetChars) {
      chunks.push({ turns: cur, messageLimit: limit });
      cur = [];
      curChars = 0;
    }
    cur.push(t);
    curChars += c;
  }
  if (cur.length > 0) chunks.push({ turns: cur, messageLimit: limit });
  return chunks;
}
