import { describe, expect, it, vi } from "vitest";
import {
  buildAi2NaoServerTools,
  parseForwardedToolProps,
  type BashToolResult,
} from "../src/llmTools/index.js";

describe("LLM tool forwarded props", () => {
  it("clamps shell timeout and accepts only known permission modes", () => {
    expect(
      parseForwardedToolProps({
        shellExecutionEnabled: true,
        shellExecutionTimeoutMs: 60_000,
        shellPermissionMode: "bypassPermissions",
      })
    ).toMatchObject({
      shellExecutionEnabled: true,
      shellExecutionTimeoutMs: 30_000,
      shellPermissionMode: "bypassPermissions",
    });

    expect(
      parseForwardedToolProps({
        shellExecutionEnabled: true,
        shellExecutionTimeoutMs: 10,
        shellPermissionMode: "root",
      })
    ).toMatchObject({
      shellExecutionEnabled: true,
      shellExecutionTimeoutMs: 1_000,
      shellPermissionMode: "default",
    });
  });

  it("passes shell execution options into the controlled Bash service", async () => {
    const run = vi.fn(async (): Promise<BashToolResult> => ({
      ok: true,
      command: "pwd",
      cwd: "/repo",
      risk: "read-only",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "/repo\n",
      stderr: "",
      outputTruncated: false,
    }));
    const approvalStore = {} as never;
    const tools = buildAi2NaoServerTools(
      {
        bashTool: { run },
        bashApprovalStore: approvalStore,
      },
      {
        shellExecutionEnabled: true,
        shellExecutionTimeoutMs: 60_000,
        shellPermissionMode: "plan",
      },
      { sessionId: "thread-1" }
    );
    const shell = tools.ai2nao_run_shell as {
      execute: (
        input: { command: string; timeoutMs?: number },
        options: { abortSignal?: AbortSignal }
      ) => Promise<BashToolResult>;
    };

    await expect(shell.execute({ command: "pwd" }, {})).resolves.toMatchObject({
      ok: true,
      stdout: "/repo\n",
    });
    expect(run).toHaveBeenCalledWith(
      { command: "pwd", timeoutMs: 30_000 },
      expect.objectContaining({
        approval: expect.objectContaining({
          store: approvalStore,
          sessionId: "thread-1",
        }),
        permissionMode: "plan",
      })
    );
  });
});
