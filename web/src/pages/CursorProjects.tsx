import { EditorRecentPage } from "./EditorRecentPage";

export function CursorProjects() {
  return (
    <EditorRecentPage
      config={{
        app: "cursor",
        queryKeyPrefix: "cursor-projects",
        title: "Cursor 打开项目",
        description:
          "从 Cursor state.vscdb 同步最近打开的文件、文件夹和 workspace，远程 URI 只保留哈希标识。",
        statusLabel: "Cursor 最近记录",
        syncLabel: "同步 Cursor 项目",
        syncingLabel: "同步中…",
      }}
    />
  );
}
