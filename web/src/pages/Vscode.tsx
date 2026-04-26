import { EditorRecentPage } from "./EditorRecentPage";

export function Vscode() {
  return (
    <EditorRecentPage
      config={{
        app: "code",
        queryKeyPrefix: "vscode",
        title: "VS Code 工作区",
        description:
          "从本机 state.vscdb 同步最近打开的文件、文件夹和 workspace，远程 URI 只保留哈希标识。",
        statusLabel: "Code 最近记录",
        syncLabel: "立即同步",
        syncingLabel: "同步中…",
      }}
    />
  );
}
