import { FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

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
          <nav className="flex gap-4 text-sm">
            <Link className="text-[var(--accent)] hover:underline" to="/repos">
              仓库
            </Link>
            <Link className="text-[var(--accent)] hover:underline" to="/search">
              搜索
            </Link>
            <Link className="text-[var(--accent)] hover:underline" to="/atuin">
              Atuin
            </Link>
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
        仅本机索引查看（只读）
      </footer>
    </div>
  );
}
