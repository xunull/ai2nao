import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";

const AiChat = lazy(() => import("./pages/AiChat").then((m) => ({ default: m.AiChat })));
const Atuin = lazy(() => import("./pages/Atuin").then((m) => ({ default: m.Atuin })));
const AtuinDirectories = lazy(() =>
  import("./pages/AtuinDirectories").then((m) => ({ default: m.AtuinDirectories }))
);
const BashPermissions = lazy(() =>
  import("./pages/BashPermissions").then((m) => ({ default: m.BashPermissions }))
);
const BashSandboxSettings = lazy(() =>
  import("./pages/BashSandboxSettings").then((m) => ({ default: m.BashSandboxSettings }))
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
const CherryStudioHistory = lazy(() =>
  import("./pages/CherryStudioHistory").then((m) => ({ default: m.CherryStudioHistory }))
);
const CherryStudioHistorySession = lazy(() =>
  import("./pages/CherryStudioHistorySession").then((m) => ({
    default: m.CherryStudioHistorySession,
  }))
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
const OpencodeHistory = lazy(() =>
  import("./pages/OpencodeHistory").then((m) => ({ default: m.OpencodeHistory }))
);
const OpencodeHistorySession = lazy(() =>
  import("./pages/OpencodeHistorySession").then((m) => ({ default: m.OpencodeHistorySession }))
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
const GithubRadar = lazy(() =>
  import("./pages/GithubRadar").then((m) => ({ default: m.GithubRadar }))
);
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
const RagDebug = lazy(() =>
  import("./pages/RagDebug").then((m) => ({ default: m.RagDebug }))
);
const RagStatus = lazy(() =>
  import("./pages/RagStatus").then((m) => ({ default: m.RagStatus }))
);
const Search = lazy(() => import("./pages/Search").then((m) => ({ default: m.Search })));
const Scheduler = lazy(() =>
  import("./pages/Scheduler").then((m) => ({ default: m.Scheduler }))
);
const WorkDashboard = lazy(() =>
  import("./pages/WorkDashboard").then((m) => ({ default: m.WorkDashboard }))
);
const WorkTokenRanking = lazy(() =>
  import("./pages/WorkTokenRanking").then((m) => ({ default: m.WorkTokenRanking }))
);
const WorkRecap = lazy(() =>
  import("./pages/WorkRecap").then((m) => ({ default: m.WorkRecap }))
);
const WorkTokensTrend = lazy(() =>
  import("./pages/WorkTokensTrend").then((m) => ({ default: m.WorkTokensTrend }))
);
const ProjectOutput = lazy(() =>
  import("./pages/ProjectOutput").then((m) => ({ default: m.ProjectOutput }))
);
const Settings = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.Settings }))
);
const Cosmos = lazy(() =>
  import("./pages/Cosmos").then((m) => ({ default: m.Cosmos }))
);
const Providers = lazy(() =>
  import("./pages/Providers").then((m) => ({ default: m.Providers }))
);
const AgentMessages = lazy(() =>
  import("./pages/AgentMessages").then((m) => ({ default: m.AgentMessages }))
);
const AiRhythm = lazy(() =>
  import("./pages/AiRhythm").then((m) => ({ default: m.AiRhythm }))
);
const CommitBridge = lazy(() =>
  import("./pages/CommitBridge").then((m) => ({ default: m.CommitBridge }))
);
const Replay = lazy(() => import("./pages/Replay").then((m) => ({ default: m.Replay })));

export function App() {
  return (
    <Layout>
      <Suspense fallback={<p className="text-[var(--muted)]">加载中...</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<WorkDashboard />} />
          <Route path="/dashboard/tokens" element={<WorkTokenRanking />} />
          <Route path="/work-recap" element={<WorkRecap />} />
          <Route path="/dashboard/tokens-trend" element={<WorkTokensTrend />} />
          <Route path="/dashboard/project-output" element={<ProjectOutput />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/dashboard/cosmos" element={<Cosmos />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/agent-messages" element={<AgentMessages />} />
          <Route path="/ai-rhythm" element={<AiRhythm />} />
          <Route path="/commit-bridge" element={<CommitBridge />} />
          <Route path="/replay" element={<Replay />} />
          <Route path="/repos" element={<Repos />} />
          <Route path="/repos/:id" element={<RepoDetail />} />
          <Route path="/repos/:id/file" element={<FileView />} />
          <Route path="/search" element={<Search />} />
          <Route path="/scheduler" element={<Scheduler />} />
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
          <Route path="/cherry-studio-history" element={<CherryStudioHistory />} />
          <Route
            path="/cherry-studio-history/s/:sessionId"
            element={<CherryStudioHistorySession />}
          />
          <Route path="/cursor-history" element={<CursorHistory />} />
          <Route path="/cursor-history/s/:sessionId" element={<CursorHistorySession />} />
          <Route path="/claude-code-history" element={<ClaudeCodeHistory />} />
          <Route
            path="/claude-code-history/s/:sessionId"
            element={<ClaudeCodeHistorySession />}
          />
          <Route path="/codex-history" element={<CodexHistory />} />
          <Route path="/codex-history/s/:sessionId" element={<CodexHistorySession />} />
          <Route path="/opencode-history" element={<OpencodeHistory />} />
          <Route path="/opencode-history/s/:sessionId" element={<OpencodeHistorySession />} />
          <Route path="/ai-chat" element={<AiChat />} />
          <Route path="/bash-permissions" element={<BashPermissions />} />
          <Route path="/bash-sandbox" element={<BashSandboxSettings />} />
          <Route path="/rag-status" element={<RagStatus />} />
          <Route path="/rag-debug" element={<RagDebug />} />
          <Route path="/github" element={<Github />} />
          <Route path="/github/radar" element={<GithubRadar />} />
          <Route path="/github/tags" element={<GithubTags />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
