import { FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

const navGroups = [
  {
    label: "本机",
    items: [
      { to: "/repos", label: "仓库" },
      { to: "/downloads", label: "下载" },
      { to: "/apps", label: "Mac 应用" },
      { to: "/brew", label: "Homebrew" },
      { to: "/atuin", label: "Atuin" },
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
      { to: "/cursor-history", label: "Cursor" },
      { to: "/claude-code-history", label: "Claude" },
      { to: "/ai-chat", label: "AI 对话" },
    ],
  },
  {
    label: "代码",
    items: [
      { to: "/github", label: "GitHub" },
      { to: "/github/tags", label: "Star Tag" },
      { to: "/search", label: "搜索" },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    nav(`/search?q=${encodeURIComponent(t)}`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-4">
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
                    <Link
                      key={item.to}
                      className="text-[var(--accent)] hover:underline"
                      to={item.to}
                    >
                      {item.label}
                    </Link>
                  ))}
                </span>
              </div>
            ))}
          </nav>
          <form onSubmit={onSubmit} className="ml-auto flex gap-2">
            <input
              className="rounded border border-[var(--border)] px-2 py-1 text-sm min-w-[12rem]"
              placeholder="搜索…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="跳转到搜索"
            />
            <button
              type="submit"
              className="rounded bg-[var(--accent)] text-white px-3 py-1 text-sm"
            >
              搜索
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl w-full px-4 py-6 flex-1">{children}</main>
      <footer className="border-t border-[var(--border)] text-xs text-[var(--muted)] py-3 text-center">
        本机索引；下载页写入需运行带可写库的 serve
      </footer>
    </div>
  );
}
