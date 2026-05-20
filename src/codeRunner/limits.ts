import { Buffer } from "node:buffer";
import type { CodeRunnerInputFile, CodeRunnerLimits, CodeRunnerRequest } from "./types.js";

export const DEFAULT_CODE_RUNNER_LIMITS: CodeRunnerLimits = {
  timeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxCodeChars: 20_000,
  maxStdinChars: 1_000_000,
  maxFileCount: 10,
  maxInputFileBytes: 1_000_000,
  maxTotalInputFileBytes: 5_000_000,
  maxOutputChars: 65_536,
  maxOutputFileCount: 10,
  maxOutputFileBytes: 1_000_000,
};

export function effectiveCodeRunnerLimits(
  request: CodeRunnerRequest,
  defaults: CodeRunnerLimits = DEFAULT_CODE_RUNNER_LIMITS
): CodeRunnerLimits {
  const requestedTimeout = Number.isFinite(request.timeoutMs) ? Number(request.timeoutMs) : defaults.timeoutMs;
  return {
    ...defaults,
    timeoutMs: Math.min(defaults.maxTimeoutMs, Math.max(1_000, requestedTimeout)),
  };
}

export function validateCodeRunnerRequest(request: CodeRunnerRequest, limits: CodeRunnerLimits): string | undefined {
  if (request.runtime && request.runtime !== "pyodide" && request.runtime !== "docker") {
    return "Only pyodide and docker runtimes are supported.";
  }
  if (request.language !== "python") return "Only Python execution is supported.";
  if (!request.code.trim()) return "Code is required.";
  if (request.code.length > limits.maxCodeChars) {
    return `Code is too large. Max ${limits.maxCodeChars} characters.`;
  }
  if ((request.stdin ?? "").length > limits.maxStdinChars) {
    return `stdin is too large. Max ${limits.maxStdinChars} characters.`;
  }
  const files = request.files ?? [];
  if (files.length > limits.maxFileCount) {
    return `Too many input files. Max ${limits.maxFileCount}.`;
  }
  let totalBytes = 0;
  for (const file of files) {
    const nameError = validateInputFileName(file.name);
    if (nameError) return nameError;
    const bytes = utf8Bytes(file.content);
    if (bytes > limits.maxInputFileBytes) {
      return `Input file ${file.name} is too large. Max ${limits.maxInputFileBytes} bytes.`;
    }
    totalBytes += bytes;
  }
  if (totalBytes > limits.maxTotalInputFileBytes) {
    return `Input files are too large. Max ${limits.maxTotalInputFileBytes} bytes total.`;
  }
  return undefined;
}

export function validateInputFileName(name: string): string | undefined {
  if (!name || name.length > 160) return "Input file names must be 1-160 characters.";
  if (name.startsWith("/") || name.startsWith(".") || name.includes("..")) {
    return `Input file name is not allowed: ${name}`;
  }
  if (name.split("/").some((part) => !part || part.startsWith("."))) {
    return `Input file name is not allowed: ${name}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    return `Input file name contains unsupported characters: ${name}`;
  }
  return undefined;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function totalInputBytes(files: CodeRunnerInputFile[] | undefined): number {
  return (files ?? []).reduce((sum, file) => sum + utf8Bytes(file.content), 0);
}
