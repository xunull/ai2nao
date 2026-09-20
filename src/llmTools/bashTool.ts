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

/**
 * 执行前/后落记录的回调。
 *
 * 故意做成回调而不是直接收一个 db:`src/llmTools/` 与 `src/bashTool/` 目前对
 * 库一无所知,让工具层长出 db 依赖是单向的退化。实现由 copilotRuntime 提供 ——
 * runId 与 fence 本来就只在「某一轮」的作用域里存在。
 */
export type BashExecRecorder = {
  /** 返回 false 表示执行权已易主,**命令一律不许跑**。 */
  start(input: { toolCallId: string; command: string; cwd: string | null }): boolean;
  finish(input: {
    toolCallId: string;
    status: "completed" | "failed";
    exitCode: number | null;
  }): void;
};

export function createBashTool(
  bashTool: BashToolService | undefined,
  options: {
    defaultTimeoutMs: number;
    approvalStore?: BashApprovalStore;
    ruleStore?: BashPermissionRuleStore;
    permissionMode?: BashPermissionMode;
    sessionId?: string;
    execRecorder?: BashExecRecorder;
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
      const cwd = input.cwd ?? null;
      // **记录必须落在 service.run 之前。** 等拿到结果再记,恰好漏掉的就是最需要
      // 记录的那几种:命令跑了一半进程没了、spawn 之后首次写库之前崩掉。
      // 多记一条(比如后面被静态规则拒了)只是让用户多确认一次;漏记才是
      // 「崩溃后判断不了它跑没跑过」的来源,所以宁可偏保守。
      if (options.execRecorder && !options.execRecorder.start({
        toolCallId: execOptions.toolCallId,
        command: input.command,
        cwd,
      })) {
        // 执行权已易主:这一轮已经被别的进程接管,旧进程不许再跑命令。
        return {
          ok: false,
          command: input.command,
          cwd: input.cwd ?? ".",
          risk: "read-only",
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          deniedReason: "这一轮已被其他进程接管，命令没有执行。",
        };
      }
      let result: BashToolResult;
      try {
        result = await service.run(
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
      } catch (error) {
        // 抛出去之前先落终态 —— 否则这一条永远停在 started,下一轮会把它标成
        // 「结果未知」去打扰用户,而我们其实知道它失败了。
        options.execRecorder?.finish({
          toolCallId: execOptions.toolCallId,
          status: "failed",
          exitCode: null,
        });
        throw error;
      }
      options.execRecorder?.finish({
        toolCallId: execOptions.toolCallId,
        status: result.ok ? "completed" : "failed",
        exitCode: result.exitCode,
      });
      return result;
    },
  });
}
