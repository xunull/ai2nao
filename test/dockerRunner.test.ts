import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildDockerRunArgs } from "../src/codeRunner/dockerRunner.js";
import { createCodeRunnerService } from "../src/codeRunner/index.js";

describe("Docker Python code runner", () => {
  it("builds a locked-down docker run command", () => {
    const args = buildDockerRunArgs({
      containerName: "ai2nao-test",
      image: "python:3.12-slim-bookworm",
      workspaceDir: "/tmp/ai2nao-run",
      user: "501:20",
      limits: {
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
      },
    });

    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("501:20");
    expect(args).toContain("--memory");
    expect(args).toContain("512m");
    expect(args).toContain("--cpus");
    expect(args).toContain("1");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("128");
    expect(args).not.toContain("--privileged");
  });

  it("rejects docker runtime unless explicitly enabled", async () => {
    const runner = createCodeRunnerService();

    const result = await runner.run({
      runtime: "docker",
      language: "python",
      code: "print(1 + 1)",
    });

    expect(result.ok).toBe(false);
    expect(result.runtime).toBe("docker");
    expect(result.error).toContain("not enabled");
  });

  it("runs docker through spawn without shell command strings", async () => {
    const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
    const fake = new FakeChildProcess();
    const spawn = vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
      calls.push({ command, args, options });
      queueMicrotask(() => {
        fake.stdout.write("42\n");
        fake.stdout.end();
        fake.stderr.end();
        fake.close(0);
      });
      return fake as unknown as ChildProcessWithoutNullStreams;
    });
    const runner = createCodeRunnerService({
      dockerEnabled: true,
      dockerDeps: { spawn },
    });

    const result = await runner.run({
      runtime: "docker",
      language: "python",
      code: "print(40 + 2)",
    });

    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("docker");
    expect(result.stdout).toBe("42\n");
    expect(calls[0].command).toBe("docker");
    expect(calls[0].args[0]).toBe("run");
    expect(calls[0].options.stdio).toBe("pipe");
  });
});

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  kill(): boolean {
    this.close(null, "SIGKILL");
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}
