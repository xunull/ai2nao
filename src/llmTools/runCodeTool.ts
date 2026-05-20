import { tool } from "ai";
import { z } from "zod";
import { createCodeRunnerService, type CodeRunnerService, type CodeRunnerResult } from "../codeRunner/index.js";

const runCodeInput = z.object({
  runtime: z
    .enum(["pyodide", "docker"])
    .optional()
    .describe("Execution runtime. Defaults to the runtime enabled by the user for this turn."),
  language: z.literal("python").describe("Programming language to execute. Only python is supported."),
  code: z.string().describe("Python code to run inside ai2nao's local WASM sandbox."),
  stdin: z.string().optional().describe("Optional stdin lines for input()."),
  files: z
    .array(
      z.object({
        name: z.string().describe("Relative input file name. No absolute paths or ../ segments."),
        content: z.string().describe("UTF-8 file content."),
      })
    )
    .optional()
    .describe("Small input files written into the sandbox workspace."),
  reason: z.string().optional().describe("Why code execution is needed."),
  timeoutMs: z.number().optional().describe("Requested timeout in milliseconds, capped by ai2nao."),
});
type RunCodeInput = z.infer<typeof runCodeInput>;

export function createRunCodeTool(
  codeRunner: CodeRunnerService | undefined,
  options: {
    defaultTimeoutMs: number;
    defaultRuntime: "pyodide" | "docker";
    dockerEnabled: boolean;
  }
) {
  const service = codeRunner ?? createCodeRunnerService({
    defaultRuntime: options.defaultRuntime,
    dockerEnabled: options.dockerEnabled,
  });
  return tool<RunCodeInput, CodeRunnerResult>({
    description:
      "Run short Python code with ai2nao. Default runtime is Pyodide/WASM; Docker Python is available only when the user explicitly enables it for this turn. Use for deterministic calculation, small data transforms, and code verification. No shell, host filesystem, network access, or package installation.",
    inputSchema: runCodeInput,
    execute: async (input, execOptions): Promise<CodeRunnerResult> => {
      return service.run(
        {
          ...input,
          runtime: input.runtime ?? options.defaultRuntime,
          timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        },
        { signal: execOptions.abortSignal }
      );
    },
  });
}
