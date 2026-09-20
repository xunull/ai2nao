import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { llmChatLogDebugBannerIfEnabled } from "./log.js";
import {
  defaultBashApprovalStore,
  type BashApprovalStore,
  type BashPermissionRuleStore,
} from "../bashTool/index.js";
import { registerLlmChatChatRoutes } from "./chatRoutes.js";
import { registerCopilotKitRoutes, sessionContextSnapshot } from "./copilotRuntime.js";
import { registerLlmChatProviderRoutes } from "./providerRoutes.js";
import { registerLlmChatSessionRoutes } from "./sessionRoutes.js";

export type LlmChatRouteDeps = {
  db?: Database.Database;
  ragDb?: Database.Database;
  bashApprovalStore?: BashApprovalStore;
  bashPermissionRules?: BashPermissionRuleStore;
};

export function registerLlmChatRoutes(app: Hono, deps?: LlmChatRouteDeps): void {
  llmChatLogDebugBannerIfEnabled();
  registerLlmChatChatRoutes(app);
  registerLlmChatProviderRoutes(app);
  if (deps?.db) {
    registerCopilotKitRoutes(app, {
      db: deps.db,
      ragDb: deps.ragDb,
      bashApprovalStore: deps.bashApprovalStore ?? defaultBashApprovalStore,
      bashPermissionRules: deps.bashPermissionRules,
    });
  }
  // 占用快照在 copilotRuntime 那一层算(估算件都在那儿),从这里注入 ——
  // 让 sessionRoutes 保持不认识 copilotRuntime,方向仍然单向。
  const db = deps?.db;
  registerLlmChatSessionRoutes(app, {
    db,
    sessionContext: db ? (sessionId) => sessionContextSnapshot({ db }, sessionId) : undefined,
  });
}
