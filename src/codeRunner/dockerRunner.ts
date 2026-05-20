import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import {
  effectiveCodeRunnerLimits,
  validateCodeRunnerRequest,
} from "./limits.js";
import type {
  CodeRunnerLimits,
  CodeRunnerOutputFile,
  CodeRunnerRequest,
  CodeRunnerResult,
} from "./types.js";

const DEFAULT_DOCKER_IMAGE = "python:3.12-slim-bookworm";

export type DockerPythonRunnerDeps = {
  spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  removeContainer?: (name: string) => void;
};

export async function runPythonInDocker(
  request: CodeRunnerRequest,
  defaults: CodeRunnerLimits,
  options: {
    image?: string;
    deps?: DockerPythonRunnerDeps;
  },
  signal: AbortSignal | undefined
): Promise<CodeRunnerResult> {
  const limits = effectiveCodeRunnerLimits(request, defaults);
  const validationError = validateCodeRunnerRequest(request, limits);
  if (validationError) return failedDockerResult(validationError, limits);
  if (signal?.aborted) return failedDockerResult("Code execution was aborted.", limits);

  const runDir = await mkdtemp(join(tmpdir(), "ai2nao-docker-run-"));
  const workspaceDir = join(runDir, "workspace");
  const outputDir = join(workspaceDir, "output");
  const containerName = `ai2nao-run-code-${randomUUID()}`;
  const image = options.image ?? DEFAULT_DOCKER_IMAGE;
  const deps = options.deps ?? {};
  const spawn = deps.spawn ?? nodeSpawn;
  let timedOut = false;

  try {
    await mkdir(outputDir, { recursive: true });
    await writeInputs(workspaceDir, request);
    const args = buildDockerRunArgs({
      containerName,
      image,
      workspaceDir,
      limits,
      user: dockerUser(),
    });
    const child = spawn("docker", args, { stdio: "pipe" });
    const stdout = new OutputBuffer(limits.maxOutputChars);
    const stderr = new OutputBuffer(limits.maxOutputChars);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve({ code, signal: exitSignal });
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        deps.removeContainer?.(containerName);
        child.kill("SIGKILL");
      }, limits.timeoutMs);
      const abort = () => {
        deps.removeContainer?.(containerName);
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.once("close", finish);
      child.stdin.end(request.stdin ?? "");
    });

    const files = await collectOutputFiles(outputDir, limits);
    return {
      ok: result.code === 0 && !timedOut,
      runtime: "docker",
      language: "python",
      timedOut,
      stdout: stdout.value(),
      stderr: stderr.value(),
      files,
      limits: {
        timeoutMs: limits.timeoutMs,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
      error: dockerRunError(result.code, result.signal, timedOut),
    };
  } catch (error) {
    return failedDockerResult(error instanceof Error ? error.message : String(error), limits);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

export function buildDockerRunArgs(options: {
  containerName: string;
  image: string;
  workspaceDir: string;
  limits: CodeRunnerLimits;
  user?: string;
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--pids-limit",
    "128",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    options.user ?? dockerUser(),
    "--workdir",
    "/workspace",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--mount",
    `type=bind,source=${options.workspaceDir},target=/workspace`,
    "-e",
    "PYTHONUNBUFFERED=1",
    options.image,
    "python",
    "/workspace/main.py",
  ];
}

function dockerUser(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

async function writeInputs(workspaceDir: string, request: CodeRunnerRequest): Promise<void> {
  await writeFile(join(workspaceDir, "main.py"), request.code, "utf8");
  for (const file of request.files ?? []) {
    const target = join(workspaceDir, file.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

async function collectOutputFiles(outputDir: string, limits: CodeRunnerLimits): Promise<CodeRunnerOutputFile[]> {
  const found: CodeRunnerOutputFile[] = [];
  const visit = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir)) {
      if (found.length >= limits.maxOutputFileCount) return;
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        await visit(fullPath, relativePath);
        continue;
      }
      if (info.size > limits.maxOutputFileBytes) {
        found.push({ name: relativePath, sizeBytes: info.size });
        continue;
      }
      const data = await readFile(fullPath);
      found.push({
        name: relativePath,
        sizeBytes: info.size,
        preview: decodePreview(data),
      });
    }
  };
  await visit(outputDir, "");
  return found;
}

function decodePreview(data: Uint8Array): string | undefined {
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(data.slice(0, 4_096));
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(preview)) return undefined;
  return preview;
}

function dockerRunError(code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): string | undefined {
  if (timedOut) return "Docker Python execution timed out.";
  if (code === 0) return undefined;
  return `Docker Python exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`;
}

function failedDockerResult(error: string, limits: CodeRunnerLimits): CodeRunnerResult {
  return {
    ok: false,
    runtime: "docker",
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
    error,
  };
}

class OutputBuffer {
  truncated = false;
  #value = "";
  #maxChars: number;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  push(chunk: string): void {
    if (this.#value.length >= this.#maxChars) {
      this.truncated = true;
      return;
    }
    const next = this.#value + chunk;
    if (next.length > this.#maxChars) {
      this.#value = next.slice(0, this.#maxChars);
      this.truncated = true;
      return;
    }
    this.#value = next;
  }

  value(): string {
    return this.#value;
  }
}
