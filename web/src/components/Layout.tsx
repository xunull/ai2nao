import { FormEvent, type ReactNode, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";

const navGroups = [
  {
    label: "本机",
    items: [
      { to: "/repos", label: "仓库" },
      { to: "/downloads", label: "下载" },
      { to: "/apps", label: "Mac 应用" },
      { to: "/vscode", label: "VS Code" },
      { to: "/cursor-projects", label: "Cursor 项目" },
      { to: "/brew", label: "Homebrew" },
      { to: "/huggingface-models", label: "HF 模型" },
      { to: "/lmstudio-models", label: "LM Studio" },
      { to: "/atuin", label: "Atuin" },
      { to: "/atuin/directories", label: "Atuin 目录" },
    ],
  },
  {
    label: "浏览器",
    items: [
      { to: "/chrome-history", label: "Chrome 历史" },
      { to: "/chrome-history/domains", label: "Chrome 域名" },
      { to: "/chrome-downloads", label: "Chrome 下载" },
    ],
  },
  {
    label: "对话",
    items: [
      { to: "/cursor-history", label: "Cursor 对话" },
      { to: "/claude-code-history", label: "Claude" },
      { to: "/codex-history", label: "Codex" },
      { to: "/ai-chat", label: "AI 对话" },
    ],
  },
  {
    label: "代码",
    items: [
      { to: "/github", label: "GitHub" },
      { to: "/github/radar", label: "开源雷达" },
      { to: "/github/tags", label: "Star Tag" },
      { to: "/search", label: "搜索" },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const frameClass = "mx-auto max-w-[1760px] px-8";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    nav(`/search?q=${encodeURIComponent(t)}`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] bg-white">
        <div className={`${frameClass} py-3 flex flex-wrap items-center gap-4`}>
          <Link to="/repos" className="font-semibold text-[var(--fg)]">
            ai2nao
          </Link>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {navGroups.map((group) => (
              <div key={group.label} className="flex items-center gap-2">
                <span className="text-[var(--muted)] text-xs">
                  {group.label}
                </span>
                <span className="flex flex-wrap gap-2">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      className={({ isActive }) =>
                        "inline-flex min-h-11 items-center rounded px-2 text-[var(--accent)] hover:bg-blue-50 hover:no-underline " +
                        (isActive ? "bg-blue-50 font-semibold text-[var(--fg)]" : "")
                      }
                      to={item.to}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </span>
              </div>
            ))}
          </nav>
          <form onSubmit={onSubmit} className="ml-auto flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              全站搜索
              <input
                className="min-h-11 min-w-[12rem] rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
                placeholder="仓库、文件、对话"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <button
              type="submit"
              className="min-h-11 rounded bg-[var(--accent)] px-4 py-2 text-sm text-white"
            >
              搜索
            </button>
          </form>
        </div>
      </header>
      <main className={`${frameClass} w-full py-6 flex-1`}>{children}</main>
      <footer className="border-t border-[var(--border)] text-xs text-[var(--muted)] py-3 text-center">
        本机索引；下载页写入需运行带可写库的 serve
      </footer>
    </div>
  );
}
