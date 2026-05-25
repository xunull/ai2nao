import { tool } from "ai";
import { z } from "zod";
import {
  createBashToolService,
  readBashSandboxConfig,
  serviceSandboxConfig,
  type BashApprovalStore,
  type BashPermissionMode,
  type BashPermissionRuleStore,
  type BashToolResult,
  type BashToolService,
} from "../bashTool/index.js";

const runShellInput = z.object({
  command: z.string().describe("Bash command to run after ai2nao permission checks."),
  cwd: z
    .string()
    .optional()
    .describe("Optional working directory relative to the ai2nao server project root."),
  timeoutMs: z.number().optional().describe("Requested timeout in milliseconds, capped by ai2nao."),
  description: z.string().optional().describe("Short reason for running this command."),
});
type RunShellInput = z.infer<typeof runShellInput>;

export function createBashTool(
  bashTool: BashToolService | undefined,
  options: {
    defaultTimeoutMs: number;
    approvalStore?: BashApprovalStore;
    ruleStore?: BashPermissionRuleStore;
    permissionMode?: BashPermissionMode;
    sessionId?: string;
  }
) {
  const sandboxConfig = readBashSandboxConfig();
  const service = bashTool ?? createBashToolService({
    limits: {
      timeoutMs: options.defaultTimeoutMs,
    },
    ruleStore: options.ruleStore,
    sandbox: serviceSandboxConfig(sandboxConfig.config),
  });
  return tool<RunShellInput, BashToolResult>({
    description:
      "Run a tightly controlled local Bash command through ai2nao. The command is checked before execution: no command substitution, heredoc, file redirection, network tools, destructive filesystem commands, sudo, secondary shells, package installation, or arbitrary interpreters. Prefer read-only inspection commands; npm run test/lint/typecheck/check/build/smoke is allowed for project verification.",
    inputSchema: runShellInput,
    execute: async (input, execOptions): Promise<BashToolResult> => {
      return service.run(
        {
          ...input,
          timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        },
        {
          signal: execOptions.abortSignal,
          approval:
            options.approvalStore && options.sessionId
              ? {
                  store: options.approvalStore,
                  sessionId: options.sessionId,
                }
              : undefined,
          permissionMode: options.permissionMode,
        }
      );
    },
  });
}
