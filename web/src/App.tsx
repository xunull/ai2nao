import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";

const AiChat = lazy(() => import("./pages/AiChat").then((m) => ({ default: m.AiChat })));
const Atuin = lazy(() => import("./pages/Atuin").then((m) => ({ default: m.Atuin })));
const AtuinDirectories = lazy(() =>
  import("./pages/AtuinDirectories").then((m) => ({ default: m.AtuinDirectories }))
);
const ChromeDownloads = lazy(() =>
  import("./pages/ChromeDownloads").then((m) => ({ default: m.ChromeDownloads }))
);
const ChromeHistory = lazy(() =>
  import("./pages/ChromeHistory").then((m) => ({ default: m.ChromeHistory }))
);
const ChromeHistoryDomains = lazy(() =>
  import("./pages/ChromeHistoryDomains").then((m) => ({ default: m.ChromeHistoryDomains }))
);
const ClaudeCodeHistory = lazy(() =>
  import("./pages/ClaudeCodeHistory").then((m) => ({ default: m.ClaudeCodeHistory }))
);
const ClaudeCodeHistorySession = lazy(() =>
  import("./pages/ClaudeCodeHistorySession").then((m) => ({
    default: m.ClaudeCodeHistorySession,
  }))
);
const CodexHistory = lazy(() =>
  import("./pages/CodexHistory").then((m) => ({ default: m.CodexHistory }))
);
const CodexHistorySession = lazy(() =>
  import("./pages/CodexHistorySession").then((m) => ({ default: m.CodexHistorySession }))
);
const CursorHistory = lazy(() =>
  import("./pages/CursorHistory").then((m) => ({ default: m.CursorHistory }))
);
const CursorHistorySession = lazy(() =>
  import("./pages/CursorHistorySession").then((m) => ({ default: m.CursorHistorySession }))
);
const CursorProjects = lazy(() =>
  import("./pages/CursorProjects").then((m) => ({ default: m.CursorProjects }))
);
const Downloads = lazy(() =>
  import("./pages/Downloads").then((m) => ({ default: m.Downloads }))
);
const FileView = lazy(() =>
  import("./pages/FileView").then((m) => ({ default: m.FileView }))
);
const Github = lazy(() => import("./pages/Github").then((m) => ({ default: m.Github })));
const GithubTags = lazy(() =>
  import("./pages/GithubTags").then((m) => ({ default: m.GithubTags }))
);
const Homebrew = lazy(() =>
  import("./pages/Homebrew").then((m) => ({ default: m.Homebrew }))
);
const HuggingFaceModels = lazy(() =>
  import("./pages/HuggingFaceModels").then((m) => ({ default: m.HuggingFaceModels }))
);
const LmStudioModels = lazy(() =>
  import("./pages/LmStudioModels").then((m) => ({ default: m.LmStudioModels }))
);
const MacApps = lazy(() =>
  import("./pages/MacApps").then((m) => ({ default: m.MacApps }))
);
const Vscode = lazy(() => import("./pages/Vscode").then((m) => ({ default: m.Vscode })));
const RepoDetail = lazy(() =>
  import("./pages/RepoDetail").then((m) => ({ default: m.RepoDetail }))
);
const Repos = lazy(() => import("./pages/Repos").then((m) => ({ default: m.Repos })));
const Search = lazy(() => import("./pages/Search").then((m) => ({ default: m.Search })));

export function App() {
  return (
    <Layout>
      <Suspense fallback={<p className="text-[var(--muted)]">加载中...</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/repos" replace />} />
          <Route path="/repos" element={<Repos />} />
          <Route path="/repos/:id" element={<RepoDetail />} />
          <Route path="/repos/:id/file" element={<FileView />} />
          <Route path="/search" element={<Search />} />
          <Route path="/atuin" element={<Atuin />} />
          <Route path="/atuin/directories" element={<AtuinDirectories />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/apps" element={<MacApps />} />
          <Route path="/vscode" element={<Vscode />} />
          <Route path="/cursor-projects" element={<CursorProjects />} />
          <Route path="/brew" element={<Homebrew />} />
          <Route path="/huggingface-models" element={<HuggingFaceModels />} />
          <Route path="/lmstudio-models" element={<LmStudioModels />} />
          <Route path="/chrome-history" element={<ChromeHistory />} />
          <Route path="/chrome-history/domains" element={<ChromeHistoryDomains />} />
          <Route path="/chrome-downloads" element={<ChromeDownloads />} />
          <Route path="/cursor-history" element={<CursorHistory />} />
          <Route path="/cursor-history/s/:sessionId" element={<CursorHistorySession />} />
          <Route path="/claude-code-history" element={<ClaudeCodeHistory />} />
          <Route
            path="/claude-code-history/s/:sessionId"
            element={<ClaudeCodeHistorySession />}
          />
          <Route path="/codex-history" element={<CodexHistory />} />
          <Route path="/codex-history/s/:sessionId" element={<CodexHistorySession />} />
          <Route path="/ai-chat" element={<AiChat />} />
          <Route path="/github" element={<Github />} />
          <Route path="/github/tags" element={<GithubTags />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
