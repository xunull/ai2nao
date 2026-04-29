import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AiChat } from "./pages/AiChat";
import { Atuin } from "./pages/Atuin";
import { ChromeDownloads } from "./pages/ChromeDownloads";
import { ChromeHistory } from "./pages/ChromeHistory";
import { ChromeHistoryDomains } from "./pages/ChromeHistoryDomains";
import { ClaudeCodeHistory } from "./pages/ClaudeCodeHistory";
import { ClaudeCodeHistorySession } from "./pages/ClaudeCodeHistorySession";
import { CodexHistory } from "./pages/CodexHistory";
import { CodexHistorySession } from "./pages/CodexHistorySession";
import { CursorHistory } from "./pages/CursorHistory";
import { CursorHistorySession } from "./pages/CursorHistorySession";
import { CursorProjects } from "./pages/CursorProjects";
import { Downloads } from "./pages/Downloads";
import { FileView } from "./pages/FileView";
import { Github } from "./pages/Github";
import { GithubTags } from "./pages/GithubTags";
import { Homebrew } from "./pages/Homebrew";
import { HuggingFaceModels } from "./pages/HuggingFaceModels";
import { MacApps } from "./pages/MacApps";
import { Vscode } from "./pages/Vscode";
import { RepoDetail } from "./pages/RepoDetail";
import { Repos } from "./pages/Repos";
import { Search } from "./pages/Search";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/repos" replace />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/repos/:id" element={<RepoDetail />} />
        <Route path="/repos/:id/file" element={<FileView />} />
        <Route path="/search" element={<Search />} />
        <Route path="/atuin" element={<Atuin />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/apps" element={<MacApps />} />
        <Route path="/vscode" element={<Vscode />} />
        <Route path="/cursor-projects" element={<CursorProjects />} />
        <Route path="/brew" element={<Homebrew />} />
        <Route path="/huggingface-models" element={<HuggingFaceModels />} />
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
    </Layout>
  );
}
