import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { runPythonInDocker, type DockerPythonRunnerDeps } from "./dockerRunner.js";
import {
  DEFAULT_CODE_RUNNER_LIMITS,
  effectiveCodeRunnerLimits,
  validateCodeRunnerRequest,
} from "./limits.js";
import type { CodeRunnerLimits, CodeRunnerRequest, CodeRunnerResult, CodeRunnerRuntime, CodeRunnerService } from "./types.js";

export function createCodeRunnerService(options: {
  limits?: Partial<CodeRunnerLimits>;
  defaultRuntime?: CodeRunnerRuntime;
  dockerEnabled?: boolean;
  dockerImage?: string;
  dockerDeps?: DockerPythonRunnerDeps;
} = {}): CodeRunnerService {
  const defaults = { ...DEFAULT_CODE_RUNNER_LIMITS, ...options.limits };
  return {
    run(request, runOptions) {
      const runtime = request.runtime ?? options.defaultRuntime ?? "pyodide";
      if (runtime === "docker") {
        if (options.dockerEnabled !== true) {
          return Promise.resolve(failedResult("docker", request.language, "Docker Python execution is not enabled for this turn.", effectiveCodeRunnerLimits(request, defaults)));
        }
        return runPythonInDocker(
          { ...request, runtime },
          defaults,
          { image: options.dockerImage, deps: options.dockerDeps },
          runOptions?.signal
        );
      }
      return runPythonInWorker({ ...request, runtime: "pyodide" }, defaults, runOptions?.signal);
    },
  };
}

async function runPythonInWorker(
  request: CodeRunnerRequest,
  defaults: CodeRunnerLimits,
  signal: AbortSignal | undefined
): Promise<CodeRunnerResult> {
  const limits = effectiveCodeRunnerLimits(request, defaults);
  const validationError = validateCodeRunnerRequest(request, limits);
  if (validationError) return failedResult(request.language, validationError, limits);
  if (signal?.aborted) return failedResult(request.language, "Code execution was aborted.", limits);

  const worker = new Worker(...workerArgs());
  let settled = false;
  return await new Promise<CodeRunnerResult>((resolve) => {
    const finish = (result: CodeRunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish({
        ok: false,
        runtime: "pyodide",
        language: "python",
        timedOut: true,
        stdout: "",
        stderr: "",
        files: [],
        limits: {
          timeoutMs: limits.timeoutMs,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        error: `Code execution timed out after ${limits.timeoutMs}ms.`,
      });
    }, limits.timeoutMs);
    const abort = () => {
      finish({
        ok: false,
        runtime: "pyodide",
        language: "python",
        timedOut: false,
        stdout: "",
        stderr: "",
        files: [],
        limits: {
          timeoutMs: limits.timeoutMs,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        error: "Code execution was aborted.",
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: WorkerMessage) => {
      finish({
        ok: message.ok,
        runtime: "pyodide",
        language: "python",
        timedOut: false,
        stdout: message.stdout,
        stderr: message.stderr,
        files: message.files,
        limits: {
          timeoutMs: limits.timeoutMs,
          stdoutTruncated: message.stdoutTruncated,
          stderrTruncated: message.stderrTruncated,
        },
        error: message.ok ? undefined : message.error,
      });
    });
    worker.once("error", (error) => {
      finish(failedResult("python", error.message, limits));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(failedResult("python", `Code worker exited with code ${code}.`, limits));
    });
    worker.postMessage({
      code: request.code,
      stdin: request.stdin ?? "",
      files: request.files ?? [],
      limits,
    });
  });
}

function workerArgs(): [URL, WorkerOptions?] {
  if (fileURLToPath(import.meta.url).endsWith(".ts")) {
    return [new URL("./pyodideWorker.ts", import.meta.url), { execArgv: ["--import", "tsx"] }];
  }
  return [new URL("./pyodideWorker.js", import.meta.url), { execArgv: [] }];
}

function failedResult(
  runtimeOrLanguage: CodeRunnerRuntime | CodeRunnerRequest["language"],
  languageOrError: CodeRunnerRequest["language"] | string,
  errorOrLimits: string | CodeRunnerLimits,
  maybeLimits?: CodeRunnerLimits
): CodeRunnerResult {
  const runtime = maybeLimits ? (runtimeOrLanguage as CodeRunnerRuntime) : "pyodide";
  const language = maybeLimits ? (languageOrError as CodeRunnerRequest["language"]) : (runtimeOrLanguage as CodeRunnerRequest["language"]);
  const error = maybeLimits ? (errorOrLimits as string) : (languageOrError as string);
  const limits = maybeLimits ?? (errorOrLimits as CodeRunnerLimits);
  return {
    ok: false,
    runtime,
    language,
    timedOut: false,
    stdout: "",
    stderr: "",
    files: [],
    limits: {
      timeoutMs: limits.timeoutMs,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    error,
  };
}

type WorkerMessage = {
  ok: boolean;
  stdout: string;
  stderr: string;
  files: CodeRunnerResult["files"];
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
};
