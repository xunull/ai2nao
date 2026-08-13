/**
 * 阅读模式的消息变换:先按后端打的标记过滤,再把相邻的 assistant 消息并成一张卡。
 *
 * **这里刻意不判断「什么算噪音」。** 口径归后端(`src/claudeCodeHistory/normalize.ts`
 * 的 `readingHidden`,与 `cleanClaudeUserMessage` 同一份),前端只读标记。这个仓库已经
 * 为前后端标签表分叉付过代价(`test/controlTags.drift.test.ts` 就是为此存在的),不再开第三份。
 *
 * 纯函数、不碰 DOM:虚拟列表的真实高度在 jsdom 里恒为 0,位置类断言只能走 playwright,
 * 所以把「算得对不对」抽到这里单测,「算完滚没滚到」留给 e2e。
 */

/** 本模块只依赖这三个字段;页面的 ApiMessage 天然满足,泛型保证调用方拿回自己的类型。 */
export type FilterableMessage = {
  id: string | null;
  role: string;
  metadata?: { readingHidden?: string };
};

/** 一张渲染卡片。合并后一张卡可能对应多条原始消息。 */
export type MergedCard<T> = {
  /** React key,取首条消息 id;id 缺失时退化为「角色-序号」。 */
  key: string;
  role: string;
  /** 这张卡包含的原始消息,按原序。时间戳等取 `messages[0]`。 */
  messages: T[];
};

/** 滤掉后端标了 `readingHidden` 的消息。标记缺省即显示。 */
export function filterByReadingHidden<T extends FilterableMessage>(msgs: T[]): T[] {
  return msgs.filter((m) => !m.metadata?.readingHidden);
}

/**
 * 相邻 assistant 消息合并成一张卡。
 *
 * **只合并 assistant。** 它的连续消息是同一轮回复被 jsonl 按 content block 拆开的
 * (实测 252 行 assistant 只对应 127 轮),合并是还原;而 user 连发两条是两次独立发言,
 * 合并会把它们读成一段。
 *
 * 跨分页边界照常合并:下一页到达后卡片就地变长,靠 react-virtual 的 measureElement
 * 重测 + 自动补偿。不按页切断,否则后端的分页实现细节会漏成「同一轮被劈成两张卡」。
 */
export function mergeAdjacentAssistant<T extends FilterableMessage>(
  msgs: T[]
): MergedCard<T>[] {
  const cards: MergedCard<T>[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const last = cards[cards.length - 1];
    if (last && m.role === "assistant" && last.role === "assistant") {
      last.messages.push(m);
      continue;
    }
    cards.push({ key: m.id ?? `${m.role}-${i}`, role: m.role, messages: [m] });
  }
  return cards;
}

/**
 * 切换开关后,原来视口顶部那条消息现在该滚到第几张卡。
 *
 * 四种情况:
 * 1. 锚点就在某张卡里 → 那张卡(**包括它落在合并卡中间一段**的情况 ——
 *    scrollToIndex 只能定位到卡,定不到卡内某段,所以返回整卡、接受卡内偏移)
 * 2. 锚点自己被滤掉了 → 沿原序往后找第一条仍可见的,用它所在的卡
 * 3. 其后全被滤掉 → 落到最后一张卡
 * 4. 锚点不在原序列里(数据已换)或没有锚点 → 0
 */
export function computeAnchorIndex<T extends FilterableMessage>(
  cards: MergedCard<T>[],
  anchorMessageId: string | null,
  prevMessages: T[]
): number {
  if (!anchorMessageId || cards.length === 0) return 0;
  const findCard = (id: string) =>
    cards.findIndex((c) => c.messages.some((m) => m.id === id));

  const direct = findCard(anchorMessageId);
  if (direct >= 0) return direct;

  const from = prevMessages.findIndex((m) => m.id === anchorMessageId);
  if (from < 0) return 0;
  for (let i = from + 1; i < prevMessages.length; i++) {
    const id = prevMessages[i].id;
    if (!id) continue;
    const idx = findCard(id);
    if (idx >= 0) return idx;
  }
  return cards.length - 1;
}
