import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AiChat } from "./pages/AiChat";
import { Atuin } from "./pages/Atuin";
import { ChromeDownloads } from "./pages/ChromeDownloads";
import { ChromeHistory } from "./pages/ChromeHistory";
import { ClaudeCodeHistory } from "./pages/ClaudeCodeHistory";
import { ClaudeCodeHistorySession } from "./pages/ClaudeCodeHistorySession";
import { CursorHistory } from "./pages/CursorHistory";
import { CursorHistorySession } from "./pages/CursorHistorySession";
import { Downloads } from "./pages/Downloads";
import { FileView } from "./pages/FileView";
import { Github } from "./pages/Github";
import { GithubTags } from "./pages/GithubTags";
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
        <Route path="/chrome-history" element={<ChromeHistory />} />
        <Route path="/chrome-downloads" element={<ChromeDownloads />} />
        <Route path="/cursor-history" element={<CursorHistory />} />
        <Route path="/cursor-history/s/:sessionId" element={<CursorHistorySession />} />
        <Route path="/claude-code-history" element={<ClaudeCodeHistory />} />
        <Route
          path="/claude-code-history/s/:sessionId"
          element={<ClaudeCodeHistorySession />}
        />
        <Route path="/ai-chat" element={<AiChat />} />
        <Route path="/github" element={<Github />} />
        <Route path="/github/tags" element={<GithubTags />} />
      </Routes>
    </Layout>
  );
}
