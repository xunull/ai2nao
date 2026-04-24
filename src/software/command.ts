import { execFile } from "node:child_process";

export class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}

export class CommandOutputTooLargeError extends Error {
  constructor(command: string, maxBuffer: number) {
    super(`${command} output exceeded ${maxBuffer} bytes`);
    this.name = "CommandOutputTooLargeError";
  }
}

export class CommandFailedError extends Error {
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`${command} failed${stderr ? `: ${stderr}` : ""}`);
    this.name = "CommandFailedError";
    this.stderr = stderr;
  }
}

export type BoundedCommandOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
};

export type BoundedCommandResult = {
  stdout: string;
  stderr: string;
};

export function runBoundedCommand(
  file: string,
  args: string[],
  opts: BoundedCommandOptions = {}
): Promise<BoundedCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBuffer = opts.maxBuffer ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed || code === "ETIMEDOUT") {
            reject(new CommandTimeoutError(file, timeoutMs));
            return;
          }
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(new CommandOutputTooLargeError(file, maxBuffer));
            return;
          }
          reject(new CommandFailedError(file, String(stderr ?? "").trim()));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}
