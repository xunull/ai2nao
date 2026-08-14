// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHistorySession } from "../web/src/pages/ClaudeCodeHistorySession";

const RAW_FETCH = globalThis.fetch;
const RAW_GET_BOUNDING_CLIENT_RECT = Element.prototype.getBoundingClientRect;
const RAW_OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const RAW_OFFSET_WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HEADER = {
  messageCount: 120,
  createdAt: "2026-06-29T00:00:00.000Z",
  lastUpdatedAt: "2026-06-29T02:00:00.000Z",
  firstUserText: "第一条消息",
  title: "分页会话测试",
  preview: "第一条消息",
  workspacePath: "/w/x/repo",
  warnings: [],
};

// 第一页(cursor=0):两条消息,nextCursor=2 → 还有下一页。
const PAGE_A = {
  ok: true,
  messages: [
    { id: "user-L1", role: "user", content: "第一条消息", timestamp: "2026-06-29T00:00:00.000Z" },
    {
      id: "assistant-L2",
      role: "assistant",
      content: "第二条回复",
      timestamp: "2026-06-29T00:01:00.000Z",
    },
  ],
  nextCursor: 2,
  hasMore: true,
};

// 第二页(cursor=2):一条消息,nextCursor=null → 到末尾。
const PAGE_B = {
  ok: true,
  messages: [
    { id: "user-L3", role: "user", content: "第三条消息", timestamp: "2026-06-29T00:02:00.000Z" },
  ],
  nextCursor: null,
  hasMore: false,
};

type MockOpts = {
  meta?: unknown;
  metaStatus?: number;
  pageA?: unknown;
  pageAStatus?: number;
  pageB?: unknown;
};

// 页面按 URL 打两类接口:?meta=1(头部)与 ?cursor=<n>&limit=(分页消息)。
function installFetchMock(opts: MockOpts = {}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("meta=1"))
      return jsonResponse(opts.meta ?? { ok: true, header: HEADER }, opts.metaStatus ?? 200);
    if (url.includes("cursor=2")) return jsonResponse(opts.pageB ?? PAGE_B);
    if (url.includes("cursor="))
      return jsonResponse(opts.pageA ?? PAGE_A, opts.pageAStatus ?? 200);
    throw new Error(`Unhandled fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/claude-code-history/s/sess-1?projectId=proj-1"]}>
        <Routes>
          <Route
            path="/claude-code-history/s/:sessionId"
            element={<ClaudeCodeHistorySession />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// @tanstack/react-virtual 量滚动容器可视高走 element.offsetHeight,量每行高走 getBoundingClientRect,
// 并用 ResizeObserver 监听变化;jsdom 三者都缺(offset/rect 全 0、无 ResizeObserver),会让虚拟列表
// 算不出可视区而渲染 0 行。给容器/行非零高度并补 ResizeObserver 桩,overscan 行才会真实渲染、消息可断言。
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  // 阅读模式开关状态存在 localStorage,不清会串到下一个用例。
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom 之外的环境忽略 */
  }
  globalThis.fetch = RAW_FETCH;
  Element.prototype.getBoundingClientRect = RAW_GET_BOUNDING_CLIENT_RECT;
  if (RAW_OFFSET_HEIGHT) Object.defineProperty(HTMLElement.prototype, "offsetHeight", RAW_OFFSET_HEIGHT);
  if (RAW_OFFSET_WIDTH) Object.defineProperty(HTMLElement.prototype, "offsetWidth", RAW_OFFSET_WIDTH);
  vi.unstubAllGlobals();
});

describe("ClaudeCodeHistorySession — 大 transcript 分页详情页", () => {
  it("从 ?meta=1 渲染头部(标题 + 条数)", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("分页会话测试")).toBeInTheDocument()
    );
    expect(screen.getByText("120 条消息")).toBeInTheDocument();
  });

  it("渲染第一页消息", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("第一条消息")).toBeInTheDocument()
    );
    expect(screen.getByText("第二条回复")).toBeInTheDocument();
  });

  it("滚动触底 → 加载并渲染下一页消息", async () => {
    installFetchMock();
    renderPage();
    // 第一页(含哨兵页脚)全部可见 → 触底 useEffect 调 fetchNextPage → 第二页出现。
    await waitFor(() =>
      expect(screen.getByText("第三条消息")).toBeInTheDocument()
    );
  });

  it("空会话 → 空态提示", async () => {
    installFetchMock({
      meta: { ok: true, header: { ...HEADER, messageCount: 0 } },
      pageA: { ok: true, messages: [], nextCursor: null, hasMore: false },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("此会话没有可展示的消息")).toBeInTheDocument()
    );
  });

  it("头部索引失败 → 错误态", async () => {
    installFetchMock({
      meta: { error: { message: "索引大文件失败" } },
      metaStatus: 500,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("索引大文件失败")).toBeInTheDocument()
    );
  });
});

describe("ClaudeCodeHistorySession — user 命令注入回显结构化渲染", () => {
  // 含 /model 命令 + stdout(带无-ESC 的 [1m..[22m 加粗残骸)的 user 消息。
  const INJECT_PAGE = {
    ok: true,
    messages: [
      {
        id: "user-L1",
        role: "user",
        content:
          "<command-name>/model</command-name><command-args></command-args>" +
          "<local-command-stdout>Set model to [1mOpus[22m done</local-command-stdout>",
        timestamp: "2026-06-29T00:00:00.000Z",
      },
    ],
    nextCursor: null,
    hasMore: false,
  };

  it("命令成 chip、stdout 的 SGR 残骸还原成加粗、原始标签不裸露", async () => {
    installFetchMock({ pageA: INJECT_PAGE });
    renderPage();
    // 命令徽标。
    await waitFor(() => expect(screen.getByText("/model")).toBeInTheDocument());
    // SGR 残骸被吃掉:Opus 作为独立(加粗)文本节点出现,且不带 [1m/[22m。
    const opus = screen.getByText("Opus");
    expect(opus).toBeInTheDocument();
    expect(opus.className).toContain("font-bold");
    // 结构化视图里不裸露 <local-command-stdout> 标签,也没有 [22m 残骸。
    expect(screen.queryByText(/local-command-stdout/)).toBeNull();
    expect(screen.queryByText(/\[22m/)).toBeNull();
  });

  it("「查看原文」切换能看到原始 payload(带标签/残骸)", async () => {
    installFetchMock({ pageA: INJECT_PAGE });
    renderPage();
    await waitFor(() => expect(screen.getByText("查看原文")).toBeInTheDocument());
    fireEvent.click(screen.getByText("查看原文"));
    // 原文里带标签与 SGR 残骸。
    await waitFor(() =>
      expect(screen.getByText(/local-command-stdout/)).toBeInTheDocument()
    );
    expect(screen.getByText(/\[22m/)).toBeInTheDocument();
    // 切回结构化。
    fireEvent.click(screen.getByText("← 结构化视图"));
    await waitFor(() =>
      expect(screen.queryByText(/local-command-stdout/)).toBeNull()
    );
  });

  it("误伤边界:纯真人正文里碰巧含 [1m 不被当 SGR、原样保留", async () => {
    const TEXT_PAGE = {
      ok: true,
      messages: [
        {
          id: "user-L1",
          role: "user",
          content: "矩阵元素 M[1m] 就是普通文字不该被上色",
          timestamp: "2026-06-29T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    installFetchMock({ pageA: TEXT_PAGE });
    renderPage();
    // 无控制标签 → 走 MessagePlainText,[1m] 原样在文本里(未被 SGR 解析吃掉)。
    await waitFor(() =>
      expect(screen.getByText(/M\[1m\]/)).toBeInTheDocument()
    );
  });
});

describe("ClaudeCodeHistorySession — appendix 智能 JSON 渲染", () => {
  const RECORD = {
    attachment: {
      type: "hook_success",
      stdout: JSON.stringify({
        hookSpecificOutput: { additionalContext: "SUPERPOWERS_MARKER\n第二行文本" },
      }),
      exitCode: 0,
    },
    type: "attachment",
  };
  const APPENDIX_PAGE = {
    ok: true,
    messages: [
      {
        id: "event-L1",
        role: "assistant",
        content: "```json\n" + JSON.stringify(RECORD, null, 2) + "\n```",
        timestamp: "2026-06-29T00:00:00.000Z",
        metadata: { claudeAppendix: true, claudeEventType: "attachment" },
      },
    ],
    nextCursor: null,
    hasMore: false,
  };

  it("appendix 默认折叠;展开后解嵌套 stdout、里层长文本显真实换行、无转义墙", async () => {
    installFetchMock({ pageA: APPENDIX_PAGE });
    renderPage();
    // 折叠态:只有展开按钮,里层内容还没渲染。
    await waitFor(() =>
      expect(screen.getByText(/展开查看结构化内容/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/SUPERPOWERS_MARKER/)).toBeNull();
    // 展开 → 智能 JSON:additionalContext 长文本可读(真实换行),且不裸露 \n 转义。
    fireEvent.click(screen.getByText(/展开查看结构化内容/));
    await waitFor(() =>
      expect(screen.getByText(/SUPERPOWERS_MARKER/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/SUPERPOWERS_MARKER\\n/)).toBeNull(); // 无字面 \n 转义
    expect(screen.getByText("查看原文")).toBeInTheDocument();
  });

  it("解析失败(半截 JSON)→ 降级回原文,不空白、不崩", async () => {
    const BAD = {
      ok: true,
      messages: [
        {
          id: "event-L1",
          role: "assistant",
          content: "```json\n{ 这是半截 JSON 没法 parse\n```",
          timestamp: "2026-06-29T00:00:00.000Z",
          metadata: { claudeAppendix: true, claudeEventType: "attachment" },
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    installFetchMock({ pageA: BAD });
    renderPage();
    fireEvent.click(await screen.findByText(/展开查看结构化内容/));
    // 降级:原始内容可见(经 MessagePlainText),不空白。
    await waitFor(() =>
      expect(screen.getByText(/半截 JSON/)).toBeInTheDocument()
    );
    // 解析失败时不给「查看原文」切换(已经是原文)。
    expect(screen.queryByText("查看原文")).toBeNull();
  });

  it("全局开关:打开 → 可见 appendix 自动展开(无需逐个点)", async () => {
    installFetchMock({ pageA: APPENDIX_PAGE });
    renderPage();
    // 初始折叠。
    await waitFor(() =>
      expect(screen.getByText(/展开查看结构化内容/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/SUPERPOWERS_MARKER/)).toBeNull();
    // 打开标题旁的全局开关 → appendix 跟随默认自动展开。
    fireEvent.click(screen.getByRole("switch", { name: /结构化内容默认展开/ }));
    await waitFor(() =>
      expect(screen.getByText(/SUPERPOWERS_MARKER/)).toBeInTheDocument()
    );
    // 再关 → 折叠回去。
    fireEvent.click(screen.getByRole("switch", { name: /结构化内容默认展开/ }));
    await waitFor(() =>
      expect(screen.queryByText(/SUPERPOWERS_MARKER/)).toBeNull()
    );
  });

  it("非 appendix 的普通消息不路由到 AppendixBody(无展开按钮)", async () => {
    const PLAIN = {
      ok: true,
      messages: [
        {
          id: "assistant-L1",
          role: "assistant",
          content: "这是一条普通助手回复,没有 appendix 标记",
          timestamp: "2026-06-29T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    installFetchMock({ pageA: PLAIN });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/这是一条普通助手回复/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/展开查看结构化内容/)).toBeNull();
  });
});

/**
 * 阅读模式(「只看对话」开关)。关注两件事:打开后噪音真的消失,以及**关闭时行为不变** ——
 * 后者由本文件前面那批既有用例守着(它们都在开关默认关的状态下跑)。
 */
const READING_PAGE = {
  ok: true,
  messages: [
    {
      id: "u1",
      role: "user",
      content: "帮我把文章存进知识库",
      timestamp: "2026-06-29T00:00:00.000Z",
    },
    {
      id: "a1",
      role: "assistant",
      content: "我先确认一下存到哪。",
      timestamp: "2026-06-29T00:01:00.000Z",
      toolCalls: [
        {
          id: "toolu_ask1",
          name: "AskUserQuestion",
          params: {
            questions: [
              {
                question: "存到哪个知识系统?",
                header: "存入目标",
                options: [{ label: "gbrain 知识库" }, { label: "Obsidian 笔记" }],
              },
            ],
          },
        },
      ],
    },
    // 携带作答的那条 user 行本身是纯 tool_result,阅读模式下会被滤掉 ——
    // 所以答案必须在过滤前按 tool_use_id 收好。这条用例正是守这个的。
    {
      id: "u2",
      role: "user",
      content: "",
      timestamp: "2026-06-29T00:02:00.000Z",
      metadata: {
        readingHidden: "tool-only",
        answers: { "存到哪个知识系统?": "gbrain 知识库" },
        answersForToolUseId: "toolu_ask1",
      },
    },
    {
      id: "a2",
      role: "assistant",
      content: "",
      timestamp: "2026-06-29T00:03:00.000Z",
      metadata: { readingHidden: "tool-only" },
    },
    {
      id: "e1",
      role: "assistant",
      content: "```json\n{\"snapshot\":1}\n```",
      timestamp: "2026-06-29T00:04:00.000Z",
      metadata: {
        claudeAppendix: true,
        claudeEventType: "file-history-snapshot",
        readingHidden: "appendix",
      },
    },
    {
      id: "a3",
      role: "assistant",
      content: "已存入 gbrain。",
      timestamp: "2026-06-29T00:05:00.000Z",
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const readingSwitch = () => screen.getByRole("switch", { name: "只看对话" });

describe("ClaudeCodeHistorySession — 阅读模式开关", () => {
  it("默认关:噪音照常显示(appendix 徽标、空消息占位都在)", async () => {
    installFetchMock({ pageA: READING_PAGE });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument()
    );
    expect(screen.getByText("file-history-snapshot")).toBeInTheDocument();
    expect(screen.getAllByText("（空消息）").length).toBeGreaterThan(0);
    // 关闭时不渲染提问卡(保持与改动前一致,不引入新展示)。
    expect(screen.queryByText(/存到哪个知识系统/)).toBeNull();
    expect(document.querySelectorAll("article")).toHaveLength(6);
  });

  it("打开:appendix / 空消息消失,相邻 assistant 并成一张卡", async () => {
    installFetchMock({ pageA: READING_PAGE });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument()
    );
    fireEvent.click(readingSwitch());
    await waitFor(() => expect(screen.queryByText("file-history-snapshot")).toBeNull());
    expect(screen.queryByText("（空消息）")).toBeNull();
    // 真人一张卡 + a1/a3 合并成的一张 = 2 张
    expect(document.querySelectorAll("article")).toHaveLength(2);
    expect(screen.getByText(/我先确认一下存到哪/)).toBeInTheDocument();
    expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument();
  });

  it("打开:AskUserQuestion 渲染成卡片并标出你选的那项", async () => {
    installFetchMock({ pageA: READING_PAGE });
    renderPage();
    await waitFor(() => expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument());
    fireEvent.click(readingSwitch());
    await waitFor(() =>
      expect(screen.getByText("存到哪个知识系统?")).toBeInTheDocument()
    );
    expect(screen.getByText("存入目标")).toBeInTheDocument();
    expect(screen.getByText("gbrain 知识库")).toBeInTheDocument();
    expect(screen.getByText("Obsidian 笔记")).toBeInTheDocument();
    expect(screen.getByText(/✓ 你选的/)).toBeInTheDocument();
    expect(screen.queryByText("未回答")).toBeNull();
  });

  it("打开:被 hook 拦下的提问(无作答)渲染成未回答态", async () => {
    const noAnswer = {
      ...READING_PAGE,
      messages: READING_PAGE.messages.map((m) =>
        m.id === "u2" ? { ...m, metadata: { readingHidden: "tool-only" } } : m
      ),
    };
    installFetchMock({ pageA: noAnswer });
    renderPage();
    await waitFor(() => expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument());
    fireEvent.click(readingSwitch());
    await waitFor(() => expect(screen.getByText("未回答")).toBeInTheDocument());
    expect(screen.queryByText(/✓ 你选的/)).toBeNull();
  });

  // R7:整页被滤空时 MessageList 仍要挂载(挂载判断用未过滤的数量),否则没有哨兵、
  // 既不加载也不显示空态 —— 用户得到一块纯白。
  it("整页全是噪音:不白屏,给出说明而不是空白", async () => {
    const allNoise = {
      ok: true,
      messages: [
        {
          id: "n1",
          role: "assistant",
          content: "",
          timestamp: "2026-06-29T00:00:00.000Z",
          metadata: { readingHidden: "tool-only" },
        },
        {
          id: "n2",
          role: "assistant",
          content: "```json\n{}\n```",
          timestamp: "2026-06-29T00:01:00.000Z",
          metadata: { claudeAppendix: true, claudeEventType: "queue-operation", readingHidden: "appendix" },
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    installFetchMock({ pageA: allNoise });
    renderPage();
    await waitFor(() => expect(screen.getByText("queue-operation")).toBeInTheDocument());
    fireEvent.click(readingSwitch());
    await waitFor(() =>
      expect(screen.getByText(/本会话没有可读的对话内容/)).toBeInTheDocument()
    );
    expect(document.querySelectorAll("article")).toHaveLength(0);
  });

  it("开关状态存进 localStorage,重新挂载后保持", async () => {
    installFetchMock({ pageA: READING_PAGE });
    const first = renderPage();
    await waitFor(() => expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument());
    fireEvent.click(readingSwitch());
    await waitFor(() => expect(screen.queryByText("（空消息）")).toBeNull());
    first.unmount();

    installFetchMock({ pageA: READING_PAGE });
    renderPage();
    await waitFor(() => expect(screen.getByText(/已存入 gbrain/)).toBeInTheDocument());
    // 不用再点,状态是从 localStorage 读回来的。
    expect(screen.queryByText("（空消息）")).toBeNull();
    expect(readingSwitch()).toHaveAttribute("aria-checked", "true");
  });
});

/**
 * 「最新在前」排序开关。
 *
 * mock 复刻后端的分页语义(cursor 在两个方向下都是绝对物理行号),否则测不出
 * 「切换后从新顺序开头重新读」这类行为 —— 那正是本组用例要守的。
 */
type MockMsg = { id: string; role: string; content: string; timestamp: string };

function installOrderAwareFetchMock(all: MockMsg[]): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.searchParams.get("meta") != null) {
      return jsonResponse({
        ok: true,
        header: { ...HEADER, messageCount: all.length, title: "排序会话" },
      });
    }
    const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursorRaw = url.searchParams.get("cursor");
    const total = all.length;
    let start: number;
    let end: number;
    if (order === "desc") {
      end = cursorRaw != null ? Number(cursorRaw) : total;
      start = Math.max(0, end - limit);
    } else {
      start = cursorRaw != null ? Number(cursorRaw) : 0;
      end = Math.min(start + limit, total);
    }
    const slice = all.slice(start, end);
    if (order === "desc") slice.reverse();
    const hasMore = order === "desc" ? start > 0 : end < total;
    return jsonResponse({
      ok: true,
      messages: slice,
      nextCursor: hasMore ? (order === "desc" ? start : end) : null,
      hasMore,
    });
  }) as unknown as typeof fetch;
}

const mk = (i: number, role: string, content: string): MockMsg => ({
  id: `m${i}`,
  role,
  content,
  timestamp: new Date(Date.parse("2026-06-29T00:00:00.000Z") + i * 60_000).toISOString(),
});

const sortSwitch = () => screen.getByRole("switch", { name: "最新在前" });

describe("ClaudeCodeHistorySession — 最新在前排序", () => {
  const CONVO = [
    mk(0, "user", "第 0 轮提问"),
    mk(1, "assistant", "第 0 轮回答"),
    mk(2, "user", "第 1 轮提问"),
    mk(3, "assistant", "第 1 轮回答"),
  ];

  it("默认正序:最早的在最上,页脚说『已到对话末尾』", async () => {
    installOrderAwareFetchMock(CONVO);
    renderPage();
    await waitFor(() => expect(screen.getByText("第 1 轮回答")).toBeInTheDocument());
    const articles = Array.from(document.querySelectorAll("article"));
    expect(articles[0].textContent).toContain("第 0 轮提问");
    expect(screen.getByText("已到对话末尾")).toBeInTheDocument();
    expect(sortSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("打开:最新的排到最上,页脚改说『已到对话开头』", async () => {
    installOrderAwareFetchMock(CONVO);
    renderPage();
    await waitFor(() => expect(screen.getByText("第 1 轮回答")).toBeInTheDocument());

    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());
    const articles = Array.from(document.querySelectorAll("article"));
    expect(articles[0].textContent).toContain("第 1 轮回答");
    expect(articles[articles.length - 1].textContent).toContain("第 0 轮提问");
    expect(screen.queryByText("已到对话末尾")).toBeNull();
  });

  // D4:卡之间倒序,但一张合并卡内部仍按写作顺序 —— 一段连贯的话倒着读是读不通的。
  it("倒序 + 阅读模式:卡之间倒序,合并卡内部仍是写作顺序", async () => {
    installOrderAwareFetchMock([
      mk(0, "user", "帮我看下文件"),
      mk(1, "assistant", "我先看一下。"),
      mk(2, "assistant", "看完了,结论是 X。"),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/结论是 X/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("switch", { name: "只看对话" }));
    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());

    const articles = Array.from(document.querySelectorAll("article"));
    // 两条 assistant 并成一张卡,排在 user 那张之上(答在问上 —— D2=A 的消息级倒序)
    expect(articles).toHaveLength(2);
    const merged = articles[0].textContent ?? "";
    expect(merged).toContain("我先看一下");
    expect(merged).toContain("结论是 X");
    // 卡内顺序:先写的在前
    expect(merged.indexOf("我先看一下")).toBeLessThan(merged.indexOf("结论是 X"));
    expect(articles[1].textContent).toContain("帮我看下文件");
  });

  it("开关状态存 localStorage,重新挂载后保持", async () => {
    installOrderAwareFetchMock(CONVO);
    const first = renderPage();
    await waitFor(() => expect(screen.getByText("第 1 轮回答")).toBeInTheDocument());
    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());
    first.unmount();

    installOrderAwareFetchMock(CONVO);
    renderPage();
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());
    expect(sortSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("两个开关互不影响:各存各的键", async () => {
    installOrderAwareFetchMock(CONVO);
    renderPage();
    await waitFor(() => expect(screen.getByText("第 1 轮回答")).toBeInTheDocument());
    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());
    // 只切排序,「只看对话」不该被带动
    expect(screen.getByRole("switch", { name: "只看对话" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(window.localStorage.getItem("ai2nao.sortOrder")).toBe("desc");
    expect(window.localStorage.getItem("ai2nao.readingMode")).not.toBe("1");
  });

  /**
   * E4:react-query 恢复无限查询时第一页用 `oldPageParams[0] ?? initialPageParam`
   * —— 缓存优先。而 maxPages(40)淘汰会把首页连同它的 pageParam 一起删掉。
   * 所以往返切换必须清掉目标 order 的缓存,否则会落在半路而不是开头。
   * 这条只在加载超过 40 页时现形,短会话永远测不出来。
   */
  it("往返切换时清掉目标 order 的缓存:切回去会重新从头请求,而不是复用缓存", async () => {
    installOrderAwareFetchMock(CONVO);
    renderPage();
    await waitFor(() => expect(screen.getByText("已到对话末尾")).toBeInTheDocument());

    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话开头")).toBeInTheDocument());

    // 记录「切回正序」之后发出的请求
    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(sortSwitch());
    await waitFor(() => expect(screen.getByText("已到对话末尾")).toBeInTheDocument());

    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .slice(callsBefore)
      .map((c) => String(c[0]));
    // 缓存被清 → 从 initialPageParam 重新起步,必然出现 cursor=0 的请求。
    // 若沿用缓存,react-query 会直接拿旧数据、一个请求都不发。
    expect(urls.some((u) => u.includes("cursor=0"))).toBe(true);
    // 且顶部回到最早那条
    const articles = Array.from(document.querySelectorAll("article"));
    expect(articles[0].textContent).toContain("第 0 轮提问");
  });
});
